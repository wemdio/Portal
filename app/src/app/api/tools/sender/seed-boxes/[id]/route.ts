import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { sealMailboxSecret, unsealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { parseSeedProxy } from '@/lib/sender/seedBoxRules';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * PATCH — выключить/включить контрольный ящик, заменить пароль или прокси
 * (proxy: строка — поставить, null или пусто — убрать). После пароля или
 * прокси ящик надо проверить заново.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { enabled?: unknown; password?: unknown; proxy?: unknown } | null;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;

    const newPassword = typeof body?.password === 'string' && body.password.trim() ? body.password.trim() : null;
    const proxyGiven = body !== null && 'proxy' in body && (body.proxy === null || typeof body.proxy === 'string');
    let proxy: { url: string; label: string } | null = null;
    if (proxyGiven && typeof body?.proxy === 'string' && body.proxy.trim()) {
      proxy = parseSeedProxy(body.proxy);
      if (!proxy) return jsonError('Не понял прокси. Пример: http://логин:пароль@1.2.3.4:8000', 400);
    }
    if (newPassword || proxyGiven) {
      // Пароль и прокси лежат в одном зашифрованном секрете: меняем одно, второе сохраняем.
      const { data: current } = await supabaseAdmin.from('sender_seed_boxes').select('secret_encrypted').eq('id', id).maybeSingle();
      if (!current) return jsonError('Ящик не найден', 404);
      const secret = unsealMailboxSecret(String(current.secret_encrypted));
      patch.secret_encrypted = sealMailboxSecret({
        imapPassword: newPassword ?? secret.imapPassword,
        proxyUrl: proxyGiven ? proxy?.url : secret.proxyUrl,
      });
      if (proxyGiven) patch.proxy_label = proxy?.label ?? null;
      patch.status = 'pending';
      patch.last_error = null;
    }
    if (Object.keys(patch).length === 1) return jsonError('Нечего менять', 400);

    const { data, error } = await supabaseAdmin.from('sender_seed_boxes').update(patch).eq('id', id).select('id').maybeSingle();
    if (error?.code === '23505') return jsonError('Этот прокси уже стоит на другом контрольном ящике — один прокси на один ящик', 409);
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
