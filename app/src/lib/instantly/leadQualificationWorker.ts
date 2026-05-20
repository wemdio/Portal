import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import { qualifyReply, getBodyText, fetchBriefByCampaign } from './leadQualifier';
import { sendLeadTelegramAlert, type LeadTelegramSpecialistMention } from './leadTelegramAlerts';
import * as instantly from './client';
import type { Email } from './types';

const REPLY_EMAILS_PAGE_SIZE = 100;
const MAX_QUALIFY_PER_TICK = 20;
const PROJECT_BATCH_SIZE = 100;
const briefCache = new Map<string, string | null>();
const campaignNameCache = new Map<string, string | null>();
const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';
const MODEL = process.env.INSTANTLY_LEAD_QUAL_MODEL ?? 'policy/gemini-flash';

function workerLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: unknown,
) {
  const line = `[instantly-lead-qual][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Returns campaign IDs that are linked to a real Portal client project.
 *
 * `user_instantly_campaign_preferences` only controls a specialist's lead-feed
 * view. It must not expand the AI polling surface by itself, because the worker
 * should not qualify replies for campaigns that are not tied to a Portal client.
 */
async function getPortalLinkedCampaignIds(): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data: legacyLinks } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('project_id, campaign_id');
  const { data: periodLinks } = await supabaseAdmin
    .from('project_period_instantly_campaigns')
    .select('project_id, campaign_id');

  const rows = [
    ...((legacyLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
    ...((periodLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
  ];
  if (rows.length === 0) return [];

  // If main DB is unavailable, we cannot verify that the project still exists
  // and belongs to a Portal client. Safer to skip than to classify orphaned
  // workspace campaigns.
  if (!supabaseMain) {
    workerLog('warn', 'supabaseMain not configured — cannot verify Portal project links');
    return [];
  }

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean) as string[])];
  const validProjectIds = new Set<string>();
  for (let i = 0; i < projectIds.length; i += PROJECT_BATCH_SIZE) {
    const batch = projectIds.slice(i, i + PROJECT_BATCH_SIZE);
    const { data: projects, error } = await supabaseMain
      .from('projects')
      .select('id, client')
      .in('id', batch);

    if (error) {
      workerLog('warn', 'Failed to verify Portal project links', error.message);
      continue;
    }

    for (const project of projects ?? []) {
      const client = typeof project.client === 'string' ? project.client.trim() : '';
      if (client) validProjectIds.add(project.id as string);
    }
  }

  const campaignIds = new Set<string>();
  for (const row of rows) {
    if (row.project_id && row.campaign_id && validProjectIds.has(row.project_id)) {
      campaignIds.add(row.campaign_id);
    }
  }

  return [...campaignIds];
}

/**
 * Resolves a campaign's display name by ID, cached per worker process.
 * Used to label lead alerts with the campaign the reply came from.
 */
async function resolveCampaignName(campaignId: string): Promise<string | null> {
  if (campaignNameCache.has(campaignId)) {
    return campaignNameCache.get(campaignId) ?? null;
  }
  let name: string | null = null;
  try {
    const campaign = await instantly.getCampaign(campaignId);
    name = campaign?.name?.trim() || null;
  } catch (err) {
    workerLog('warn', `Failed to fetch campaign name for ${campaignId}`, err);
  }
  campaignNameCache.set(campaignId, name);
  return name;
}

async function fetchRecentLinkedReplies(
  campaignIds: Set<string>,
): Promise<Email[]> {
  const maxPages = Math.max(
    1,
    Math.min(20, envNumber('INSTANTLY_LEADS_EMAIL_PAGES', 5)),
  );
  const replyEmails: Email[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await instantly.listEmails({
      ue_type: 2,
      limit: REPLY_EMAILS_PAGE_SIZE,
      starting_after: startingAfter,
    });
    const allEmails = res.items ?? [];
    const linkedReplies = allEmails.filter((e) => {
      const campaignId = e.campaign_id;
      return (e.ue_type ?? 2) === 2 && !!campaignId && campaignIds.has(campaignId);
    });
    workerLog(
      'info',
      `Reply page ${page + 1}: ${allEmails.length} replies fetched, ${linkedReplies.length} linked to Portal projects`,
    );
    replyEmails.push(...linkedReplies);

    startingAfter = res.next_starting_after || undefined;
    if (!startingAfter || allEmails.length === 0) break;
  }

  return replyEmails;
}

/**
 * Main polling function: fetches recent reply emails from the Instantly API,
 * keeps only replies for campaigns linked to Portal client projects, deduplicates
 * against already-processed records, and qualifies new ones via AI.
 * Returns the number of new replies qualified.
 */
export async function pollAndQualifyReplies(): Promise<number> {
  if (!supabaseAdmin) {
    workerLog('warn', 'supabaseAdmin not configured — skipping');
    return 0;
  }
  const db = supabaseAdmin;

  const apiKey = API_KEY();
  if (!apiKey) {
    workerLog('warn', 'No AI API key (OPENROUTER_INSTANTLY_LEAD_API_KEY / OPENROUTER_BRIEF_API_KEY) — skipping');
    return 0;
  }

  // 1. Only qualify campaigns that are tied to a Portal client project.
  const campaignIds = await getPortalLinkedCampaignIds();
  workerLog('info', `Portal-linked campaigns: ${campaignIds.length}`);
  if (campaignIds.length === 0) return 0;

  // 2. Fetch recent replies globally, then filter locally by Portal-linked campaign.
  // This avoids one Instantly API call per historical auto-linked campaign.
  const campaignIdSet = new Set(campaignIds);
  const replyEmails = await fetchRecentLinkedReplies(campaignIdSet);

  if (replyEmails.length === 0) {
    workerLog('info', 'No linked reply emails found');
    return 0;
  }

  // 3a. Deduplicate: skip reply emails that were already processed
  // Batch .in() queries to avoid PostgREST URL length limits
  const emailIds = replyEmails.map((e) => e.id).filter(Boolean) as string[];
  const existingIds = new Set<string>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < emailIds.length; i += BATCH_SIZE) {
    const batch = emailIds.slice(i, i + BATCH_SIZE);
    const { data: existing } = await db
      .from('instantly_lead_qualifications')
      .select('instantly_email_id')
      .in('instantly_email_id', batch);
    if (existing) {
      for (const r of existing) {
        existingIds.add((r as { instantly_email_id: string }).instantly_email_id);
      }
    }
  }

  let newReplies = replyEmails.filter((e) => e.id && !existingIds.has(e.id));

  // 3b. Within current batch: keep only the most recent reply per lead+campaign
  const latestByLead = new Map<string, (typeof newReplies)[0]>();
  for (const reply of newReplies) {
    const leadEmail = reply.from_address_email ?? '';
    const key = `${leadEmail}::${reply.campaign_id}`;
    const prev = latestByLead.get(key);
    if (!prev) {
      latestByLead.set(key, reply);
    } else {
      const prevTs = new Date(prev.timestamp_email ?? prev.timestamp_created ?? 0).getTime();
      const curTs = new Date(reply.timestamp_email ?? reply.timestamp_created ?? 0).getTime();
      if (curTs > prevTs) latestByLead.set(key, reply);
    }
  }
  newReplies = [...latestByLead.values()];

  if (newReplies.length === 0) return 0;

  workerLog('info', `Found ${newReplies.length} new linked reply(s) across ${campaignIds.length} Portal-linked campaign(s)`);

  // 4. Qualify each new reply (capped per tick to stay within rate limits)
  const interReplyDelay = Math.max(
    1000,
    envNumber('INSTANTLY_LEADS_INTER_REPLY_DELAY_MS', 3500),
  );
  let processed = 0;
  for (let i = 0; i < Math.min(newReplies.length, MAX_QUALIFY_PER_TICK); i++) {
    const reply = newReplies[i];
    if (i > 0) await new Promise((r) => setTimeout(r, interReplyDelay));
    try {
      await qualifyOneReply(db, reply, apiKey);
      processed++;
    } catch (err) {
      workerLog('error', `Failed to qualify reply ${reply.id}`, err);
      await db.from('instantly_lead_qualifications').insert({
        campaign_id: reply.campaign_id ?? 'unknown',
        lead_email: reply.from_address_email ?? 'unknown',
        thread_id: reply.thread_id,
        instantly_email_id: reply.id,
        status: 'error',
        error_message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return processed;
}

async function qualifyOneReply(
  db: NonNullable<typeof supabaseAdmin>,
  reply: Email,
  apiKey: string,
): Promise<void> {
  const campaignId = reply.campaign_id;
  const leadEmail =
    reply.from_address_email ??
    reply.to_address_email_list ??
    '';

  if (!campaignId || !leadEmail) return;

  if (!briefCache.has(campaignId)) {
    briefCache.set(campaignId, await fetchBriefByCampaign(campaignId));
  }
  const cachedBrief = briefCache.get(campaignId) ?? null;

  const result = await qualifyReply(campaignId, leadEmail, reply.thread_id, {
    apiKey,
    model: MODEL,
    briefText: cachedBrief,
  });

  const campaignName = await resolveCampaignName(campaignId);

  let leadName: string | undefined;
  let companyName: string | undefined;
  try {
    const leads = await instantly.getLeadsByEmail({ email: leadEmail, campaign_id: campaignId });
    const lead = leads?.[0];
    if (lead) {
      leadName =
        [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
      companyName = lead.company_name ?? undefined;
    }
  } catch {
    // lead metadata is optional enrichment
  }

  const replyText = result.threadContext
    ? getBodyText(result.threadContext.replyEmail.body)
    : getBodyText(reply.body);
  const lastOutText = result.threadContext?.lastOutbound
    ? getBodyText(result.threadContext.lastOutbound.body)
    : null;

  let status: string;
  if (result.needsReview) status = 'needs_review';
  else if (result.isLead) status = 'lead';
  else if (result.objectionHandleable) status = 'objection';
  else status = 'not_lead';

  // ВАЖНО: ловим error от upsert. Без этого тихий 42P10 («there is no unique
  // or exclusion constraint matching the ON CONFLICT specification») съедал
  // все классификации с ~6 мая 2026 — таблица оставалась пустой, AI крутился
  // вхолостую. Миграция 20260514_0001 заменила partial UNIQUE на full UNIQUE;
  // если ON CONFLICT снова сломается — теперь сразу будет видно в логах.
  const { data: inserted, error: upsertErr } = await db
    .from('instantly_lead_qualifications')
    .upsert(
      {
        campaign_id: campaignId,
        campaign_name: campaignName,
        lead_email: leadEmail,
        lead_name: leadName,
        company_name: companyName,
        thread_id: reply.thread_id,
        reply_subject: reply.subject ?? null,
        reply_preview: replyText.slice(0, 300) || null,
        reply_body: replyText || null,
        last_outbound_preview: lastOutText?.slice(0, 300) ?? null,
        last_outbound_ue_type: result.threadContext?.lastOutbound?.ue_type ?? null,
        status,
        proposal_seen: result.proposalSeen,
        interest_signals: result.interestSignals,
        ai_reason: result.reason,
        ai_confidence: result.confidence,
        instantly_email_id: reply.id,
        instantly_lead_id: null,
        reply_timestamp: reply.timestamp_email ?? null,
        objection_handleable: result.objectionHandleable,
        objection_draft: result.objectionDraft,
      },
      { onConflict: 'instantly_email_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (upsertErr) {
    workerLog(
      'error',
      `Upsert failed for ${leadEmail} (campaign ${campaignId}, email_id=${reply.id ?? 'null'}): ${upsertErr.message ?? String(upsertErr)} [code=${upsertErr.code ?? 'n/a'}]`,
    );
    // Не молча проглатываем — кидаем дальше, чтобы внешний catch в pollAndQualifyReplies
    // записал status='error' и проблема была видна и в БД, и в Telegram-алертах.
    throw new Error(`Upsert failed: ${upsertErr.message ?? 'unknown'}`);
  }

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status}${result.objectionHandleable ? ' [objection]' : ''} (confidence: ${result.confidence.toFixed(2)})${inserted?.id ? '' : ' [dedup-skip]'}`,
  );

  if (status === 'lead' && inserted?.id && supabaseMain) {
    await notifySpecialistsAboutLead(
      db,
      inserted.id,
      campaignId,
      leadEmail,
      leadName ?? null,
      companyName ?? null,
      campaignName,
      reply.subject ?? null,
      replyText || null,
      result.reason ?? null,
    );
  }
}

