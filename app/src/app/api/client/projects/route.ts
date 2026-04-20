import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  specialist: string | null;
  manager: string | null;
  contacts_done: string | null;
  contacts_obligation: string | null;
  deadline: string | null;
  launch_date: string | null;
};

type TaskCounterRow = { project_id: string | null; status: string | null };
type LeadProjectRow = { project_id: string | null };

const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress']);
const DONE_TASK_STATUSES = new Set(['done']);

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: projects, error } = await supabaseAdmin
    .from('projects')
    .select(
      'id, name, status, specialist, manager, contacts_done, contacts_obligation, deadline, launch_date',
    )
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return jsonError(error.message, 500);

  const rows = (projects ?? []) as ProjectRow[];
  if (rows.length === 0) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const projectIds = rows.map((p) => p.id);

  const tasksRes = await supabaseAdmin
    .from('tasks')
    .select('project_id, status')
    .in('project_id', projectIds);

  const tasksByProject = new Map<string, { active: number; done: number; total: number }>();
  for (const id of projectIds) {
    tasksByProject.set(id, { active: 0, done: 0, total: 0 });
  }
  if (!tasksRes.error) {
    for (const t of (tasksRes.data ?? []) as TaskCounterRow[]) {
      if (!t.project_id) continue;
      const bucket = tasksByProject.get(t.project_id);
      if (!bucket) continue;
      bucket.total += 1;
      if (t.status && ACTIVE_TASK_STATUSES.has(t.status)) bucket.active += 1;
      else if (t.status && DONE_TASK_STATUSES.has(t.status)) bucket.done += 1;
    }
  }

  const leadsByProject = new Map<string, number>(projectIds.map((id) => [id, 0]));
  if (supabaseInstantly) {
    const leadsRes = await supabaseInstantly
      .from('client_forwarded_leads')
      .select('project_id')
      .eq('client_user_id', userId)
      .in('project_id', projectIds);

    if (!leadsRes.error) {
      for (const l of (leadsRes.data ?? []) as LeadProjectRow[]) {
        if (!l.project_id) continue;
        leadsByProject.set(l.project_id, (leadsByProject.get(l.project_id) ?? 0) + 1);
      }
    }
  }

  const items = rows.map((p) => {
    const tasks = tasksByProject.get(p.id) ?? { active: 0, done: 0, total: 0 };
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      specialist: p.specialist,
      manager: p.manager,
      contacts_done: p.contacts_done,
      contacts_obligation: p.contacts_obligation,
      deadline: p.deadline,
      launch_date: p.launch_date,
      tasks_total: tasks.total,
      tasks_active: tasks.active,
      tasks_done: tasks.done,
      leads_count: leadsByProject.get(p.id) ?? 0,
    };
  });

  return NextResponse.json({ items, total: items.length });
}
