import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

const SUPERVISOR_ROLES = ['admin', 'director', 'lead', 'manager'];

/**
 * GET /api/instantly/my-projects
 * Returns projects visible to the current user, each with linked campaign IDs.
 * - Specialists (technician, sales, marketer): only their own projects
 * - Supervisors (admin, director, lead, manager): all active projects
 */
export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin || !supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Get user role
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = (profile?.role as string) ?? 'technician';
  const isSupervisor = SUPERVISOR_ROLES.includes(role);

  // Fetch projects
  let projectQuery = supabaseAdmin
    .from('projects')
    .select('id, client, name, specialist, specialist_user_id')
    .in('status', ['В работе', 'Тестирование', 'Подготовка'])
    .order('client');

  if (!isSupervisor) {
    projectQuery = projectQuery.eq('specialist_user_id', user.id);
  }

  const { data: projects, error: projErr } = await projectQuery;
  if (projErr) {
    return NextResponse.json({ error: projErr.message }, { status: 500 });
  }

  if (!projects?.length) {
    return NextResponse.json({ projects: [], is_supervisor: isSupervisor });
  }

  // Fetch campaign links for these projects
  const projectIds = projects.map((p) => p.id as string);
  const { data: legacyLinks } = await supabaseInstantly
    .from('project_instantly_campaigns')
    .select('project_id, campaign_id')
    .in('project_id', projectIds);
  const { data: periodLinks } = await supabaseInstantly
    .from('project_period_instantly_campaigns')
    .select('project_id, campaign_id')
    .in('project_id', projectIds);

  const projectCampaigns: Record<string, string[]> = {};
  const links = [...(legacyLinks ?? []), ...(periodLinks ?? [])];
  for (const l of links ?? []) {
    const pid = l.project_id as string;
    if (!projectCampaigns[pid]) projectCampaigns[pid] = [];
    projectCampaigns[pid].push(l.campaign_id as string);
  }

  const result = projects.map((p) => ({
    id: p.id as string,
    client: (p.client as string) ?? (p.name as string) ?? '',
    campaign_ids: projectCampaigns[p.id as string] ?? [],
  }));

  return NextResponse.json({ projects: result, is_supervisor: isSupervisor });
});
