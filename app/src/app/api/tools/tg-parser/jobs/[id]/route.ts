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

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.jobs.id.patch' },
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

      let body: { action?: string };
      try {
        body = (await req.json()) as { action?: string };
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      if (body.action !== 'stop') {
        return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
      }

      const { data: row } = await supabase
        .from('tg_parser_jobs')
        .select('id, status, config')
        .eq('id', id)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      if (row.status !== 'pending' && row.status !== 'running') {
        return NextResponse.json(
          { error: 'Можно остановить только задачу в очереди или выполняющуюся' },
          { status: 409 },
        );
      }

      const { data: updated, error } = await supabase
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: 'Остановлено вручную',
          stop_reason: 'manual_stop',
          completed_at: new Date().toISOString(),
        })
        .eq('id', id)
        .in('status', ['pending', 'running'])
        .select('id, status, stop_reason, error_message, completed_at')
        .maybeSingle();

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!updated) {
        return NextResponse.json({ error: 'Задача уже завершилась' }, { status: 409 });
      }

      supabase.from('tg_parser_logs').insert({
        job_id: id,
        job_user_id: user.id,
        is_target: Boolean((row.config as { is_target?: boolean } | null)?.is_target),
        account_label: (row.config as { account_label?: string } | null)?.account_label ?? null,
        level: 'warning',
        message: 'Остановлено вручную пользователем',
      }).then(({ error }) => {
        if (error) console.warn('[tg-parser] stop log insert failed:', error.message);
      }, () => {});

      return NextResponse.json({ ok: true, job: updated });
    },
  );
}
