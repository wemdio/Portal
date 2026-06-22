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

/** Множество уже виденных hh_employer_id — для отсева в текущем прогоне. */
export async function loadSeenEmployerIds(): Promise<Set<string>> {
  if (!supabaseAdmin) return new Set();
  const { data, error } = await supabaseAdmin
    .from('outreachos_seen_employers')
    .select('hh_employer_id');
  if (error || !data) return new Set();
  return new Set(data.map((r) => (r as { hh_employer_id: string }).hh_employer_id));
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
