import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { resolveBoard, jsonBoardError as jsonError } from '@/lib/leadBoard/boardResolver';
import { normalizeColumnConfig } from '@/lib/leadBoard/columnConfig';

export const dynamic = 'force-dynamic';

/**
 * Гостевое управление колонками доски (тот же токен): скрыть/показать builtin,
 * добавить/переименовать/удалить кастомные. Значения кастомных колонок в
 * rows.custom[key] при удалении колонки НЕ стираются — колонка просто уходит
 * из конфига (недеструктивно; вернёте — данные на месте).
 *
 * PATCH { columnConfig } → нормализация (lib/leadBoard/columnConfig) →
 * update project_lead_boards.column_config. Ответ — нормализованный конфиг.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId, db } = r.board!;

  let body: { columnConfig?: unknown };
  try {
    body = (await req.json()) as { columnConfig?: unknown };
  } catch {
    return jsonError('Invalid JSON', 400);
  }
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);

  const n = normalizeColumnConfig(body.columnConfig);
  if (n.error) return jsonError(n.error, 400);

  const { error } = await db
    .from('project_lead_boards')
    .update({ column_config: n.config, updated_at: new Date().toISOString() })
    .eq('project_id', projectId);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true, columnConfig: n.config });
}
