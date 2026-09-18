import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getLocalBriefs, listVisibleProjects, missingBriefReason } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { projects, supervisor } = await listVisibleProjects(user.id);
  const localBriefs = await getLocalBriefs(projects.map((p) => p.id));
  // Пометка в списке — только когда ответы собрать не из чего, и с причиной.
  // Бриф целиком в список не отдаём: он большой, а нужен только признак.
  const items = projects.map(({ briefText, ...p }) => ({
    ...p,
    missingReason: missingBriefReason(briefText, localBriefs.get(p.id)),
  }));

  return NextResponse.json({ projects: items, canManageGlobalKb: supervisor });
});
