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
  const since = new Date(Date.now() - ACTIVE_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

  // Условия:
  // - активная сделка (status_id NOT IN 142, 143)
  // - обновлялась за последние ACTIVE_LOOKBACK_DAYS
  // - есть хотя бы один якорь (contact_tg_username OR company_website OR contact_phone)
  // Сортировка — свежие изменения раньше.
  const { data, error } = await db
    .from('amo_leads')
    .select('id, updated_at, status_name, responsible_name, contact_tg_username, company_website, contact_phone, status_id')
    .gte('updated_at', since)
    .not('status_id', 'in', `(${AMO_WON_STATUS},${AMO_LOST_STATUS})`)
    .order('updated_at', { ascending: false })
    .limit(DAILY_CAP * 4); // с запасом, дальше отсеем без якоря

  if (error) throw new Error(`pickDealsForAnalysis: ${error.message}`);
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
