import { createAmoClient } from '@/lib/crm/amoClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { checkTransition, STAGE_NAMES, type StatusChange } from './rules';

const REQUEST_TIMEOUT_MS = 15_000;

function amoEnv(): { baseUrl: string; token: string } | null {
  const raw = (process.env.AMO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim();
  if (!raw || !token) return null;
  return { baseUrl: raw.startsWith('http') ? raw : `https://${raw}`, token };
}

async function amoRequest<T>(
  env: { baseUrl: string; token: string },
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AMO ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Этот переход — откат, который сделали мы сами (запись о нём лежит рядом по времени). */
async function isOwnRevert(change: StatusChange): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const at = (change.occurredAt ?? new Date()).getTime();
  const { data } = await supabaseAdmin
    .from('amo_funnel_reverts')
    .select('id')
    .eq('amo_deal_id', change.leadId)
    .eq('bad_status_id', change.oldStatusId)
    .eq('restored_status_id', change.statusId)
    .gte('reverted_at', new Date(at - 10 * 60_000).toISOString())
    .lte('reverted_at', new Date(at + 60_000).toISOString())
    .limit(1);
  return (data ?? []).length > 0;
}

export type GuardResult = 'ok' | 'reverted' | 'stale' | 'no-credentials';

/**
 * Проверяет один переход и при нарушении возвращает сделку на прежний этап.
 *
 * Перед откатом читает сделку живьём: пока вебхук шёл, менеджер мог уже
 * сделать следующий, законный ход — затирать его откатом нельзя.
 * Откат — это движение «назад» (или выход из бокового этапа), правилами оно
 * разрешено, поэтому повторный вебхук от самого отката цикла не даёт.
 */
export async function enforceTransition(change: StatusChange): Promise<GuardResult> {
  const input = {
    pipelineId: change.pipelineId,
    oldPipelineId: change.oldPipelineId,
    fromStatusId: change.oldStatusId,
    toStatusId: change.statusId,
  };
  const verdict = checkTransition(input);
  if (verdict.allowed) return 'ok';

  // Наш собственный откат пришёл новым вебхуком — повторно его не трогаем,
  // иначе он «откатит откат» и сделка заметалась бы между этапами.
  if (await isOwnRevert(change)) return 'ok';

  const env = amoEnv();
  if (!env) return 'no-credentials';

  const current = await amoRequest<{ status_id?: number }>(env, 'GET', `/api/v4/leads/${change.leadId}`);
  if (current.status_id !== change.statusId) return 'stale';

  // Откат оставляет в истории AMO пару «туда — обратно». Фиксируем его, чтобы
  // дашборды (view amo_status_events_v) не считали сделку побывавшей на
  // запрещённом этапе. Запись — ДО отката: вебхук самого отката должен найти
  // её и не откатывать откат. Без записи статистика соврёт — громкая ошибка.
  let logId: number | null = null;
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('amo_funnel_reverts').insert({
      amo_deal_id: change.leadId,
      bad_status_id: change.statusId,
      restored_status_id: change.oldStatusId,
    }).select('id').single();
    if (error) console.error('[amo-funnel-guard] revert not logged', change.leadId, error.message);
    else logId = (data as { id: number }).id;
  } else {
    console.error('[amo-funnel-guard] supabaseAdmin missing, revert not logged', change.leadId);
  }

  try {
    await amoRequest(env, 'PATCH', `/api/v4/leads/${change.leadId}`, {
      status_id: change.oldStatusId,
      pipeline_id: change.pipelineId,
    });
  } catch (err) {
    // Откат не удался — сделка осталась на месте, вычёркивать из истории нечего.
    if (logId !== null && supabaseAdmin) {
      await supabaseAdmin.from('amo_funnel_reverts').delete().eq('id', logId);
    }
    throw err;
  }

  const to = STAGE_NAMES[change.statusId] ?? String(change.statusId);
  const from = STAGE_NAMES[change.oldStatusId] ?? String(change.oldStatusId);
  await createAmoClient({ baseUrl: env.baseUrl, token: env.token })
    .addLeadNote(
      change.leadId,
      `⛔ Перенос на «${to}» отменён, сделка возвращена на «${from}».\n${verdict.reason}`,
    )
    .catch((err) => console.warn('[amo-funnel-guard] note failed', change.leadId, err));

  return 'reverted';
}
