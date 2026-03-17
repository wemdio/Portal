import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (req, { supabase }, params) => {
  const configId = params?.id;
  if (!configId) return NextResponse.json({ error: 'Missing config id' }, { status: 400 });

  const url = new URL(req.url);
  const level = url.searchParams.get('level');
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  let query = supabase
    .from('sales_copilot_logs')
    .select('*', { count: 'exact' })
    .eq('config_id', configId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (level) query = query.eq('level', level);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data, total: count });
});
