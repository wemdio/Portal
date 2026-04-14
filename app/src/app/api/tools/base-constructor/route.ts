import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import { withToolTrace } from '@/lib/toolTrace';
import { AVAILABLE_STEPS, type StepKey } from '@/lib/tools/processingSteps';

const admin = supabaseAdmin!;
const validStepKeys = new Set<string>(AVAILABLE_STEPS.map((s) => s.key));

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.post' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const body = await req.json();
      const { data, selected_steps, step_config, file_name } = body;

      if (!Array.isArray(data) || data.length < 2) {
        return NextResponse.json({ error: 'Data must contain header + at least 1 row' }, { status: 400 });
      }
      if (!Array.isArray(selected_steps) || selected_steps.length === 0) {
        return NextResponse.json({ error: 'Select at least one step' }, { status: 400 });
      }
      for (const key of selected_steps) {
        if (!validStepKeys.has(key)) {
          return NextResponse.json({ error: `Unknown step: ${key}` }, { status: 400 });
        }
      }

      const { data: existing } = await admin
        .from('base_constructor_jobs')
        .select('id')
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing'])
        .limit(1)
        .single();

      if (existing) {
        return NextResponse.json({ error: 'У вас уже есть активная задача' }, { status: 409 });
      }

      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .insert({
          user_id: user.id,
          file_name: file_name || null,
          data,
          selected_steps,
          step_config: step_config || {},
          initial_row_count: data.length - 1,
          total_steps: selected_steps.length,
        })
        .select()
        .single();

      if (error || !job) {
        return NextResponse.json({ error: error?.message || 'Failed to create job' }, { status: 500 });
      }

      runBaseConstructorJob(job.id).catch((err) =>
        console.error('[base-constructor] Worker error:', err),
      );

      return NextResponse.json({ job });
    },
  );
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.get' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { data, error } = await admin
        .from('base_constructor_jobs')
        .select('id, status, file_name, selected_steps, current_step, current_step_key, current_step_progress, total_steps, initial_row_count, result_stats, error_message, created_at, completed_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ jobs: data || [] });
    },
  );
}
