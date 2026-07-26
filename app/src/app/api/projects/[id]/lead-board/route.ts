import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  getOrCreateBoard,
  DEFAULT_COLUMN_CONFIG,
  type BoardColumnConfigEntry,
} from '@/lib/instantly/leadBoardWriter';
import { createBoardToken, boardTokenSecret, boardUrl } from '@/lib/leadBoard/boardToken';
import { BOARD_COLUMN_LABELS } from '@/lib/leadBoard/boardColumns';

export const dynamic = 'force-dynamic';

/**
 * Staff-API гостевой таблицы лидов проекта (плитка на /projects/[id]).
 * Auth — middleware (маршрут /api/projects/* доступен только internal-ролям),
 * поэтому тут без своей проверки, как у соседнего .../campaigns.
 *
 * GET   — { link, columnConfig } (доска создаётся лениво при первом запросе);
 * POST  — { action: 'regenerate' } → новый токен, старые ссылки умирают;
 * PATCH — { columnConfig } → сохранить видимость колонок (нормализуется по
 *         базовому набору: неизвестные ключи — 400, порядок — как в дефолте).
 */

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeConfig(raw: unknown): { config?: BoardColumnConfigEntry[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'columnConfig must be an array' };
  const allowed = new Set(Object.keys(BOARD_COLUMN_LABELS));
  const byKey = new Map<string, boolean>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'columnConfig entries must be objects' };
    const key = (item as { key?: unknown }).key;
    if (typeof key !== 'string' || !allowed.has(key)) {
      return { error: `unknown column key: ${String(key)}` };
    }
    byKey.set(key, (item as { visible?: unknown }).visible !== false);
  }
  const config = DEFAULT_COLUMN_CONFIG.map((d) => ({
    key: d.key,
    visible: byKey.get(d.key) ?? d.visible,
  }));
  if (!config.some((c) => c.visible)) {
    return { error: 'at least one column must stay visible' };
  }
  return { config };
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  try {
    const board = await getOrCreateBoard(supabaseInstantly, id);
    return NextResponse.json({ link: boardUrl(board.token), columnConfig: board.columnConfig });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return jsonError('Invalid JSON', 400);
  }
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);
  if (body.action !== 'regenerate') return jsonError('unknown action', 400);

  const db = supabaseInstantly;
  try {
    await getOrCreateBoard(db, id); // доска обязана существовать до ротации
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
  const token = createBoardToken(id, boardTokenSecret());
  const { error } = await db
    .from('project_lead_boards')
    .update({ token, updated_at: new Date().toISOString() })
    .eq('project_id', id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ link: boardUrl(token) });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  let body: { columnConfig?: unknown };
  try {
    body = (await req.json()) as { columnConfig?: unknown };
  } catch {
    return jsonError('Invalid JSON', 400);
  }
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);
  const n = normalizeConfig(body.columnConfig);
  if (n.error) return jsonError(n.error, 400);

  const db = supabaseInstantly;
  try {
    await getOrCreateBoard(db, id);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
  const { error } = await db
    .from('project_lead_boards')
    .update({ column_config: n.config, updated_at: new Date().toISOString() })
    .eq('project_id', id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true, columnConfig: n.config });
}
