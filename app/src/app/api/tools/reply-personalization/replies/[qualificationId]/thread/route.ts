import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { fetchReplyThread } from '@/lib/replyPersonalization/instantlyThread';
import { resolveProjectReply } from '@/lib/replyPersonalization/projectReply';
import { findReferredEmails } from '@/lib/replyPersonalization/referredContact';
import { getThreadLanguage, listSentDrafts } from '@/lib/replyPersonalization/db';
import type { ThreadMessage } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

/**
 * GET — полный тред переписки по письму для правой панели «как в мессенджере».
 * Один клик по письму = максимум один живой запрос LIST /emails (тот же
 * примитив, что и при генерации), результат кэшируется на 5 минут — листание
 * туда-сюда по списку писем не расходует бюджет Instantly повторно.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedThread {
  messages: ThreadMessage[];
  contextComplete: boolean;
  referredEmails: string[];
  expiresAt: number;
}

const THREAD_CACHE = new Map<string, CachedThread>();

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of THREAD_CACHE) {
    if (entry.expiresAt <= now) THREAD_CACHE.delete(key);
  }
}

function fallbackThread(reply: { replyBody: string | null; lastOutboundPreview: string | null }): ThreadMessage[] {
  const thread: ThreadMessage[] = [];
  if (reply.lastOutboundPreview) thread.push({ fromUs: true, text: reply.lastOutboundPreview });
  if (reply.replyBody) thread.push({ fromUs: false, text: reply.replyBody });
  return thread;
}

/**
 * Только буквы и цифры: копия письма из Instantly приходит из HTML, и знаки
 * препинания, кавычки и переносы в ней отличаются от того, что мы отправляли.
 */
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Дописывает в тред наши отправленные ответы, которых в нём ещё нет.
 *
 * Instantly показывает только что отправленное письмо в треде с задержкой (а
 * сам тред мы ещё и кэшируем на 5 минут), поэтому после «Отправить» переписка
 * выглядела так, будто ответа не было: менялся только статус в списке слева.
 * Журнал отправок — наш, и он точно знает, что ушло.
 *
 * Сверяем по началу текста: копия из Instantly содержит наш текст плюс
 * процитированную историю переписки, поэтому равенство строк не подходит.
 */
function withSentDrafts(messages: ThreadMessage[], sent: { text: string; sentAt: string }[]): ThreadMessage[] {
  const result = [...messages];
  for (const draft of sent) {
    const key = normalize(draft.text).slice(0, 120);
    if (!key) continue;
    if (result.some((m) => m.fromUs && normalize(m.text).includes(key))) continue;
    result.push({ fromUs: true, text: draft.text, timestamp: draft.sentAt || undefined });
  }
  return result;
}

export const GET = withAuth(async (req: NextRequest, _user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  // Отправленное нами и язык переписки читаем всегда мимо кэша треда: это наши
  // же данные, они меняются от кнопки «Отправить» и переключателя языка.
  const [sent, language] = await Promise.all([
    listSentDrafts(qualificationId),
    getThreadLanguage(qualificationId),
  ]);

  const cached = THREAD_CACHE.get(qualificationId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({
      messages: withSentDrafts(cached.messages, sent),
      contextComplete: cached.contextComplete,
      referredEmails: cached.referredEmails,
      language,
    });
  }

  const reply = await resolveProjectReply(projectId, qualificationId);
  if (!reply) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });
  const { qualification, accountId } = reply;

  let contextComplete = true;
  let messages: ThreadMessage[] | null = await fetchReplyThread(qualification, accountId);
  if (!messages || messages.length === 0) {
    contextComplete = false;
    messages = fallbackThread(qualification);
  }

  // Новый контакт ищем в последнем ответе адресата: «пишите Екатерине, почта ...».
  const lastInbound = [...messages].reverse().find((m) => !m.fromUs)?.text ?? qualification.replyBody ?? '';
  const referredEmails = findReferredEmails(lastInbound, [qualification.leadEmail, qualification.eaccount]);

  pruneCache();
  // В кэш кладём то, что пришло из Instantly: наши отправки дописываются поверх
  // при каждой отдаче, иначе свежий ответ застревал бы в кэше на пять минут.
  THREAD_CACHE.set(qualificationId, { messages, contextComplete, referredEmails, expiresAt: Date.now() + CACHE_TTL_MS });

  return NextResponse.json({
    messages: withSentDrafts(messages, sent),
    contextComplete,
    referredEmails,
    language,
  });
});
