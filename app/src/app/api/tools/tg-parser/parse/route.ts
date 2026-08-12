import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { normalizeTgLinks } from '@/lib/tgParser/normalizeLinks';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.parse.post' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      let body: {
        links?: string[];
        parse_chat_messages?: boolean;
        parse_chat_members?: boolean;
        parse_post_comments?: boolean;
        enrich_profile?: boolean;
        message_limit?: number;
        filter_online?: boolean;
        filter_recently?: boolean;
        max_offline_days?: number | null;
        account_id?: string;
        is_target?: boolean;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid JSON body', 400);
      }

      // Расклеиваем здесь, а не на экране: экран это и так делает, а до Telegram
      // склейка доезжала со всех остальных входов — см. normalizeTgLinks.
      const { links } = normalizeTgLinks(body?.links);
      const parse_chat_messages = body?.parse_chat_messages ?? true;
      const parse_chat_members = body?.parse_chat_members ?? true;
      const parse_post_comments = body?.parse_post_comments ?? true;
      const enrich_profile = Boolean(body?.enrich_profile);
      const message_limit = Math.min(5000, Math.max(10, Number(body?.message_limit) || 100));
      const filter_online = Boolean(body?.filter_online);
      const filter_recently = Boolean(body?.filter_recently);
      const max_offline_days = body?.max_offline_days != null ? Number(body.max_offline_days) : null;
      const is_target = Boolean(body?.is_target);

      if (links.length === 0) {
        return jsonError('links must be a non-empty array of Telegram chat/channel links', 400);
      }

      const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';

      if (is_target) {
        const { count, error: cErr } = await supabaseAdmin
          .from('tg_parser_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('status', ['pending', 'running'])
          .eq('config->>is_target', 'true');
        if (cErr) return jsonError(cErr.message, 500);
        if (count && count > 0) {
          return jsonError(
            'Уже есть активная задача целевого парсинга. Дождитесь завершения.',
            409,
          );
        }
      } else if (accountId) {
        const { count, error: cErr } = await supabaseAdmin
          .from('tg_parser_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('status', ['pending', 'running'])
          .eq('account_id', accountId);
        if (cErr) return jsonError(cErr.message, 500);
        if (count && count > 0) {
          return jsonError(
            'Для этого аккаунта уже есть активная задача парсинга (в очереди или выполняется). Дождитесь завершения.',
            409,
          );
        }
      } else {
        const { count, error: cErr } = await supabaseAdmin
          .from('tg_parser_jobs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('status', ['pending', 'running'])
          .is('account_id', null);
        if (cErr) return jsonError(cErr.message, 500);
        if (count && count > 0) {
          return jsonError(
            'Уже есть активная задача парсинга без выбранного аккаунта. Дождитесь завершения.',
            409,
          );
        }
      }

      let accountLabel = 'Без аккаунта (переменные окружения)';
      if (is_target) {
        accountLabel = 'Секретный аккаунт (целевой парсинг)';
      } else if (accountId) {
        const { data: accRow } = await supabaseAdmin
          .from('tg_parser_accounts')
          .select('name, phone, api_id, session_data, is_active')
          .eq('id', accountId)
          .single();
        if (!accRow?.session_data || !accRow.is_active) {
          return jsonError('Account not found or inactive', 404);
        }
        accountLabel = accRow.name || accRow.phone || `Account ${accRow.api_id}`;
      }

      const linksSummary =
        links.length <= 2
          ? links.join(', ')
          : `${links.slice(0, 2).join(', ')} +${links.length - 2}`;

      const config = {
        links,
        parse_chat_messages,
        parse_chat_members,
        parse_post_comments,
        enrich_profile,
        message_limit,
        filter_online,
        filter_recently,
        max_offline_days,
        is_target,
        account_label: accountLabel,
        links_summary: linksSummary,
      };

      const { data: row, error: insErr } = await supabaseAdmin
        .from('tg_parser_jobs')
        .insert({
          user_id: user.id,
          status: 'pending',
          config,
          account_id: accountId || null,
        })
        .select('id')
        .single();

      if (insErr || !row) {
        console.error('tg_parser_jobs insert:', insErr);
        return jsonError(insErr?.message ?? 'Не удалось создать задачу', 500);
      }

      supabaseAdmin.from('tg_parser_logs').insert({
        job_id: row.id,
        job_user_id: user.id,
        is_target: is_target,
        account_label: accountLabel,
        level: 'info',
        message: 'Задача добавлена в очередь',
      }).then(({ error }) => {
        if (error) console.warn('[tg-parser] queue log insert failed:', error.message);
      }, () => {});

      return NextResponse.json({ job_id: row.id, status: 'pending' as const });
    },
  );
}
