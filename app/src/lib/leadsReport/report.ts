import type { SupabaseClient } from '@supabase/supabase-js';
import { appendRows, readColumn } from '@/lib/googleSheets/writer';
import type { LeadsReportConfig } from '@/lib/leadsReport/config';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';
import { buildRow, type AmoLead } from '@/lib/leadsReport/rowBuilder';

export type ReportRunResult = {
  fetchedFromDb: number;
  matchedFilter: number;
  skippedDedup: number;
  appended: number;
};

/** Определяет колонку служебного `amo_id` (последняя колонка в конфиге). */
function amoIdColumnLetter(config: LeadsReportConfig): string {
  const index = config.columns.length - 1;
  if (index < 0 || index >= 26) {
    throw new Error(
      `Unsupported AMO id column index ${index} for config ${config.name}`,
    );
  }
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Проверяет соответствие сделки фильтру конфига по указанному кастомному полю AMO. */
function matchesFilter(lead: AmoLead, config: LeadsReportConfig): boolean {
  const value = extractCustomField(lead.raw, config.amoFieldFilter.fieldName) ?? '';
  const filter = config.amoFieldFilter.match;
  if ('equals' in filter) return value === filter.equals;
  return value !== filter.notEquals;
}

/**
 * Читает колонку `dateColumnLetter` в шите (значения возвращаются как
 * FORMATTED_VALUE — Google Sheets отдаёт то, что видит пользователь) и
 * ищет максимальную дату в формате DD.MM.YYYY — единственном формате,
 * в котором скрипт сам пишет даты (см. `formatMskDate` в rowBuilder).
 * Всё что не парсится (заголовки, пустые ячейки, ручные заметки типа
 * «отдал ЛПР») пропускаем — max-дата всё равно определяется по нашим
 * же записям либо по ручным датам менеджеров, если те использовали
 * тот же формат.
 *
 * Возвращает null, если ни одной валидной DD.MM.YYYY-даты нет — тогда
 * вызывающий код должен упасть на sinceDays-fallback.
 */
function parseMaxDddMmYyyy(values: string[], nowMs: number = Date.now()): Date | null {
  let max: Date | null = null;
  for (const raw of values) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (!m) continue;
    const day = Number(m[1]);
    const mon = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(Date.UTC(year, mon - 1, day));
    if (!Number.isFinite(d.getTime())) continue;
    // Игнорируем даты из будущего — менеджеры иногда ставят дату
    // «передачи лида» на день-два вперёд как plan. Такой max сдвинул бы
    // окно в будущее, а в БД сделок с created_at из будущего нет →
    // fetchedFromDb=0. Клампим границу окна на «сейчас».
    if (d.getTime() > nowMs) continue;
    if (!max || d.getTime() > max.getTime()) max = d;
  }
  return max;
}

/**
 * Выполнить один прогон отчёта: читает свежие лиды из БД, фильтрует,
 * дедуплицирует по amo_id уже присутствующим в Sheet и дописывает новые.
 */
export async function runReport(
  db: SupabaseClient,
  config: LeadsReportConfig,
  opts: { sinceDays: number; amoHost: string },
): Promise<ReportRunResult> {
  if (!config.spreadsheetId) {
    throw new Error(`spreadsheetId is empty for config ${config.name}`);
  }
  if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) {
    throw new Error(`sinceDays must be positive for config ${config.name}`);
  }

  // Инкрементальное окно: тянем из БД только сделки, которые созданы не
  // раньше max-даты в шите. Это позволяет переключиться на боевую таблицу
  // без разовых дубликатов существующих ручных строк (у которых amo_id
  // в служебной колонке пустой, поэтому classic amo_id-дедуп их не видит).
  // Если шит совсем пустой (первый запуск на новом листе) — fallback на
  // `sinceDays` от «сейчас».
  const dateValues = await readColumn(
    config.spreadsheetId,
    config.sheetName,
    config.dateColumnLetter,
  );
  const sheetMaxDate = parseMaxDddMmYyyy(dateValues);
  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() - opts.sinceDays);
  const since = sheetMaxDate ?? fallback;

  const { data, error } = await db
    .from('amo_leads')
    .select(
      'amo_id, name, status_name, contact_phone, contact_email, company_name, company_website, responsible_name, created_at, raw',
    )
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;
  const leads = (data ?? []) as AmoLead[];
  const matching = leads.filter((lead) => matchesFilter(lead, config));

  const existing = new Set(
    (
      await readColumn(
        config.spreadsheetId,
        config.sheetName,
        amoIdColumnLetter(config),
      )
    )
      .map((value) => value.trim())
      .filter((value) => value && value.toLocaleLowerCase('ru-RU') !== 'amo id'),
  );

  const fresh = matching.filter(
    (lead) => !existing.has(String(lead.amo_id)),
  );
  const rows = fresh.map((lead) => buildRow(lead, config, opts.amoHost));
  await appendRows(config.spreadsheetId, config.sheetName, rows);

  return {
    fetchedFromDb: leads.length,
    matchedFilter: matching.length,
    skippedDedup: matching.length - fresh.length,
    appended: rows.length,
  };
}
