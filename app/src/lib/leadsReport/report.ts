import type { SupabaseClient } from '@supabase/supabase-js';
import { appendRows, readColumn } from '@/lib/googleSheets/writer';
import type { LeadsReportConfig } from '@/lib/leadsReport/config';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';
import { buildRow, type AmoLead } from '@/lib/leadsReport/rowBuilder';

const SOURCE_FIELD_NAME = 'Источник';

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

/** Проверяет соответствие сделки фильтру конфига по custom-полю «Источник». */
function matchesFilter(lead: AmoLead, config: LeadsReportConfig): boolean {
  const source = extractCustomField(lead.raw, SOURCE_FIELD_NAME) ?? '';
  const filter = config.amoSourceFilter;
  if ('equals' in filter) return source === filter.equals;
  return source !== filter.notEquals;
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

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - opts.sinceDays);

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
