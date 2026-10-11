import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  checkHeSendingPoolMailboxAtProvider,
  describeHeSendingPoolMailboxUses,
  findHeSendingPoolMailboxUses,
  setHeSendingPoolMailboxStatus,
  HE_SENDING_POOL_TABLE,
} from '@/lib/hypothesisEngine/sendingPool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const MIGRATION_MISSING_TEXT = 'Пул ящиков ENG недоступен: не применена миграция 20261011_0001_he_sending_pool.sql';

/**
 * PATCH — выключить свободный ящик пула ({ status: 'disabled' }) или вернуть
 * выключенный в свободные ({ status: 'available' }). Смена статуса —
 * he_sending_pool_set_status под замком пула: выдача проекту и выключение не
 * разойдутся.
 *
 * ОТДАННЫЙ проекту ящик не меняется (409): его адрес уже стоит в кампаниях
 * проекта у рассыльщика, и выключение здесь их не остановит. Сломанный отданный
 * ящик разбирают у рассыльщика (рассыльщик сам не шлёт из ящика в ошибке).
 *
 * Включение снова проверяет ящик: что его не вписали в пресет или живой
 * запуск RU-кабинета другого клиента (findHeSendingPoolMailboxUses — та же
 * проверка, что при добавлении) и что у рассыльщика он жив (мог сломаться,
 * пока был выключен): включённый ящик получит следующий новый проект.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.sending-pool.status' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let status: 'available' | 'disabled';
      try {
        const body = (await req.json()) as { status?: unknown } | null;
        if (body?.status !== 'available' && body?.status !== 'disabled') {
          return jsonError('status — available или disabled', 400);
        }
        status = body.status;
      } catch {
        return jsonError('Тело запроса — JSON-объект', 400);
      }

      if (status === 'available') {
        const { data: row, error: rowErr } = await supabaseAdmin
          .from(HE_SENDING_POOL_TABLE)
          .select('email, instantly_account_id, status')
          .eq('id', id)
          .maybeSingle();
        if (rowErr) {
          if (rowErr.code === '42P01' || rowErr.code === 'PGRST205') return jsonError(MIGRATION_MISSING_TEXT, 409);
          await logError('tools.hypothesis-engine.sending-pool.read_failed', rowErr, { userId, id });
          return jsonError('Не удалось прочитать ящик пула', 500);
        }
        if (!row) return jsonError('Ящика с таким id в пуле нет', 404);
        const mailbox = row as { email: string; instantly_account_id: string; status: string };
        if (mailbox.status === 'disabled') {
          if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
          const uses = await findHeSendingPoolMailboxUses(supabaseInstantly, [mailbox.email]);
          if (uses.kind === 'error') {
            await logError('tools.hypothesis-engine.sending-pool.presets_read_failed', new Error(uses.message), { userId, id });
            return jsonError('Не удалось проверить пресеты и запуски клиентов — ящик не включён, попробуйте ещё раз', 500);
          }
          if (uses.kind === 'in_use') {
            return jsonError(
              `Ящик используется другим клиентом: ${describeHeSendingPoolMailboxUses(uses.uses)}. ` +
                'Включать его в пул нельзя — сначала уберите его оттуда',
              409,
            );
          }
          const provider = await checkHeSendingPoolMailboxAtProvider(mailbox.email, mailbox.instantly_account_id);
          if (!provider.ok) return jsonError(provider.message, provider.status);
        }
      }

      const result = await setHeSendingPoolMailboxStatus(supabaseAdmin, id, status);
      switch (result.kind) {
        case 'updated':
          void logAudit('tools.hypothesis-engine.sending_pool_status', `ENG sending pool mailbox ${status}`, {
            userId,
            id,
            status,
          });
          return NextResponse.json({ ok: true, status });
        case 'unchanged':
          return NextResponse.json({ ok: true, status, unchanged: true });
        case 'assigned':
          return jsonError(
            'Ящик отдан проекту — его адрес уже в кампаниях проекта, выключить его здесь нельзя',
            409,
          );
        case 'not_found':
          return jsonError('Ящика с таким id в пуле нет', 404);
        case 'unavailable':
          return jsonError(MIGRATION_MISSING_TEXT, 409);
        case 'error':
          await logError('tools.hypothesis-engine.sending-pool.status_failed', new Error(result.message), { userId, id });
          return jsonError('Не удалось изменить статус ящика', 500);
      }
    },
  );
}
