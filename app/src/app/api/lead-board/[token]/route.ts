import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isLeadQuality, LEAD_QUALITY_OPTIONS } from '@/lib/leadBoard/leadQuality';
import { resolveBoard } from '@/lib/leadBoard/boardResolver';
import { parseImportDate } from '@/lib/leadBoard/importLeads';

export const dynamic = 'force-dynamic';

/**
 * Публичный API гостевой таблицы лидов проекта (/leads-board/<token>).
 * Авторизация — сам токен (capability): HMAC-подпись + равенство сохранённому
 * в project_lead_boards.token, общий резолвер — lib/leadBoard/boardResolver.
 * Путь allowlist'нут в middleware (isPublicApiPath), сессии тут нет и не надо.
 *
 * GET   — доска: проект, конфиг колонок, ряды (≤500, свежие первые), статистика.
 * PATCH — правка ТОЛЬКО клиентских колонок (quality/comment/taken) одного ряда;
 *         ряд обязан принадлежать проекту токена (eq project_id).
 */

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
      'id, lead_email, lead_name, company_name, phone, website, request_text, campaign_name, step_number, reply_timestamp, quality, comment, taken, custom',
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

/** Editable поля. Всё вне списка (+rowId) в PATCH — 400, а не тихий игнор. */
const EDITABLE = [
  'quality', 'comment', 'taken',
  'lead_email', 'lead_name', 'company_name', 'phone', 'website', 'campaign_name',
  'request_text', 'step_number', 'reply_timestamp',
  'custom',
] as const;

/** Текстовые поля и их лимиты (null = очистить). */
const TEXT_FIELDS: Record<string, number> = {
  lead_email: 500,
  lead_name: 200,
  company_name: 200,
  phone: 200,
  website: 300,
  campaign_name: 200,
  request_text: 5000,
};

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  // Next уже декодирует params; токен — base64url (без %), повторный decode не
  // нужен и на крафтаном сегменте с % кидал бы URIError → 500 вместо 401.
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId, columnConfig } = r.board!;
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
      return jsonError(`field "${key}" is not editable`, 400);
    }
  }

  // Строка нужна и для 404, и для merge кастомных полей.
  const { data: row, error: rowErr } = await db
    .from('project_lead_board_rows')
    .select('id, custom')
    .eq('id', rowId)
    .eq('project_id', projectId) // чужой ряд этим токеном не правится
    .maybeSingle();
  if (rowErr) return jsonError(rowErr.message, 500);
  if (!row) return jsonError('Row not found', 404);

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
  for (const [field, maxLen] of Object.entries(TEXT_FIELDS)) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v !== null && typeof v !== 'string') return jsonError(`${field} must be a string`, 400);
    patch[field] = typeof v === 'string' ? v.slice(0, maxLen) : null;
  }
  if ('step_number' in body) {
    if (body.step_number === null) {
      patch.step_number = null;
    } else if (
      typeof body.step_number === 'number' &&
      Number.isInteger(body.step_number) &&
      body.step_number >= 1 &&
      body.step_number <= 99
    ) {
      patch.step_number = body.step_number;
    } else {
      return jsonError('step_number must be an integer 1..99 or null', 400);
    }
  }
  if ('reply_timestamp' in body) {
    if (body.reply_timestamp === null) {
      patch.reply_timestamp = null;
    } else if (typeof body.reply_timestamp === 'string') {
      const iso = parseImportDate(body.reply_timestamp);
      if (!iso) return jsonError('reply_timestamp: unparseable date (dd.mm.yyyy / yyyy-mm-dd)', 400);
      patch.reply_timestamp = iso;
    } else {
      return jsonError('reply_timestamp must be a string or null', 400);
    }
  }
  if ('custom' in body) {
    if (!body.custom || typeof body.custom !== 'object' || Array.isArray(body.custom)) {
      return jsonError('custom must be an object {columnKey: value}', 400);
    }
    const customKeys = new Set(columnConfig.filter((c) => c.custom).map((c) => c.key));
    const merged: Record<string, unknown> = { ...((row.custom as Record<string, unknown> | null) ?? {}) };
    for (const [k, v] of Object.entries(body.custom as Record<string, unknown>)) {
      if (!customKeys.has(k)) return jsonError(`unknown custom column: ${k}`, 400);
      if (v === null) delete merged[k];
      else if (typeof v === 'string') merged[k] = v.slice(0, 500);
      else return jsonError('custom values must be strings or null', 400);
    }
    patch.custom = merged;
  }
  if (Object.keys(patch).length === 0) {
    return jsonError('nothing to update', 400);
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('project_lead_board_rows')
    .update(patch)
    .eq('id', rowId)
    .eq('project_id', projectId)
    .select('id, quality, comment, taken, custom, updated_at')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true, row: data });
}

/** Добавить пустую строку (спец заполняет ячейки через PATCH). */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId } = r.board!;
  const db = supabaseInstantly!;

  const { data, error } = await db
    .from('project_lead_board_rows')
    .insert({ project_id: projectId })
    .select('id')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError('insert returned no row', 500);

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}

/** Удалить строку (мусор/дубль). Скоуп по проекту токена. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
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
  if (body === null || typeof body !== 'object') return jsonError('Invalid JSON', 400);
  const rowId = typeof body.rowId === 'string' ? body.rowId : '';
  if (!rowId) return jsonError('rowId is required', 400);

  const { data, error } = await db
    .from('project_lead_board_rows')
    .delete()
    .eq('id', rowId)
    .eq('project_id', projectId) // чужой ряд этим токеном не удаляется
    .select('id');
  if (error) return jsonError(error.message, 500);
  if (!data || data.length === 0) return jsonError('Row not found', 404);

  return NextResponse.json({ ok: true });
}
