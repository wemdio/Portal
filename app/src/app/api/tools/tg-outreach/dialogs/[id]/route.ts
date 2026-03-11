import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import type { DialogStatus } from '@/lib/tgOutreach/types';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.by-id.get' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        const { data, error } = await auth.supabase
          .from('tg_outreach_dialogs')
          .select('*')
          .eq('id', id)
          .single();
      
        if (error) return jsonError('Диалог не найден', 404);
        return NextResponse.json(data);
    },
  );
}

const VALID_STATUSES: DialogStatus[] = ['none', 'lead', 'not_lead', 'later'];

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.by-id.put' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        let body: { status?: string };
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }
      
        if (!body.status || !VALID_STATUSES.includes(body.status as DialogStatus)) {
          return jsonError(`status должен быть одним из: ${VALID_STATUSES.join(', ')}`, 400);
        }
      
        const { data, error } = await auth.supabase
          .from('tg_outreach_dialogs')
          .update({ status: body.status })
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
    { request: req, operation: 'tools.tg-outreach.dialogs.by-id.delete' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        const { error } = await auth.supabase
          .from('tg_outreach_dialogs')
          .delete()
          .eq('id', id);
      
        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ ok: true });
    },
  );
}
