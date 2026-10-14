import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { releaseHeSendingPool } from '@/lib/hypothesisEngine/sendingPool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST — вернуть ВСЕ ящики пула этого проекта в свободные
 * (he_sending_pool_release под замком пула). Тело не читается: у действия один
 * аргумент — сам проект.
 *
 * Только у проекта БЕЗ запуска (то же правило, что у runbook смены сайта —
 * docs/runbooks/eng-change-client-website.md): адреса запущенного проекта стоят
 * в его кампаниях у рассыльщика, и следующий проект слал бы из них же. Такой
 * проект отвечает 409, ничего не возвращено.
 *
 * После возврата адреса убираются из пресета владельца проекта
 * (client_campaign_presets, БД рассыльщика): иначе устаревший пресет держал бы
 * ящик, который пул отдаст другому клиенту, и запуск того клиента отказал бы
 * («ящик пула в чужом пресете», engSendingPreset.ts). Две БД — не атомарно:
 * сбой этого шага ящики в пуле НЕ откатывает, ответ называет его
 * (preset_cleanup: 'failed'), и сотрудник убирает адреса на
 * /admin/clients/<владелец>/preset.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.sending-pool.release' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: projectRow, error: projectErr } = await supabaseAdmin
        .from('he_projects')
        .select('id, created_by')
        .eq('id', id)
        .maybeSingle();
      if (projectErr) {
        await logError('tools.hypothesis-engine.sending-pool.project_read_failed', projectErr, { userId, projectId: id });
        return jsonError('Не удалось прочитать проект', 500);
      }
      if (!projectRow) return jsonError('Проект не найден', 404);
      const owner = typeof (projectRow as { created_by?: unknown }).created_by === 'string'
        ? ((projectRow as { created_by: string }).created_by)
        : null;

      const result = await releaseHeSendingPool(supabaseAdmin, id);
      switch (result.kind) {
        case 'nothing_assigned':
          return jsonError('У проекта нет ящиков пула', 409);
        case 'launched':
          return jsonError(
            'У проекта есть запуск: адреса его ящиков стоят в его кампаниях у рассыльщика. Возврат таких ящиков — решение владельца, кнопкой не делается',
            409,
          );
        case 'unavailable':
          return jsonError('Пул ящиков ENG недоступен: не применена миграция 20261011_0001_he_sending_pool.sql', 409);
        case 'error':
          await logError('tools.hypothesis-engine.sending-pool.release_failed', new Error(result.message), {
            userId,
            projectId: id,
          });
          return jsonError('Не удалось вернуть ящики проекта', 500);
        case 'released':
          break;
      }

      const released = result.mailboxes.map((m) => m.email.trim().toLowerCase());
      let presetCleanup: 'cleaned' | 'not_present' | 'no_preset' | 'no_owner' | 'failed' = 'no_owner';
      if (owner) {
        presetCleanup = await removeFromOwnerPreset(owner, released);
      }

      void logAudit('tools.hypothesis-engine.sending_pool_released', 'ENG sending pool mailboxes released from project', {
        userId,
        projectId: id,
        mailboxes: released.length,
        presetCleanup,
      });
      if (presetCleanup === 'failed') {
        await logError('tools.hypothesis-engine.sending-pool.preset_cleanup_failed', new Error('preset cleanup failed'), {
          userId,
          projectId: id,
          owner,
        });
      }
      return NextResponse.json({ ok: true, released, preset_cleanup: presetCleanup, owner });
    },
  );
}

/** Убрать возвращённые адреса из пресета владельца проекта. Не бросает. */
async function removeFromOwnerPreset(
  owner: string,
  released: string[],
): Promise<'cleaned' | 'not_present' | 'no_preset' | 'failed'> {
  if (!supabaseInstantly) return 'failed';
  try {
    const { data, error } = await supabaseInstantly
      .from('client_campaign_presets')
      .select('id, email_account_ids')
      .eq('client_user_id', owner)
      .maybeSingle();
    if (error) return 'failed';
    if (!data) return 'no_preset';
    const preset = data as { id: string; email_account_ids: unknown };
    const current = Array.isArray(preset.email_account_ids)
      ? preset.email_account_ids.filter((v): v is string => typeof v === 'string')
      : [];
    const drop = new Set(released);
    const kept = current.filter((e) => !drop.has(e.trim().toLowerCase()));
    if (kept.length === current.length) return 'not_present';
    const { error: updateErr } = await supabaseInstantly
      .from('client_campaign_presets')
      .update({ email_account_ids: kept })
      .eq('id', preset.id)
      .eq('client_user_id', owner);
    return updateErr ? 'failed' : 'cleaned';
  } catch {
    return 'failed';
  }
}
