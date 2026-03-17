import 'server-only';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createGramClient } from '@/lib/tgOutreach/gramClient';

const BUCKET_SESSIONS = 'tg-outreach-sessions';

type OutreachAccountRow = {
  id: string;
  campaign_id: string;
  session_name: string;
  api_id: number;
  api_hash: string;
  phone: string;
  proxy_id: string | null;
  session_data: string | null;
  session_file_path: string | null;
  is_active: boolean;
};

type PoolAccountRow = {
  id: string;
  phone: string | null;
  status: string | null;
  session_data: unknown;
};

function normalizePhone(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, '');
  const onlyDigits = digits.replace(/\D/g, '');

  // RU defaults: 10 digits -> +7, 11 digits starting with 8/7 -> +7
  if (onlyDigits.length === 10) return `+7${onlyDigits}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('8')) return `+7${onlyDigits.slice(1)}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('7')) return `+${onlyDigits}`;

  // Generic E.164-ish
  if (s.startsWith('+') && onlyDigits.length >= 11 && onlyDigits.length <= 15) return `+${onlyDigits}`;
  return null;
}

const sessionPathCache = new Map<string, string>();

async function downloadSessionToTemp(db: SupabaseClient, storagePath: string): Promise<string> {
  const cached = sessionPathCache.get(storagePath);
  if (cached && fs.existsSync(cached)) return cached;
  const { data, error } = await db.storage.from(BUCKET_SESSIONS).download(storagePath);
  if (error || !data) throw new Error(error?.message ?? 'Не удалось скачать .session');
  const localPath = path.join(os.tmpdir(), `tg-session-${storagePath.replace(/[\\/]/g, '-')}`);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  sessionPathCache.set(storagePath, localPath);
  return localPath;
}

async function getAnyActiveTelegramAccount(): Promise<OutreachAccountRow | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('tg_outreach_accounts')
    .select('id,campaign_id,session_name,api_id,api_hash,phone,proxy_id,session_data,session_file_path,is_active')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(20);
  const accounts = (data ?? []) as OutreachAccountRow[];
  const outreach = accounts.find((a) => Boolean(a.session_data?.trim() || a.session_file_path)) ?? null;
  if (outreach) return outreach;

  // Fallback: allow using active accounts from TG pool as a source for CIS enrichment.
  const apiId = Number(process.env.TG_API_ID ?? process.env.TELEGRAM_API_ID ?? '0');
  const apiHash = String(process.env.TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '').trim();
  if (apiId <= 0 || !apiHash) return null;

  const { data: poolData } = await supabaseAdmin
    .from('tg_pool_accounts')
    .select('id,phone,status,session_data')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(20);
  const poolAccounts = (poolData ?? []) as PoolAccountRow[];
  const pool = poolAccounts.find((a) => {
    const raw = a.session_data;
    if (typeof raw === 'string') return raw.trim().length > 0;
    if (raw && typeof raw === 'object') {
      const sessionString = String((raw as { session_string?: unknown }).session_string ?? '').trim();
      return sessionString.length > 0;
    }
    return false;
  });
  if (!pool) return null;

  const sessionDataRaw = pool.session_data;
  const poolSessionString =
    typeof sessionDataRaw === 'string'
      ? sessionDataRaw.trim()
      : String((sessionDataRaw as { session_string?: unknown })?.session_string ?? '').trim();
  if (!poolSessionString) return null;

  return {
    id: `pool:${pool.id}`,
    campaign_id: 'tg-pool',
    session_name: `pool_${pool.id}`,
    api_id: apiId,
    api_hash: apiHash,
    phone: String(pool.phone ?? ''),
    proxy_id: null,
    session_data: poolSessionString,
    session_file_path: null,
    is_active: true,
  };
}

