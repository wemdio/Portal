/**
 * Pure (db, now) → result function for lead-qualification escalation.
 *
 * Mirrors the previous `escalateLeadNotifications` that lived inline inside
 * /api/cron/deadline-notifications. Extracted so the worker scheduler loop
 * can call the same code without an HTTP round-trip.
 *
 * Escalation timeline (counted from the moment the original specialist-level
 * `lead_new` notification was created in `deadline_notification_log`):
 *
 *   ≥30 min unread  → notify the project manager (PM) of that specialist
 *                     (level=lead, type=lead_escalation)
 *   ≥1.5h  unread   → notify Anya (level=ceo, type=lead_ceo)
 *   ≥2.5h  unread   → notify Nikita (extra row, type=lead_ceo, dedup is
 *                     done per-recipient via notifications uniqueness)
 *
 * Scope: this function does NOT need the project metadata that the deadline
 * cron uses; it walks `deadline_notification_log` (entity_type='lead_qualification',
 * level='specialist') and joins with the `notifications` table to find
 * still-unread entries.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_ESCALATION_EMAILS = {
  anya: 'grid4ina.an@gmail.com',
  nikita: 'sorichev@polzaagency.ru',
} as const;

export interface LeadEscalationDeps {
  db: SupabaseClient;
  now: Date;
  escalationEmails?: { anya: string; nikita: string };
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface LeadEscalationResult {
  /** Number of new notifications created during this run. */
  created: number;
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
  return nameIndex.get(assigneeName.trim().toLowerCase()) ?? null;
}

