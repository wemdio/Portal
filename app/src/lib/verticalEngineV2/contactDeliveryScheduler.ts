import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runContactDeliveryDay,
  type ContactDeliveryDayResult,
} from '@/lib/verticalEngineV2/contactDeliveryRunner';
import { runProjectContactSupply } from './contactSupplyRunner';
import { reconcileContactDeliveries } from './contactDeliveryReconciliation';
import { activateDeliveredContactCampaigns } from './contactDeliveryActivation';
import { refreshDeliveryRate } from './contactDeliveryRateService';

export type ContactDeliverySchedulerLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: unknown,
) => void;

type RunContactDeliveryProject = (input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  veProjectId: string;
  now?: Date;
}) => Promise<ContactDeliveryDayResult>;

export interface BoundProjectRow {
  id: string;
  delivery_timezone: string;
  sender_daily_capacity: number;
}

interface ActiveQueueItemRow {
  project_id: string;
}

export interface ContactDeliverySweepResult {
  skipped: boolean;
  eligibleProjects: number;
  attemptedProjects: number;
  failedProjects: number;
}

const DEFAULT_RUN_PROJECT: RunContactDeliveryProject = runContactDeliveryDay;

/** Дата в часовом поясе проекта — так её считает бронь дня (timezone(tz, now)::date). */
function localDay(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Сегодня загружать нечего: день проекта забронирован и закрыт, ничего не в
 * пути, повторов не просили, и дневная норма набрана либо свободных готовых
 * контактов нет. Повторяет условия ve_reserve_contact_delivery_day и
 * ve_top_up_contact_delivery_day (миграции 20260928_0005, 20260929_0061): в
 * таком состоянии бронь вернула бы «replayed» без работы. Любое сомнение —
 * false, и проход идёт как раньше.
 */
export async function deliveryDaySettled(
  portalDb: SupabaseClient,
  project: BoundProjectRow,
  now: Date,
): Promise<boolean> {
  if (!project.delivery_timezone) return false;
  const { data: run, error } = await portalDb
    .from('ve_contact_delivery_daily_runs')
    .select('id, reservation_status, status, required_daily, sender_daily_capacity, reserved_count, upload_blocked_at, upload_retry_requested_at, recovery_retry_requested_at')
    .eq('ve_project_id', project.id)
    .eq('run_date', localDay(project.delivery_timezone, now))
    .maybeSingle();
  if (error || !run) return false;
  if (run.status !== 'completed' || run.upload_blocked_at || run.upload_retry_requested_at || run.recovery_retry_requested_at) return false;
  if (run.reservation_status === 'not_scheduled') return true;
  if (run.reservation_status !== 'reserved') return false;

  const { count: inFlight, error: inFlightError } = await portalDb
    .from('ve_contact_delivery_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', run.id)
    .in('status', ['reserved', 'attempting']);
  if (inFlightError || inFlight == null || inFlight > 0) return false;

  const quota = Math.min(Number(run.required_daily), Number(run.sender_daily_capacity), Number(project.sender_daily_capacity));
  if (!Number.isFinite(quota)) return false;
  if (Number(run.reserved_count) >= quota) return true;

  const { data: items, error: itemsError } = await portalDb
    .from('ve_launch_queue_items')
    .select('id')
    .eq('project_id', project.id)
    .eq('status', 'active');
  if (itemsError) return false;
  const itemIds = ((items ?? []) as { id: string }[]).map((item) => item.id);
  if (!itemIds.length) return true;
  const { count: ready, error: readyError } = await portalDb
    .from('ve_contact_delivery_rows')
    .select('id', { count: 'exact', head: true })
    .in('item_id', itemIds)
    .eq('status', 'ready')
    .is('run_id', null);
  if (readyError || ready == null) return false;
  return ready === 0;
}

/**
 * Runs one idempotent delivery-day attempt for every fully bound VE2 project.
 *
 * Projects are deliberately processed sequentially: all of them share the
 * same Instantly workspace and provider rate budget. A project-level error is
 * logged and isolated so it cannot starve the rest of the sweep.
 */
export async function runBoundContactDeliveries(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  now?: Date;
  runProject?: RunContactDeliveryProject;
  runSupply?: typeof runProjectContactSupply;
  reconcile?: typeof reconcileContactDeliveries;
  recoverActivation?: typeof activateDeliveredContactCampaigns;
  refreshRate?: typeof refreshDeliveryRate;
  daySettled?: typeof deliveryDaySettled;
  /** Finish an already attempted delivery, then leave remaining work for restart. */
  shouldStop?: () => boolean;
  log: ContactDeliverySchedulerLog;
}): Promise<ContactDeliverySweepResult> {
  if (input.shouldStop?.()) return { skipped: true, eligibleProjects: 0, attemptedProjects: 0, failedProjects: 0 };
  if (!input.instantlyDb) {
    input.log('error', 'VE2 contact delivery skipped: Instantly DB client is not configured');
    return {
      skipped: true,
      eligibleProjects: 0,
      attemptedProjects: 0,
      failedProjects: 0,
    };
  }

  // Prepared campaigns need their first upload before the specialist presses
  // Start in Instantly. Include paused/queued records so manual resumes are seen.
  const { data: activeItemData, error: activeItemError } = await input.portalDb
    .from('ve_launch_queue_items')
    .select('project_id')
    .in('status', ['prepared', 'queued', 'active', 'uncertain']);
  if (activeItemError) {
    throw new Error(`VE2 active delivery queue scan failed: ${activeItemError.message}`);
  }
  const activeProjectIds = [
    ...new Set(
      ((activeItemData ?? []) as ActiveQueueItemRow[])
        .map((item) => item.project_id)
        .filter(Boolean),
    ),
  ];
  if (activeProjectIds.length === 0) {
    return {
      skipped: false,
      eligibleProjects: 0,
      attemptedProjects: 0,
      failedProjects: 0,
    };
  }

  const { data, error } = await input.portalDb
    .from('ve_projects')
    .select('id, delivery_timezone, sender_daily_capacity')
    .in('id', activeProjectIds)
    // A NULL period is a Portal project without periods; the SQL term decides.
    .not('portal_project_id', 'is', null)
    .gt('target_contacts', 0)
    .not('delivery_schedule_days', 'is', null)
    .not('delivery_timezone', 'is', null)
    .gt('sender_daily_capacity', 0)
    .not('delivery_plan_bound_at', 'is', null)
    .not('delivery_plan_bound_by', 'is', null)
    .not('launch_preset_id', 'is', null)
    .order('id', { ascending: true });
  if (error) throw new Error(`VE2 contact delivery project scan failed: ${error.message}`);

  const projects = (data ?? []) as BoundProjectRow[];
  const runProject = input.runProject ?? DEFAULT_RUN_PROJECT;
  let failedProjects = 0;
  let attemptedProjects = 0;

  for (const project of projects) {
    if (input.shouldStop?.()) break;
    try {
      const observed = await (input.recoverActivation ?? activateDeliveredContactCampaigns)({
        portalDb: input.portalDb, veProjectId: project.id,
      });
      if (observed.errors.length) throw new Error(observed.errors.join('; '));
    } catch (error) {
      failedProjects += 1;
      input.log('error', `VE2 campaign state project ${project.id} unavailable; delivery deferred`, error);
      continue;
    }
    try {
      const recovery = await (input.reconcile ?? reconcileContactDeliveries)({
        portalDb: input.portalDb, veProjectId: project.id, shouldStop: input.shouldStop,
      });
      if (recovery.errors.length) input.log('warn', `VE2 contact reconciliation project ${project.id} incomplete`, recovery.errors);
      if (recovery.accepted || recovery.released) input.log('info', `VE2 contact reconciliation project ${project.id}`, recovery);
    } catch (error) {
      input.log('error', `VE2 contact reconciliation project ${project.id} failed`, error);
    }
    if (input.shouldStop?.()) break;
    // День уже закрыт — темп в Instantly не проверяем и день не бронируем:
    // бронь требует темп не старше 10 минут, а проверка листает все ящики и
    // кампании воркспейса. Подготовка контактов (supply) идёт как обычно —
    // ей Instantly не нужен, а новые готовые контакты откроют день на следующем проходе.
    let settled = false;
    try {
      settled = await (input.daySettled ?? deliveryDaySettled)(input.portalDb, project, input.now ?? new Date());
    } catch {
      settled = false;
    }
    if (settled) {
      try {
        await (input.runSupply ?? runProjectContactSupply)({
          portalDb: input.portalDb, instantlyDb: input.instantlyDb, veProjectId: project.id, now: input.now,
        });
      } catch (error) {
        input.log('error', `VE2 contact supply project ${project.id} failed`, error);
      }
      continue;
    }
    try {
      await (input.refreshRate ?? refreshDeliveryRate)(input.portalDb, input.instantlyDb, project.id);
    } catch (error) {
      failedProjects += 1;
      input.log('error', `VE2 rate refresh project ${project.id} failed; new delivery deferred`, error);
      continue;
    }
    if (input.shouldStop?.()) break;
    try {
      await (input.runSupply ?? runProjectContactSupply)({
        portalDb: input.portalDb, instantlyDb: input.instantlyDb, veProjectId: project.id, now: input.now,
      });
    } catch (error) {
      // A source outage must not stop the already validated ready reserve.
      input.log('error', `VE2 contact supply project ${project.id} failed`, error);
    }
    if (input.shouldStop?.()) break;
    attemptedProjects += 1;
    try {
      const result = await runProject({
        portalDb: input.portalDb,
        instantlyDb: input.instantlyDb,
        veProjectId: project.id,
        now: input.now,
      });
      if (result.status === 'failed' || result.status === 'uncertain') {
        failedProjects += 1;
        input.log(
          'warn',
          `VE2 contact delivery project ${project.id} finished with ${result.status}`,
          result.error,
        );
      }
    } catch (error) {
      failedProjects += 1;
      input.log('error', `VE2 contact delivery project ${project.id} failed`, error);
    }
  }

  return {
    skipped: false,
    eligibleProjects: projects.length,
    attemptedProjects,
    failedProjects,
  };
}

/**
 * Process-local overlap guard for the worker's startup/interval tick. The DB
 * remains the cross-process/daily idempotency boundary; this guard only avoids
 * wasting one worker process on a second concurrent sweep.
 */
export function createGuardedContactDeliveryTick(input: {
  run: () => Promise<unknown>;
  log: ContactDeliverySchedulerLog;
}): () => Promise<boolean> {
  let running = false;

  return async () => {
    if (running) {
      input.log('warn', 'VE2 contact delivery tick skipped: previous tick is still running');
      return false;
    }

    running = true;
    try {
      await input.run();
    } catch (error) {
      input.log('error', 'VE2 contact delivery tick failed', error);
    } finally {
      running = false;
    }
    return true;
  };
}
