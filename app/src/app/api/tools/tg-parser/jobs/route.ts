import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.jobs.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset')) || 0);

      /**
       * Идущие задачи отдаём отдельно от страницы.
       *
       * Две вещи в интерфейсе смотрят не на страницу, а на всю очередь: опрос
       * (обновляем список, только пока что-то работает) и подсказка «этот
       * аккаунт уже парсит». Со страницей по десять задача, уехавшая на вторую
       * страницу, выпала бы из обеих — опрос бы встал, а подсказка бы врала.
       * Строк тут единицы: параллельные задачи ограничены одной на аккаунт.
       */
      const runningQuery = supabase
        .from('tg_parser_jobs')
        .select(
          'id, user_id, created_at, status, config, account_id, stop_reason, error_message, started_at, completed_at, found_count, progress_note, progress_at',
        )
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(100);

      // Лёгкий RPC (без тяжёлого result_users); откат на прямой select, пока
      // миграция не применена.
      const [{ data: rpcData, error: rpcError }, { data: runningRows }] = await Promise.all([
        supabase.rpc('tg_parser_jobs_list', { row_limit: limit, row_offset: offset }),
        runningQuery,
      ]);

      if (!rpcError) {
        const items = (rpcData ?? []) as Array<{ total_count?: number }>;
        // total_count одинаков во всех строках — это оконный счётчик. Пустая
        // страница означает, что до конца списка уже долистали.
        const total = items.length > 0 ? Number(items[0].total_count ?? items.length) : 0;
        return NextResponse.json({ items, total, running: runningRows ?? [] });
      }

      const { data, error, count } = await supabase
        .from('tg_parser_jobs')
        .select(
          'id, user_id, created_at, status, config, account_id, result_users, stop_reason, error_message, started_at, completed_at, found_count, progress_note, progress_at',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ items: data ?? [], total: count ?? 0, running: runningRows ?? [] });
    },
  );
}
