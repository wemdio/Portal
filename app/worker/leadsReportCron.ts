/**
 * Ежедневный one-shot запуск: дописывает новые сделки AMO в маркетинговую
 * и outreach Google-таблицы. Расписание задаётся на prod-хосте после деплоя.
 *
 * Host crontab: 10 14 * * * (14:10 UTC = 17:10 МСК), после AMO-синка в 16:45 МСК.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { ALL_CONFIGS } from '@/lib/leadsReport/config';
import { runReport } from '@/lib/leadsReport/report';

const WORKER_ID = 'leads-report-cron';
const parsedSinceDays = Number(process.env.LEADS_REPORT_SINCE_DAYS);
const SINCE_DAYS =
  Number.isFinite(parsedSinceDays) && parsedSinceDays > 0
    ? parsedSinceDays
    : 30;
const AMO_HOST =
  process.env.AMO_BASE_URL_HOST ?? 'polzaagency.amocrm.ru';

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const db = requireSupabaseAdmin(log);
  log('info', 'starting', { since_days: SINCE_DAYS, amo_host: AMO_HOST });

  for (const config of ALL_CONFIGS) {
    const startedAt = new Date().toISOString();
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | null = null;
    let result: Awaited<ReturnType<typeof runReport>> | null = null;

    try {
      result = await runReport(db, config, {
        sinceDays: SINCE_DAYS,
        amoHost: AMO_HOST,
      });
      log('info', 'report done', { config: config.name, ...result });
    } catch (error) {
      status = 'error';
      errorMessage =
        error instanceof Error ? error.message : String(error);
      log('error', 'report failed', {
        config: config.name,
        error: errorMessage,
      });
    }

    const { error: insertError } = await db.from('external_sync_runs').insert({
      source: config.syncSource,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      records_upserted: result?.appended ?? 0,
      error: errorMessage,
      meta: result
        ? {
            fetched_from_db: result.fetchedFromDb,
            matched_filter: result.matchedFilter,
            skipped_dedup: result.skippedDedup,
            spreadsheet_id: config.spreadsheetId,
          }
        : { spreadsheet_id: config.spreadsheetId },
    });

    if (insertError) {
      log('error', 'external_sync_runs insert failed', {
        config: config.name,
        message: insertError.message,
      });
    }
  }

  log('info', 'done');
}

main().catch((error) => {
  console.error('[leadsReportCron] fatal', error);
  process.exit(1);
});
