/**
 * Пятничный отчёт продаж по пяти каналам.
 *
 * Host crontab:
 *   0 14 * * 5 docker exec portal-worker-leads-report-bot \
 *     node /app/workers/leadsReportSummaryCron.js
 *   14:00 UTC = 17:00 МСК пятница.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import { computeAllChannelMetrics } from '@/lib/leadsReport/metrics';
import { getAllRecipients } from '@/lib/leadsReport/subscribers';
import { formatSummary } from '@/lib/leadsReport/summaryFormatter';
import { currentMskWeekWindow } from '@/lib/leadsReport/weekWindow';
import { sendMessage } from '@/lib/tgBot/telegramClient';

const WORKER_ID = 'leads-report-summary-cron';
const TOKEN = process.env.LEADS_REPORT_TG_BOT_TOKEN ?? '';

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  if (!TOKEN) {
    log('error', 'LEADS_REPORT_TG_BOT_TOKEN is not set');
    process.exit(1);
  }

  const db = requireSupabaseAdmin(log);
  const startedAt = new Date().toISOString();
  const window = currentMskWeekWindow(new Date());
  let status: 'success' | 'partial' | 'error' = 'success';
  let errorMessage: string | null = null;
  let recipientsSent = 0;
  let recipientsFailed = 0;

  try {
    const metrics = await computeAllChannelMetrics(
      db,
      SUMMARY_CHANNELS,
      window.start,
      window.end,
    );
    const recipients = await getAllRecipients(db);
    if (recipients.length === 0) {
      throw new Error('No Telegram report recipients configured');
    }

    const text = formatSummary(window.start, window.end, metrics);
    for (const chatId of recipients) {
      try {
        await sendMessage(TOKEN, { chatId, text });
        recipientsSent += 1;
      } catch (error) {
        recipientsFailed += 1;
        log('error', 'send failed', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (recipientsFailed > 0) status = 'partial';
  } catch (error) {
    status = 'error';
    errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'summary failed', errorMessage);
  }

  const { error: logError } = await db.from('external_sync_runs').insert({
    source: 'leads_report_summary',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    records_upserted: recipientsSent,
    error: errorMessage,
    meta: {
      week_start: window.start.toISOString(),
      week_end: window.end.toISOString(),
      recipients_sent: recipientsSent,
      recipients_failed: recipientsFailed,
    },
  });
  if (logError) throw logError;

  log('info', 'done', {
    status,
    recipientsSent,
    recipientsFailed,
  });
  if (status === 'error') process.exitCode = 1;
}

main().catch((error) => {
  console.error('[leadsReportSummaryCron] fatal', error);
  process.exit(1);
});
