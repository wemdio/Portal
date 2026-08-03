/**
 * Ежедневный автозаполнитель листа «Отчетность продаж Polza Agency».
 *
 * MVP: заполняем ФАКТ-ячейки блока «ИТОГО ПО ОТДЕЛУ» × колонка «МЕСЯЦ»
 *      и × все 5 недельных колонок. Недельные и месячные границы читаются
 *      из самого листа (первая строка), поэтому скрипт работает для
 *      произвольного месяца.
 *
 * Host crontab: 10 14 * * * (14:10 UTC = 17:10 МСК), после AMO-синка в 16:45 МСК.
 * Env:
 *   SALES_REPORT_SPREADSHEET_ID  — ID таблицы «Отчетность продаж Polza Agency».
 *   LEADS_REPORT_PIPELINE_NAME   — как для остальных отчётов (default «Воронка - новые лиды»).
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { computeSalesReportBlock } from '@/lib/salesReport/metrics';
import {
  loadSheetSchema,
  monthlySheetName,
  type SalesReportMetricKey,
} from '@/lib/salesReport/sheetSchema';
import { ensureMonthlySheet } from '@/lib/salesReport/sheetProvisioner';
import { writeFactCells, type CellUpdate } from '@/lib/salesReport/writer';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

const WORKER_ID = 'sales-report-cron';
const TEMPLATE_SHEET_NAME =
  process.env.SALES_REPORT_TEMPLATE_SHEET_NAME ?? 'ШАБЛОН';

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const spreadsheetId = process.env.SALES_REPORT_SPREADSHEET_ID ?? '';
  if (!spreadsheetId) {
    log('error', 'SALES_REPORT_SPREADSHEET_ID is not set');
    process.exit(1);
  }

  const db = requireSupabaseAdmin(log);
  const now = new Date();
  const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const sheetName = monthlySheetName(now);
  log('info', 'starting', { sheet: sheetName });

  try {
    const provision = await ensureMonthlySheet(
      spreadsheetId,
      sheetName,
      mskNow.getUTCFullYear(),
      mskNow.getUTCMonth(),
      TEMPLATE_SHEET_NAME,
    );
    if (provision.created) {
      log('info', 'monthly sheet CREATED from template', {
        sheet: sheetName,
        template: TEMPLATE_SHEET_NAME,
        dates_written: provision.datesWritten ?? 0,
      });
    }
  } catch (e) {
    log('error', 'cannot ensure monthly sheet', {
      sheet: sheetName,
      error: e instanceof Error ? e.message : String(e),
    });
    await sendWorkerAlert({
      workerId: WORKER_ID,
      subject: `нет листа «${sheetName}», автосоздание не удалось`,
      error: e,
      context: {
        spreadsheet_id: spreadsheetId,
        template: TEMPLATE_SHEET_NAME,
        action: `Добавьте вручную лист «${sheetName}» (копия «${TEMPLATE_SHEET_NAME}»)`,
      },
    });
    process.exit(2);
    return;
  }

  let schema;
  try {
    schema = await loadSheetSchema(spreadsheetId, sheetName);
  } catch (e) {
    log('error', 'cannot load sheet schema after ensuring the tab exists', {
      sheet: sheetName,
      error: e instanceof Error ? e.message : String(e),
    });
    await sendWorkerAlert({
      workerId: WORKER_ID,
      subject: `не могу прочитать структуру листа «${sheetName}»`,
      error: e,
      context: { spreadsheet_id: spreadsheetId },
    });
    process.exit(3);
    return;
  }

  const updates: CellUpdate[] = [];

  for (const factCol of schema.factColumns) {
    const block = await computeSalesReportBlock(db, factCol.start, factCol.end);
    log('info', 'block computed', {
      col: factCol.label,
      column_index: factCol.factColumnIndex,
      start: factCol.start.toISOString(),
      end: factCol.end.toISOString(),
      block,
    });

    for (const metricRow of schema.totalsBlock) {
      const value = block[metricRow.key as SalesReportMetricKey];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      updates.push({
        row: metricRow.row,
        columnIndex: factCol.factColumnIndex,
        value,
      });
    }
  }

  if (updates.length === 0) {
    log('info', 'nothing to write (empty updates)');
    return;
  }

  await writeFactCells(spreadsheetId, sheetName, updates);
  log('info', 'done', { cells_written: updates.length });
}

main().catch(async (err) => {
  console.error('[worker][sales-report-cron][FATAL]', err);
  await sendWorkerAlert({
    workerId: WORKER_ID,
    subject: 'fatal (main crashed)',
    error: err,
  });
  process.exit(1);
});
