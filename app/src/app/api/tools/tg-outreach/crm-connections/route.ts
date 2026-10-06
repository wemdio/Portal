/**
 * Подключения CRM для передачи лидов TG-аутрича.
 *
 * GET — список: встроенная «Наша AMO» и amoCRM клиентов (без токенов).
 * POST — новое подключение клиента. Сначала проверяем его живым запросом
 * воронок: сохранить нерабочий токен значит узнать об этом только тогда, когда
 * лид не доедет до CRM.
 *
 * Таблица без политик для authenticated — токен не должен уходить на экран,
 * поэтому ходим под service_role, а пускаем только сотрудников.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAmoClient, normalizeAmoBaseUrl } from '@/lib/crm/amoClient';
import {
  CRM_CONNECTION_PUBLIC_COLUMNS,
  polzaConnectionPublic,
  sealCrmToken,
  type CrmConnectionPublic,
} from '@/lib/crm/connections';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.crm-connections.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);

      const { data, error } = await supabaseAdmin
        .from('crm_connections')
        .select(CRM_CONNECTION_PUBLIC_COLUMNS)
        .order('created_at', { ascending: true });
      if (error) return jsonError(error.message, 500);

      const list: CrmConnectionPublic[] = [
        polzaConnectionPublic(),
        ...((data ?? []) as Array<Omit<CrmConnectionPublic, 'builtin'>>).map((c) => ({ ...c, builtin: false })),
      ];
      return NextResponse.json({ connections: list });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.crm-connections.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);

      const body = (await req.json().catch(() => null)) as { name?: string; base_url?: string; token?: string } | null;
      const name = (body?.name ?? '').trim();
      const token = (body?.token ?? '').trim();
      const baseUrl = normalizeAmoBaseUrl(body?.base_url ?? '');
      if (!name) return jsonError('Укажите название подключения', 400);
      if (!baseUrl) return jsonError('Адрес не похож на amoCRM — нужен вида client.amocrm.ru', 400);
      if (!token) return jsonError('Вставьте долгосрочный токен amoCRM', 400);

      try {
        await createAmoClient({ baseUrl, token }).listPipelines();
      } catch (err) {
        return jsonError(`Не подключилось: ${err instanceof Error ? err.message : String(err)}`, 400);
      }

      let sealed: string;
      try {
        sealed = sealCrmToken(token);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : String(err), 500);
      }

      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('crm_connections')
        .insert({
          name,
          base_url: baseUrl,
          secret_encrypted: sealed,
          status: 'ok',
          last_verified_at: now,
          created_by: auth.user.id,
        })
        .select(CRM_CONNECTION_PUBLIC_COLUMNS)
        .single();
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ connection: { ...(data as object), builtin: false } });
    },
  );
}
