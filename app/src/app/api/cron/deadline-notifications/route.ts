import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = process.env.CRON_SECRET ?? '';

const ESCALATION_EMAILS: Record<string, string> = {
  anya: 'grid4ina.an@gmail.com',
  nikita: 'sorichev@polzaagency.ru',
};

const MSK_OFFSET_HOURS = 3;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!CRON_SECRET && token === CRON_SECRET;
}

interface DeadlineEntity {
  entity_type: 'project' | 'task';
  entity_id: string;
  entity_name: string;
  deadline: Date;
  specialist_name: string | null;
  manager_name: string | null;
  project_name?: string;
}

interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
}

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
  const key = assigneeName.trim().toLowerCase();
  return nameIndex.get(key) ?? null;
}

/**
 * For project deadlines (stored as `date`), we treat them as 18:00 MSK of that day.
 * This means specialist gets notified at 17:00 MSK, lead at 18:00, CEO at 19:00.
 */
function projectDeadlineToTimestamp(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcHour = 18 - MSK_OFFSET_HOURS;
  return new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
}

type EscalationLevel = 'specialist' | 'lead' | 'ceo';

function determineLevel(deadline: Date, now: Date): EscalationLevel | null {
  const diffMs = deadline.getTime() - now.getTime();
  const diffMinutes = diffMs / (1000 * 60);

  // 1 hour after deadline → CEO
  if (diffMinutes <= -50) return 'ceo';
  // At deadline (within ±10 min) → lead
  if (diffMinutes <= 10) return 'lead';
  // 1 hour before deadline (50-70 min before) → specialist
  if (diffMinutes <= 70) return 'specialist';
  return null;
}

function buildNotificationContent(
  entity: DeadlineEntity,
  level: EscalationLevel,
): { title: string; body: string } {
  const entityLabel =
    entity.entity_type === 'project' ? 'проекта' : 'задачи';
  const name = entity.entity_name;
  const projectCtx =
    entity.entity_type === 'task' && entity.project_name
      ? ` (${entity.project_name})`
      : '';

  switch (level) {
    case 'specialist':
      return {
        title: `Дедлайн через час`,
        body: `Дедлайн ${entityLabel} «${name}»${projectCtx} наступает через час.`,
      };
    case 'lead':
      return {
        title: `Дедлайн наступил`,
        body: `Дедлайн ${entityLabel} «${name}»${projectCtx} наступил. Специалист: ${entity.specialist_name ?? '—'}.`,
      };
    case 'ceo':
      return {
        title: `Дедлайн просрочен на час`,
        body: `Дедлайн ${entityLabel} «${name}»${projectCtx} просрочен более чем на час. Специалист: ${entity.specialist_name ?? '—'}, лид: ${entity.manager_name ?? '—'}.`,
      };
  }
}

