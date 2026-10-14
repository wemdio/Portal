import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { manualLeadMark, type LeadMarkFields } from '@/lib/tgOutreach/leadMark';
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

        let body: { status?: string; can_send?: boolean };
        try {
          body = await req.json();
        } catch {
          return jsonError('Неверный JSON', 400);
        }

        const update: {
          status?: DialogStatus;
          can_send?: boolean;
          can_send_changed_at?: string;
          can_send_changed_by?: string;
          can_send_changed_reason?: string;
        } & LeadMarkFields = {};
        if (body.status !== undefined) {
          if (!VALID_STATUSES.includes(body.status as DialogStatus)) {
            return jsonError(`status должен быть одним из: ${VALID_STATUSES.join(', ')}`, 400);
          }
          update.status = body.status as DialogStatus;
        }
        // Диалоги любой кампании правит вся команда. Миграция 20260807_0004
        // открыла запись в tg_outreach_dialogs всем (update_all), а здесь
        // оставалась проверка «кампания твоя» с 403 «только просмотр» —
        // 08.10.2026 из-за неё нельзя было отметить лида в кампаниях
        // ушедшего специалиста. Текущую строку читаем ради can_send и статуса
        // «до» и подписи в логе.
        const { data: existing, error: existingErr } = await auth.supabase
          .from('tg_outreach_dialogs')
          .select('can_send, status, campaign_id, tg_user_id, tg_username')
          .eq('id', id)
          .maybeSingle();
        if (existingErr) return jsonError(existingErr.message, 500);
        if (!existing) return jsonError('Диалог не найден', 404);
        const existingRow = existing as {
          can_send: boolean;
          status: DialogStatus;
          campaign_id: string;
          tg_user_id: number | string;
          tg_username: string | null;
        };
        // Кнопка «Лид» — ручная отметка: на карточке будет видно, кто её
        // поставил. Повторное нажатие на уже лиде автора не переписывает.
        if (update.status === 'lead' && existingRow.status !== 'lead') {
          Object.assign(update, await manualLeadMark(auth.supabase, auth.user));
        }

        let canSendBefore: boolean | null = null;
        const canSendDialogMeta = {
          campaign_id: existingRow.campaign_id,
          tg_user_id: existingRow.tg_user_id,
          tg_username: existingRow.tg_username,
        };
        if (body.can_send !== undefined) {
          if (typeof body.can_send !== 'boolean') {
            return jsonError('can_send должен быть boolean', 400);
          }
          canSendBefore = existingRow.can_send;
          if (canSendBefore !== body.can_send) {
            update.can_send = body.can_send;
            update.can_send_changed_at = new Date().toISOString();
            update.can_send_changed_by = auth.user.id;
            update.can_send_changed_reason = 'manual';
          }
          // noop (request с тем же значением) — не добавляем can_send в
          // update. status может всё равно прийти в этом же запросе.
        }
        if (Object.keys(update).length === 0) {
          return jsonError('Передайте status и/или can_send', 400);
        }

        const { data, error } = await auth.supabase
          .from('tg_outreach_dialogs')
          .update(update)
          .eq('id', id)
          .select()
          .single();

        if (error) return jsonError(error.message, 500);

        // Логируем смену can_send в общий лог кампании, чтобы история была
        // видна в табе «Логи» и не терялась при следующем переключении
        // (на самом диалоге хранится только последнее изменение).
        // Fire-and-forget: если INSERT упадёт (RLS, timeout), пользователь
        // всё равно получит обновлённый диалог.
        if (body.can_send !== undefined && canSendBefore !== body.can_send) {
          const label = canSendDialogMeta.tg_username
            ? `@${canSendDialogMeta.tg_username}`
            : `id ${canSendDialogMeta.tg_user_id}`;
          const action = body.can_send ? 'разрешена' : 'отключена';
          auth.supabase
            .from('tg_outreach_logs')
            .insert({
              campaign_id: canSendDialogMeta.campaign_id,
              level: 'info',
              message: `Отправка в диалог ${label} ${action} вручную пользователем портала.`,
            })
            .then(({ error: logErr }) => {
              if (logErr) console.warn('[tg-outreach] can_send audit log insert failed:', logErr.message);
            });
        }
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
