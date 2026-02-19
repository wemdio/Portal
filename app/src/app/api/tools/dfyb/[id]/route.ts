import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { data: job, error } = await admin
    .from('dfyb_jobs')
    .select('id, user_id, status, current_step, current_step_name, current_step_progress, total_steps, target_count, plan, result_stats, personalization_prompt, error_message, created_at, started_at, completed_at')
    .eq('id', id)
    .single();

  if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({ job });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json();

  if (body.action === 'cancel') {
    const { error } = await admin
      .from('dfyb_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .in('status', ['planning', 'parsing', 'processing']);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
