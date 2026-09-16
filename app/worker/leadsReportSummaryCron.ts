/**
 * Пятничный отчёт продаж по пяти каналам.
 *
 * Расписание живёт на прод-сервере в `/etc/cron.d/portal-leads-report`
 * (НЕ в `crontab -l` у root — там его нет и не было):
 *   15 18 * * 5 root docker exec portal-worker-leads-report-bot \
 *     node /app/workers/leadsReportSummaryCron.js \
 *     >> /var/log/portal-leads-report-summary.log 2>&1
 *   18:15 пятница по Москве: в шапке того же файла стоит `TZ=Europe/Moscow`,
 *   поэтому время там всегда московское и от часов сервера не зависит.
 *   Не путать с `EXTERNAL_SYNC_CRON`: тот интерпретируется в UTC, потому что
 *   APScheduler внутри сервиса синка прибит к UTC явно (`timezone="UTC"`).
 *   Отсюда те же 18:05 МСК записаны там как `5 15 * * *`.
 *
 * Три времени идут строго в этом порядке и связаны намертво: окно
 * закрывается в 18:00 (см. `currentMskWeekWindow`), синк AMO бежит в 18:05
 * (`EXTERNAL_SYNC_CRON`) и укладывается в три минуты, отчёт уходит в 18:15.
 * Синк ПОСЛЕ отсечки — это и есть гарантия: всё, что попало в окно, к его
 * старту уже создано и заведомо доедет в базу. Пока синк шёл до отсечки
 * (16:30 против 17:00), сделки, заведённые в получасовой просвет, не попадали
 * ни в тот отчёт, ни в следующий — см. 35041989 от 04.09.2026.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import { computeAllChannelMetrics } from '@/lib/leadsReport/metrics';
import { getAllRecipients } from '@/lib/leadsReport/subscribers';
import { formatSummaryMessages } from '@/lib/leadsReport/summaryFormatter';
import { currentMskWeekWindow } from '@/lib/leadsReport/weekWindow';
import { sendMessage } from '@/lib/tgBot/telegramClient';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

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

    // Два сообщения: основные каналы и дополнительные — см.
    // `formatSummaryMessages`. Получатель считается доставленным, только
    // если ушли ОБА: половина отчёта хуже, чем явный `partial` в логе.
    //
    // В шапку идёт `labelStart` (суббота), а не `start` (вечер пятницы): так
    // подписан ручной отчёт продаж, и совпадение шапок — то, ради чего два
    // отчёта вообще можно класть рядом. Считается при этом по `start` —
    // см. `currentMskWeekWindow`.
    const messages = formatSummaryMessages(
      window.labelStart,
      window.end,
      metrics,
    );
    for (const chatId of recipients) {
      try {
        for (const text of messages) {
          await sendMessage(TOKEN, { chatId, text });
        }
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
    await sendWorkerAlert({
      workerId: WORKER_ID,
      subject: 'weekly summary failed',
      error,
      context: {
        week_start: window.start.toISOString(),
        week_end: window.end.toISOString(),
      },
    });
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

main().catch(async (error) => {
  console.error('[leadsReportSummaryCron] fatal', error);
  await sendWorkerAlert({
    workerId: WORKER_ID,
    subject: 'fatal (main crashed)',
    error,
  });
  process.exit(1);
});
