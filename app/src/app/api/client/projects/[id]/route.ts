import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

type ProjectDetailRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  specialist: string | null;
  manager: string | null;
  contacts_done: string | null;
  contacts_obligation: string | null;
  launch_date: string | null;
  deadline: string | null;
};

type TaskRow = {
  id: string;
  title: string;
  status: string | null;
  deadline: string | null;
};

const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress']);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const { id: projectId } = await ctx.params;

  const projectRes = await supabaseAdmin
    .from('projects')
    .select(
      'id, name, description, status, specialist, manager, contacts_done, contacts_obligation, launch_date, deadline',
    )
    .eq('id', projectId)
    .eq('client_user_id', userId)
    .maybeSingle();

  const project = projectRes.data as ProjectDetailRow | null;
  if (!project) {
    return jsonError('Проект не найден или доступ запрещён', 404);
  }

  const tasksRes = await supabaseAdmin
    .from('tasks')
    .select('id, title, status, deadline')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  const tasks = (tasksRes.data ?? []) as TaskRow[];

  const active = tasks
    .filter((t) => t.status && ACTIVE_TASK_STATUSES.has(t.status))
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      deadline: t.deadline,
    }));

  const done = tasks
    .filter((t) => t.status === 'done')
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      deadline: t.deadline,
    }));

  let leadsCount = 0;
  if (supabaseInstantly) {
    const leadsRes = await supabaseInstantly
      .from('client_forwarded_leads')
      .select('id')
      .eq('client_user_id', userId)
      .eq('project_id', projectId);

    if (!leadsRes.error) {
      leadsCount = (leadsRes.data ?? []).length;
    }
  }

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      specialist: project.specialist,
      manager: project.manager,
      contacts_done: project.contacts_done,
      contacts_obligation: project.contacts_obligation,
      launch_date: project.launch_date,
      deadline: project.deadline,
      leads_count: leadsCount,
    },
    tasks: {
      active,
      done,
    },
  });
}
