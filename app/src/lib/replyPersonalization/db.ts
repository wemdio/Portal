// Слой доступа к данным инструмента. Читает из instantly_lead_qualifications
// / project_instantly_campaigns / project_period_instantly_campaigns
// исключительно SELECT — никогда не пишет туда и не импортирует бизнес-логику
// квалификатора (leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { DraftRow, DraftStatus, KnowledgeBase, QualificationRow } from './types';

export function requireClients() {
  if (!supabaseAdmin || !supabaseInstantly) {
    throw new Error('Server misconfigured: supabaseAdmin/supabaseInstantly missing');
  }
  return { admin: supabaseAdmin, instantly: supabaseInstantly };
}

const SUPERVISOR_ROLES = ['admin', 'director', 'lead', 'manager'];

export async function isSupervisor(userId: string): Promise<boolean> {
  const { admin } = requireClients();
  const { data } = await admin.from('profiles').select('role').eq('id', userId).single();
  return SUPERVISOR_ROLES.includes((data?.role as string) ?? '');
}

/** Проекты, видимые пользователю — тот же критерий, что у /api/instantly/my-projects. */
export async function listVisibleProjects(userId: string) {
  const { admin } = requireClients();
  const supervisor = await isSupervisor(userId);

  let query = admin
    .from('projects')
    .select('id, client, name, specialist, specialist_user_id')
    .in('status', ['В работе', 'Тестирование', 'Подготовка'])
    .order('client');
  if (!supervisor) query = query.eq('specialist_user_id', userId);

  const { data, error } = await query;
  if (error) throw new Error(`projects query failed: ${error.message}`);
  return (data ?? []).map((p) => ({
    id: p.id as string,
    client: (p.client as string) ?? (p.name as string) ?? '',
  }));
}

/** Кампании проекта — тот же join, что у /api/instantly/my-projects. */
export async function getProjectCampaignIds(projectId: string): Promise<string[]> {
  const { instantly } = requireClients();
  const [legacy, period] = await Promise.all([
    instantly.from('project_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
    instantly.from('project_period_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
  ]);
  const ids = new Set<string>();
  for (const row of legacy.data ?? []) if (row.campaign_id) ids.add(row.campaign_id as string);
  for (const row of period.data ?? []) if (row.campaign_id) ids.add(row.campaign_id as string);
  return [...ids];
}

export async function getKnowledgeBase(projectId: string): Promise<KnowledgeBase | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_kb')
    .select('project_id, brief, product_facts, tone_notes, example_case, instantly_account_id, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw new Error(`kb query failed: ${error.message}`);
  if (!data) return null;
  return {
    projectId: data.project_id as string,
    brief: (data.brief as string) ?? '',
    productFacts: (data.product_facts as string) ?? '',
    toneNotes: (data.tone_notes as string) ?? '',
    exampleCase: (data.example_case as string) ?? '',
    instantlyAccountId: (data.instantly_account_id as string) ?? 'main',
    updatedAt: data.updated_at as string,
  };
}

export async function upsertKnowledgeBase(
  projectId: string,
  patch: Pick<KnowledgeBase, 'brief' | 'productFacts' | 'toneNotes' | 'exampleCase' | 'instantlyAccountId'>,
  userId: string,
): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_kb').upsert(
    {
      project_id: projectId,
      brief: patch.brief,
      product_facts: patch.productFacts,
      tone_notes: patch.toneNotes,
      example_case: patch.exampleCase,
      instantly_account_id: patch.instantlyAccountId || 'main',
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id' },
  );
  if (error) throw new Error(`kb upsert failed: ${error.message}`);
}

function mapQualificationRow(row: Record<string, unknown>): QualificationRow {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    campaignName: (row.campaign_name as string) ?? null,
    leadEmail: row.lead_email as string,
    companyName: (row.company_name as string) ?? null,
    threadId: (row.thread_id as string) ?? null,
    replySubject: (row.reply_subject as string) ?? null,
    replyBody: (row.reply_body as string) ?? null,
    lastOutboundPreview: (row.last_outbound_preview as string) ?? null,
    instantlyEmailId: (row.instantly_email_id as string) ?? null,
    eaccount: (row.eaccount as string) ?? null,
    replyTimestamp: (row.reply_timestamp as string) ?? null,
  };
}

