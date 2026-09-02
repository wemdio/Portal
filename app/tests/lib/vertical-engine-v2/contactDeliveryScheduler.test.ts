/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  createGuardedContactDeliveryTick,
  runBoundContactDeliveries,
} from '@/lib/verticalEngineV2/contactDeliveryScheduler';

const COMPLETE_BINDING = {
  portal_project_id: '20000000-0000-0000-0000-000000000001',
  portal_period_id: '30000000-0000-0000-0000-000000000001',
  target_contacts: 100,
  delivery_schedule_days: [1, 2, 3, 4, 5],
  delivery_timezone: 'Europe/Moscow',
  sender_daily_capacity: 20,
  delivery_plan_bound_at: '2026-09-02T10:00:00.000Z',
  delivery_plan_bound_by: '40000000-0000-0000-0000-000000000001',
  launch_preset_id: 'preset-1',
};

describe('VE2 contact delivery scheduler', () => {
  it('runs only complete bindings and isolates one project failure from the next', async () => {
    const portal = createMockSupabase({
      tables: {
        ve_projects: [
          { id: 've-1', ...COMPLETE_BINDING },
          { id: 've-partial', ...COMPLETE_BINDING, delivery_plan_bound_by: null },
          { id: 've-2', ...COMPLETE_BINDING, portal_period_id: 'period-2' },
          { id: 've-queued', ...COMPLETE_BINDING, portal_period_id: 'period-queued' },
        ],
        ve_launch_queue_items: [
          { id: 'item-1', project_id: 've-1', status: 'active' },
          { id: 'item-2', project_id: 've-2', status: 'active' },
          { id: 'item-queued', project_id: 've-queued', status: 'queued' },
        ],
      },
      enforceQueryWindows: true,
    });
    const runProject = jest.fn(async ({ veProjectId }: { veProjectId: string }) => {
      if (veProjectId === 've-1') throw new Error('provider timeout');
      return {
        status: 'completed' as const,
        runId: 'run-2',
        runDate: '2026-09-02',
        accepted: 2,
        skipped: 0,
        uncertain: 0,
      };
    });
    const log = jest.fn();

    const result = await runBoundContactDeliveries({
      portalDb: portal as never,
      instantlyDb: {} as never,
      now: new Date('2026-09-02T12:00:00.000Z'),
      runProject: runProject as never,
      log,
    });

    expect(runProject.mock.calls.map(([input]) => input.veProjectId)).toEqual(['ve-1', 've-2']);
    expect(result).toEqual({
      skipped: false,
      eligibleProjects: 2,
      attemptedProjects: 2,
      failedProjects: 1,
    });
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('ve-1'),
      expect.any(Error),
    );
  });

  it('does not read or mutate the Portal DB without the Instantly client', async () => {
    const portal = createMockSupabase({
      tables: { ve_projects: [{ id: 've-1', ...COMPLETE_BINDING }] },
    });
    const runProject = jest.fn();
    const log = jest.fn();

    const result = await runBoundContactDeliveries({
      portalDb: portal as never,
      instantlyDb: null,
      runProject: runProject as never,
      log,
    });

    expect(result).toEqual({
      skipped: true,
      eligibleProjects: 0,
      attemptedProjects: 0,
      failedProjects: 0,
    });
    expect(portal.selects).toHaveLength(0);
    expect(runProject).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Instantly'),
    );
  });

  it('skips an overlapping tick and unlocks after the current tick settles', async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const run = jest.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const log = jest.fn();
    const tick = createGuardedContactDeliveryTick({ run, log });

    const active = tick();
    await expect(tick()).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await expect(active).resolves.toBe(true);
    await expect(tick()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
