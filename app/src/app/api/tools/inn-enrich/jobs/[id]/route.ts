import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getInnEnrichUser } from '@/lib/innEnrich/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getInnEnrichUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const { data, error } = await supabaseAdmin!
    .from('inn_enrich_jobs')
    .select(
      'id, status, file_name, total, processed, stats, error_message, created_at, completed_at, user_id',
    )
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (data.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { user_id: _userId, ...job } = data;
  return NextResponse.json({ job });
}
