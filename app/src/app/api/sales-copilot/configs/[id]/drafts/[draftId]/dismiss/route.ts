import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const POST = withCopilotAuth(async (_req, { supabase }, params) => {
  const configId = params?.id;
  const draftId = params?.draftId;
  if (!configId || !draftId) return NextResponse.json({ error: 'Missing ids' }, { status: 400 });

  const { error } = await supabase
    .from('sales_copilot_drafts')
    .update({
      status: 'dismissed',
      acted_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .eq('config_id', configId)
    .eq('status', 'pending');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
});