/**
 * Create in-app notifications for specialists responsible for this campaign's project.
 * Finds specialist via: campaign → project_instantly_campaigns → projects.specialist_user_id.
 * Falls back to user_instantly_campaign_preferences if no project link exists.
 * Also logs the 'specialist' level in deadline_notification_log for escalation.
 */
async function notifySpecialistsAboutLead(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  qualificationId: string,
  campaignId: string,
  leadEmail: string,
  leadName: string | null,
  companyName: string | null,
  campaignName: string | null,
  replySubject: string | null,
  replyPreview: string | null,
  aiReason: string | null,
): Promise<void> {
  if (!supabaseMain) return;

  try {
    const userIds = new Set<string>();
    let clientName: string | null = null;

    // Primary: find specialist via project link
    const { data: legacyLinks } = await instantlyDb
      .from('project_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);
    const { data: periodLinks } = await instantlyDb
      .from('project_period_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);

    const links = [...(periodLinks ?? []), ...(legacyLinks ?? [])];
    if (links?.length) {
      const projectIds = links.map((l: { project_id: string }) => l.project_id);
      const { data: projects } = await supabaseMain
        .from('projects')
        .select('specialist_user_id, client')
        .in('id', projectIds)
        .not('specialist_user_id', 'is', null);

      if (projects) {
        for (const p of projects) {
          if (p.specialist_user_id) userIds.add(p.specialist_user_id as string);
          const client = typeof p.client === 'string' ? p.client.trim() : '';
          if (client && !clientName) clientName = client;
        }
      }
    }

    // Раньше тут был fallback на user_instantly_campaign_preferences
    // (ручной выбор кампаний). Убран 16 мая 2026 вместе с UI-блоком:
    // worker и так квалифицирует только project-linked кампании
    // (getPortalLinkedCampaignIds), поэтому specialist_user_id проекта
    // — единственный реальный источник получателя.

    if (userIds.size === 0) {
      workerLog('warn', `No specialist found for campaign ${campaignId} — no lead notification sent`);
      return;
    }

    const userIdList = [...userIds];
    const contactLabel = leadName ?? leadEmail;
    const campaignLabel = campaignName ? ` (${campaignName})` : '';

    const rows = userIdList.map((uid) => ({
      user_id: uid,
      type: 'lead_new',
      title: 'Новый квалифицированный лид',
      body: `${contactLabel}${companyName ? ` — ${companyName}` : ''}${campaignLabel}`,
      entity_type: 'lead_qualification',
      entity_id: qualificationId,
    }));

    const { error: notifErr } = await supabaseMain
      .from('notifications')
      .insert(rows);

    if (notifErr) {
      workerLog('error', 'Failed to create lead notifications', notifErr.message);
      return;
    }

    await supabaseMain
      .from('deadline_notification_log')
      .upsert(
        {
          entity_type: 'lead_qualification',
          entity_id: qualificationId,
          level: 'specialist',
        },
        { onConflict: 'entity_type,entity_id,level' },
      );

    await sendTelegramLeadAlertForSpecialists({
      userIds: userIdList,
      qualificationId,
      campaignId,
      leadEmail,
      leadName,
      companyName,
      campaignName,
      clientName,
      replySubject,
      replyPreview,
      aiReason,
    });

    workerLog('info', `Created lead notifications for ${userIds.size} specialist(s)`);
  } catch (err) {
    workerLog('error', 'Error creating lead notifications', err);
  }
}

async function sendTelegramLeadAlertForSpecialists(data: {
  userIds: string[];
  qualificationId: string;
  campaignId: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  campaignName: string | null;
  clientName: string | null;
  replySubject: string | null;
  replyPreview: string | null;
  aiReason: string | null;
}): Promise<void> {
  if (!supabaseMain) return;

  try {
    const { data: profiles } = await supabaseMain
      .from('profiles')
      .select('id, full_name, email')
      .in('id', data.userIds);

    const { data: links } = await supabaseMain
      .from('telegram_links')
      .select('user_id, telegram_id, telegram_username')
      .in('user_id', data.userIds);

    const profilesById = new Map(
      (profiles ?? []).map((profile) => [
        profile.id as string,
        profile as { id: string; full_name?: string | null; email?: string | null },
      ]),
    );
    const linksByUserId = new Map(
      (links ?? []).map((link) => [
        link.user_id as string,
        link as { user_id: string; telegram_id?: string | number | null; telegram_username?: string | null },
      ]),
    );

    const specialistMentions: LeadTelegramSpecialistMention[] = data.userIds.map((userId) => {
      const profile = profilesById.get(userId);
      const link = linksByUserId.get(userId);
      return {
        userId,
        fullName: profile?.full_name ?? profile?.email ?? null,
        telegramId: link?.telegram_id ?? null,
        telegramUsername: link?.telegram_username ?? null,
      };
    });

    const result = await sendLeadTelegramAlert({
      qualificationId: data.qualificationId,
      campaignId: data.campaignId,
      leadEmail: data.leadEmail,
      leadName: data.leadName,
      companyName: data.companyName,
      campaignName: data.campaignName,
      clientName: data.clientName,
      specialistMentions,
      replySubject: data.replySubject,
      replyPreview: data.replyPreview,
      aiReason: data.aiReason,
    });

    if (!result.sent) {
      workerLog('warn', `Telegram lead alert skipped or failed for qualification ${data.qualificationId}`);
    }
  } catch (err) {
    workerLog('error', 'Error sending Telegram lead alert', err);
  }
}
