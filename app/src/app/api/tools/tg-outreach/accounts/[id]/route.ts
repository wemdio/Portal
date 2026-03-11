import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.by-id.put' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }
      
        const allowed = ['session_name', 'api_id', 'api_hash', 'phone', 'proxy_id', 'session_data', 'is_active'] as const;
        const update: Record<string, unknown> = {};
        for (const key of allowed) {
          if (body[key] !== undefined) update[key] = body[key];
        }
      
        if (Object.keys(update).length === 0) return jsonError('Нет полей для обновления', 400);
      
        const { data, error } = await auth.supabase
          .from('tg_outreach_accounts')
          .update(update)
          .eq('id', id)
          .select()
          .single();
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json(data);
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.by-id.delete' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        const { error } = await auth.supabase
          .from('tg_outreach_accounts')
          .delete()
          .eq('id', id);
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ ok: true });
    },
  );
}
