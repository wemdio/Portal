/**
 * Pure (db, now) → result function for deadline-driven notifications.
 *
 * Owns the business logic that previously lived inline in
 * /api/cron/deadline-notifications. Both the API route and the worker loop
 * now thin-wrap this function.
 *
 * Why split: the worker process must be able to invoke the same code path
 * without an HTTP round-trip; a pure function with explicit `now` is also
 * trivially unit-testable.
 *
 * Notes on data shape:
 *   - `tasks.deadline` is `timestamptz`.
 *   - `projects.deadline` is `text` (`YYYY-MM-DD`); we treat it as 18:00 MSK
 *     of that day (= 15:00 UTC) before applying the same level math.
 *   - Tasks → projects relation is fetched as two queries (no PostgREST join)
 *     so the unit-test mock stays simple and the production cost is one
 *     extra round-trip per invocation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const MSK_OFFSET_HOURS = 3;

const DEFAULT_ESCALATION_EMAILS = {
  anya: 'grid4ina.an@gmail.com',
  nikita: 'sorichev@polzaagency.ru',
} as const;

const PROJECT_DONE_STATUSES = ['Завершен', 'Отменен'] as const;

export interface DeadlineDeps {
  db: SupabaseClient;
  now: Date;
  /** Override per-environment if needed (defaults to PolzaAgency leads). */
  escalationEmails?: { anya: string; nikita: string };
  /** Hook for tests / monitoring. Default: console. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface DeadlineResult {
  processed: number;
  created: number;
  leadEscalated: number;
}

interface DeadlineEntity {
  entity_type: 'project' | 'task';
  entity_id: string;
  entity_name: string;
  deadline: Date;
  specialist_name: string | null;
  manager_name: string | null;
  project_name?: string | null;
}

interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
}

type EscalationLevel = 'specialist' | 'lead' | 'ceo';

function buildNameIndex(profiles: ProfileRow[]): Map<string, ProfileRow> {
  const map = new Map<string, ProfileRow>();
  for (const p of profiles) {
    const name = p.full_name?.trim().toLowerCase();
    if (name) map.set(name, p);
    const emailLocal = p.email?.split('@')[0]?.trim().toLowerCase();
    if (emailLocal) map.set(emailLocal, p);
  }
  return map;
}

function resolveProfile(
  nameIndex: Map<string, ProfileRow>,
  assigneeName: string | null | undefined,
): ProfileRow | null {
  if (!assigneeName) return null;
  return nameIndex.get(assigneeName.trim().toLowerCase()) ?? null;
}

/** 18:00 MSK on the given date → UTC instant. */
function projectDeadlineToTimestamp(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcHour = 18 - MSK_OFFSET_HOURS;
  return new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
}

function determineLevel(deadline: Date, now: Date): EscalationLevel | null {
  const diffMinutes = (deadline.getTime() - now.getTime()) / 60_000;
  if (diffMinutes <= -50) return 'ceo';
  if (diffMinutes <= 10) return 'lead';
  if (diffMinutes <= 70) return 'specialist';
  return null;
}

function buildNotificationContent(
  entity: DeadlineEntity,
  level: EscalationLevel,
): { title: string; body: string } {
  const entityLabel = entity.entity_type === 'project' ? 'проекта' : 'задачи';
  const projectCtx =
    entity.entity_type === 'task' && entity.project_name ? ` (${entity.project_name})` : '';

  switch (level) {
    case 'specialist':
      return {
        title: 'Дедлайн через час',
        body: `Дедлайн ${entityLabel} «${entity.entity_name}»${projectCtx} наступает через час.`,
      };
    case 'lead':
      return {
        title: 'Дедлайн наступил',
        body: `Дедлайн ${entityLabel} «${entity.entity_name}»${projectCtx} наступил. Специалист: ${entity.specialist_name ?? '—'}.`,
      };
    case 'ceo':
      return {
        title: 'Дедлайн просрочен на час',
        body: `Дедлайн ${entityLabel} «${entity.entity_name}»${projectCtx} просрочен более чем на час. Специалист: ${entity.specialist_name ?? '—'}, лид: ${entity.manager_name ?? '—'}.`,
      };
  }
}

interface TaskRow {
  id: string;
  title: string;
  deadline: string;
  specialist: string | null;
  project_id: string | null;
  status: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  deadline: string | null;
  specialist: string | null;
  manager: string | null;
  status: string | null;
}

interface DedupRow {
  entity_type: string;
  entity_id: string;
  level: string;
}

