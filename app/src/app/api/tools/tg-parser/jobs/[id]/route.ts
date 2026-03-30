import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.jobs.id.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await ctx.params;
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

      const { data, error } = await supabase
        .from('tg_parser_jobs')
        .select(
          'id, created_at, status, config, account_id, result_users, stop_reason, error_message, started_at, completed_at',
        )
        .eq('id', id)
        .maybeSingle();

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      return NextResponse.json({ job: data });
    },
  );
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.jobs.id.delete' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { id } = await ctx.params;
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

      const { data: row } = await supabase
        .from('tg_parser_jobs')
        .select('status')
        .eq('id', id)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (row.status === 'pending' || row.status === 'running') {
        return NextResponse.json(
          { error: 'Нельзя удалить задачу в очереди или выполняющуюся' },
          { status: 409 },
        );
      }

      const { error } = await supabase.from('tg_parser_jobs').delete().eq('id', id);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    },
  );
}
