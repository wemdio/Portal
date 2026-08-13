/**
 * Auto-pipeline worker — long-running daemon (заменяет HTTP-крон /api/cron/auto-hh-pipeline).
 *
 * Зачем демон: раньше добор гонялся внутри `portal`-контейнера по HTTP-крону.
 * Редеплой делает `force-recreate portal` → процесс добора убивался на середине,
 * оставляя зомби-строку `running` и 0 залитых лидов (инцидент 03.06.2026,
 * см. wiki/log.md). Теперь добор живёт здесь — отдельный сервис с
 * stop_grace_period и авто-resume.
 *
 * Resilience:
 *   - SIGTERM (редеплой): передаём shouldStop в runAutoPipelineForClient — новые
 *     домены больше не назначаются, уже начатые завершаются и их префикс
 *     фиксируется (Instantly + snapshots + seen). Run получает failed/interrupted,
 *     остаток подбирается следующим запуском. Никакого зомби.
 *   - Hard kill (OOM/SIGKILL): heartbeat прогона протухает → closeStaleAutoPipelineRuns
 *     закрывает строку → следующий тик перезапускает.
 *   - Resume: повторный прогон дедупит уже обработанных (seen_employers) и
 *     дозаливает остаток; createLeads(skip_if_in_campaign) идемпотентен → без
 *     дублей и без потерь.
 *
 * Расписание (без отдельного cron'а): каждый тик (~10 мин) для каждого
 * eligible-клиента проверяем — мы в окне допустимых попыток
 * [parse_window_start_utc .. parse_window_end_utc] И сегодня ещё не было
 * completed-прогона → запускаем (с ретраями до MAX_ATTEMPTS за окно). Для
 * Mailganer окно 21:00–03:00 UTC (00:00–06:00 МСК), pacing=burst.
 *
 * Деплой: отдельный сервис portal-worker-autopipeline в docker-compose.prod.yml
 * (command: node /app/workers/autoPipeline.js), restart: unless-stopped,
 * stop_grace_period. Бандл собирается в Dockerfile.worker (esbuild).
 *
 * ВАЖНО: после деплоя отключить старый внешний крон на /api/cron/auto-hh-pipeline,
 * иначе он будет дублировать запуск (lock через unique-index спасает от двойного
 * прогона, но плодит лишние HTTP-вызовы в portal).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';
import { installUndiciAssertGuard } from './_undiciAssertGuard';
import {
  closeStaleAutoPipelineRuns,
  runAutoPipelineForClient,
} from '@/lib/jobs/autoPipelineRunner';
import { isInsideWindow } from '@/lib/jobs/autoPipelinePacing';

const WORKER_ID = 'auto-pipeline';
const log = createWorkerLogger(WORKER_ID);
const TICK_MS = Number(process.env.AUTOPIPELINE_TICK_MS ?? '600000'); // 10 мин
const MAX_ATTEMPTS = Number(process.env.AUTOPIPELINE_MAX_ATTEMPTS ?? '6'); // попыток за окно
const DEFAULT_START_HOUR_UTC = 21; // 00:00 МСК
const DEFAULT_END_HOUR_UTC = 3; //   06:00 МСК

interface EligibleClient {
  clientUserId: string;
  startHourUtc: number;
  endHourUtc: number;
}

type Db = ReturnType<typeof requireSupabaseAdmin>;

/** Самое позднее наступление часа hourUtc:00 UTC, которое <= now. */
function windowStart(hourUtc: number, now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(hourUtc, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function loadEligibleClients(db: Db): Promise<EligibleClient[]> {
  const { data: configs, error } = await db
    .from('client_auto_pipeline_configs')
    .select('client_user_id, parse_window_start_utc, parse_window_end_utc')
    .eq('enabled', true);
  if (error || !configs) return [];

  const ids = (configs as Array<{ client_user_id: string }>)
    .map((c) => c.client_user_id)
    .filter(Boolean);
  if (ids.length === 0) return [];

  const { data: profiles } = await db
    .from('profiles')
    .select('id')
    .in('id', ids)
    .eq('auto_pipeline_enabled', true);
  const enabled = new Set((profiles ?? []).map((p) => (p as { id: string }).id));

  return (configs as Array<{
    client_user_id: string;
    parse_window_start_utc: number | null;
    parse_window_end_utc: number | null;
  }>)
    .filter((c) => enabled.has(c.client_user_id))
    .map((c) => ({
      clientUserId: c.client_user_id,
      startHourUtc: typeof c.parse_window_start_utc === 'number' ? c.parse_window_start_utc : DEFAULT_START_HOUR_UTC,
      endHourUtc: typeof c.parse_window_end_utc === 'number' ? c.parse_window_end_utc : DEFAULT_END_HOUR_UTC,
    }));
}

async function decideDue(
  db: Db,
  client: EligibleClient,
  now: Date,
): Promise<{ due: boolean; reason: string }> {
  // 1. В окне допустимых попыток? (вне окна не дёргаем — экономим HH-вызовы.)
  if (!isInsideWindow({ startHourUtc: client.startHourUtc, endHourUtc: client.endHourUtc }, now)) {
    return { due: false, reason: 'outside-window' };
  }
  // 2. Был ли completed-прогон в текущем окне? Если да — на сегодня всё.
  const since = windowStart(client.startHourUtc, now).toISOString();
  const { data: runs, error } = await db
    .from('client_auto_pipeline_runs')
    .select('status')
    .eq('client_user_id', client.clientUserId)
    .gte('started_at', since);
  if (error) return { due: false, reason: 'db-error' };
  const rows = (runs ?? []) as Array<{ status: string }>;
  if (rows.some((r) => r.status === 'completed')) {
    return { due: false, reason: 'already-completed-this-window' };
  }
  if (rows.length >= MAX_ATTEMPTS) {
    return { due: false, reason: `max-attempts-reached(${rows.length})` };
  }
  return { due: true, reason: `attempt ${rows.length + 1}/${MAX_ATTEMPTS}` };
}

async function main(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const isShuttingDown = setupGracefulShutdown(log);

  log('info', `Started. tick=${TICK_MS}ms maxAttempts=${MAX_ATTEMPTS}`);

  while (!isShuttingDown()) {
    try {
      const eligible = await loadEligibleClients(db);
      for (const client of eligible) {
        if (isShuttingDown()) break;
        try {
          // Reconcile abandoned runs even outside the client's execution
          // window. Otherwise a hard-killed night run can look active in the
          // dashboard until the next night.
          await closeStaleAutoPipelineRuns(client.clientUserId);
        } catch (err) {
          // Fail closed for this client: do not start another run while its
          // current state cannot be reconciled reliably.
          log('error', `Stale-run reconciliation failed for ${client.clientUserId}`, err);
          continue;
        }
        const { due, reason } = await decideDue(db, client, new Date());
        if (!due) continue;

        log('info', `→ Running pipeline for ${client.clientUserId} (${reason})`);
        try {
          const summary = await runAutoPipelineForClient(client.clientUserId, {
            shouldStop: isShuttingDown,
          });
          log(
            'info',
            `← ${client.clientUserId}: status=${summary.status} parsed=${summary.parsed} new=${summary.new} routed=${summary.routed} stored=${summary.stored} skipped=${summary.skipped} failed=${summary.failed}${summary.error ? ' err=' + summary.error : ''}`,
          );
        } catch (err) {
          log('error', `← crashed ${client.clientUserId}`, err);
        }
      }
    } catch (err) {
      log('error', 'Tick error', err);
    }

    // Прерываемый сон: реагируем на SIGTERM в течение ~5с, не ждём весь tick.
    const until = Date.now() + TICK_MS;
    while (Date.now() < until && !isShuttingDown()) {
      await sleep(Math.min(5_000, until - Date.now()));
    }
  }

  log('info', 'Graceful shutdown complete');
  process.exit(0);
}

installUndiciAssertGuard(log);
void main().catch((err) => {
  console.error('[worker][auto-pipeline][FATAL]', err);
  process.exit(1);
});
