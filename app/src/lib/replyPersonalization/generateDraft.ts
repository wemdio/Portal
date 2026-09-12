import { buildReplyPrompt } from './buildPrompt';
import { getKnowledgeBase, getQualificationById, insertDraft } from './db';
import { generateReplyWithSearch } from './geminiClient';
import { fetchFullThread } from './instantlyThread';
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
): Promise<GenerateDraftResult> {
  const startedAt = Date.now();

  const kb = await getKnowledgeBase(projectId);
  if (!kb) throw new GenerateDraftError('У проекта не заполнена база знаний', 409);

  const qualification = await getQualificationById(qualificationId);
  if (!qualification) throw new GenerateDraftError('Письмо не найдено', 404);

  let contextComplete = true;
  let thread: ThreadMessage[] | null = null;
  if (qualification.threadId) {
    thread = await fetchFullThread({
      campaignId: qualification.campaignId,
      leadEmail: qualification.leadEmail,
      threadId: qualification.threadId,
      accountId: kb.instantlyAccountId,
    });
  }
  if (!thread) {
    contextComplete = false;
    thread = fallbackThread(qualification);
  }
  if (thread.length === 0) {
    throw new GenerateDraftError('Нет текста переписки для генерации ответа', 422);
  }

  const messages = buildReplyPrompt({ kb, qualification, thread, contextComplete });
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
    model: process.env.REPLY_PERSONALIZATION_MODEL_ID ?? 'vertex/google/gemini-3-pro-preview',
    latencyMs: Date.now() - startedAt,
    createdBy: userId,
  });

  return {
    draftId: draft.id,
    text: draft.generatedText ?? '',
    factsUsed: draft.factsUsed ?? '',
    sources: draft.sources,
    contextComplete: draft.contextComplete,
  };
}
