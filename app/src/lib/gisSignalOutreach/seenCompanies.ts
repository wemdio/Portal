/**
 * Дедуп-журнал gisSignalOutreach (gis_signal_seen_companies).
 *
 * Ключ — twogis_id карточки 2GIS. Компания попадает сюда ТОЛЬКО после
 * успешного append хотя бы одного её контакта в Instantly (at-least-once:
 * пока append не случился, компания остаётся eligible на следующих прогонах).
 * Окна ре-контакта нет: 2GIS-карточка, однажды залитая, больше не трогается.
 *
 * Паттерн повторяет lib/outreachos/seenEmployers.ts.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface SeenCompanyRow {
  twogis_id: string;
  domain: string | null;
  company_name: string | null;
  segment_key: string;
}

const CHUNK = 500;
/**
 * SELECT с .in() кладёт все id в query-string: 2GIS id по 16-17 цифр → чанк 500
 * это ~9-10 КБ URL, а nginx перед Kong режет заголовки >8K (414). Поэтому
 * lookup-чанк 100 (~2 КБ). 06.08.2026: первый прод-прогон отсёк все 21122
 * кандидата именно так — fail-closed без лога скрыл 414.
 */
const SELECT_CHUNK = 100;

/**
 * Из переданных twogis_id возвращает те, которых НЕТ в журнале (unseen-подмножество
 * входа). Батчевый lookup: `in` чанками по SELECT_CHUNK, чтобы не упираться в лимит
 * URL PostgREST на больших выборках. Сбой БД → пустой Set (fail-closed: ничего не
 * тянем, прогон ретраится завтра — лучше пропустить день, чем пере-залить).
 */
export async function filterUnseenIds(ids: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Set();
  if (!supabaseAdmin) return new Set(); // fail-closed, см. шапку

  const seen = new Set<string>();
  for (let i = 0; i < unique.length; i += SELECT_CHUNK) {
    const slice = unique.slice(i, i + SELECT_CHUNK);
    const { data, error } = await supabaseAdmin
      .from('gis_signal_seen_companies')
      .select('twogis_id')
      .in('twogis_id', slice);
    if (error) {
      console.warn(
        `[gis-signal][seen] lookup failed (chunk ${i / SELECT_CHUNK + 1}, ${slice.length} ids): ${error.message} — fail-closed, весь батч отсеян`,
      );
      return new Set(); // fail-closed, см. шапку
    }
    for (const r of (data ?? []) as { twogis_id: string }[]) {
      if (r.twogis_id) seen.add(r.twogis_id);
    }
  }
  return new Set(unique.filter((id) => !seen.has(id)));
}

/**
 * Upsert обработанных компаний чанками по 500, ignore-duplicates по twogis_id
 * (повторный прогон/гонка сегментов не должны перетирать first_seen_at).
 * Вызывается ТОЛЬКО после успешного append — см. pipelineRunner (at-least-once).
 */
export async function markSeen(rows: SeenCompanyRow[]): Promise<void> {
  if (!supabaseAdmin || rows.length === 0) return;
  const db = supabaseAdmin;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await db
        .from('gis_signal_seen_companies')
        .upsert(slice, { onConflict: 'twogis_id', ignoreDuplicates: true });
      if (!error) { lastErr = null; break; }
      lastErr = error.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    if (lastErr) throw new Error(`markSeen upsert failed after retries: ${lastErr}`);
  }
}
