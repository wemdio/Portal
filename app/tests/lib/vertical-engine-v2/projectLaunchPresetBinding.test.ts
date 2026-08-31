/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { ensureVeProjectLaunchPresetBinding } from '@/lib/verticalEngineV2/projectLaunchPresetBinding';

const PROJECT_ID = '00000000-0000-4000-8000-000000000301';
const PRESET_ID = '00000000-0000-4000-8000-000000000302';
const OTHER_PRESET_ID = '00000000-0000-4000-8000-000000000303';
const USER_ID = '00000000-0000-4000-8000-000000000304';
const BOUND_AT = '2026-08-31T10:00:00.000Z';

function unboundProject() {
  return {
    id: PROJECT_ID,
    launch_preset_id: null,
    launch_instantly_account_id: null,
    launch_preset_bound_at: null,
    launch_preset_bound_by: null,
  };
}

function boundProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    launch_preset_id: PRESET_ID,
    launch_instantly_account_id: 'workspace-a',
    launch_preset_bound_at: BOUND_AT,
    launch_preset_bound_by: USER_ID,
    ...overrides,
  };
}

function ensure(db: ReturnType<typeof createMockSupabase>) {
  return ensureVeProjectLaunchPresetBinding(db as never, {
    projectId: PROJECT_ID,
    livePresetId: PRESET_ID,
    liveInstantlyAccountId: 'workspace-a',
    boundBy: USER_ID,
    now: new Date(BOUND_AT),
  });
}

it('CAS-binds the first live preset/workspace to an unbound project', async () => {
  const db = createMockSupabase({ tables: { ve_projects: [unboundProject()] } });

  await expect(ensure(db)).resolves.toEqual({
    status: 'bound',
    newlyBound: true,
    binding: expect.objectContaining({
      launch_preset_id: PRESET_ID,
      launch_instantly_account_id: 'workspace-a',
      launch_preset_bound_at: BOUND_AT,
      launch_preset_bound_by: USER_ID,
    }),
  });
  expect(db.updates).toHaveLength(1);
  expect(db.updates[0].filters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ column: 'id', op: 'eq', value: PROJECT_ID }),
      expect.objectContaining({ column: 'launch_preset_id', op: 'is', value: null }),
      expect.objectContaining({ column: 'launch_instantly_account_id', op: 'is', value: null }),
      expect.objectContaining({ column: 'launch_preset_bound_at', op: 'is', value: null }),
      expect.objectContaining({ column: 'launch_preset_bound_by', op: 'is', value: null }),
    ]),
  );
});

it('returns the existing matching binding without writing', async () => {
  const db = createMockSupabase({ tables: { ve_projects: [boundProject()] } });

  await expect(ensure(db)).resolves.toEqual({
    status: 'bound',
    newlyBound: false,
    binding: expect.objectContaining({ launch_preset_id: PRESET_ID }),
  });
  expect(db.updates).toHaveLength(0);
});

it('fails closed when the project is bound to another preset', async () => {
  const db = createMockSupabase({
    tables: {
      ve_projects: [boundProject({ launch_preset_id: OTHER_PRESET_ID })],
    },
  });

  await expect(ensure(db)).resolves.toEqual({
    status: 'mismatch',
    binding: expect.objectContaining({ launch_preset_id: OTHER_PRESET_ID }),
  });
  expect(db.updates).toHaveLength(0);
});

it('fails closed when the bound preset moved to another live workspace', async () => {
  const db = createMockSupabase({
    tables: {
      ve_projects: [boundProject({ launch_instantly_account_id: 'workspace-old' })],
    },
  });

  await expect(ensure(db)).resolves.toEqual({
    status: 'workspace_changed',
    binding: expect.objectContaining({ launch_instantly_account_id: 'workspace-old' }),
  });
  expect(db.updates).toHaveLength(0);
});

it('rereads and accepts the same binding after losing the first-binding race', async () => {
  const db = createMockSupabase({
    tables: { ve_projects: [unboundProject()] },
    beforeFirstUpdates: {
      ve_projects: (rows) => rows.map((row) => ({ ...row, ...boundProject() })),
    },
  });

  await expect(ensure(db)).resolves.toEqual({
    status: 'bound',
    newlyBound: false,
    binding: expect.objectContaining({ launch_preset_id: PRESET_ID }),
  });
});

it('rereads and reports mismatch after another request wins with another preset', async () => {
  const db = createMockSupabase({
    tables: { ve_projects: [unboundProject()] },
    beforeFirstUpdates: {
      ve_projects: (rows) =>
        rows.map((row) => ({
          ...row,
          ...boundProject({ launch_preset_id: OTHER_PRESET_ID }),
        })),
    },
  });

  await expect(ensure(db)).resolves.toEqual({
    status: 'mismatch',
    binding: expect.objectContaining({ launch_preset_id: OTHER_PRESET_ID }),
  });
});

it('distinguishes a missing project from a database failure', async () => {
  const missingDb = createMockSupabase({ tables: { ve_projects: [] } });
  await expect(ensure(missingDb)).resolves.toEqual({ status: 'project_not_found' });

  const failedDb = createMockSupabase({ errorTables: { ve_projects: 'db unavailable' } });
  await expect(ensure(failedDb)).resolves.toEqual({
    status: 'error',
    error: 'db unavailable',
  });
});

it('fails closed on a partially populated binding that violates the schema invariant', async () => {
  const db = createMockSupabase({
    tables: {
      ve_projects: [
        {
          ...unboundProject(),
          launch_preset_id: PRESET_ID,
        },
      ],
    },
  });

  await expect(ensure(db)).resolves.toEqual({
    status: 'error',
    error: 'Project launch preset binding is incomplete',
  });
  expect(db.updates).toHaveLength(0);
});
