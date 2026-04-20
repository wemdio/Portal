/**
 * TDD anchor for deadline-notifications cron logic.
 *
 * The production endpoint /api/cron/deadline-notifications today contains all
 * the business logic inline (querying tasks/projects/profiles, dedup via
 * `deadline_notification_log`, fan-out into `notifications`). This test pins
 * the public contract of the soon-to-be-extracted pure function
 * `runDeadlineNotifications(db, now)` from `@/lib/notifications/deadlineCron`.
 *
 * Time semantics under test (mirrors current route behaviour):
 *   - `specialist` notification fires when the task deadline is between
 *     50 and 70 minutes from `now` (i.e. ~T-1h).
 *   - `lead` notification fires within ±10 min of the deadline (T0). When
 *     `lead` triggers, `specialist` is also created if it wasn't already
 *     (escalation = "all levels up to current").
 *   - `ceo` notification fires once the deadline is more than 50 minutes in
 *     the past, and again creates the lower levels if missing.
 *   - The dedup table `deadline_notification_log` prevents the same level
 *     from being sent twice for the same (entity_type, entity_id).
 *
 * Project deadlines are stored as `text` (`YYYY-MM-DD`). The function maps
 * them to 18:00 MSK = 15:00 UTC of that day before applying the same
 * level-decision logic.
 *
 * `now` is injected so we never rely on real wall-clock time.
 */

import { createMockSupabase } from '../../helpers/mockSupabase';
import { runDeadlineNotifications } from '@/lib/notifications/deadlineCron';

const ANYA_EMAIL = 'grid4ina.an@gmail.com';
const NIKITA_EMAIL = 'sorichev@polzaagency.ru';

const ANYA_ID = 'anya-id';
const NIKITA_ID = 'nikita-id';
const SPEC_ID = 'spec-id';
const LEAD_ID = 'lead-id';

function profilesSeed(extra: Array<{ id: string; full_name: string; email: string }> = []) {
  return [
    { id: ANYA_ID, full_name: 'Anna Gridina', email: ANYA_EMAIL },
    { id: NIKITA_ID, full_name: 'Nick Sorichev', email: NIKITA_EMAIL },
    { id: SPEC_ID, full_name: 'Дмитрий К.', email: 'dim.livix@gmail.com' },
    { id: LEAD_ID, full_name: 'Вова С.', email: 'vova@example.com' },
    ...extra,
  ];
}

const NOW = new Date('2026-04-20T12:00:00Z');

