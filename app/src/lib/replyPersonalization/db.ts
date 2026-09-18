// Слой доступа к данным инструмента. Читает из instantly_lead_qualifications
// / project_instantly_campaigns / project_period_instantly_campaigns
// исключительно SELECT — никогда не пишет туда и не импортирует бизнес-логику
// квалификатора (leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { DraftRow, DraftStatus, GlobalKnowledgeBase, KnowledgeBase, QualificationRow } from './types';

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
export async function listVisibleProjects(userId: string): Promise<{
  /** briefText — бриф из карточки проекта: по нему видно, чего проекту не хватает. */
  projects: { id: string; client: string; briefText: string }[];
  /** Руководитель (admin/director/lead/manager) — может редактировать глобальный тон/пример. */
  supervisor: boolean;
}> {
  const { admin } = requireClients();
  const supervisor = await isSupervisor(userId);

  let query = admin
    .from('projects')
    .select('id, client, name, specialist, specialist_user_id, brief_text')
    .in('status', ['В работе', 'Тестирование', 'Подготовка'])
    .order('client');
  if (!supervisor) query = query.eq('specialist_user_id', userId);

  const { data, error } = await query;
  if (error) throw new Error(`projects query failed: ${error.message}`);
  return {
    projects: (data ?? []).map((p) => ({
      id: p.id as string,
      client: (p.client as string) ?? (p.name as string) ?? '',
      briefText: (p.brief_text as string) ?? '',
    })),
    supervisor,
  };
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

/**
 * Instantly-аккаунт каждой кампании — из каталога, который синк заполняет по
 * всем аккаунтам. Кампания, ещё не попавшая в каталог, считается основной.
 */
export async function getCampaignAccountIds(campaignIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!campaignIds.length) return result;
  // Каталог с аккаунтами ведёт синк в базе Instantly (instantly-migrations,
  // 20260520_0001). В основной базе лежит старая копия таблицы без колонки
  // instantly_account_id — запрос туда ронял список писем любого проекта.
  const { instantly } = requireClients();
  const { data, error } = await instantly
    .from('instantly_campaign_catalog')
    .select('id, instantly_account_id')
    .in('id', campaignIds);
  if (error) throw new Error(`campaign catalog query failed: ${error.message}`);
  for (const row of data ?? []) {
    result.set(row.id as string, (row.instantly_account_id as string) || 'main');
  }
  for (const id of campaignIds) if (!result.has(id)) result.set(id, 'main');
  return result;
}

/**
 * Бриф из карточки проекта — основной источник для генерации ответов. Читается
 * живьём, а не копируется в базу знаний инструмента: карточку ведут менеджеры
 * проекта, и она остаётся источником истины.
 *
 * Пустая строка здесь не тупик: у базы знаний есть запасной `localBrief`,
 * который специалист заполняет прямо в модалке, когда карточка ещё пуста,
 * а отвечать лиду нужно сейчас. Приоритет — у карточки (см. resolveBrief).
 */
export async function getProjectBrief(projectId: string): Promise<string> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('projects')
    .select('brief_text')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new Error(`project brief query failed: ${error.message}`);
  return (data?.brief_text as string) ?? '';
}

/**
 * Какой бриф уходит в генерацию. Карточка проекта побеждает всегда: локальное
 * поле — это запас на время, пока карточку не заполнили, и оно не должно
 * незаметно переопределять то, что менеджеры ведут в проекте.
 */
export function resolveBrief(projectBrief: string, kb: KnowledgeBase | null): string {
  return projectBrief.trim() ? projectBrief : (kb?.localBrief ?? '');
}

/**
 * Запасные брифы из базы знаний по списку проектов — одним запросом, для
 * пометок в списке проектов (раньше там был запрос на каждый проект).
 */
export async function getLocalBriefs(projectIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!projectIds.length) return result;
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_kb')
    .select('project_id, local_brief')
    .in('project_id', projectIds);
  if (error) throw new Error(`kb query failed: ${error.message}`);
  for (const row of data ?? []) result.set(row.project_id as string, (row.local_brief as string) ?? '');
  return result;
}

/**
 * Что мешает собирать ответы по проекту. Единственное обязательное — бриф:
 * тон и пример письма подстрахованы глобальными настройками студии, а без
 * брифа ИИ не из чего взять, что за продукт и кому он продаётся.
 *
 * Раньше «готовность» считалась по наличию строки базы знаний — и все проекты
 * с брифом в карточке, но без сохранённой модалки, числились незаполненными,
 * а генерация им отказывала.
 */
