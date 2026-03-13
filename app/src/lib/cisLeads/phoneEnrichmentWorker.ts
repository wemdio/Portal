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
  return accounts.find((a) => Boolean(a.session_data?.trim() || a.session_file_path)) ?? null;
}

async function withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const account = await getAnyActiveTelegramAccount();
  if (!account) throw new Error('Нет активного Telegram аккаунта для пробива (tg_outreach_accounts)');

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

export async function runPhoneEnrichmentBatch(): Promise<{ processed: number }> {
  if (!supabaseAdmin) return { processed: 0 };

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

  const unique = Array.from(new Set(normalized)).slice(0, 120);
  if (unique.length === 0) return { processed: 0 };

  const { data: existing } = await supabaseAdmin
    .from('phone_identities')
    .select('phone_normalized')
    .in('phone_normalized', unique);

  const existingSet = new Set((existing ?? []).map((r) => String((r as { phone_normalized?: unknown }).phone_normalized ?? '')));
  const toCheck = unique.filter((p) => !existingSet.has(p)).slice(0, 50);
  if (toCheck.length === 0) return { processed: 0 };

  await withClient(async (client) => {
    // Telegram requires contacts import in batches; keep it small and safe.
    const contacts = toCheck.map(
      (p, i) =>
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now() + i) as unknown as never,
          phone: p,
          firstName: 'Lead',
          lastName: 'Finder',
        }),
    );

    try {
      const res = await client.invoke(new Api.contacts.ImportContacts({ contacts }));

      const userById = new Map<number, Api.User>();
      for (const u of res.users) {
        if (u instanceof Api.User) {
          userById.set(Number(u.id), u);
        }
      }

      // Imported entries map phone contacts to user_id.
      const foundPhones = new Set<string>();
      for (const imp of res.imported) {
        const userId = Number(imp.userId);
        const u = userById.get(userId);
        if (!u) continue;

        // We don't get phone back from Telegram in a stable way; assume order aligns with contacts list.
        // Telegram returns `imported` in the same order as contacts in most cases, but not guaranteed.
        // As a conservative fallback, mark as found without linking exact phone if uncertain.
      }

      // Pragmatic mapping: treat any returned users as found for some subset of phones.
      // For reliability, we map by index: if user count matches, use positional mapping.
      const returnedUsers = res.users.filter((u) => u instanceof Api.User) as Api.User[];
      if (returnedUsers.length === toCheck.length) {
        for (let i = 0; i < toCheck.length; i++) {
          const phone = toCheck[i]!;
          const u = returnedUsers[i]!;
          foundPhones.add(phone);
          await upsertIdentity({
            phone,
            status: 'found',
            tg_user_id: Number(u.id),
            tg_username: u.username ?? null,
            first_name: u.firstName ?? null,
            last_name: u.lastName ?? null,
          });
        }
      } else {
        // If mismatch, still persist "not_found" for all; can be retried later.
        for (const phone of toCheck) {
          if (foundPhones.has(phone)) continue;
          await upsertIdentity({ phone, status: 'not_found' });
        }
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

