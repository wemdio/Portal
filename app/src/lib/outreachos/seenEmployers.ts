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
  /**
   * Числовой id работодателя HH. NULL = компания 2GIS top-up (у карточки 2GIS
   * нет hh id; её дедуп-ось — domain). Миграция 20260811_0001 заменила PRIMARY
   * KEY на UNIQUE-индекс, чтобы NULL был допустим.
   */
  hh_employer_id: string | null;
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

/**
 * Только домены seen-окна (без hh_employer_id) — лёгкий вариант loadRecentlySeen
 * для кросс-пайплайнного дедупа: gisSignalOutreach (§4.2 дизайн-дока top-up'а)
 * отсекает карточки, чей домен OutreachOS уже контактировал за окно.
 * Та же семантика окна (last_status_at >= now − withinDays), тот же fail-open
 * (сбой БД → пустой Set, как у loadRecentlySeen).
 */
export async function loadRecentlySeenDomains(withinDays = RECONTACT_AFTER_DAYS): Promise<Set<string>> {
  const domains = new Set<string>();
  if (!supabaseAdmin) return domains;
  const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('outreachos_seen_employers')
    .select('domain')
    .gte('last_status_at', cutoff);
  if (error || !data) return domains;
  for (const r of data as { domain: string | null }[]) {
    if (r.domain) domains.add(r.domain.toLowerCase());
  }
  return domains;
}

/**
 * Upsert статусов обработанных работодателей чанками по 500.
 *
 * На КРИТИЧЕСКОМ пути: pipelineRunner вызывает markSeen ДО append в Instantly,
 * чтобы частичный/упавший append не дал пере-залить компанию в окне 45 дней.
 * Поэтому ретраим транзиентные сбои БД (таймаут/деадлок/обрыв) — случайный блип
 * не должен отменять весь дневной добор. Если все ретраи упали — кидаем (тогда
 * append не выполнится → компании ретраятся, в Instantly чисто).
 *
 * ДВА потока строк (миграция 20260811_0001):
 *  - HH-строки (hh_employer_id задан): upsert onConflict=hh_employer_id — как
 *    раньше, семантика не изменилась.
 *  - GIS-строки top-up (hh_employer_id = NULL): upsert по hh_employer_id для
 *    них бессмыслен (NULL в unique-индексе не конфликтует → копились бы дубли
 *    домена при каждом ре-контакте спустя окно). Вместо этого delete+insert
 *    ПО ДОМЕНУ: одна строка на домен, last_status_at честно обновляется.
 */
export async function markSeen(rows: SeenEmployerUpsert[]): Promise<void> {
  if (!supabaseAdmin || rows.length === 0) return;
  const db = supabaseAdmin;
  const now = new Date().toISOString();

  const hhRows = rows.filter((r) => r.hh_employer_id);
  // GIS-строки без домена не пишем вовсе: ни по одной дедуп-оси их не найти.
  // Дедуп по домену внутри батча — последняя запись побеждает (статус свежее).
  const gisByDomain = new Map<string, SeenEmployerUpsert>();
  for (const r of rows) {
    if (r.hh_employer_id || !r.domain) continue;
    gisByDomain.set(r.domain.toLowerCase(), r);
  }
  const gisRows = [...gisByDomain.values()];

  const CHUNK = 500;
  for (let i = 0; i < hhRows.length; i += CHUNK) {
    const slice = hhRows.slice(i, i + CHUNK).map((r) => ({ ...r, last_status_at: now }));
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await db
        .from('outreachos_seen_employers')
        .upsert(slice, { onConflict: 'hh_employer_id' });
      if (!error) { lastErr = null; break; }
      lastErr = error.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    if (lastErr) throw new Error(`markSeen upsert failed after retries: ${lastErr}`);
  }

  for (let i = 0; i < gisRows.length; i += CHUNK) {
    const slice = gisRows.slice(i, i + CHUNK);
    const domains = slice.map((r) => (r.domain as string).toLowerCase());
    const payload = slice.map((r) => ({ ...r, domain: (r.domain as string).toLowerCase(), last_status_at: now }));
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error: delErr } = await db
        .from('outreachos_seen_employers')
        .delete()
        .is('hh_employer_id', null)
        .in('domain', domains);
      if (delErr) {
        lastErr = delErr.message;
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      const { error: insErr } = await db.from('outreachos_seen_employers').insert(payload);
      if (!insErr) { lastErr = null; break; }
      lastErr = insErr.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    if (lastErr) throw new Error(`markSeen gis delete+insert failed after retries: ${lastErr}`);
  }
}
