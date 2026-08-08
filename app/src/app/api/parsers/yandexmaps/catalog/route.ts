import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { fetchYandexMapsCatalogDictionaries } from '@/lib/parsers/yandexMapsCatalog';

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

// Предпросчёта «сколько найдётся» здесь больше нет. Он уходил на каждое
// изменение фильтра, а стоил полного прохода по всем подходящим строкам: счёт
// обязан досмотреть выборку до конца, в отличие от самого сбора, который
// останавливается, набрав нужное количество. Оператор теперь просто указывает,
// сколько организаций забрать, и получает их — считать наперёд незачем.
//
// Объём каждой рубрики и каждого места по-прежнему виден в форме: он берётся из
// справочников, посчитанных заранее (`yandex_maps_catalog_places` и
// `yandex_maps_catalog_rubrics`), и ничего не стоит.
