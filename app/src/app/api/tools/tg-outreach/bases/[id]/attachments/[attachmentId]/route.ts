import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ATTACHMENTS_BUCKET } from '@/lib/tgOutreach/firstTouch/attachments';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

/** Отметить файл «для всех» ({ is_default: true }) или снять отметку. Такой файл у базы один. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.attachments.patch' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, attachmentId } = await ctx.params;
      const body = (await req.json().catch(() => null)) as { is_default?: unknown } | null;
      if (typeof body?.is_default !== 'boolean') return jsonError('Нужно поле is_default', 400);

      if (body.is_default) {
        const { error } = await auth.supabase
          .from('tg_outreach_base_attachments')
          .update({ is_default: false })
          .eq('base_id', id)
          .eq('is_default', true)
          .neq('id', attachmentId);
        if (error) return jsonError(error.message, 500);
      }
      const { data, error } = await auth.supabase
        .from('tg_outreach_base_attachments')
        .update({ is_default: body.is_default })
        .eq('id', attachmentId)
        .eq('base_id', id)
        .select('id');
      if (error) return jsonError(error.message, 500);
      if (!data?.length) return jsonError('Файл не найден', 404);
      return NextResponse.json({ ok: true });
    },
  );
}

/** Удалить файл базы. Контакты, у которых он указан в таблице, встанут, пока файл не загрузят снова. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.attachments.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, attachmentId } = await ctx.params;

      const { data, error } = await auth.supabase
        .from('tg_outreach_base_attachments')
        .delete()
        .eq('id', attachmentId)
        .eq('base_id', id)
        .select('storage_path');
      if (error) return jsonError(error.message, 500);
      if (!data?.length) return jsonError('Файл не найден', 404);

      if (supabaseAdmin) {
        const { error: rmError } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove(data.map((r) => r.storage_path as string));
        if (rmError) console.warn(`[tg-outreach] attachment ${attachmentId}: not removed from storage: ${rmError.message}`);
      }
      return NextResponse.json({ ok: true });
    },
  );
}
