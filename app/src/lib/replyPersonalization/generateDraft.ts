import { buildReplyPrompt } from './buildPrompt';
import { fetchCampaignSteps } from './campaignSequence';
import {
  getGlobalKnowledgeBase,
  getGlobalSystemPrompt,
  getKnowledgeBaseOrEmpty,
  getProjectBrief,
  insertDraft,
  listSentDrafts,
  resolveBrief,
} from './db';
import { generateReplyWithSearch } from './geminiClient';
import { fetchReplyThread, withSentDrafts } from './instantlyThread';
import { resolveProjectReply } from './projectReply';
import { findReferredEmails } from './referredContact';
import type { GenerateDraftResult, ReplyLanguage, ThreadMessage } from './types';

export class GenerateDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function fallbackThread(reply: { replyBody: string | null; lastOutboundPreview: string | null }): ThreadMessage[] {
  const thread: ThreadMessage[] = [];
  if (reply.lastOutboundPreview) thread.push({ fromUs: true, text: reply.lastOutboundPreview });
  if (reply.replyBody) thread.push({ fromUs: false, text: reply.replyBody });
  return thread;
}

/**
 * projectId передаётся явно вызывающим роутом (URL/тело запроса уже содержит
 * его — и он же используется для проверки доступа пользователя ДО вызова
 * этой функции), поэтому здесь не резолвится заново.
 *
 * qualificationId может быть как uuid из instantly_lead_qualifications
 * (аккаунт 'main'), так и строкой instantly_email_id (живой список с другого
 * аккаунта): для 'main' письмо достаётся из таблицы, для живого — напрямую
 * из Instantly при получении треда.
 */
export async function generateDraftForQualification(
  projectId: string,
  qualificationId: string,
  userId: string,
  /** Новый контакт из ответа адресата; null/пусто — ответ в ту же переписку. */
  recipientEmail: string | null = null,
  /** Язык письма из переключателя в чате; по умолчанию русский. */
  language: ReplyLanguage = 'ru',
): Promise<GenerateDraftResult> {
  const startedAt = Date.now();

  const [kb, projectBrief, globalKb, systemPrompt] = await Promise.all([
    getKnowledgeBaseOrEmpty(projectId),
    getProjectBrief(projectId),
    getGlobalKnowledgeBase(),
    getGlobalSystemPrompt(),
  ]);
  // Карточка проекта в приоритете; её запасной вариант из модалки нужен, пока
  // бриф там не заполнен. Пустой бриф с 06.10.2026 не повод отказать: ИИ
  // соберёт черновик из общих кейсов и тона, а суть предложения возьмёт из
  // наших писем в переписке и шагов кампании (см. buildPrompt). Специалист всё
  // равно правит текст перед отправкой.
  const brief = resolveBrief(projectBrief, kb);

  const reply = await resolveProjectReply(projectId, qualificationId);
  if (!reply) throw new GenerateDraftError('Письмо не найдено', 404);
  const { qualification, accountId } = reply;

  let contextComplete = true;
  const [fullThread, campaignSteps, sent] = await Promise.all([
    fetchReplyThread(qualification, accountId),
    fetchCampaignSteps(qualification.campaignId, accountId),
    listSentDrafts(qualificationId),
  ]);
  let thread: ThreadMessage[] | null = fullThread;
  if (!thread) {
    contextComplete = false;
    thread = fallbackThread(qualification);
  }
  // Наши ответы из портала — как на экране переписки: Instantly их может ещё
  // не показывать, и без них ИИ отвечал заново на уже отвеченную реплику.
  thread = withSentDrafts(thread, sent);
  if (thread.length === 0) {
    throw new GenerateDraftError('Нет текста переписки для генерации ответа', 422);
  }

  // Новый адрес принимаем, только если он есть в ответе адресата: иначе через
  // инструмент можно было бы написать от имени проекта кому угодно.
  const recipient = recipientEmail?.trim().toLowerCase() || null;
  if (recipient && recipient !== qualification.leadEmail.toLowerCase()) {
    const lastInbound = [...thread].reverse().find((m) => !m.fromUs)?.text ?? qualification.replyBody ?? '';
    const referred = findReferredEmails(lastInbound, [qualification.leadEmail, qualification.eaccount]);
    if (!referred.includes(recipient)) {
      throw new GenerateDraftError('Этого адреса нет в ответе адресата', 422);
    }
  }
  const newContact = recipient && recipient !== qualification.leadEmail.toLowerCase() ? recipient : null;

  const messages = buildReplyPrompt({
    kb,
    globalKb,
    systemPrompt,
    brief,
    qualification,
    thread,
    contextComplete,
    campaignSteps,
    recipientEmail: newContact,
    language,
  });
  const result = await generateReplyWithSearch(messages);

  const draft = await insertDraft({
    projectId,
    qualificationId,
    campaignId: qualification.campaignId,
    threadId: qualification.threadId,
    leadEmail: qualification.leadEmail,
    generatedText: result.text,
    factsUsed: result.sources.map((s) => s.title || s.url).join(', '),
    sources: result.sources,
    contextComplete,
    model: result.model,
    latencyMs: Date.now() - startedAt,
    createdBy: userId,
    recipientEmail: newContact,
  });

  return {
    draftId: draft.id,
    text: draft.generatedText ?? '',
    factsUsed: draft.factsUsed ?? '',
    sources: draft.sources,
    contextComplete: draft.contextComplete,
    recipientEmail: draft.recipientEmail,
  };
}
