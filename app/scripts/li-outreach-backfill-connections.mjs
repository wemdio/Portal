#!/usr/bin/env node
/**
 * One-shot backfill: walk Unipile chats for a given LinkedIn account and
 * mirror confirmed connections back into our DB.
 *
 * Why this exists:
 *   For ~5 weeks (until Apr 29, 2026) the Unipile webhook for our LinkedIn
 *   accounts pointed at someone else's ngrok tunnel, so we never received
 *   `new_relation` / `message_received` events. As a result every lead that
 *   actually accepted our invite still shows status='invited' in our DB,
 *   campaigns stalled on the message step, and the dashboard reads "0 connected"
 *   even when LinkedIn says otherwise.
 *
 *   This script asks Unipile directly: for every chat the account sees,
 *   pull the other attendee's provider_id, find the matching li_lead by
 *   linkedin_id (or public_identifier), then:
 *     - set li_leads.chat_id, status='connected', last_activity = chat ts
 *     - clear li_campaign_leads.next_action_at so the next tick processes them
 *
 * Idempotent: leads already at status='messaged'/'replied' are left alone.
 *
 * Usage (run from repo root or anywhere):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   UNIPILE_DSN=api27.unipile.com:15745 UNIPILE_API_KEY=... \
 *   ACCOUNT_ID=<unipile_account_id> \
 *   [DRY_RUN=1] [LIMIT=200] [VERBOSE=1] \
 *     node app/scripts/li-outreach-backfill-connections.mjs
 */

import { createClient } from '@supabase/supabase-js';

// ---- Config ----------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const ACCOUNT_ID = process.env.ACCOUNT_ID; // unipile_account_id (not our DB id)
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Number(process.env.LIMIT ?? '500'); // safety cap on chats to scan
const VERBOSE = process.env.VERBOSE === '1';

const required = { SUPABASE_URL, SUPABASE_KEY, UNIPILE_DSN, UNIPILE_KEY, ACCOUNT_ID };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const baseUrl = `https://${UNIPILE_DSN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1`;

// ---- Unipile helpers -------------------------------------------------------

async function unipile(method, path, params = {}) {
  const url = new URL(`${baseUrl}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { 'X-API-KEY': UNIPILE_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Unipile ${res.status} ${method} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function* iterChats() {
  let cursor;
  let scanned = 0;
  for (;;) {
    const data = await unipile('GET', 'chats', {
      account_id: ACCOUNT_ID,
      limit: 100,
      cursor,
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const chat of items) {
      yield chat;
      scanned++;
      if (scanned >= LIMIT) return;
    }
    cursor = data?.cursor;
    if (!cursor) return;
  }
}

// ---- Main ------------------------------------------------------------------

function pickAttendeeProviderId(chat) {
  // Unipile 1:1 chats expose the other party's provider_id directly as
  // top-level `attendee_provider_id`. Group/multi-attendee chats expose
  // an `attendees[]` array of objects (or a `attendee_provider_ids[]`
  // array of strings). Try them all so we work for both shapes.
  const direct = String(chat?.attendee_provider_id ?? '').trim();
  if (direct && direct !== ACCOUNT_ID) return direct;

  if (Array.isArray(chat?.attendees)) {
    for (const a of chat.attendees) {
      const pid = String(a?.provider_id ?? a?.attendee_provider_id ?? '').trim();
      if (pid && pid !== ACCOUNT_ID) return pid;
    }
  }
  if (Array.isArray(chat?.attendee_provider_ids)) {
    for (const id of chat.attendee_provider_ids) {
      const pid = String(id ?? '').trim();
      if (pid && pid !== ACCOUNT_ID) return pid;
    }
  }
  return null;
}

async function findLeadByProviderId(providerId) {
  const { data, error } = await db
    .from('li_leads')
    .select('id, name, status, chat_id, public_identifier, linkedin_id')
    .eq('linkedin_id', providerId)
    .maybeSingle();
  if (error) {
    console.warn(`  ! lookup error for ${providerId}: ${error.message}`);
    return null;
  }
  return data;
}

async function main() {
  console.log(`[backfill] account=${ACCOUNT_ID} dry_run=${DRY_RUN} limit=${LIMIT}`);

  let scanned = 0;
  let matched = 0;
  let connected = 0;
  let alreadyOk = 0;
  let unmatched = 0;
  let cleared = 0;

  for await (const chat of iterChats()) {
    scanned++;
    const chatId = String(chat?.id ?? chat?.chat_id ?? '').trim();
    const providerId = pickAttendeeProviderId(chat);
    if (!chatId || !providerId) {
      if (VERBOSE) console.log(`  - skip chat: no chat_id/provider_id`);
      continue;
    }

    const lead = await findLeadByProviderId(providerId);
    if (!lead) {
      unmatched++;
      if (VERBOSE) console.log(`  ? no lead for provider_id=${providerId} (chat ${chatId})`);
      continue;
    }
    matched++;

    // Skip iff lead is already up-to-date — same chat_id AND a status
    // at or beyond `connected`. Otherwise we always need to at least
    // record the chat_id we just discovered.
    if (
      lead.chat_id === chatId &&
      ['connected', 'messaged', 'replied', 'completed'].includes(lead.status)
    ) {
      alreadyOk++;
      continue;
    }

    const update = {
      // Always (re)set chat_id since we just discovered it from Unipile,
      // and it might have been null before due to the broken webhook.
      chat_id: chatId,
      // Only flip status forward — never downgrade messaged/replied/completed.
      ...(['new', 'invited'].includes(lead.status) ? { status: 'connected' } : {}),
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    console.log(`  ✓ ${lead.name} (${providerId}) → chat_id=${chatId} status=${update.status ?? lead.status}`);
    if (!DRY_RUN) {
      const { error } = await db.from('li_leads').update(update).eq('id', lead.id);
      if (error) {
        console.warn(`    ! update failed: ${error.message}`);
        continue;
      }
      // Clear any stale next_action_at on campaign_leads so the runner
      // re-evaluates them on the next tick (now with chat_id present).
      const { error: clrErr } = await db
        .from('li_campaign_leads')
        .update({
          next_action_at: null,
          status: 'in_progress',
          updated_at: new Date().toISOString(),
        })
        .eq('lead_id', lead.id);
      if (clrErr) console.warn(`    ! campaign_leads clear failed: ${clrErr.message}`);
      else cleared++;
    }
    connected++;
  }

  console.log(`\n[backfill] done.`);
  console.log(`  chats scanned         : ${scanned}`);
  console.log(`  matched to a lead     : ${matched}`);
  console.log(`  marked connected      : ${connected}`);
  console.log(`  already up to date    : ${alreadyOk}`);
  console.log(`  unmatched (no lead)   : ${unmatched}`);
  console.log(`  campaign_leads cleared: ${cleared}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
