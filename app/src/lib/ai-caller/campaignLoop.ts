import type { SupabaseClient } from '@supabase/supabase-js';
import { createCall, getCall, type AiCallerProvider } from '@/lib/ai-caller-provider';
import { normalizeRuPhoneNumber } from '@/lib/phone-normalization';

const CALL_DELAY_MIN_MS = 5_000;
const CALL_DELAY_MAX_MS = 15_000;
const CALL_POLL_INTERVAL_MS = 3_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_POLL_ERRORS = 5;
const MAX_CREATE_CALL_RETRIES = 2;

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): number {
  return Math.floor(Math.random() * (CALL_DELAY_MAX_MS - CALL_DELAY_MIN_MS + 1)) + CALL_DELAY_MIN_MS;
}

interface Campaign {
  id: string;
  assistant_id: string;
  phone_number_id: string;
  provider: AiCallerProvider;
  called_contacts: number;
  successful_contacts: number;
}

interface Contact {
  id: string;
  phone_number: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
}

async function waitForCallEnd(
  callId: string,
  provider: AiCallerProvider,
  shouldStop: () => boolean,
  log: LogFn,
): Promise<{ duration: number | null; endedReason: string | null; hasTranscript: boolean }> {
  const start = Date.now();
  let errors = 0;

  while (!shouldStop()) {
    if (Date.now() - start > CALL_TIMEOUT_MS) {
      log('warn', `Call ${callId} timed out after ${CALL_TIMEOUT_MS}ms`);
      return { duration: null, endedReason: 'timeout', hasTranscript: false };
    }

    await sleep(CALL_POLL_INTERVAL_MS);

    let callData: Record<string, unknown>;
    try {
      callData = (await getCall(callId, provider)) as Record<string, unknown>;
      errors = 0;
    } catch (err) {
      errors++;
      log('warn', `Poll error #${errors} for call ${callId}: ${err instanceof Error ? err.message : String(err)}`);
      if (errors >= MAX_POLL_ERRORS) {
        return { duration: null, endedReason: 'poll_errors', hasTranscript: false };
      }
      continue;
    }

    const status = (callData.status as string) ?? '';
    if (status === 'ended' || status === 'failed') {
      const duration =
        callData.startedAt && callData.endedAt
          ? Math.round(
              (new Date(callData.endedAt as string).getTime() -
                new Date(callData.startedAt as string).getTime()) /
                1000,
            )
          : null;
      const endedReason = (callData.endedReason as string) || null;
      const hasTranscript = !!((callData.transcript as string)?.trim());
      return { duration, endedReason, hasTranscript };
    }
  }

  return { duration: null, endedReason: 'stopped', hasTranscript: false };
}

/**
 * Resets contacts stuck in 'calling' status back to 'pending'.
 * This handles the case where a previous process (browser or worker) crashed mid-call.
 */
export async function resetStuckContacts(db: SupabaseClient, campaignId: string, log: LogFn) {
  const { data } = await db
    .from('ai_campaign_contacts')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'calling');

  if (data?.length) {
    log('info', `Resetting ${data.length} stuck calling contacts to pending`);
    await db
      .from('ai_campaign_contacts')
      .update({ status: 'pending', called_at: null, vapi_call_id: null })
      .eq('campaign_id', campaignId)
      .eq('status', 'calling');
  }
}

/**
 * Server-side campaign call loop.
 * Iterates over pending contacts, creates calls, waits for completion, moves to next.
 */