async function withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const account = await getAnyActiveTelegramAccount();
  if (!account) {
    throw new Error(
      'Нет активного Telegram аккаунта с сессией для пробива (tg_outreach_accounts или tg_pool_accounts)',
    );
  }

  const db = supabaseAdmin!;
  const downloadSessionFile = (storagePath: string) => downloadSessionToTemp(db, storagePath);

  const client = await createGramClient(
    {
      id: account.id,
      campaign_id: account.campaign_id,
      session_name: account.session_name,
      api_id: account.api_id,
      api_hash: account.api_hash,
      phone: account.phone,
      proxy_id: account.proxy_id,
      session_data: account.session_data ?? '',
      session_file_path: account.session_file_path,
      is_active: true,
    } as unknown as import('@/lib/tgOutreach/types').OutreachAccount,
    null,
    downloadSessionFile,
  );

  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function upsertIdentity(params: {
  phone: string;
  status: 'found' | 'not_found' | 'error';
  tg_user_id?: number | null;
  tg_username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  about?: string | null;
  error_message?: string | null;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('phone_identities')
    .upsert(
      {
        phone_normalized: params.phone,
        tg_user_id: params.tg_user_id ?? null,
        tg_username: params.tg_username ?? null,
        first_name: params.first_name ?? null,
        last_name: params.last_name ?? null,
        about: params.about ?? null,
        source: 'mtproto',
        checked_at: new Date().toISOString(),
        check_status: params.status,
        error_message: params.error_message ?? null,
      },
      { onConflict: 'phone_normalized' },
    );
}

/** Phone -> company_contact ids to update with tg_username when found */
const phoneToContactIds = new Map<string, string[]>();

export async function runPhoneEnrichmentBatch(): Promise<{ processed: number }> {
  if (!supabaseAdmin) return { processed: 0 };

  phoneToContactIds.clear();

  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('raw_phone')
    .not('raw_phone', 'is', null)
    .limit(5000);

  const phonesRaw = (leads ?? [])
    .map((r) => String((r as { raw_phone?: unknown }).raw_phone ?? '').trim())
    .filter(Boolean);

  const normalized = phonesRaw
    .map(normalizePhone)
    .filter((p): p is string => Boolean(p));

  const uniqueFromLeads = Array.from(new Set(normalized));

  const { data: contactsWithPhone } = await supabaseAdmin
    .from('company_contacts')
    .select('id, channel_phone')
    .not('channel_phone', 'is', null)
    .is('channel_tg_username', null)
    .limit(2000);

  for (const row of (contactsWithPhone ?? []) as Array<{ id: string; channel_phone: string }>) {
    const phone = normalizePhone(row.channel_phone);
    if (!phone) continue;
    const list = phoneToContactIds.get(phone) ?? [];
    if (!list.includes(row.id)) list.push(row.id);
    phoneToContactIds.set(phone, list);
  }

  const fromContacts = Array.from(phoneToContactIds.keys());
  const unique = Array.from(new Set([...uniqueFromLeads, ...fromContacts])).slice(0, 120);
  if (unique.length === 0) return { processed: 0 };

  const { data: existing } = await supabaseAdmin
    .from('phone_identities')
    .select('phone_normalized, tg_username')
    .in('phone_normalized', unique);

  const existingSet = new Set((existing ?? []).map((r) => String((r as { phone_normalized?: unknown }).phone_normalized ?? '')));
  const existingTgByPhone = new Map(
    (existing ?? []).map((r) => [
      String((r as { phone_normalized?: unknown }).phone_normalized ?? ''),
      String((r as { tg_username?: unknown }).tg_username ?? '').trim() || null,
    ]),
  );

  const toCheck = unique.filter((p) => !existingSet.has(p)).slice(0, 50);

  for (const phone of fromContacts) {
    if (toCheck.includes(phone)) continue;
    const tg = existingTgByPhone.get(phone);
    if (!tg) continue;
    const ids = phoneToContactIds.get(phone);
    if (!ids?.length) continue;
    for (const id of ids) {
      await supabaseAdmin.from('company_contacts').update({ channel_tg_username: tg }).eq('id', id);
    }
  }

  if (toCheck.length === 0) return { processed: 0 };

  await withClient(async (client) => {
    // Telegram requires contacts import in batches; keep it small and safe.
    const contactEntries = toCheck.map((p, i) => {
      const clientId = BigInt(Date.now() + i);
      return {
        phone: p,
        clientId,
        contact: new Api.InputPhoneContact({
          clientId: clientId as unknown as never,
          phone: p,
          firstName: 'Lead',
          lastName: 'Finder',
        }),
      };
    });
    const contacts = contactEntries.map((entry) => entry.contact);
    const phoneByClientId = new Map<string, string>(
      contactEntries.map((entry) => [entry.clientId.toString(), entry.phone]),
    );

    try {
      const res = await client.invoke(new Api.contacts.ImportContacts({ contacts }));

      const userById = new Map<number, Api.User>();
      for (const u of res.users) {
        if (u instanceof Api.User) {
          userById.set(Number(u.id), u);
        }
      }

      const foundPhones = new Set<string>();
      for (const imp of res.imported ?? []) {
        const userId = Number((imp as { userId?: unknown }).userId ?? 0);
        const clientId = String((imp as { clientId?: unknown }).clientId ?? '');
        const phone = phoneByClientId.get(clientId);
        const u = userById.get(userId);
        if (!phone || !u) continue;

        foundPhones.add(phone);
        const tgUsername = u.username ?? null;
        await upsertIdentity({
          phone,
          status: 'found',
          tg_user_id: Number(u.id),
          tg_username: tgUsername,
          first_name: u.firstName ?? null,
          last_name: u.lastName ?? null,
        });
        const contactIds = phoneToContactIds.get(phone);
        if (tgUsername && contactIds?.length) {
          for (const contactId of contactIds) {
            await supabaseAdmin!.from('company_contacts').update({ channel_tg_username: tgUsername }).eq('id', contactId);
          }
        }
      }

      for (const phone of toCheck) {
        if (foundPhones.has(phone)) continue;
        await upsertIdentity({ phone, status: 'not_found' });
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Telegram import error';
      for (const phone of toCheck) {
        await upsertIdentity({ phone, status: 'error', error_message: msg });
      }
    }
  });

  return { processed: toCheck.length };
}

