import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

interface Body {
  action?: 'disable' | 'enable' | 'recheck';
  dailyCampaignLimit?: number;
  imapHost?: string | null;
  imapPort?: number;
}

/** PATCH — выключить, вернуть в работу, отправить на повторную проверку, поправить лимит или IMAP-хост. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.patch' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return jsonError('Невалидный JSON', 400);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.action === 'disable') patch.enabled = false;
    // Возврат в работу и повторная проверка — это одно и то же: ящик снова
    // проходит вход по SMTP/IMAP, и только после этого попадает в рассылку.
    if (body.action === 'enable') patch.enabled = true;
    // Взяли в работу или отправили на перепроверку — ящик заново проходит вход.
    if (body.action === 'enable' || body.action === 'recheck') {
      patch.status = 'pending';
      patch.last_error = null;
    }

    if (typeof body.dailyCampaignLimit === 'number') {
      const limit = Math.max(1, Math.min(500, Math.floor(body.dailyCampaignLimit)));
      patch.daily_campaign_limit = limit;
    }
    if (body.imapHost !== undefined) patch.imap_host = body.imapHost?.trim() || null;
    if (typeof body.imapPort === 'number' && body.imapPort > 0 && body.imapPort < 65536) {
      patch.imap_port = Math.floor(body.imapPort);
    }

    const { error } = await supabaseAdmin.from('sender_mailboxes').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}

/** DELETE — убрать ящик из инструмента. Сам ящик у провайдера не трогаем. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { error } = await supabaseAdmin.from('sender_mailboxes').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