describe('runDeadlineNotifications', () => {
  it('fires specialist-level notification ~1h before deadline', async () => {
    const deadlineISO = new Date(NOW.getTime() + 55 * 60 * 1000).toISOString(); // T-55min
    const db = createMockSupabase({
      tables: {
        tasks: [
          {
            id: 'task-1',
            title: 'Fix offer',
            deadline: deadlineISO,
            specialist: 'Дмитрий К.',
            project_id: 'proj-1',
            status: 'pending',
          },
        ],
        projects: [
          {
            id: 'proj-1',
            name: 'Аутрич',
            specialist: 'Дмитрий К.',
            manager: 'Вова С.',
            deadline: '2099-01-01',
            status: 'В работе',
          },
        ],
        profiles: profilesSeed(),
        deadline_notification_log: [],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(1);
    const notifs = db.getRows('notifications');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      user_id: SPEC_ID,
      type: 'deadline',
      entity_type: 'task',
      entity_id: 'task-1',
    });
    const log = db.getRows('deadline_notification_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      entity_type: 'task',
      entity_id: 'task-1',
      level: 'specialist',
    });
  });

  it('at deadline (T0) fires lead level and back-fills specialist', async () => {
    const deadlineISO = new Date(NOW.getTime() - 1 * 60 * 1000).toISOString(); // T-1min, within ±10
    const db = createMockSupabase({
      tables: {
        tasks: [
          {
            id: 'task-2',
            title: 'Закреп',
            deadline: deadlineISO,
            specialist: 'Дмитрий К.',
            project_id: 'proj-1',
            status: 'pending',
          },
        ],
        projects: [
          {
            id: 'proj-1', name: 'Аутрич',
            specialist: 'Дмитрий К.', manager: 'Вова С.',
            deadline: '2099-01-01', status: 'В работе',
          },
        ],
        profiles: profilesSeed(),
        deadline_notification_log: [],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(2);
    const notifs = db.getRows('notifications');
    const types = notifs.map((n) => n.type).sort();
    expect(types).toEqual(['deadline', 'deadline_lead']);

    expect(notifs.find((n) => n.type === 'deadline')?.user_id).toBe(SPEC_ID);
    expect(notifs.find((n) => n.type === 'deadline_lead')?.user_id).toBe(LEAD_ID);

    const log = db.getRows('deadline_notification_log');
    expect(log.map((l) => l.level).sort()).toEqual(['lead', 'specialist']);
  });

  it('1h past deadline fires CEO level for both Anya and Nikita', async () => {
    const deadlineISO = new Date(NOW.getTime() - 65 * 60 * 1000).toISOString(); // T+65min past
    const db = createMockSupabase({
      tables: {
        tasks: [
          {
            id: 'task-3',
            title: 'Гипотезы',
            deadline: deadlineISO,
            specialist: 'Дмитрий К.',
            project_id: 'proj-1',
            status: 'pending',
          },
        ],
        projects: [
          {
            id: 'proj-1', name: 'Аутрич',
            specialist: 'Дмитрий К.', manager: 'Вова С.',
            deadline: '2099-01-01', status: 'В работе',
          },
        ],
        profiles: profilesSeed(),
        deadline_notification_log: [],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: NOW });

    // 1 specialist + 1 lead + 2 CEO recipients = 4
    expect(result.created).toBe(4);

    const notifs = db.getRows('notifications');
    const ceoRecipients = notifs.filter((n) => n.type === 'deadline_ceo').map((n) => n.user_id).sort();
    expect(ceoRecipients).toEqual([ANYA_ID, NIKITA_ID].sort());
  });

  it('does not duplicate notifications already recorded in dedup log', async () => {
    const deadlineISO = new Date(NOW.getTime() - 65 * 60 * 1000).toISOString(); // CEO window
    const db = createMockSupabase({
      tables: {
        tasks: [
          {
            id: 'task-4', title: 'Repeat',
            deadline: deadlineISO,
            specialist: 'Дмитрий К.',
            project_id: 'proj-1',
            status: 'pending',
          },
        ],
        projects: [
          {
            id: 'proj-1', name: 'Аутрич',
            specialist: 'Дмитрий К.', manager: 'Вова С.',
            deadline: '2099-01-01', status: 'В работе',
          },
        ],
        profiles: profilesSeed(),
        deadline_notification_log: [
          { entity_type: 'task', entity_id: 'task-4', level: 'specialist' },
          { entity_type: 'task', entity_id: 'task-4', level: 'lead' },
          { entity_type: 'task', entity_id: 'task-4', level: 'ceo' },
        ],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(0);
    expect(db.getRows('notifications')).toHaveLength(0);
  });

  it('skips a level silently when the recipient profile is missing (does not throw)', async () => {
    // Task at T0 → would normally create both specialist and lead. We remove
    // the lead profile (Вова С.) from `profiles` to simulate the production
    // gap and assert that ONLY the specialist row is created, no exception.
    const deadlineISO = new Date(NOW.getTime() - 1 * 60 * 1000).toISOString();
    const db = createMockSupabase({
      tables: {
        tasks: [
          {
            id: 'task-5', title: 'Orphan',
            deadline: deadlineISO,
            specialist: 'Дмитрий К.',
            project_id: 'proj-1',
            status: 'pending',
          },
        ],
        projects: [
          {
            id: 'proj-1', name: 'Аутрич',
            specialist: 'Дмитрий К.', manager: 'Вова С.',
            deadline: '2099-01-01', status: 'В работе',
          },
        ],
        profiles: [
          { id: ANYA_ID, full_name: 'Anna Gridina', email: ANYA_EMAIL },
          { id: NIKITA_ID, full_name: 'Nick Sorichev', email: NIKITA_EMAIL },
          { id: SPEC_ID, full_name: 'Дмитрий К.', email: 'dim.livix@gmail.com' },
          // Вова С. intentionally absent.
        ],
        deadline_notification_log: [],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: NOW });

    expect(result.created).toBe(1);
    const notifs = db.getRows('notifications');
    expect(notifs.map((n) => n.type)).toEqual(['deadline']);
    // Dedup log records only successfully-sent levels.
    expect(db.getRows('deadline_notification_log').map((l) => l.level)).toEqual(['specialist']);
  });

  it('treats project.deadline (text YYYY-MM-DD) as 18:00 MSK = 15:00 UTC', async () => {
    // NOW = 2026-04-20 12:00 UTC. Project deadline 2026-04-20 → 15:00 UTC →
    // delta = +3h, so neither specialist (~T-1h) nor lead (~T0) nor CEO
    // window applies. We only verify that the projects path is wired, by
    // setting a project whose synthesized timestamp lands exactly in the
    // specialist window.
    //
    // T-55min from NOW = 11:05 UTC; 18:00 MSK = 15:00 UTC. To land in the
    // specialist window we need NOW = 14:05 UTC → adjust `now` for this case.
    const projectNow = new Date('2026-04-20T14:05:00Z'); // 55min before 15:00 UTC
    const db = createMockSupabase({
      tables: {
        tasks: [],
        projects: [
          {
            id: 'proj-X', name: 'Direct project deadline',
            specialist: 'Дмитрий К.', manager: 'Вова С.',
            deadline: '2026-04-20', status: 'В работе',
          },
        ],
        profiles: profilesSeed(),
        deadline_notification_log: [],
        notifications: [],
      },
    });

    const result = await runDeadlineNotifications({ db: db as never, now: projectNow });

    expect(result.created).toBe(1);
    const notifs = db.getRows('notifications');
    expect(notifs[0]).toMatchObject({
      user_id: SPEC_ID,
      type: 'deadline',
      entity_type: 'project',
      entity_id: 'proj-X',
    });
  });
});
