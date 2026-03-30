import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';
import {
  clampTgParserMaxContactsPerRun,
  TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT,
} from '@/lib/tgParser/constants';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const { data, error } = await supabase
        .from('tg_parser_accounts')
        .select('id, name, api_id, api_hash, phone, proxy_url, session_data, is_active, max_contacts_per_run, created_at')
        .order('created_at', { ascending: true });

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.post' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonError('Invalid JSON body', 400);
      }

      const apiId = Number(body.api_id);
      const apiHash = (body.api_hash as string)?.trim();
      if (!apiId || !apiHash) return jsonError('api_id и api_hash обязательны', 400);

      const sessionData = (body.session_data as string)?.trim() ?? '';
      if (!sessionData) return jsonError('session_data обязателен', 400);

      const name = (body.name as string)?.trim() || `Account ${apiId}`;
      const maxContacts =
        body.max_contacts_per_run != null
          ? clampTgParserMaxContactsPerRun(body.max_contacts_per_run)
          : TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT;

      const { data, error } = await supabase
        .from('tg_parser_accounts')
        .insert({
          user_id: user.id,
          name,
          api_id: apiId,
          api_hash: apiHash,
          phone: (body.phone as string)?.trim() ?? '',
          session_data: sessionData,
          proxy_url: (body.proxy_url as string)?.trim() ?? '',
          is_active: true,
          max_contacts_per_run: maxContacts,
        })
        .select('id, name, api_id, api_hash, phone, proxy_url, session_data, is_active, max_contacts_per_run, created_at')
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data, { status: 201 });
    },
  );
}
