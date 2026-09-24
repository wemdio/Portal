import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { fetchReplyThread } from '@/lib/replyPersonalization/instantlyThread';
import { resolveProjectReply } from '@/lib/replyPersonalization/projectReply';
import { findReferredEmails } from '@/lib/replyPersonalization/referredContact';
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

export const GET = withAuth(async (req: NextRequest, _user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const cached = THREAD_CACHE.get(qualificationId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({
      messages: cached.messages,
      contextComplete: cached.contextComplete,
      referredEmails: cached.referredEmails,
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
  THREAD_CACHE.set(qualificationId, { messages, contextComplete, referredEmails, expiresAt: Date.now() + CACHE_TTL_MS });

  return NextResponse.json({ messages, contextComplete, referredEmails });
});
