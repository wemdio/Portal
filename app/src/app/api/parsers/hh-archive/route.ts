/**
 * POST /api/parsers/hh-archive — создаёт job (status='pending', worker подберёт)
 * GET  /api/parsers/hh-archive — список своих job'ов (с пагинацией по created_at)
 *
 * Защиты:
 *   - max_results capped до HH_ARCHIVE_MAX_RESULTS (env, default 50000)
 *   - один активный job на user (UNIQUE partial index в БД — INSERT упадёт 23505)
 *   - валидация дат, числа запросов, chunk_strategy
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const DEFAULT_MAX_RESULTS = Number(process.env.HH_ARCHIVE_MAX_RESULTS ?? '50000');
const HARD_CEILING = 200000; // совпадает с CHECK constraint в SQL

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface CreateRequest {
  search_queries?: unknown;
  area?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  archived?: unknown;
  chunk_strategy?: unknown;
  max_results?: unknown;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);
  if (!supabaseAdmin) return err('Server misconfigured', 500);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  let body: CreateRequest;
  try {
    body = (await req.json()) as CreateRequest;
  } catch {
    return err('Invalid JSON', 400);
  }

  const queries = Array.isArray(body.search_queries)
    ? body.search_queries.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (queries.length === 0) return err('search_queries обязательны', 400);
  if (queries.length > 30) return err('Слишком много запросов (макс 30)', 400);

  const area = typeof body.area === 'string' && body.area ? body.area : '113';
  const dateFrom = typeof body.date_from === 'string' ? body.date_from : '';
  const dateTo = typeof body.date_to === 'string' ? body.date_to : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return err('date_from и date_to обязательны в формате YYYY-MM-DD', 400);
  }
  if (dateFrom > dateTo) return err('date_from > date_to', 400);

  const archived = body.archived !== false;
  const chunkStrategy =
    typeof body.chunk_strategy === 'string' &&
    ['single', 'monthly', 'weekly', 'daily'].includes(body.chunk_strategy)
      ? body.chunk_strategy
      : 'monthly';

  let maxResults = typeof body.max_results === 'number' ? Math.floor(body.max_results) : DEFAULT_MAX_RESULTS;
  if (maxResults <= 0) maxResults = DEFAULT_MAX_RESULTS;
  if (maxResults > HARD_CEILING) maxResults = HARD_CEILING;

  // INSERT через user-scoped client — пройдёт RLS и UNIQUE-индекс
  // на активные job'ы. 23505 = есть активный → 409.
  const { data: job, error } = await supabase
    .from('hh_archive_jobs')
    .insert({
      user_id: user.id,
      search_queries: queries,
      area,
      date_from: dateFrom,
      date_to: dateTo,
      archived,
      chunk_strategy: chunkStrategy,
      max_results: maxResults,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return err('У вас уже есть активная задача — дождитесь её завершения', 409);
    }
    return err(error.message, 500);
  }
  return NextResponse.json({ job }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  const { data, error } = await supabase
    .from('hh_archive_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return err(error.message, 500);
  return NextResponse.json({ jobs: data ?? [] });
}
