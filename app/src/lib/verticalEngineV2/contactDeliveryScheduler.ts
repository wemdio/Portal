import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runContactDeliveryDay,
  type ContactDeliveryDayResult,
} from '@/lib/verticalEngineV2/contactDeliveryRunner';
import { runProjectContactSupply } from './contactSupplyRunner';

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

interface BoundProjectRow {
  id: string;
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
  log: ContactDeliverySchedulerLog;
}): Promise<ContactDeliverySweepResult> {
  if (!input.instantlyDb) {
    input.log('error', 'VE2 contact delivery skipped: Instantly DB client is not configured');
    return {
      skipped: true,
      eligibleProjects: 0,
      attemptedProjects: 0,
      failedProjects: 0,
    };
  }

  // A prepared bundle can wait in the seasonality portfolio for weeks. Do
  // not treat that intentional queueing as a delivery failure on every tick;
  // only projects with an actually active bundle are due for provider work.
  const { data: activeItemData, error: activeItemError } = await input.portalDb
    .from('ve_launch_queue_items')
    .select('project_id')
    .eq('status', 'active');
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
    .select('id')
    .in('id', activeProjectIds)
    .not('portal_project_id', 'is', null)
    .not('portal_period_id', 'is', null)
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

  for (const project of projects) {
    try {
      await (input.runSupply ?? runProjectContactSupply)({
        portalDb: input.portalDb, instantlyDb: input.instantlyDb, veProjectId: project.id, now: input.now,
      });
    } catch (error) {
      // A source outage must not stop the already validated ready reserve.
      input.log('error', `VE2 contact supply project ${project.id} failed`, error);
    }
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
    attemptedProjects: projects.length,
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
