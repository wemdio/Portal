/**
 * Outreach worker — фоновые синки, оставшиеся после удаления «Нашего» и
 * «Бугор» аутрича (27.10.2026): сами пайплайны (сбор, SMTP-проверка, письма,
 * загрузка в Instantly) удалены вместе с инструментами, а контейнер остался
 * ради двух задач, которые с ними жили по соседству.
 *
 * Schedules:
 *  - Project contacts sync: 07:00 UTC (10:00 MSK) — PROJECT_CONTACTS_SYNC_HOUR_UTC.
 *                   Pulls SUM(new_leads_contacted_count) from instantly_campaign_catalog
 *                   per linked project (project_instantly_campaigns) and writes
 *                   projects.contacts_done. См. lib/projectContactsSync.ts.
 *  - Instantly campaign analytics: раз в час (WORKER_ANALYTICS_SYNC_INTERVAL_MS).
 */

import { syncInstantlyCampaignAnalytics } from '@/lib/tools/instantlyCampaignCatalog';
import { syncProjectContactsFromInstantly } from '@/lib/projectContactsSync';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const PROJECT_CONTACTS_SYNC_HOUR_UTC = Number(process.env.PROJECT_CONTACTS_SYNC_HOUR_UTC ?? '7');
const WORKER_ID = `outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

function getNextRunMs(hourUtc: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

let _shuttingDown = false;

/**
 * Catch-up для project-contacts sync: смотрим MAX(contacts_done_synced_at) в `projects`.
 * Если сегодняшний 07:00 UTC уже прошёл, а синхронизации после него не было —
 * запускаем сразу. Без этого рестарт контейнера после 07:00 UTC пропустит день.
 */
async function wasTodaysProjectContactsSyncMissed(): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  if (!db) return false;
  const now = new Date();
  const todayScheduled = new Date(now);
  todayScheduled.setUTCHours(PROJECT_CONTACTS_SYNC_HOUR_UTC, 0, 0, 0);
  if (now.getTime() < todayScheduled.getTime()) return false;
  const { data, error } = await db
    .from('projects')
    .select('contacts_done_synced_at')
    .gte('contacts_done_synced_at', todayScheduled.toISOString())
    .limit(1);
  if (error) {
    log('warn', `project-contacts-sync catch-up check failed: ${error.message}`);
    return false;
  }
  return !data || data.length === 0;
}

async function runProjectContactsSync(): Promise<void> {
  const mainDb = requireSupabaseAdmin(log);
  if (!mainDb) return;
  if (!supabaseInstantly) {
    log('warn', 'project-contacts-sync skipped: INSTANTLY_SUPABASE_URL is not set');
    return;
  }
  log('info', 'project-contacts-sync starting...');
  try {
    const result = await syncProjectContactsFromInstantly({
      mainDb,
      instantlyDb: supabaseInstantly,
      now: new Date(),
      log: (level, msg, extra) => log(level, `[project-contacts-sync] ${msg}`, extra),
    });
    log(
      'info',
      `project-contacts-sync done: updated ${result.projectsUpdated}/${result.projectsWithLinks} projects, ` +
        `campaigns resolved ${result.campaignsResolved}, ` +
        `missing projects ${result.projectsMissing.length}, missing campaigns ${result.campaignsMissing.length}`,
    );
  } catch (err) {
    log('error', 'project-contacts-sync failed', err);
  }
}

async function projectContactsSyncScheduler(): Promise<void> {
  if (await wasTodaysProjectContactsSyncMissed()) {
    log(
      'info',
      `project-contacts-sync: catch-up — today's ${PROJECT_CONTACTS_SYNC_HOUR_UTC}:00 UTC run was missed, running now`,
    );
    try {
      await runProjectContactsSync();
    } catch (err) {
      log('error', 'project-contacts-sync catch-up failed', err);
    }
  }
  while (!_shuttingDown) {
    const waitMs = getNextRunMs(PROJECT_CONTACTS_SYNC_HOUR_UTC);
    const nextRun = new Date(Date.now() + waitMs).toISOString();
    log('info', `project-contacts-sync: next run at ${nextRun} (in ${Math.round(waitMs / 60_000)} min)`);
    await sleep(waitMs);
    if (_shuttingDown) break;
    await runProjectContactsSync();
  }
}

const ANALYTICS_SYNC_INTERVAL_MS = Number(
  process.env.WORKER_ANALYTICS_SYNC_INTERVAL_MS ?? String(60 * 60 * 1000),
);

/**
 * Periodic Instantly -> DB campaign-analytics sync (multi-account).
 * Re-homed here from worker/index.ts: the worker-split architecture no longer
 * runs the WORKER_KIND=all path that owned index.ts's periodicSyncLoop, so the
 * hourly analytics sync had stopped running in prod entirely (the Campaigns
 * page showed zeros for every account). Uses getCampaignAnalytics (NOT the
 * /emails API), so it is safe to run next to the instantly-leads worker.
 * Runs once on startup, then every ANALYTICS_SYNC_INTERVAL_MS.
 */
async function analyticsSyncScheduler(): Promise<void> {
  while (!_shuttingDown) {
    try {
      log('info', 'analytics-sync: syncing Instantly campaign analytics to DB...');
      const { rows } = await syncInstantlyCampaignAnalytics();
      log('info', `analytics-sync: done, ${rows} campaign(s) updated`);
      // actual_reply_count (/emails-пересчёт) ОТКЛЮЧЁН: клиентские «Ответы» теперь
      // считаются как список Instantly (reply_count_unique + reply_count_automatic_unique
      // из /campaigns/analytics), эту колонку больше никто не читает. Не жжём
      // rate-limited /emails впустую (CLAUDE.md, инцидент 22 мая). syncActualReplyCounts
      // оставлена в коде — вернуть вызов, если снова понадобятся «точные живые ответы».
    } catch (err) {
      log('warn', 'analytics-sync: failed', err);
    }
    await sleep(ANALYTICS_SYNC_INTERVAL_MS);
    if (_shuttingDown) break;
  }
}

async function main(): Promise<void> {
  log('info', `Starting Outreach worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const wrappedShouldStop = () => {
    const v = shouldStop();
    _shuttingDown = v;
    return v;
  };

  void projectContactsSyncScheduler();
  void analyticsSyncScheduler();

  // Очереди задач у воркера больше нет: цикл опроса только держит процесс
  // живым и ловит сигнал остановки, синки крутятся своими таймерами.
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop: wrappedShouldStop,
    pollOnce: async () => false,
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
