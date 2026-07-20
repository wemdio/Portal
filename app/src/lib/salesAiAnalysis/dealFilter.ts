/**
 * Отбор сделок для Sales AI-анализа.
 *
 * Берём активные сделки (не won/lost), обновлённые за последние N дней,
 * у которых есть хоть один якорь для связки: TG-юзер, сайт или телефон.
 * Иначе анализировать нечего — ни переписки, ни звонков не найдём.
 *
 * Дедуп по input_hash делается уже в pipeline.ts после сбора контекста —
 * здесь только «кандидаты на анализ».
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface DealCandidate {
  amo_lead_id: number;
  updated_at: string;
  status_name: string | null;
  responsible_name: string | null;
}

const ACTIVE_LOOKBACK_DAYS = Number(process.env.SALES_AI_LOOKBACK_DAYS ?? 60);
const DAILY_CAP = Number(process.env.SALES_AI_DAILY_CAP ?? 100);
const AMO_WON_STATUS = 142;
const AMO_LOST_STATUS = 143;

export async function pickDealsForAnalysis(db: SupabaseClient): Promise<DealCandidate[]> {
  // Две выборки: (1) активные по amo_leads.updated_at, (2) сделки с
  // транскриптом свежее последнего анализа (view). Мержим по amo_lead_id,
  // активные приоритетнее (свежие изменения интереснее). Cap применяется
  // к объединённому множеству.
  const [active, staleTranscripts] = await Promise.all([
    pickActiveDeals(db),
    pickDealsWithNewTranscripts(db),
  ]);

  const seen = new Set<number>();
  const merged: DealCandidate[] = [];
  for (const list of [active, staleTranscripts]) {
    for (const c of list) {
      if (seen.has(c.amo_lead_id)) continue;
      seen.add(c.amo_lead_id);
      merged.push(c);
      if (merged.length >= DAILY_CAP) return merged;
    }
  }
  return merged;
}

async function pickActiveDeals(db: SupabaseClient): Promise<DealCandidate[]> {
  const since = new Date(Date.now() - ACTIVE_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

  const { data, error } = await db
    .from('amo_leads')
    .select('id, updated_at, status_name, responsible_name, contact_tg_username, company_website, contact_phone, status_id')
    .gte('updated_at', since)
    .not('status_id', 'in', `(${AMO_WON_STATUS},${AMO_LOST_STATUS})`)
    .order('updated_at', { ascending: false })
    .limit(DAILY_CAP * 4);

  if (error) throw new Error(`pickActiveDeals: ${error.message}`);
  if (!data) return [];

  const withAnchor = data.filter((d: {
    contact_tg_username: string | null;
    company_website: string | null;
    contact_phone: string | null;
  }) => d.contact_tg_username || d.company_website || d.contact_phone);

  return withAnchor.slice(0, DAILY_CAP).map((d: {
    id: number; updated_at: string; status_name: string | null; responsible_name: string | null;
  }) => ({
    amo_lead_id: d.id,
    updated_at: d.updated_at,
    status_name: d.status_name,
    responsible_name: d.responsible_name,
  }));
}

/**
 * Сделки со свежим транскриптом после последнего анализа —
 * читаем из view v_sales_ai_stale_transcripts. Ловит «молчащие» в AMO
 * сделки, по которым менеджер провёл звонок, но карточку не обновил.
 * См. supabase/migrations/20260715_0001_sales_ai_stale_transcripts_view.sql
 */
async function pickDealsWithNewTranscripts(db: SupabaseClient): Promise<DealCandidate[]> {
  const { data, error } = await db
    .from('v_sales_ai_stale_transcripts')
    .select('amo_lead_id, updated_at, status_name, responsible_name')
    .order('latest_transcript_at', { ascending: false })
    .limit(DAILY_CAP);

  if (error) throw new Error(`pickDealsWithNewTranscripts: ${error.message}`);
  if (!data) return [];

  return (data as Array<{
    amo_lead_id: number; updated_at: string;
    status_name: string | null; responsible_name: string | null;
  }>).map((d) => ({
    amo_lead_id: d.amo_lead_id,
    updated_at: d.updated_at,
    status_name: d.status_name,
    responsible_name: d.responsible_name,
  }));
}
