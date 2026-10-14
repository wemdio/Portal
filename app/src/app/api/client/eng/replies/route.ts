import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logInfo } from '@/lib/loggerServer';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  HE_ENG_REPLIES_MAX_PAGE_SIZE,
  HE_ENG_REPLIES_PAGE_SIZE,
  parseHeEngRepliesCursor,
  readHeEngReplies,
  readHeEngReplyCampaigns,
  readHeEngReplyMailboxes,
} from '@/lib/hypothesisEngine/engReplies';
import { engServerError } from '../_shared';

export const dynamic = 'force-dynamic';

/** Один текст на все сбои чтения ленты — подробности в application_logs. */
const REPLIES_LOAD_FAILED = 'Failed to load replies';
const REPLIES_BAD_PAGE = 'This page of replies cannot be opened. Reload the page.';

/** Проектов клиента в выборке — тот же кап, что у дашборда. */
const PROJECTS_LIMIT = 100;

/**
 * GET — ответы на кампании ENG-клиента (кабинет /client/eng/replies): только
 * чтение, свежие сверху, страницами по курсору (`before_at` + `before_id` из
 * `next` прошлого ответа; `limit` — до HE_ENG_REPLIES_MAX_PAGE_SIZE).
 *
 * Скоуп владельца — здесь: проекты строго свои (created_by = user id), их
 * кампании — из he_templates.launch_info (lib/hypothesisEngine/engReplies).
 * Ответ, пришедший на ящик не этого клиента, не отдаётся: ящики клиента —
 * пул его проектов и пресеты его запусков (client_user_id = user id), правило
 * — то же, что у RU-поверхностей ответов (шапка engReplies.ts, «ЧУЖОЙ ЯЩИК»);
 * скрытые — в application_logs (client.eng.replies.foreign_mailbox_hidden; у RU
 * — client.replies.foreign_mailbox_hidden).
 * Источник ответов и чего в нём нет — шапка engReplies.ts; рассыльщика роут не
 * зовёт вовсе.
 *
 * `campaigns` — сколько запущенных кампаний у клиента: 0 — кабинет говорит
 * «кампаний ещё нет», а не «ответов нет».
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const url = new URL(req.url);
  const before = parseHeEngRepliesCursor(url.searchParams.get('before_at'), url.searchParams.get('before_id'));
  if (before === 'invalid') return jsonError(REPLIES_BAD_PAGE, 400);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, HE_ENG_REPLIES_MAX_PAGE_SIZE)
    : HE_ENG_REPLIES_PAGE_SIZE;

  const { data: projects, error: projectsError } = await supabaseAdmin
    .from('he_projects')
    .select('id')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(PROJECTS_LIMIT);
  if (projectsError) {
    return engServerError('client.eng.replies.projects_failed', projectsError, REPLIES_LOAD_FAILED, { userId });
  }

  const campaigns = await readHeEngReplyCampaigns(
    supabaseAdmin,
    (projects ?? []) as Array<{ id: string }>,
  );
  if (!campaigns.ok) {
    return engServerError('client.eng.replies.campaigns_failed', campaigns.error, REPLIES_LOAD_FAILED, { userId });
  }

  // Ящики клиента — только когда есть что фильтровать.
  let mailboxes: Set<string> | null = null;
  if (campaigns.campaigns.length > 0) {
    const read = await readHeEngReplyMailboxes(supabaseAdmin, supabaseInstantly, {
      userId,
      projectIds: ((projects ?? []) as Array<{ id: string }>).map((p) => p.id),
      presetIds: campaigns.presetIds,
    });
    if (!read.ok) {
      return engServerError('client.eng.replies.mailboxes_failed', read.error, REPLIES_LOAD_FAILED, { userId });
    }
    mailboxes = read.mailboxes;
  }

  const replies = await readHeEngReplies(supabaseAdmin, campaigns.campaigns, { limit, before, mailboxes });
  if (!replies.ok) {
    return engServerError('client.eng.replies.read_failed', replies.error, REPLIES_LOAD_FAILED, { userId });
  }
  if (replies.hidden.length > 0) {
    await logInfo(
      'client.eng.replies.foreign_mailbox_hidden',
      `Hidden replies received by mailboxes that are not this client's: ${replies.hidden.length}`,
      { userId, hidden: replies.hidden.slice(0, 20) },
    );
  }

  return NextResponse.json({
    campaigns: campaigns.campaigns.length,
    items: replies.items,
    next: replies.next ? { before_at: replies.next.at, before_id: String(replies.next.id) } : null,
  });
}
