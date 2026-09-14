import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getQualificationById } from '@/lib/replyPersonalization/db';
import { fetchFullThread } from '@/lib/replyPersonalization/instantlyThread';
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
    return NextResponse.json({ messages: cached.messages, contextComplete: cached.contextComplete });
  }

  const kb = await getKnowledgeBase(projectId);
  if (!kb) return NextResponse.json({ error: 'У проекта не заполнена база знаний' }, { status: 409 });

  const qualification = await getQualificationById(qualificationId);
  if (!qualification) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });

  let contextComplete = true;
  let messages: ThreadMessage[] | null = null;
  if (qualification.threadId) {
    messages = await fetchFullThread({
      campaignId: qualification.campaignId,
      leadEmail: qualification.leadEmail,
      threadId: qualification.threadId,
      accountId: kb.instantlyAccountId,
    });
  }
  if (!messages || messages.length === 0) {
    contextComplete = false;
    messages = fallbackThread(qualification);
  }

  pruneCache();
  THREAD_CACHE.set(qualificationId, { messages, contextComplete, expiresAt: Date.now() + CACHE_TTL_MS });

  return NextResponse.json({ messages, contextComplete });
});