export function missingBriefReason(projectBrief: string, localBrief: string | null | undefined): string | null {
  if (projectBrief.trim() || (localBrief ?? '').trim()) return null;
  return 'В карточке проекта нет брифа';
}

/** База знаний проекта; проекта без сохранённой модалки — пустая, не null. */
export async function getKnowledgeBaseOrEmpty(projectId: string): Promise<KnowledgeBase> {
  return (
    (await getKnowledgeBase(projectId)) ?? {
      projectId,
      productFacts: '',
      toneNotes: '',
      exampleCase: '',
      localBrief: '',
      updatedAt: '',
    }
  );
}

export async function getKnowledgeBase(projectId: string): Promise<KnowledgeBase | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_kb')
    .select('project_id, product_facts, tone_notes, example_case, local_brief, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw new Error(`kb query failed: ${error.message}`);
  if (!data) return null;
  return {
    projectId: data.project_id as string,
    productFacts: (data.product_facts as string) ?? '',
    toneNotes: (data.tone_notes as string) ?? '',
    exampleCase: (data.example_case as string) ?? '',
    localBrief: (data.local_brief as string) ?? '',
    updatedAt: data.updated_at as string,
  };
}

export async function upsertKnowledgeBase(
  projectId: string,
  patch: Pick<KnowledgeBase, 'productFacts' | 'toneNotes' | 'exampleCase' | 'localBrief'>,
  userId: string,
): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_kb').upsert(
    {
      project_id: projectId,
      product_facts: patch.productFacts,
      tone_notes: patch.toneNotes,
      example_case: patch.exampleCase,
      local_brief: patch.localBrief,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id' },
  );
  if (error) throw new Error(`kb upsert failed: ${error.message}`);
}

const EMPTY_GLOBAL: GlobalKnowledgeBase = { toneNotes: '', exampleCase: '', updatedAt: '' };

/** Глобальный тон/пример — singleton id=1, для всех проектов сразу. */
export async function getGlobalKnowledgeBase(): Promise<GlobalKnowledgeBase> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_global_kb')
    .select('tone_notes, example_case, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`global kb query failed: ${error.message}`);
  if (!data) return { ...EMPTY_GLOBAL };
  return {
    toneNotes: (data.tone_notes as string) ?? '',
    exampleCase: (data.example_case as string) ?? '',
    updatedAt: (data.updated_at as string) ?? '',
  };
}

export async function upsertGlobalKnowledgeBase(
  patch: Pick<GlobalKnowledgeBase, 'toneNotes' | 'exampleCase'>,
  userId: string,
): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_global_kb').upsert(
    {
      id: 1,
      tone_notes: patch.toneNotes,
      example_case: patch.exampleCase,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(`global kb upsert failed: ${error.message}`);
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

/** Read-only: уже синхронизированные квалификатором ответы (кампании проектов квалификатор читает только с 'main'). */
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

/**
 * Неотправленный черновик ИИ по письму — чтобы вернуть его в поле ответа,
 * когда менеджер ушёл в другое письмо и вернулся. Каждая генерация стоит
 * денег, и терять её из-за переключения чата нельзя.
 * Берём только если самая свежая запись по письму — черновик ИИ: после
 * отправки или пропуска старый черновик уже не нужен. Ручные записи
 * (model='manual') — техническая обёртка отправки, не черновик.
 */
export async function getOpenDraft(qualificationId: string): Promise<DraftRow | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .select()
    .eq('qualification_id', qualificationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`open draft lookup failed: ${error.message}`);
  if (!data) return null;
  const draft = mapDraftRow(data);
  if (draft.status !== 'draft' || draft.model === 'manual' || !draft.generatedText?.trim()) return null;
  return draft;
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

/**
 * Пишет в черновик финальный (отредактированный сотрудником) текст ДО
 * физической отправки: журнал хранит ровно то, что ушло адресату, а повторная
 * попытка после сбоя отправляет тот же текст, а не оригинал генерации.
 */
export async function updateDraftText(draftId: string, text: string): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin
    .from('reply_personalization_drafts')
    .update({ generated_text: text })
    .eq('id', draftId);
  if (error) throw new Error(`draft text-update failed: ${error.message}`);
}
