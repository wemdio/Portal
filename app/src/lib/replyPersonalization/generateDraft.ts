import { buildReplyPrompt } from './buildPrompt';
import { fetchCampaignSteps } from './campaignSequence';
import { getGlobalKnowledgeBase, getGlobalSystemPrompt, getKnowledgeBaseOrEmpty, getProjectBrief, insertDraft, resolveBrief } from './db';
import { generateReplyWithSearch } from './geminiClient';
import { fetchReplyThread } from './instantlyThread';
import { resolveProjectReply } from './projectReply';
import { findReferredEmails } from './referredContact';
import type { GenerateDraftResult, ThreadMessage } from './types';

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
): Promise<GenerateDraftResult> {
  const startedAt = Date.now();

  const [kb, projectBrief, globalKb, systemPrompt] = await Promise.all([
    getKnowledgeBaseOrEmpty(projectId),
    getProjectBrief(projectId),
    getGlobalKnowledgeBase(),
    getGlobalSystemPrompt(),
  ]);
  // Карточка проекта в приоритете; её запасной вариант из модалки нужен, пока
  // бриф там не заполнен, иначе ответить лиду сегодня было бы нечем. Без брифа
  // ИИ не из чего взять суть продукта — это единственный повод отказать:
  // тон и пример подстрахованы глобальными настройками.
  const brief = resolveBrief(projectBrief, kb);
  if (!brief.trim()) {
    throw new GenerateDraftError('В карточке проекта нет брифа — заполните его там или в базе знаний проекта', 409);
  }

  const reply = await resolveProjectReply(projectId, qualificationId);
  if (!reply) throw new GenerateDraftError('Письмо не найдено', 404);
  const { qualification, accountId } = reply;

  let contextComplete = true;
  const [fullThread, campaignSteps] = await Promise.all([
    fetchReplyThread(qualification, accountId),
    fetchCampaignSteps(qualification.campaignId, accountId),
  ]);
  let thread: ThreadMessage[] | null = fullThread;
  if (!thread) {
    contextComplete = false;
    thread = fallbackThread(qualification);
  }
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
