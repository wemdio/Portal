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

const CHUNK = 500;

/**
 * Бюджет длины списка доменов в query-string одного DELETE'а (символов).
 *
 * GIS-ветка удаляет строки фильтром `domain=in.(…)`, а он у PostgREST целиком
 * лежит в URL. nginx перед Kong режет строку запроса >8 КБ → 414 «URI too long».
 * Тот же класс бага уже ловил соседний журнал — gisSignalOutreach/seenCompanies.ts
 * (там SELECT_CHUNK=100 на 16-значные twogis_id, ~2 КБ).
 *
 * Здесь чанк считается по ДЛИНЕ, а не по числу строк: домены переменной длины,
 * а punycode/UTF-8 после процентного кодирования раздувается втрое — фиксированный
 * счётчик строк гарантий не даёт. 1800 символов ≈ 2 КБ: тот же порядок, что у
 * соседа, с запасом на базовый URL и остальные фильтры.
 *
 * Инцидент 13.08.2026: 483 домена ушли одним чанком (CHUNK=500) → ~10 КБ URL →
 * 414. Прогон упал ПОСЛЕ upsert'а HH-строк и ДО append: 261 компания сожжена в
 * seen-окне 45 дней без единого письма, 193 готовых лида не залиты. До 12.08
 * баг не проявлялся — топ-ап добирал десятки доменов, а не сотни.
 */
export const DELETE_URL_BUDGET = 1800;

/**
 * Режет список доменов на под-чанки, каждый из которых уложится в бюджет URL.
 * Домен длиннее всего бюджета уезжает в собственный чанк (пустых чанков не
 * бывает — иначе delete молча потерял бы строки).
 */
export function chunkDomainsByUrlBudget(domains: string[], budget = DELETE_URL_BUDGET): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const domain of domains) {
    // +3 = кавычки вокруг значения и запятая-разделитель внутри in.(…)
    const cost = encodeURIComponent(domain).length + 3;
    if (current.length > 0 && length + cost > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(domain);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
    // delete идёт под-чанками по бюджету URL (см. DELETE_URL_BUDGET), insert —
    // одним запросом: у него строки в теле POST'а, лимита длины URL там нет.
    const domainChunks = chunkDomainsByUrlBudget(domains);
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // delete идемпотентен → повтор всей серии под-чанков после сбоя безопасен.
      let delErrMessage: string | null = null;
      for (const domainChunk of domainChunks) {
        const { error: delErr } = await db
          .from('outreachos_seen_employers')
          .delete()
          .is('hh_employer_id', null)
          .in('domain', domainChunk);
        if (delErr) {
          delErrMessage = delErr.message;
          break;
        }
      }
      if (delErrMessage) {
        lastErr = delErrMessage;
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
