import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type Ctx = { params: Promise<{ id: string }> };

/** GET — current daily usage for an account */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.usage.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const { id } = await ctx.params;
      if (!id) return jsonError('Missing id', 400);

      const { data: account } = await supabase
        .from('tg_parser_accounts')
        .select('id, daily_limit')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

      if (!account) return jsonError('Account not found', 404);

      const today = new Date().toISOString().slice(0, 10);
      const { data: usage } = await supabase
        .from('tg_parser_account_usage')
        .select('sent_count')
        .eq('account_id', id)
        .eq('usage_date', today)
        .maybeSingle();

      const sentToday = usage?.sent_count ?? 0;

      return NextResponse.json({
        account_id: id,
        daily_limit: account.daily_limit,
        sent_today: sentToday,
        remaining: Math.max(0, account.daily_limit - sentToday),
        limit_reached: sentToday >= account.daily_limit,
      });
    },
  );
}

/** POST — increment usage (call after sending a message). Uses DB function for atomicity. */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.usage.post' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const { id } = await ctx.params;
      if (!id) return jsonError('Missing id', 400);

      const { data: account } = await supabase
        .from('tg_parser_accounts')
        .select('id, daily_limit')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

      if (!account) return jsonError('Account not found', 404);

      const db = supabaseAdmin ?? supabase;
      const { data, error } = await db.rpc('tg_parser_increment_usage', {
        p_account_id: id,
      });

      if (error) {
        if (error.message.includes('Daily limit reached')) {
          return NextResponse.json(
            { error: 'Daily limit reached', daily_limit: account.daily_limit },
            { status: 429 },
          );
        }
        return jsonError(error.message, 500);
      }

      return NextResponse.json({
        account_id: id,
        sent_today: data,
        daily_limit: account.daily_limit,
        remaining: Math.max(0, account.daily_limit - (data as number)),
      });
    },
  );
}
