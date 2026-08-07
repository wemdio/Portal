import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import {
  countYandexMapsCatalog,
  fetchYandexMapsCatalogDictionaries,
  normalizeYandexMapsCatalogFilters,
} from '@/lib/parsers/yandexMapsCatalog';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireUser(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

/** Справочники «страна → регион → город» и список рубрик для формы поиска. */
export async function GET(req: NextRequest) {
  if (!await requireUser(req)) return jsonError('Unauthorized', 401);
  try {
    const dictionaries = await fetchYandexMapsCatalogDictionaries();
    return NextResponse.json(dictionaries, {
      // Справочник меняется только при пересчёте после импорта — незачем
      // тянуть 30 тыс. строк на каждое открытие формы.
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Не удалось загрузить справочники', 500);
  }
}

/** Сколько организаций найдётся по выбранным фильтрам — до запуска. */
export async function POST(req: NextRequest) {
  if (!await requireUser(req)) return jsonError('Unauthorized', 401);
  try {
    const body = await req.json();
    const filters = normalizeYandexMapsCatalogFilters(body?.catalog_filters ?? body);
    if (!filters) return NextResponse.json({ total: 0, capped: false });
    return NextResponse.json(await countYandexMapsCatalog(filters));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Не удалось посчитать организации', 500);
  }
}
