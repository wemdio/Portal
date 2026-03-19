import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (req, { supabase }, params) => {
  const configId = params?.id;
  if (!configId) return NextResponse.json({ error: 'Missing config id' }, { status: 400 });

  const url = new URL(req.url);
  const draftType = url.searchParams.get('type');
  const status = url.searchParams.get('status') ?? 'pending';
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  let query = supabase
    .from('sales_copilot_drafts')
    .select('*', { count: 'exact' })
    .eq('config_id', configId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (draftType) query = query.eq('draft_type', draftType);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data, total: count });
});