export async function runCampaignLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  log: LogFn,
) {
  const { data: campaign, error: cErr } = await db
    .from('ai_campaigns')
    .select('id, assistant_id, phone_number_id, provider, called_contacts, successful_contacts')
    .eq('id', campaignId)
    .single();

  if (cErr || !campaign) {
    log('error', `Campaign ${campaignId} not found`);
    return;
  }

  const camp = campaign as Campaign;

  const providerKey = camp.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'VAPI_API_KEY';
  if (!process.env[providerKey]) {
    log('error', `${providerKey} not set — cannot make calls`);
    await db.from('ai_campaigns').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', campaignId);
    return;
  }

  await resetStuckContacts(db, campaignId, log);

  await db
    .from('ai_campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', campaignId);

  log('info', `Campaign "${campaignId}" loop started (provider: ${camp.provider})`);

  let calledCount = camp.called_contacts ?? 0;
  let successCount = camp.successful_contacts ?? 0;

  while (!shouldStop()) {
    // Re-check campaign status in DB (might have been paused externally)
    const { data: fresh } = await db
      .from('ai_campaigns')
      .select('status')
      .eq('id', campaignId)
      .single();

    if (fresh?.status !== 'running') {
      log('info', `Campaign status changed to "${fresh?.status}" — exiting loop`);
      return;
    }

    // Get next pending contact
    const { data: contact } = await db
      .from('ai_campaign_contacts')
      .select('id, phone_number, company_name, contact_name, email')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!contact) {
      // No more pending contacts — campaign complete
      await db
        .from('ai_campaigns')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', campaignId);
      log('info', `All contacts processed — campaign completed (called: ${calledCount}, success: ${successCount})`);
      return;
    }

    const c = contact as Contact;
    const phone = normalizeRuPhoneNumber(c.phone_number);

    if (!phone) {
      log('warn', `Invalid phone "${c.phone_number}" for contact ${c.id}, marking failed`);
      await db.from('ai_campaign_contacts').update({ status: 'failed' }).eq('id', c.id);
      continue;
    }

    // Mark as calling
    await db
      .from('ai_campaign_contacts')
      .update({ status: 'calling', called_at: new Date().toISOString() })
      .eq('id', c.id);

    log('info', `Calling ${phone} (contact ${c.id}, company: ${c.company_name ?? '—'})`);

    // Create call with retries
    let callId: string | null = null;
    for (let attempt = 0; attempt <= MAX_CREATE_CALL_RETRIES; attempt++) {
      try {
        const call = await createCall(
          {
            assistantId: camp.assistant_id,
            phoneNumberId: camp.phone_number_id,
            customer: { number: phone },
            contactData: {
              contactName: c.contact_name || undefined,
              companyName: c.company_name || undefined,
              email: c.email || undefined,
            },
          },
          camp.provider,
        );
        callId = (call as Record<string, string>).id;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_CREATE_CALL_RETRIES) {
          log('warn', `createCall attempt ${attempt + 1} failed: ${msg}, retrying...`);
          await sleep(2_000);
        } else {
          log('error', `createCall failed after ${MAX_CREATE_CALL_RETRIES + 1} attempts: ${msg}`);
        }
      }
    }

    if (!callId) {
      await db.from('ai_campaign_contacts').update({ status: 'failed' }).eq('id', c.id);
      continue;
    }

    // Store call ID
    await db.from('ai_campaign_contacts').update({ vapi_call_id: callId }).eq('id', c.id);

    calledCount++;
    await db
      .from('ai_campaigns')
      .update({ called_contacts: calledCount, updated_at: new Date().toISOString() })
      .eq('id', campaignId);

    // Wait for call to end
    const result = await waitForCallEnd(callId, camp.provider, shouldStop, log);

    // Complete contact
    const isSuccessful = result.hasTranscript && (result.duration ?? 0) > 15;
    await db
      .from('ai_campaign_contacts')
      .update({
        status: 'completed',
        call_duration: result.duration,
        call_ended_reason: result.endedReason,
      })
      .eq('id', c.id);

    if (isSuccessful) {
      successCount++;
      await db
        .from('ai_campaigns')
        .update({ successful_contacts: successCount, updated_at: new Date().toISOString() })
        .eq('id', campaignId);
    }

    log(
      'info',
      `Call completed: ${phone}, duration=${result.duration ?? '?'}s, reason=${result.endedReason ?? '?'}, success=${isSuccessful}`,
    );

    if (shouldStop()) break;

    // Delay before next call
    const delay = randomDelay();
    log('info', `Next call in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }

  log('info', 'Campaign loop stopped (shouldStop signal)');
}