async function run() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: 'Server misconfigured: missing Supabase service role' },
      { status: 500 },
    );
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
  const windowEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h ahead

  const windowStartISO = windowStart.toISOString();
  const windowEndISO = windowEnd.toISOString();

  // --- Fetch tasks with deadlines in the window ---
  const { data: tasks, error: taskErr } = await supabaseAdmin
    .from('tasks')
    .select('id, title, deadline, specialist, project_id, projects:project_id(name, specialist, manager)')
    .not('deadline', 'is', null)
    .neq('status', 'done')
    .gte('deadline', windowStartISO)
    .lte('deadline', windowEndISO);

  if (taskErr) {
    console.error('[deadline-cron] tasks query error:', taskErr.message);
  }

  // --- Fetch projects with deadlines in the window ---
  const windowStartDate = windowStart.toISOString().slice(0, 10);
  const windowEndDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data: projects, error: projErr } = await supabaseAdmin
    .from('projects')
    .select('id, name, deadline, specialist, manager')
    .not('deadline', 'is', null)
    .not('status', 'in', '("Завершен","Отменен")')
    .gte('deadline', windowStartDate)
    .lte('deadline', windowEndDate);

  if (projErr) {
    console.error('[deadline-cron] projects query error:', projErr.message);
  }

  // --- Collect all entities ---
  const entities: DeadlineEntity[] = [];

  for (const t of tasks ?? []) {
    const proj = Array.isArray(t.projects) ? t.projects[0] : t.projects;
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

  for (const p of projects ?? []) {
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
    return NextResponse.json({ processed: 0, created: 0 });
  }

  // --- Load profiles for name resolution ---
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name');

  const nameIndex = buildNameIndex(profiles ?? []);

  const anyaProfile = (profiles ?? []).find(
    (p) => p.email?.toLowerCase() === ESCALATION_EMAILS.anya,
  );
  const nikitaProfile = (profiles ?? []).find(
    (p) => p.email?.toLowerCase() === ESCALATION_EMAILS.nikita,
  );
  const ceoProfiles = [anyaProfile, nikitaProfile].filter(Boolean) as ProfileRow[];

  // --- Load existing dedup entries ---
  const { data: existingLogs } = await supabaseAdmin
    .from('deadline_notification_log')
    .select('entity_type, entity_id, level')
    .or(
      entities
        .map(
          (e) =>
            `and(entity_type.eq.${e.entity_type},entity_id.eq.${e.entity_id})`,
        )
        .join(','),
    );

  const sentSet = new Set(
    (existingLogs ?? []).map(
      (l: { entity_type: string; entity_id: string; level: string }) =>
        `${l.entity_type}:${l.entity_id}:${l.level}`,
    ),
  );

  // --- Process each entity ---
  let created = 0;

  for (const entity of entities) {
    const level = determineLevel(entity.deadline, now);
    if (!level) continue;

    // Escalation: send all levels up to current
    const levels: EscalationLevel[] = [];
    if (level === 'specialist') levels.push('specialist');
    if (level === 'lead') levels.push('specialist', 'lead');
    if (level === 'ceo') levels.push('specialist', 'lead', 'ceo');

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
      } else if (lvl === 'ceo') {
        recipients.push(...ceoProfiles);
      }

      if (!recipients.length) {
        console.warn(
          `[deadline-cron] No recipients for ${entity.entity_type}:${entity.entity_id} level=${lvl}`,
        );
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

      const { error: insertErr } = await supabaseAdmin
        .from('notifications')
        .insert(rows);

      if (insertErr) {
        console.error(`[deadline-cron] insert notification error:`, insertErr.message);
        continue;
      }

      const { error: logErr } = await supabaseAdmin
        .from('deadline_notification_log')
        .upsert(
          {
            entity_type: entity.entity_type,
            entity_id: entity.entity_id,
            level: lvl,
          },
          { onConflict: 'entity_type,entity_id,level' },
        );

      if (logErr) {
        console.error(`[deadline-cron] dedup log error:`, logErr.message);
      }

      sentSet.add(key);
      created += rows.length;
    }
  }

  // ─── Lead qualification escalation ─────────────────────────────────
  const leadCreated = await escalateLeadNotifications(
    supabaseAdmin,
    nameIndex,
    anyaProfile ?? null,
    nikitaProfile ?? null,
  );

  return NextResponse.json({
    processed: entities.length,
    created,
    lead_escalated: leadCreated,
  });
}

/**
 * Escalate lead qualification notifications:
 *  - 30min after specialist notified and still unread → notify PM (project manager)
 *  - 1.5h after specialist notified and still unread → notify Anya
 *  - 2.5h after specialist notified and still unread → notify Nikita
 */