export async function runDeadlineNotifications(deps: DeadlineDeps): Promise<DeadlineResult> {
  const { db, now } = deps;
  const escalationEmails = deps.escalationEmails ?? DEFAULT_ESCALATION_EMAILS;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[deadline-cron] ${msg}`, extra);
    else console[level](`[deadline-cron] ${msg}`);
  });

  const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const windowStartISO = windowStart.toISOString();
  const windowEndISO = windowEnd.toISOString();

  // ─── Tasks in the window ───────────────────────────────────────────────
  const tasksRes = await db
    .from('tasks')
    .select('id, title, deadline, specialist, project_id, status')
    .not('deadline', 'is', null)
    .neq('status', 'done')
    .gte('deadline', windowStartISO)
    .lte('deadline', windowEndISO);

  if (tasksRes.error) log('error', `tasks query failed: ${tasksRes.error.message}`);
  const tasks = (tasksRes.data ?? []) as TaskRow[];

  // ─── Projects: two paths ───────────────────────────────────────────────
  // 1) Resolve project metadata for the tasks above (no PostgREST join).
  // 2) Projects whose own `deadline` falls into the window — independent fan-out.
  const taskProjectIds = Array.from(
    new Set(tasks.map((t) => t.project_id).filter((id): id is string => !!id)),
  );

  let taskProjects: ProjectRow[] = [];
  if (taskProjectIds.length) {
    const res = await db
      .from('projects')
      .select('id, name, deadline, specialist, manager, status')
      .in('id', taskProjectIds);
    if (res.error) log('error', `projects-by-id query failed: ${res.error.message}`);
    taskProjects = (res.data ?? []) as ProjectRow[];
  }
  const projectById = new Map<string, ProjectRow>();
  for (const p of taskProjects) projectById.set(p.id, p);

  const windowStartDate = windowStart.toISOString().slice(0, 10);
  const windowEndDate = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const projectsRes = await db
    .from('projects')
    .select('id, name, deadline, specialist, manager, status')
    .not('deadline', 'is', null)
    .not('status', 'in', `(${PROJECT_DONE_STATUSES.map((s) => `"${s}"`).join(',')})`)
    .gte('deadline', windowStartDate)
    .lte('deadline', windowEndDate);
  if (projectsRes.error) log('error', `projects-by-deadline query failed: ${projectsRes.error.message}`);
  const projectsInWindow = (projectsRes.data ?? []) as ProjectRow[];

  // ─── Collect entities ──────────────────────────────────────────────────
  const entities: DeadlineEntity[] = [];

  for (const t of tasks) {
    const proj = t.project_id ? projectById.get(t.project_id) : undefined;
    entities.push({
      entity_type: 'task',
      entity_id: t.id,
      entity_name: t.title,
      deadline: new Date(t.deadline),
      specialist_name: t.specialist ?? proj?.specialist ?? null,
      manager_name: proj?.manager ?? null,
      project_name: proj?.name ?? null,
    });
  }

  for (const p of projectsInWindow) {
    if (!p.deadline) continue;
    const dl = projectDeadlineToTimestamp(p.deadline);
    if (dl.getTime() < windowStart.getTime() || dl.getTime() > windowEnd.getTime()) continue;
    entities.push({
      entity_type: 'project',
      entity_id: p.id,
      entity_name: p.name,
      deadline: dl,
      specialist_name: p.specialist ?? null,
      manager_name: p.manager ?? null,
    });
  }

  if (!entities.length) {
    return { processed: 0, created: 0, leadEscalated: 0 };
  }

  // ─── Profiles for name resolution ──────────────────────────────────────
  const profilesRes = await db.from('profiles').select('id, email, full_name');
  const profiles = (profilesRes.data ?? []) as ProfileRow[];
  const nameIndex = buildNameIndex(profiles);

  const anyaProfile =
    profiles.find((p) => p.email?.toLowerCase() === escalationEmails.anya) ?? null;
  const nikitaProfile =
    profiles.find((p) => p.email?.toLowerCase() === escalationEmails.nikita) ?? null;
  const ceoProfiles = [anyaProfile, nikitaProfile].filter((p): p is ProfileRow => !!p);

  // ─── Existing dedup entries ────────────────────────────────────────────
  const orExpr = entities
    .map((e) => `and(entity_type.eq.${e.entity_type},entity_id.eq.${e.entity_id})`)
    .join(',');
  const dedupRes = await db
    .from('deadline_notification_log')
    .select('entity_type, entity_id, level')
    .or(orExpr);
  const dedupRows = (dedupRes.data ?? []) as DedupRow[];
  const sentSet = new Set(dedupRows.map((l) => `${l.entity_type}:${l.entity_id}:${l.level}`));

  // ─── Fan out ───────────────────────────────────────────────────────────
  let created = 0;

  for (const entity of entities) {
    const level = determineLevel(entity.deadline, now);
    if (!level) continue;

    // Escalation policy: send all levels up to the current one (back-fill).
    const levels: EscalationLevel[] =
      level === 'specialist' ? ['specialist'] :
      level === 'lead' ? ['specialist', 'lead'] :
      ['specialist', 'lead', 'ceo'];

    for (const lvl of levels) {
      const key = `${entity.entity_type}:${entity.entity_id}:${lvl}`;
      if (sentSet.has(key)) continue;

      const recipients: ProfileRow[] = [];
      if (lvl === 'specialist') {
        const p = resolveProfile(nameIndex, entity.specialist_name);
        if (p) recipients.push(p);
      } else if (lvl === 'lead') {
        const p = resolveProfile(nameIndex, entity.manager_name);
        if (p) recipients.push(p);
      } else {
        recipients.push(...ceoProfiles);
      }

      if (!recipients.length) {
        log('warn', `no recipients for ${entity.entity_type}:${entity.entity_id} level=${lvl}`);
        continue;
      }

      const { title, body } = buildNotificationContent(entity, lvl);
      const rows = recipients.map((r) => ({
        user_id: r.id,
        type: lvl === 'specialist' ? 'deadline' : lvl === 'lead' ? 'deadline_lead' : 'deadline_ceo',
        title,
        body,
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
      }));

      const insertRes = await db.from('notifications').insert(rows);
      if (insertRes.error) {
        log('error', `insert notification failed: ${insertRes.error.message}`);
        continue;
      }

      const logRes = await db.from('deadline_notification_log').upsert(
        { entity_type: entity.entity_type, entity_id: entity.entity_id, level: lvl },
        { onConflict: 'entity_type,entity_id,level' },
      );
      if (logRes.error) {
        log('error', `dedup log upsert failed: ${logRes.error.message}`);
      }

      sentSet.add(key);
      created += rows.length;
    }
  }

  // Lead-qualification escalation lives in a separate worker
  // (`leadQualificationWorker`) and is intentionally NOT replicated here.
  return { processed: entities.length, created, leadEscalated: 0 };
}
