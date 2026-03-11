import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runDfybJob } from '@/lib/tools/dfybWorker';
import { withToolTrace } from '@/lib/toolTrace';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.dfyb.post' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const body = await req.json();
        const { brief, company_url, target_count, personalization_prompt } = body;
      
        if (!brief?.trim()) {
          return NextResponse.json({ error: 'Brief is required' }, { status: 400 });
        }
        if (![1000, 2000, 3000, 4000, 5000].includes(target_count)) {
          return NextResponse.json({ error: 'Invalid target_count' }, { status: 400 });
        }
      
        const { data: existing } = await admin
          .from('dfyb_jobs')
          .select('id, current_step_name')
          .eq('user_id', user.id)
          .in('status', ['planning', 'parsing', 'processing'])
          .limit(1)
          .single();
      
        if (existing) {
          return NextResponse.json(
            { error: `У вас уже есть активная задача: ${existing.current_step_name}` },
            { status: 409 },
          );
        }
      
        const { data: job, error } = await admin
          .from('dfyb_jobs')
          .insert({
            user_id: user.id,
            brief: brief.trim(),
            company_url: company_url?.trim() || null,
            target_count,
            personalization_prompt: personalization_prompt?.trim() || null,
          })
          .select()
          .single();
      
        if (error || !job) {
          return NextResponse.json({ error: error?.message || 'Failed to create job' }, { status: 500 });
        }
      
        runDfybJob(job.id).catch((err) => console.error('[dfyb] Worker error:', err));
      
        return NextResponse.json({ job });
    },
  );
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.dfyb.get' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const { data, error } = await admin
          .from('dfyb_jobs')
          .select('id, status, current_step, current_step_name, current_step_progress, total_steps, target_count, result_stats, error_message, created_at, completed_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20);
      
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ jobs: data || [] });
    },
  );
}
