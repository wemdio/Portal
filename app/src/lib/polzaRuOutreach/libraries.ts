/**
 * Версионируемые библиотеки: утверждения оффера, кейсы, подписи.
 *
 * Генератор не хранит коммерческих чисел в шаблонах. Он получает только
 * активные записи: утверждённые, с разрешением на публикацию (кейсы) и не
 * истёкшие. Истёкшая или неутверждённая запись равна отсутствию данных —
 * письмо собирается в нейтральном варианте (LAUNCH_INSTRUCTIONS_INDEX).
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SenderProfile {
  id: string;
  sender_name: string;
  sender_title: string | null;
  company_name: string;
  phone: string | null;
  website: string | null;
  telegram: string | null;
}

/**
 * Кейс идёт в письмо, только если лидов в нём от этого числа (решение
 * 24.09.2026): слабый кейс в письме работает против нас. Кейс без числа
 * лидов не идёт тоже.
 */
export const MIN_CASE_LEADS = 8;

export interface CaseRecord {
  case_id: string;
  public_name: string;
  industry_groups: string[];
  allowed_chains: string[];
  case_text_short: string;
}

export interface OfferClaim {
  id: string;
  chain_type: string;
  claim_key: string;
  claim_text: string;
}

export interface Libraries {
  sender: SenderProfile | null;
  cases: CaseRecord[];
  claims: OfferClaim[];
  offerVersion: string;
}

function isActive(expiresAt: unknown, now: number): boolean {
  if (!expiresAt) return true;
  const t = new Date(String(expiresAt)).getTime();
  return Number.isFinite(t) && t > now;
}

export async function loadLibraries(db: SupabaseClient, senderId: string | null): Promise<Libraries> {
  const now = Date.now();

  const sendersQuery = db.from('polza_ru_senders').select('*').eq('status', 'active');
  const { data: senders, error: sendersErr } = await sendersQuery;
  if (sendersErr) throw new Error(`senders load failed: ${sendersErr.message}`);
  const sender =
    (senders ?? []).find((s) => senderId && s.id === senderId) ??
    (senders ?? []).find((s) => s.is_default) ??
    (senders ?? [])[0] ??
    null;

  const { data: cases, error: casesErr } = await db
    .from('polza_ru_cases')
    .select('*')
    .eq('status', 'approved')
    .eq('legal_publication_approved', true)
    .gte('leads_count', MIN_CASE_LEADS);
  if (casesErr) throw new Error(`cases load failed: ${casesErr.message}`);

  const { data: claims, error: claimsErr } = await db
    .from('polza_ru_offer_claims')
    .select('*')
    .eq('status', 'approved');
  if (claimsErr) throw new Error(`offer claims load failed: ${claimsErr.message}`);

  const activeClaims = (claims ?? []).filter((c) => isActive(c.expires_at, now));
  const versionSeed = activeClaims
    .map((c) => `${c.id}:${c.updated_at}`)
    .sort()
    .join('|');

  return {
    sender: sender
      ? {
          id: String(sender.id),
          sender_name: String(sender.sender_name),
          sender_title: sender.sender_title ?? null,
          company_name: String(sender.company_name ?? 'Polza Agency'),
          phone: sender.phone ?? null,
          website: sender.website ?? null,
          telegram: sender.telegram ?? null,
        }
      : null,
    cases: (cases ?? [])
      .filter((c) => isActive(c.expires_at, now))
      .map((c) => ({
        case_id: String(c.case_id),
        public_name: String(c.public_name),
        industry_groups: (c.industry_groups ?? []) as string[],
        allowed_chains: (c.allowed_chains ?? []) as string[],
        case_text_short: String(c.case_text_short),
      })),
    claims: activeClaims.map((c) => ({
      id: String(c.id),
      chain_type: String(c.chain_type),
      claim_key: String(c.claim_key),
      claim_text: String(c.claim_text),
    })),
    offerVersion: activeClaims.length
      ? `offer-${createHash('sha256').update(versionSeed).digest('hex').slice(0, 10)}`
      : 'neutral',
  };
}

/** Утверждённые формулировки для цепочки: её собственные и общие («all»). */
export function claimsForChain(claims: OfferClaim[], chain: string): OfferClaim[] {
  return claims.filter((c) => c.chain_type === 'all' || c.chain_type === chain);
}

/** Подпись целиком из профиля отправителя: имя, должность, телефон, сайт, Telegram. */
export function formatSignature(sender: SenderProfile): string {
  return [sender.sender_name, sender.sender_title, sender.company_name, sender.phone, sender.website, sender.telegram]
    .filter((line): line is string => Boolean(line && line.trim()))
    .join('\n');
}

/** Имя для самопредставления в письмах 2–3 («Егор, Polza Agency»). */
export function senderFirstName(sender: SenderProfile): string {
  return sender.sender_name.trim().split(/\s+/)[0] ?? sender.sender_name;
}