const QUALIFICATION_COLUMNS =
  'id, campaign_id, campaign_name, lead_email, company_name, thread_id, reply_subject, reply_body, last_outbound_preview, instantly_email_id, eaccount, reply_timestamp';

/** Read-only: уже синхронизированные квалификатором ответы (только account 'main', см. §«Отклонения»). */
export async function listSyncedQualifications(campaignIds: string[], limit = 50): Promise<QualificationRow[]> {
  if (!campaignIds.length) return [];
  const { instantly } = requireClients();
  const { data, error } = await instantly
    .from('instantly_lead_qualifications')
    .select(QUALIFICATION_COLUMNS)
    .in('campaign_id', campaignIds)
    .order('reply_timestamp', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`qualifications query failed: ${error.message}`);
  return (data ?? []).map(mapQualificationRow);
}

export async function getQualificationById(id: string): Promise<QualificationRow | null> {
  const { instantly } = requireClients();
  const { data, error } = await instantly
    .from('instantly_lead_qualifications')
    .select(QUALIFICATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`qualification lookup failed: ${error.message}`);
  return data ? mapQualificationRow(data) : null;
}

/** Последний статус на каждый qualification_id ('skipped' исключается из выдачи целиком в вызывающем коде). */
export async function getLatestDraftStatuses(
  qualificationIds: string[],
): Promise<Record<string, DraftStatus>> {
  if (!qualificationIds.length) return {};
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .select('qualification_id, status, created_at')
    .in('qualification_id', qualificationIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`draft status query failed: ${error.message}`);
  const result: Record<string, DraftStatus> = {};
  for (const row of data ?? []) {
    const qid = row.qualification_id as string;
    if (!(qid in result)) result[qid] = row.status as DraftStatus;
  }
  return result;
}

function mapDraftRow(row: Record<string, unknown>): DraftRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    qualificationId: row.qualification_id as string,
    status: row.status as DraftStatus,
    generatedText: (row.generated_text as string) ?? null,
    factsUsed: (row.facts_used as string) ?? null,
    sources: (row.sources as { url: string; title?: string }[]) ?? [],
    contextComplete: (row.context_complete as boolean) ?? true,
    model: (row.model as string) ?? null,
    createdAt: row.created_at as string,
    sentAt: (row.sent_at as string) ?? null,
  };
}

export async function insertDraft(input: {
  projectId: string;
  qualificationId: string;
  campaignId: string;
  threadId: string | null;
  leadEmail: string;
  generatedText: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
  model: string;
  latencyMs: number;
  createdBy: string;
}): Promise<DraftRow> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .insert({
      project_id: input.projectId,
      qualification_id: input.qualificationId,
      campaign_id: input.campaignId,
      thread_id: input.threadId,
      lead_email: input.leadEmail,
      status: 'draft',
      generated_text: input.generatedText,
      facts_used: input.factsUsed,
      sources: input.sources,
      context_complete: input.contextComplete,
      model: input.model,
      latency_ms: input.latencyMs,
      created_by: input.createdBy,
    })
    .select()
    .single();
  if (error) throw new Error(`draft insert failed: ${error.message}`);
  return mapDraftRow(data);
}

export async function insertSkip(input: {
  projectId: string;
  qualificationId: string;
  campaignId: string;
  threadId: string | null;
  leadEmail: string;
  createdBy: string;
}): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_drafts').insert({
    project_id: input.projectId,
    qualification_id: input.qualificationId,
    campaign_id: input.campaignId,
    thread_id: input.threadId,
    lead_email: input.leadEmail,
    status: 'skipped',
    created_by: input.createdBy,
  });
  if (error) throw new Error(`skip insert failed: ${error.message}`);
}

export async function getDraftById(draftId: string): Promise<DraftRow | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .select()
    .eq('id', draftId)
    .maybeSingle();
  if (error) throw new Error(`draft lookup failed: ${error.message}`);
  return data ? mapDraftRow(data) : null;
}

export async function markDraftSent(draftId: string): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin
    .from('reply_personalization_drafts')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', draftId);
  if (error) throw new Error(`draft sent-update failed: ${error.message}`);
}
