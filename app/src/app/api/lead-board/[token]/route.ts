import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { verifyBoardToken, boardTokenSecret } from '@/lib/leadBoard/boardToken';
import { isLeadQuality, LEAD_QUALITY_OPTIONS } from '@/lib/leadBoard/leadQuality';
import { parseColumnConfig, type BoardColumnConfigEntry } from '@/lib/instantly/leadBoardWriter';

export const dynamic = 'force-dynamic';

/**
 * Публичный API гостевой таблицы лидов проекта (/leads-board/<token>).
 * Авторизация — сам токен (capability): HMAC-подпись + равенство сохранённому
 * в project_lead_boards.token (не совпал = отозван). Путь allowlist'нут в
 * middleware (isPublicApiPath), сессии тут нет и не надо.
 *
 * GET   — доска: проект, конфиг колонок, ряды (≤500, свежие первые), статистика.
 * PATCH — правка ТОЛЬКО клиентских колонок (quality/comment/taken) одного ряда;
 *         ряд обязан принадлежать проекту токена (eq project_id).
 */

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface ResolvedBoard {
  projectId: string;
  columnConfig: BoardColumnConfigEntry[];
}

async function resolveBoard(
  token: string,
): Promise<{ board?: ResolvedBoard; error?: NextResponse }> {
  if (!supabaseInstantly) return { error: jsonError('Server misconfigured', 500) };
  const db = supabaseInstantly;
  const secret = boardTokenSecret();
  if (!secret) return { error: jsonError('Server misconfigured', 500) };

  const projectId = verifyBoardToken(token, secret);
  if (!projectId) return { error: jsonError('Invalid token', 401) };

  const { data, error } = await db
    .from('project_lead_boards')
    .select('token, column_config')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return { error: jsonError(error.message, 500) };
  // Токен обязан совпасть с сохранённым: иначе он отозван (регенерирован).
  if (!data || (data.token as string) !== token) {
    return { error: jsonError('Token invalid or revoked', 401) };
  }
  return { board: { projectId, columnConfig: parseColumnConfig(data.column_config) } };
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  // Next уже декодирует params; токен — base64url (без %), повторный decode не
  // нужен и на крафтаном сегменте с % кидал бы URIError → 500 вместо 401.
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId, columnConfig } = r.board!;
  const db = supabaseInstantly!;

  const { data: rows, error: rowsErr } = await db
    .from('project_lead_board_rows')
    .select(
      'id, lead_email, lead_name, company_name, phone, website, request_text, campaign_name, step_number, reply_timestamp, quality, comment, taken',
    )
    .eq('project_id', projectId)
    .order('reply_timestamp', { ascending: false })
    .limit(500);
  if (rowsErr) return jsonError(rowsErr.message, 500);

  // Имя проекта/клиента — из main DB (доска хранит только uuid).
  let projectName: string | null = null;
  let clientName: string | null = null;
  if (supabaseAdmin) {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('name, client')
      .eq('id', projectId)
      .maybeSingle();
    projectName = (project?.name as string | null) ?? null;
    clientName = (project?.client as string | null) ?? null;
  }

  const items = rows ?? [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const byQuality: Record<string, number> = {};
  const byCampaign: Record<string, number> = {};
  let last7d = 0;
  for (const row of items) {
    const q = ((row.quality as string | null) ?? '').trim() || 'без оценки';
    byQuality[q] = (byQuality[q] ?? 0) + 1;
    const c = ((row.campaign_name as string | null) ?? '').trim() || '—';
    byCampaign[c] = (byCampaign[c] ?? 0) + 1;
    const ts = Date.parse((row.reply_timestamp as string | null) ?? '');
    if (Number.isFinite(ts) && ts >= weekAgo) last7d++;
  }

  return NextResponse.json({
    project: { name: projectName, client: clientName },
    columnConfig,
    qualities: LEAD_QUALITY_OPTIONS,
    rows: items,
    stats: { total: items.length, last7d, byQuality, byCampaign },
  });
}

/** Клиентские (editable) колонки. Всё остальное в PATCH — 400, а не тихий игнор. */
const EDITABLE = ['quality', 'comment', 'taken'] as const;

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  // Next уже декодирует params; токен — base64url (без %), повторный decode не
  // нужен и на крафтаном сегменте с % кидал бы URIError → 500 вместо 401.
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId } = r.board!;
  const db = supabaseInstantly!;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON', 400);
  }
  // Тело null — валидный JSON: без гарда body.rowId кидал бы TypeError → 500.
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);

  const rowId = typeof body.rowId === 'string' ? body.rowId : '';
  if (!rowId) return jsonError('rowId is required', 400);
  for (const key of Object.keys(body)) {
    if (key !== 'rowId' && !(EDITABLE as readonly string[]).includes(key)) {
      return jsonError(`field "${key}" is not editable (allowed: quality, comment, taken)`, 400);
    }
  }

  const patch: Record<string, unknown> = {};
  if ('quality' in body) {
    if (body.quality === null || body.quality === '') {
      patch.quality = null; // снятие оценки
    } else if (isLeadQuality(body.quality)) {
      patch.quality = body.quality;
    } else {
      return jsonError('unknown quality value', 400);
    }
  }
  if ('comment' in body) {
    if (body.comment !== null && typeof body.comment !== 'string') {
      return jsonError('comment must be a string', 400);
    }
    patch.comment = typeof body.comment === 'string' ? body.comment.slice(0, 2000) : null;
  }
  if ('taken' in body) {
    if (typeof body.taken !== 'boolean') return jsonError('taken must be a boolean', 400);
    patch.taken = body.taken;
  }
  if (Object.keys(patch).length === 0) {
    return jsonError('nothing to update (allowed: quality, comment, taken)', 400);
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('project_lead_board_rows')
    .update(patch)
    .eq('id', rowId)
    .eq('project_id', projectId) // чужой ряд этим токеном не правится
    .select('id, quality, comment, taken, updated_at')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError('Row not found', 404);

  return NextResponse.json({ ok: true, row: data });
}
