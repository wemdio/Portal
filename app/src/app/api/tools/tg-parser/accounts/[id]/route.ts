import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.by-id.patch' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        const { id } = await ctx.params;
        if (!id) return jsonError('Missing id', 400);
      
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return jsonError('Invalid JSON body', 400);
        }
      
        const allowed = ['name', 'is_active', 'proxy_url', 'phone', 'session_data'] as const;
        const updates: Record<string, unknown> = {};
        for (const key of allowed) {
          if (body[key] !== undefined) updates[key] = body[key];
        }
      
        if (Object.keys(updates).length === 0) {
          return jsonError('No valid fields to update', 400);
        }
      
        const { data, error } = await supabase
          .from('tg_parser_accounts')
          .update(updates)
          .eq('id', id)
          .eq('user_id', user.id)
          .select('id, name, api_id, api_hash, phone, proxy_url, session_data, is_active, created_at')
          .single();
      
        if (error) return jsonError(error.message, 500);
        if (!data) return jsonError('Account not found', 404);
        return NextResponse.json(data);
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.by-id.delete' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        const { id } = await ctx.params;
        if (!id) return jsonError('Missing id', 400);
      
        const { error } = await supabase
          .from('tg_parser_accounts')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
      
        if (error) return jsonError(error.message, 500);
        return new NextResponse(null, { status: 204 });
    },
  );
}
