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
      
        // `.select()` здесь не ради данных, а ради честного ответа. Без него
        // supabase-js отдаёт 204 и error=null независимо от того, сколько строк
        // удалилось: строка, скрытая RLS, просто не попадает под DELETE. Роут
        // рапортовал {ok:true}, UI перезагружал список — и «удалённая» строка
        // оставалась на месте без единого сообщения. Именно так владельческие
        // политики (сняты в 20260807_0004) прятали отказ.
        const { data, error } = await auth.supabase
          .from('tg_outreach_accounts')
          .delete()
          .eq('id', id)
          .select('id');

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) {
          return jsonError('Аккаунт не найден или недоступен для удаления', 404);
        }
        return NextResponse.json({ ok: true });
    },
  );
}
