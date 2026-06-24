/**
 * Дедуп-журнал OutreachOS (outreachos_seen_employers).
 *
 * Свой, изолированный от client_auto_pipeline_seen_employers (там Mailganer-
 * формы колонок endpoint_score/spf/raw и status routed/stored). Здесь только
 * факт «этого работодателя уже обрабатывали» + финальный статус.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type SeenStatus = 'appended' | 'skipped' | 'failed' | 'no_email';

export interface SeenEmployerUpsert {
  hh_employer_id: string;
  hh_employer_name: string | null;
  domain: string | null;
  site_url: string | null;
  status: SeenStatus;
}

/**
 * Окно «не контактировать одну компанию чаще, чем раз в N дней». 45 = 1.5 месяца.
 * Повторный аутрич РАЗРЕШЁН — просто не чаще окна (компания старше окна снова
 * eligible). Меняется одной строкой. Можно вынести в конфиг, если понадобится.
 */
export const RECONTACT_AFTER_DAYS = 45;

export interface RecentlySeen {
  ids: Set<string>;
  domains: Set<string>;
}

/**
 * Кого контактировали за последние RECONTACT_AFTER_DAYS дней (по last_status_at).
 * Эти компании в текущем прогоне пропускаем. Дедуп по ДВУМ осям: hh_employer_id
 * И домен сайта — вторая ось ловит компанию, пере-зарегавшуюся на HH с новым id.
 * Компании с последним контактом старше окна в выборку НЕ попадают → снова eligible.
 */
export async function loadRecentlySeen(withinDays = RECONTACT_AFTER_DAYS): Promise<RecentlySeen> {
  const empty: RecentlySeen = { ids: new Set(), domains: new Set() };
  if (!supabaseAdmin) return empty;
  const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('outreachos_seen_employers')
    .select('hh_employer_id, domain')
    .gte('last_status_at', cutoff);
  if (error || !data) return empty;
  const ids = new Set<string>();
  const domains = new Set<string>();
  for (const r of data as { hh_employer_id: string | null; domain: string | null }[]) {
    if (r.hh_employer_id) ids.add(r.hh_employer_id);
    if (r.domain) domains.add(r.domain.toLowerCase());
  }
  return { ids, domains };
}

/** Upsert статусов обработанных работодателей чанками по 500. */
export async function markSeen(rows: SeenEmployerUpsert[]): Promise<void> {
  if (!supabaseAdmin || rows.length === 0) return;
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, last_status_at: now }));
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from('outreachos_seen_employers')
      .upsert(slice, { onConflict: 'hh_employer_id' });
    if (error) throw new Error(`markSeen upsert failed: ${error.message}`);
  }
}