async function escalateLeadNotifications(
  db: NonNullable<typeof supabaseAdmin>,
  nameIndex: Map<string, ProfileRow>,
  anyaProfile: ProfileRow | null,
  nikitaProfile: ProfileRow | null,
): Promise<number> {
  const now = new Date();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  // Find lead qualifications with specialist-level notification sent 30min+ ago
  const { data: specLogs } = await db
    .from('deadline_notification_log')
    .select('entity_id, created_at')
    .eq('entity_type', 'lead_qualification')
    .eq('level', 'specialist')
    .lte('created_at', thirtyMinAgo);

  if (!specLogs?.length) return 0;

  const qualIds = specLogs.map((l: { entity_id: string }) => l.entity_id);

  // Check which specialist notifications are still unread
  const { data: unreadNotifs } = await db
    .from('notifications')
    .select('entity_id')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .eq('is_read', false)
    .in('entity_id', qualIds);

  const unreadQualIds = new Set(
    (unreadNotifs ?? []).map((n: { entity_id: string }) => n.entity_id),
  );
  if (!unreadQualIds.size) return 0;

  // Load existing escalation entries to avoid duplicates
  const { data: existingEscalations } = await db
    .from('deadline_notification_log')
    .select('entity_id, level')
    .eq('entity_type', 'lead_qualification')
    .in('entity_id', [...unreadQualIds])
    .in('level', ['lead', 'ceo']);

  const escalatedSet = new Set(
    (existingEscalations ?? []).map(
      (e: { entity_id: string; level: string }) => `${e.entity_id}:${e.level}`,
    ),
  );

  const specLogMap = new Map<string, string>();
  for (const log of specLogs) {
    specLogMap.set(log.entity_id, log.created_at);
  }

  // Get notification details for the body
  const { data: originalNotifs } = await db
    .from('notifications')
    .select('entity_id, body')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .in('entity_id', [...unreadQualIds]);

  const notifBodyMap = new Map<string, string>();
  for (const n of originalNotifs ?? []) {
    if (n.body) notifBodyMap.set(n.entity_id, n.body);
  }

  // Load qualification → campaign → project → manager (PM) mapping
  const { data: quals } = await db
    .from('notifications')
    .select('entity_id, entity_type')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .in('entity_id', [...unreadQualIds]);

  // Build qualId → PM profile mapping via instantly DB
  const qualPmMap = new Map<string, ProfileRow>();
  // We need to go: qualification → instantly_lead_qualifications.campaign_id → project_instantly_campaigns → projects.manager
  // But we only have main DB here. Use a single query approach:
  // Get campaign_ids from the lead_new notification body is not ideal.
  // Instead, query instantly DB from main cron is not possible (different DB).
  // Workaround: store campaign_id context in notification or use projects.manager for all unread leads.
  // Best approach: query projects where specialist_user_id matches the original notification recipient.
  const { data: notifRecipients } = await db
    .from('notifications')
    .select('entity_id, user_id')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .in('entity_id', [...unreadQualIds]);

  const qualSpecialistMap = new Map<string, string>();
  for (const n of notifRecipients ?? []) {
    if (n.user_id) qualSpecialistMap.set(n.entity_id, n.user_id);
  }

  // For each specialist, find their project's manager
  const specialistIds = [...new Set(qualSpecialistMap.values())];
  const specialistPmMap = new Map<string, ProfileRow>();
  if (specialistIds.length > 0) {
    const { data: projects } = await db
      .from('projects')
      .select('specialist_user_id, manager')
      .in('specialist_user_id', specialistIds)
      .not('manager', 'is', null);

    if (projects) {
      for (const p of projects) {
        if (p.specialist_user_id && p.manager) {
          const pm = resolveProfile(nameIndex, p.manager as string);
          if (pm) specialistPmMap.set(p.specialist_user_id as string, pm);
        }
      }
    }
  }

  let created = 0;

  for (const qualId of unreadQualIds) {
    const specCreatedAt = specLogMap.get(qualId);
    if (!specCreatedAt) continue;

    const specTime = new Date(specCreatedAt).getTime();
    const elapsedMin = (now.getTime() - specTime) / 60_000;
    const leadBody = notifBodyMap.get(qualId) ?? '';

    // 30min+ → PM (manager of the project) escalation
    if (elapsedMin >= 30 && !escalatedSet.has(`${qualId}:lead`)) {
      const specialistId = qualSpecialistMap.get(qualId);
      const pm = specialistId ? specialistPmMap.get(specialistId) : null;
      if (pm) {
        const { error } = await db.from('notifications').insert({
          user_id: pm.id,
          type: 'lead_escalation',
          title: 'Лид не обработан более 30 мин',
          body: leadBody,
          entity_type: 'lead_qualification',
          entity_id: qualId,
        });
        if (!error) {
          await db.from('deadline_notification_log').upsert(
            { entity_type: 'lead_qualification', entity_id: qualId, level: 'lead' },
            { onConflict: 'entity_type,entity_id,level' },
          );
          created += 1;
        }
      }
    }

    // 1.5h+ → Anya escalation
    if (elapsedMin >= 90 && !escalatedSet.has(`${qualId}:ceo`)) {
      if (anyaProfile) {
        const { error } = await db.from('notifications').insert({
          user_id: anyaProfile.id,
          type: 'lead_ceo',
          title: 'Лид не обработан более 1.5 часов',
          body: leadBody,
          entity_type: 'lead_qualification',
          entity_id: qualId,
        });
        if (!error) {
          await db.from('deadline_notification_log').upsert(
            { entity_type: 'lead_qualification', entity_id: qualId, level: 'ceo' },
            { onConflict: 'entity_type,entity_id,level' },
          );
          created += 1;
        }
      }
    }

    // 2.5h+ → Nikita escalation (reuse 'ceo' level won't work since Anya already uses it)
    // We need a 4th level. For now use a separate check via notifications dedup.
    if (elapsedMin >= 150 && nikitaProfile) {
      const nikitaKey = `lead_qualification:${qualId}:nikita`;
      const { data: nikitaExisting } = await db
        .from('notifications')
        .select('id')
        .eq('entity_type', 'lead_qualification')
        .eq('entity_id', qualId)
        .eq('user_id', nikitaProfile.id)
        .eq('type', 'lead_ceo')
        .limit(1)
        .maybeSingle();

      if (!nikitaExisting) {
        const { error } = await db.from('notifications').insert({
          user_id: nikitaProfile.id,
          type: 'lead_ceo',
          title: 'Лид не обработан более 2.5 часов',
          body: leadBody,
          entity_type: 'lead_qualification',
          entity_id: qualId,
        });
        if (!error) created += 1;
      }
    }
  }

  return created;
}

export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}