export async function runLeadEscalation(deps: LeadEscalationDeps): Promise<LeadEscalationResult> {
  const { db, now } = deps;
  const escalationEmails = deps.escalationEmails ?? DEFAULT_ESCALATION_EMAILS;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[lead-escalation] ${msg}`, extra);
    else console[level](`[lead-escalation] ${msg}`);
  });

  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  const specLogsRes = await db
    .from('deadline_notification_log')
    .select('entity_id, created_at')
    .eq('entity_type', 'lead_qualification')
    .eq('level', 'specialist')
    .lte('created_at', thirtyMinAgo);
  if (specLogsRes.error) log('error', `specLogs query failed: ${specLogsRes.error.message}`);
  const specLogs = (specLogsRes.data ?? []) as Array<{ entity_id: string; created_at: string }>;
  if (!specLogs.length) return { created: 0 };

  const qualIds = specLogs.map((l) => l.entity_id);

  const unreadRes = await db
    .from('notifications')
    .select('entity_id')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .eq('is_read', false)
    .in('entity_id', qualIds);
  if (unreadRes.error) log('error', `unread query failed: ${unreadRes.error.message}`);
  const unreadQualIds = new Set(
    ((unreadRes.data ?? []) as Array<{ entity_id: string }>).map((n) => n.entity_id),
  );
  if (!unreadQualIds.size) return { created: 0 };

  const escalationsRes = await db
    .from('deadline_notification_log')
    .select('entity_id, level')
    .eq('entity_type', 'lead_qualification')
    .in('entity_id', [...unreadQualIds])
    .in('level', ['lead', 'ceo']);
  const escalatedSet = new Set(
    ((escalationsRes.data ?? []) as Array<{ entity_id: string; level: string }>).map(
      (e) => `${e.entity_id}:${e.level}`,
    ),
  );

  const specLogMap = new Map<string, string>();
  for (const r of specLogs) specLogMap.set(r.entity_id, r.created_at);

  const originalNotifsRes = await db
    .from('notifications')
    .select('entity_id, body')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .in('entity_id', [...unreadQualIds]);
  const notifBodyMap = new Map<string, string>();
  for (const n of (originalNotifsRes.data ?? []) as Array<{ entity_id: string; body: string | null }>) {
    if (n.body) notifBodyMap.set(n.entity_id, n.body);
  }

  // Map qualification → user_id of the specialist who originally received it.
  const recipientsRes = await db
    .from('notifications')
    .select('entity_id, user_id')
    .eq('entity_type', 'lead_qualification')
    .eq('type', 'lead_new')
    .in('entity_id', [...unreadQualIds]);
  const qualSpecialistMap = new Map<string, string>();
  for (const n of (recipientsRes.data ?? []) as Array<{ entity_id: string; user_id: string | null }>) {
    if (n.user_id) qualSpecialistMap.set(n.entity_id, n.user_id);
  }

  // Profiles + name index for PM resolution.
  const profilesRes = await db.from('profiles').select('id, email, full_name');
  const profiles = (profilesRes.data ?? []) as ProfileRow[];
  const nameIndex = buildNameIndex(profiles);
  const anyaProfile =
    profiles.find((p) => p.email?.toLowerCase() === escalationEmails.anya) ?? null;
  const nikitaProfile =
    profiles.find((p) => p.email?.toLowerCase() === escalationEmails.nikita) ?? null;

  // For each specialist who has unread leads, find their project's manager.
  const specialistIds = [...new Set(qualSpecialistMap.values())];
  const specialistPmMap = new Map<string, ProfileRow>();
  if (specialistIds.length > 0) {
    const projRes = await db
      .from('projects')
      .select('specialist_user_id, manager')
      .in('specialist_user_id', specialistIds)
      .not('manager', 'is', null);
    if (projRes.error) log('warn', `projects query failed: ${projRes.error.message}`);
    for (const p of (projRes.data ?? []) as Array<{ specialist_user_id: string | null; manager: string | null }>) {
      if (p.specialist_user_id && p.manager) {
        const pm = resolveProfile(nameIndex, p.manager);
        if (pm) specialistPmMap.set(p.specialist_user_id, pm);
      }
    }
  }

  let created = 0;

  for (const qualId of unreadQualIds) {
    const specCreatedAt = specLogMap.get(qualId);
    if (!specCreatedAt) continue;

    const elapsedMin = (now.getTime() - new Date(specCreatedAt).getTime()) / 60_000;
    const leadBody = notifBodyMap.get(qualId) ?? '';

    if (elapsedMin >= 30 && !escalatedSet.has(`${qualId}:lead`)) {
      const specialistId = qualSpecialistMap.get(qualId);
      const pm = specialistId ? specialistPmMap.get(specialistId) : null;
      if (pm) {
        const ins = await db.from('notifications').insert({
          user_id: pm.id,
          type: 'lead_escalation',
          title: 'Лид не обработан более 30 мин',
          body: leadBody,
          entity_type: 'lead_qualification',
          entity_id: qualId,
        });
        if (!ins.error) {
          await db.from('deadline_notification_log').upsert(
            { entity_type: 'lead_qualification', entity_id: qualId, level: 'lead' },
            { onConflict: 'entity_type,entity_id,level' },
          );
          created += 1;
        }
      }
    }

    if (elapsedMin >= 90 && !escalatedSet.has(`${qualId}:ceo`) && anyaProfile) {
      const ins = await db.from('notifications').insert({
        user_id: anyaProfile.id,
        type: 'lead_ceo',
        title: 'Лид не обработан более 1.5 часов',
        body: leadBody,
        entity_type: 'lead_qualification',
        entity_id: qualId,
      });
      if (!ins.error) {
        await db.from('deadline_notification_log').upsert(
          { entity_type: 'lead_qualification', entity_id: qualId, level: 'ceo' },
          { onConflict: 'entity_type,entity_id,level' },
        );
        created += 1;
      }
    }

    // 2.5h+ → Nikita escalation. We can't reuse 'ceo' level (Anya occupies it),
    // so we de-dup per-recipient via the notifications table.
    if (elapsedMin >= 150 && nikitaProfile) {
      const existing = await db
        .from('notifications')
        .select('id')
        .eq('entity_type', 'lead_qualification')
        .eq('entity_id', qualId)
        .eq('user_id', nikitaProfile.id)
        .eq('type', 'lead_ceo')
        .limit(1)
        .maybeSingle();

      if (!existing.data) {
        const ins = await db.from('notifications').insert({
          user_id: nikitaProfile.id,
          type: 'lead_ceo',
          title: 'Лид не обработан более 2.5 часов',
          body: leadBody,
          entity_type: 'lead_qualification',
          entity_id: qualId,
        });
        if (!ins.error) created += 1;
      }
    }
  }

  return { created };
}
