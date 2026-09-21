import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isDuplicateName, normalizeTagName } from '@/lib/sender/tags';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** PATCH — переименовать тег. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.tags.rename' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const name = normalizeTagName(body?.name);
    if (!name) return jsonError('Укажите название тега', 400);

    const { data, error } = await supabaseAdmin
      .from('sender_mailbox_tags')
      .update({ name })
      .eq('id', id)
      .select('id, name')
      .maybeSingle();

    if (error) {
      if (isDuplicateName(error.code)) return jsonError(`Тег «${name}» уже есть`, 409);
      return jsonError(error.message, 500);
    }
    if (!data) return jsonError('Тег не найден', 404);

    return NextResponse.json({ id: String(data.id), name: String(data.name) });
  });
}

/**
 * DELETE — удалить тег.
 *
 * Ящики остаются: колонка tag_id объявлена «on delete set null», поэтому метка
 * снимается самой базой, одним действием и без обхода строк.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.tags.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { error } = await supabaseAdmin.from('sender_mailbox_tags').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ ok: true });
  });
}
