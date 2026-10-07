import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** PATCH — выключить/включить контрольный ящик или заменить пароль (тогда его надо проверить заново). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { enabled?: unknown; password?: unknown } | null;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body?.password === 'string' && body.password.trim()) {
      patch.secret_encrypted = sealMailboxSecret({ imapPassword: body.password.trim() });
      patch.status = 'pending';
      patch.last_error = null;
    }
    if (Object.keys(patch).length === 1) return jsonError('Нечего менять', 400);

    const { data, error } = await supabaseAdmin.from('sender_seed_boxes').update(patch).eq('id', id).select('id').maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError('Ящик не найден', 404);
    return NextResponse.json({ ok: true });
  });
}

/** DELETE — удалить контрольный ящик. Пробы остаются в истории health score. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { error } = await supabaseAdmin.from('sender_seed_boxes').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
