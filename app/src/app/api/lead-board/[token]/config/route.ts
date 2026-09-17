import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { resolveBoard, jsonBoardError as jsonError } from '@/lib/leadBoard/boardResolver';
import { normalizeColumnConfig, reorderColumnConfig } from '@/lib/leadBoard/columnConfig';

export const dynamic = 'force-dynamic';

/**
 * Гостевое управление колонками доски (тот же токен): скрыть/показать builtin,
 * добавить/переименовать/удалить кастомные. Значения кастомных колонок в
 * rows.custom[key] при удалении колонки НЕ стираются — колонка просто уходит
 * из конфига (недеструктивно; вернёте — данные на месте).
 *
 * PATCH { columnConfig } или { columnOrder: string[] } → проверка →
 * update project_lead_boards.column_config. Ответ — нормализованный конфиг.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId, db, columnConfig, configUpdatedAt } = r.board!;

  let body: { columnConfig?: unknown; columnOrder?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);

  if ('columnOrder' in body && 'columnConfig' in body) return jsonError('Send either columnOrder or columnConfig', 400);
  const orderOnly = 'columnOrder' in body;
  const n = orderOnly
    ? reorderColumnConfig(columnConfig, body.columnOrder)
    : normalizeColumnConfig(body.columnConfig);
  if (n.error) return jsonError(n.error, 400);

  // Optimistic concurrency protects metadata changed while this request runs.
  // Reordering writes only the board config, never any lead rows.
  const { data: saved, error } = await db
    .from('project_lead_boards')
    .update({ column_config: n.config, updated_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('token', token)
    .eq('updated_at', configUpdatedAt)
    .select('project_id')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!saved) return jsonError('Настройки изменились в другой вкладке. Обновите страницу и повторите.', 409);

  return NextResponse.json({ ok: true, columnConfig: n.config });
}
