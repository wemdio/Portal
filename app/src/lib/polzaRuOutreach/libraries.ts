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
import type { ProfileCode } from './types';

export interface SenderProfile {
  id: string;
  sender_name: string;
  sender_title: string | null;
  company_name: string;
  phone: string | null;
  website: string | null;
  telegram: string | null;
}

export interface CaseRecord {
  case_id: string;
  public_name: string;
  industry_tags: string[];
  product_tags: string[];
  sales_model_tags: string[];
  allowed_profiles: string[];
  case_text_short: string;
}

export interface OfferClaim {
  id: string;
  profile_code: string;
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

export async function loadLibraries(
  db: SupabaseClient,
  profile: ProfileCode,
  senderId: string | null,
): Promise<Libraries> {
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
    .eq('legal_publication_approved', true);
  if (casesErr) throw new Error(`cases load failed: ${casesErr.message}`);

  const { data: claims, error: claimsErr } = await db
    .from('polza_ru_offer_claims')
    .select('*')
    .eq('status', 'approved')
    .in('profile_code', [profile, 'all']);
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
      .filter((c) => Array.isArray(c.allowed_profiles) && c.allowed_profiles.includes(profile))
      .map((c) => ({
        case_id: String(c.case_id),
        public_name: String(c.public_name),
        industry_tags: (c.industry_tags ?? []) as string[],
        product_tags: (c.product_tags ?? []) as string[],
        sales_model_tags: (c.sales_model_tags ?? []) as string[],
        allowed_profiles: (c.allowed_profiles ?? []) as string[],
        case_text_short: String(c.case_text_short),
      })),
    claims: activeClaims.map((c) => ({
      id: String(c.id),
      profile_code: String(c.profile_code),
      claim_key: String(c.claim_key),
      claim_text: String(c.claim_text),
    })),
    offerVersion: activeClaims.length
      ? `offer-${createHash('sha256').update(versionSeed).digest('hex').slice(0, 10)}`
      : 'neutral',
  };
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

/**
 * Кейс под компанию — детерминированно по пересечению тегов. «Примерно похожий»
 * кейс не берётся: без пересечения тегов письмо 2 идёт без кейса (правила RU, письмо 2).
 */
export function pickCase(cases: CaseRecord[], companyTags: string[]): CaseRecord | null {
  const tags = new Set(companyTags.map((t) => t.toLowerCase().trim()).filter(Boolean));
  if (!tags.size) return null;
  let best: { c: CaseRecord; score: number } | null = null;
  for (const c of cases) {
    const all = [...c.industry_tags, ...c.product_tags, ...c.sales_model_tags].map((t) => t.toLowerCase().trim());
    const score = all.filter((t) => tags.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

/** Все теги активных кейсов — словарь, из которого LLM выбирает теги компании. */
export function caseTagVocabulary(cases: CaseRecord[]): string[] {
  const set = new Set<string>();
  for (const c of cases) {
    for (const t of [...c.industry_tags, ...c.product_tags, ...c.sales_model_tags]) {
      if (t.trim()) set.add(t.toLowerCase().trim());
    }
  }
  return Array.from(set).sort();
}
