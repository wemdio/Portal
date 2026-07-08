import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.patch' }, async (trace) => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const { id } = await params;

    const { data: account } = await supabaseAdmin
      .from('li_accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!account) return jsonError('Account not found', 404);

    const body = (await req.json().catch(() => ({}))) as { proxy_url?: string | null };

    const proxyUrl = body.proxy_url !== undefined ? (body.proxy_url || null) : undefined;

    if (proxyUrl === undefined) {
      return jsonError('No fields to update', 400);
    }

    // Сначала патчим Unipile — прокси должен жить ИМЕННО в Unipile (там
    // крутится браузерная сессия LinkedIn). Если Unipile отклонил — в нашу
    // БД не пишем, иначе UI покажет прокси, которого фактически нет. Creds
    // берём из env (см. миграцию 20260708_0001), а не из li_settings.
    const unipileDsn = process.env.UNIPILE_DSN ?? '';
    const unipileApiKey = process.env.UNIPILE_API_KEY ?? '';

    let unipilePatched = false;
    if (unipileDsn && unipileApiKey) {
      try {
        const client = new UnipileClient(unipileDsn, unipileApiKey);
        await client.patchAccountProxy(account.unipile_account_id, proxyUrl);
        unipilePatched = true;
      } catch (e) {
        console.error('[li-outreach] patchAccountProxy failed:', e);
        await trace.fail(e);
        const raw = e instanceof Error ? e.message : String(e);
        // 404 = аккаунта нет в Unipile: запись устарела (переподключён или
        // удалён в Unipile, при reconnect выдаётся новый account_id).
        const friendly = raw.includes('404')
          ? 'Unipile не нашёл этот аккаунт — скорее всего запись устарела (аккаунт переподключён или удалён). Нажмите «Синхронизировать», затем настройте прокси на актуальной карточке, а устаревшую удалите.'
          : `Unipile отклонил прокси: ${raw}`;
        return jsonError(friendly, 502);
      }
    }

    // Unipile принял (или Unipile не настроен) — фиксируем в нашей БД.
    // updated_at проставит триггер trg_li_accounts_set_updated_at.
    const { error: dbErr } = await supabaseAdmin
      .from('li_accounts')
      .update({ proxy_url: proxyUrl })
      .eq('id', id);
    if (dbErr) return jsonError(dbErr.message, 500);

    return NextResponse.json({ ok: true, proxy_url: proxyUrl, unipile_patched: unipilePatched });
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.accounts.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const { id } = await params;

    // Удаляем только локальную строку li_accounts (например устаревший
    // дубликат после reconnect в Unipile). Сам аккаунт в Unipile не трогаем.
    // FK из li_campaigns/li_leads на account_id — ON DELETE SET NULL,
    // кампании не каскадятся, просто теряют ссылку на мёртвый аккаунт.
    const { error } = await supabaseAdmin
      .from('li_accounts')
      .delete()
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ ok: true });
  });
}
