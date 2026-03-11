import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseTgUsers } from '@/lib/tgParser/parser';
import type { TgParserAccount } from '@/lib/tgParser/types';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
      
        let body: {
          links?: string[];
          parse_chat_messages?: boolean;
          parse_chat_members?: boolean;
          parse_post_comments?: boolean;
          message_limit?: number;
          filter_online?: boolean;
          filter_recently?: boolean;
          max_offline_days?: number | null;
          account_id?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('Invalid JSON body', 400);
        }
      
        const links = Array.isArray(body?.links) ? body.links.filter((l): l is string => typeof l === 'string') : [];
        const parse_chat_messages = body?.parse_chat_messages ?? true;
        const parse_chat_members = body?.parse_chat_members ?? true;
        const parse_post_comments = body?.parse_post_comments ?? true;
        const message_limit = Math.min(5000, Math.max(10, Number(body?.message_limit) || 100));
        const filter_online = Boolean(body?.filter_online);
        const filter_recently = Boolean(body?.filter_recently);
        const max_offline_days = body?.max_offline_days != null ? Number(body.max_offline_days) : null;
      
        if (links.length === 0) {
          return jsonError('links must be a non-empty array of Telegram chat/channel links', 400);
        }
      
        let account: TgParserAccount | undefined;
        const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : undefined;
        if (accountId && supabaseAdmin) {
          const { data: row } = await supabaseAdmin
            .from('tg_parser_accounts')
            .select('api_id, api_hash, session_data, proxy_url')
            .eq('id', accountId)
            .eq('user_id', user.id)
            .eq('is_active', true)
            .single();
          if (!row?.session_data) return jsonError('Account not found or inactive', 404);
          account = {
            api_id: row.api_id,
            api_hash: row.api_hash,
            session_data: row.session_data,
            proxy_url: row.proxy_url || undefined,
          };
        }
      
        try {
          const result = await parseTgUsers({
            links,
            parse_chat_messages,
            parse_chat_members,
            parse_post_comments,
            message_limit,
            filter_online,
            filter_recently,
            max_offline_days,
            account,
          });
      
          if (result.status === 'error') {
            return NextResponse.json({ status: 'error', error: result.error });
          }
          return NextResponse.json({ status: 'ok', users: result.users });
        } catch (err) {
          console.error('tg-parser parse error:', err);
          return jsonError('Internal Server Error', 500);
        }
    },
  );
}
