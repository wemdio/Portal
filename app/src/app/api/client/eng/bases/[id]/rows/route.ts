import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadClientHeBase } from '@/lib/hypothesisEngine/apiGuards';

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
  if (!id) return jsonError('Missing id', 400);

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
    return jsonError(error.code === 'PGRST116' ? 'Base not found' : error.message, error.code === 'PGRST116' ? 404 : 500);
  }

  const rows = Array.isArray((base as { data?: unknown }).data)
    ? ((base as { data: unknown[] }).data as Array<Record<string, unknown>>)
    : [];
  const columns = Array.isArray((base as { columns?: unknown }).columns)
    ? ((base as { columns: unknown[] }).columns as string[])
    : [];

  return NextResponse.json({
    columns,
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    status: (base as { status?: string }).status,
    row_count: (base as { row_count?: number }).row_count ?? rows.length,
  });
}
