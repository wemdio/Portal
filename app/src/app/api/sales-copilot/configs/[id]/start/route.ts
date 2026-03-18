import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const POST = withCopilotAuth(async (_req, { supabase, userId }, params) => {
  const configId = params?.id;
  if (!configId) return NextResponse.json({ error: 'Missing config id' }, { status: 400 });

  const { data: config, error: cfgErr } = await supabase
    .from('sales_copilot_configs')
    .select('id, is_enabled')
    .eq('id', configId)
    .single();

  if (cfgErr || !config) return NextResponse.json({ error: 'Config not found' }, { status: 404 });

  if (!config.is_enabled) {
    await supabase.from('sales_copilot_configs').update({ is_enabled: true, updated_at: new Date().toISOString() }).eq('id', configId);
  }

  const { data: job, error: jobErr } = await supabase
    .from('sales_copilot_jobs')
    .insert({ config_id: configId, user_id: userId, action: 'start' })
    .select()
    .single();

  if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 500 });
  return NextResponse.json(job, { status: 201 });
});
