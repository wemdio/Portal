import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getProjectBrief, missingBriefReason } from '@/lib/replyPersonalization/db';
import { listProjectOthers } from '@/lib/replyPersonalization/othersFolder';
import type { OthersPage } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

/**
 * GET ?cursor=&q=&fresh=1 — папка Others в Instantly по ящикам кампаний
 * проекта, свежие сверху. cursor — из прошлого ответа (следующая страница),
 * q — полный адрес для поиска в самом Instantly, fresh=1 — мимо минутного кэша.
 */
export const GET = withAuth(async (req: NextRequest, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  const search = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const fresh = url.searchParams.get('fresh') === '1';

  // Как и в основном списке: без брифа письма показываем, а нехватку брифа
  // отдаём предупреждением — отвечать можно руками.
  const [projectBrief, kb, page] = await Promise.all([
    getProjectBrief(projectId),
    getKnowledgeBase(projectId),
    listProjectOthers(projectId, { cursor, search, fresh }),
  ]);
  const body: OthersPage = { ...page, missingReason: missingBriefReason(projectBrief, kb?.localBrief) };
  return NextResponse.json(body);
});
