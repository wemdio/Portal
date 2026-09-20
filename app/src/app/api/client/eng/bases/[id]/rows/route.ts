import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { loadClientHeBase, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  toClientEngBaseColumns,
  toClientEngBaseDataRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/** Дефолт/потолок страницы превью базы (data jsonb читается целиком, режем в памяти). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  // Ниже минимума — мусорный ввод → дефолт; выше максимума — тихий кламп.
  if (v < min) return fallback;
  return Math.min(max, v);
}

// GET — страница строк СВОЕЙ базы для превью (шаг Review & Launch мастера).
// Только чтение he_bases: data — массив Record по именам columns (вердикт
// валидации почты живёт на строке как _email_status, в columns не входит).
// offset (default 0) / limit (default 100, max 500) — серверный slice.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  // Скоуп владельца до чтения data: чужая база — 404, существование не раскрываем.
  const owned = await loadClientHeBase(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const url = new URL(req.url);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

  const { data: base, error } = await supabaseAdmin
    .from('he_bases')
    .select('id, status, row_count, columns, data')
    .eq('id', id)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return jsonError('Base not found', 404);
    return engServerError('client.eng.bases.rows_failed', error, 'Failed to load the base rows', {
      userId: result.auth.userId,
      baseId: id,
    });
  }

  const rows = Array.isArray((base as { data?: unknown }).data)
    ? ((base as { data: unknown[] }).data as Array<Record<string, unknown>>)
    : [];
  const columns = Array.isArray((base as { columns?: unknown }).columns)
    ? ((base as { columns: unknown[] }).columns as string[])
    : [];

  // Строки базы принадлежат клиенту, но в них есть и наше: провенанс источника
  // (`source_detail` — код поставщика, русские подписи, поисковый запрос плана)
  // и служебные пометки `_*`. Превью печатает строку ЦЕЛИКОМ в title каждой
  // <tr> (EngStepReview.tsx:102), так что режем на сервере, а не на экране.
  // Проецируем только отданную страницу: сама `data` — до 50k строк.
  return NextResponse.json({
    columns: toClientEngBaseColumns(columns),
    rows: rows.slice(offset, offset + limit).map(toClientEngBaseDataRow),
    total: rows.length,
    status: (base as { status?: string }).status,
    row_count: (base as { row_count?: number }).row_count ?? rows.length,
  });
}
