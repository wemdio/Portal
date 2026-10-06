/**
 * Одно подключение amoCRM клиента: PUT — новое название или токен (с живой
 * проверкой), DELETE — удаление.
 *
 * Удаление подключения, на которое смотрят кампании, без подтверждения не
 * проходит: ответ 409 со списком кампаний. С `?confirm=1` удаляем и выключаем
 * у этих кампаний передачу в CRM — иначе очередь копила бы лидов, которые
 * никуда не уедут.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAmoClient, normalizeAmoBaseUrl } from '@/lib/crm/amoClient';
import {
  CRM_CONNECTION_PUBLIC_COLUMNS,
  POLZA_CONNECTION,
  sealCrmToken,
  unsealCrmToken,
} from '@/lib/crm/connections';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.crm-connections.by-id.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);
      const { id } = await ctx.params;
      if (id === POLZA_CONNECTION) return jsonError('Нашу AMO настраивают на сервере', 400);

      const { data: current, error: readErr } = await supabaseAdmin
        .from('crm_connections')
        .select('base_url, secret_encrypted')
        .eq('id', id)
        .maybeSingle();
      if (readErr) return jsonError(readErr.message, 500);
      if (!current) return jsonError('Подключение не найдено', 404);

      const body = (await req.json().catch(() => null)) as { name?: string; token?: string } | null;
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const name = (body?.name ?? '').trim();
      if (name) update.name = name;

      const newToken = (body?.token ?? '').trim();
      try {
        const row = current as { base_url: string; secret_encrypted: string };
        const baseUrl = normalizeAmoBaseUrl(row.base_url);
        if (!baseUrl) return jsonError('Неверный адрес amoCRM в подключении', 400);
        const token = newToken || unsealCrmToken(row.secret_encrypted);
        await createAmoClient({ baseUrl, token }).listPipelines();
        if (newToken) update.secret_encrypted = sealCrmToken(newToken);
        update.status = 'ok';
        update.last_error = null;
        update.last_verified_at = new Date().toISOString();
      } catch (err) {
        return jsonError(`Не подключилось: ${err instanceof Error ? err.message : String(err)}`, 400);
      }

      const { data, error } = await supabaseAdmin
        .from('crm_connections')
        .update(update)
        .eq('id', id)
        .select(CRM_CONNECTION_PUBLIC_COLUMNS)
        .single();
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ connection: { ...(data as object), builtin: false } });
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.crm-connections.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);
      const { id } = await ctx.params;
      if (id === POLZA_CONNECTION) return jsonError('Нашу AMO удалить нельзя', 400);

      const { data: usedBy, error: useErr } = await supabaseAdmin
        .from('tg_outreach_campaigns')
        .select('id, name, crm_settings')
        .filter('crm_settings->>connection', 'eq', id);
      if (useErr) return jsonError(useErr.message, 500);
      const campaigns = (usedBy ?? []) as Array<{ id: string; name: string; crm_settings: Record<string, unknown> }>;

      const confirmed = new URL(req.url).searchParams.get('confirm') === '1';
      if (campaigns.length && !confirmed) {
        return NextResponse.json(
          { error: 'Подключение используется в кампаниях', used_by: campaigns.map((c) => c.name) },
          { status: 409 },
        );
      }

      for (const c of campaigns) {
        const { error } = await supabaseAdmin
          .from('tg_outreach_campaigns')
          .update({ crm_settings: { ...c.crm_settings, enabled: false, connection: null } })
          .eq('id', c.id);
        if (error) return jsonError(error.message, 500);
      }

      // Ждущие задачи этого подключения закрываем с причиной: уехать им некуда.
      await supabaseAdmin
        .from('tg_outreach_crm_pushes')
        .update({ status: 'failed', error_message: 'подключение CRM удалено' })
        .eq('connection', id)
        .eq('status', 'pending');

      const { error } = await supabaseAdmin.from('crm_connections').delete().eq('id', id);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, disabled_campaigns: campaigns.length });
    },
  );
}
