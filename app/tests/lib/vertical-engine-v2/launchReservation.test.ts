/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  isVeLaunchReservationExpired,
  reconcileExpiredLaunchReservation,
  VE_LAUNCH_RESERVATION_TIMEOUT_MS,
} from '@/lib/verticalEngineV2/launchReservation';
import type { VeSegmentationAudit } from '@/lib/verticalEngineV2/types';

function audit(overrides: Partial<VeSegmentationAudit> = {}): VeSegmentationAudit {
  return {
    id: 'audit-launch-lease',
    project_id: 'project-1',
    template_id: 'template-1',
    base_id: 'base-1',
    requested_by: 'user-1',
    status: 'ready',
    input_hash: 'a'.repeat(64),
    segment_keys: [],
    summary: null,
    assignments: [],
    error: null,
    tokens_used: 0,
    cost_usd: 0,
    completed_at: null,
    launch_status: 'running',
    launch_reservation_id: 'reservation-1',
    launch_preset_id: 'preset-1',
    launch_started_at: '2026-08-28T10:00:00.000Z',
    launch_heartbeat_at: '2026-08-28T10:10:00.000Z',
    launch_completed_at: null,
    launch_error: null,
    launch_resolution_id: null,
    launch_resolved_by: null,
    launch_resolved_at: null,
    created_at: '2026-08-28T09:59:00.000Z',
    updated_at: '2026-08-28T10:10:00.000Z',
    ...overrides,
  };
}

it('uses the latest heartbeat, not the original start time, for expiry', () => {
  const now = new Date('2026-08-28T10:20:00.000Z');
  expect(isVeLaunchReservationExpired(audit(), now)).toBe(false);
  expect(
    isVeLaunchReservationExpired(
      audit({ launch_heartbeat_at: '2026-08-28T10:04:59.999Z' }),
      now,
    ),
  ).toBe(true);
  expect(VE_LAUNCH_RESERVATION_TIMEOUT_MS).toBe(15 * 60_000);
});

it('keeps the exact reservation locked while turning an expired launch uncertain', async () => {
  const currentAudit = audit({ launch_heartbeat_at: '2026-08-28T10:00:00.000Z' });
  const db = createMockSupabase({
    tables: { ve_segmentation_audits: [{ ...currentAudit }] },
  });

  const result = await reconcileExpiredLaunchReservation(
    db as never,
    currentAudit,
    new Date('2026-08-28T10:20:00.000Z'),
  );
  expect(result).toEqual(
    expect.objectContaining({
      changed: true,
      error: null,
      audit: expect.objectContaining({
        launch_status: 'uncertain',
        launch_reservation_id: 'reservation-1',
      }),
    }),
  );
});

it('does not expire a reservation whose heartbeat advanced after the read', async () => {
  const currentAudit = audit({ launch_heartbeat_at: '2026-08-28T10:00:00.000Z' });
  const freshHeartbeat = '2026-08-28T10:19:30.000Z';
  const db = createMockSupabase({
    tables: { ve_segmentation_audits: [{ ...currentAudit }] },
    beforeFirstUpdates: {
      ve_segmentation_audits: (rows) =>
        rows.map((row) => ({
          ...row,
          launch_heartbeat_at: freshHeartbeat,
          updated_at: freshHeartbeat,
        })),
    },
  });

  const result = await reconcileExpiredLaunchReservation(
    db as never,
    currentAudit,
    new Date('2026-08-28T10:20:00.000Z'),
  );

  expect(result).toEqual(
    expect.objectContaining({
      changed: false,
      error: null,
      audit: expect.objectContaining({
        launch_status: 'running',
        launch_heartbeat_at: freshHeartbeat,
      }),
    }),
  );
});
