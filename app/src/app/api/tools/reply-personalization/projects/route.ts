import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getKnowledgeBase, listVisibleProjects } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const projects = await listVisibleProjects(user.id);
  const withKb = await Promise.all(
    projects.map(async (p) => ({
      ...p,
      hasKnowledgeBase: Boolean(await getKnowledgeBase(p.id)),
    })),
  );

  return NextResponse.json({ projects: withKb });
});
