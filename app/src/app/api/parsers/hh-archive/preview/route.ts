/**
 * POST /api/parsers/hh-archive/preview
 *
 * Pre-flight estimate: для каждого search_query считаем, сколько подходящих
 * вакансий уже лежит в `hh_vacancies` — БЕЗ похода в HH API. Юзер видит
 * реальные цифры и решает: запускать job или сузить фильтры.
 *
 * Раньше preview ходил в api.hh.ru — но HH API отдаёт только последние
 * ~60 дней. Любые запросы за более старые периоды возвращали 0, что
 * выглядело как «парсер сломан» (см. инцидент 27.07.2026). Теперь ищем
 * локально; за периоды до `oldest_available` — плашка в UI честно
 * говорит «данных нет, парсинга не было». См. hhArchive/localSearch.ts.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { parseAreas } from '@/lib/parsers/hhArchive/parser';
import { countVacanciesLocal, getOldestVacancyDate } from '@/lib/parsers/hhArchive/localSearch';
import { logInfo, logWarn } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface PreviewRequest {
  search_queries?: unknown;
  area?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  // `archived` больше не читаем: локальный архив хранит и открытые, и закрытые
  // вакансии, отдельного статуса у нас нет. Поле принимаем для совместимости
  // со старым фронтом, но игнорируем.
  archived?: unknown;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  let body: PreviewRequest;
  try {
    body = (await req.json()) as PreviewRequest;
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
  const areaIds = parseAreas(area);

  const perQuery = await Promise.all(
    queries.map(async (q) => {
      try {
        const found = await countVacanciesLocal({
          query: q,
          areaIds,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        });
        void logInfo(
          'parser.hh_archive.preview.query',
          'HH archive local-count',
          { userId: user.id, query: q, area, date_from: dateFrom, date_to: dateTo, found },
        );
        return { query: q, found, error: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : 'count failed';
        void logWarn(
          'parser.hh_archive.preview.query.failed',
          'HH archive local-count failed',
          { userId: user.id, query: q, error: message },
        );
        return { query: q, found: 0, error: message };
      }
    }),
  );

  const totalEstimated = perQuery.reduce((s, r) => s + r.found, 0);

  // Дата самой старой записи — фронт покажет плашку «данные с ...».
  // Fire-and-forget, ошибка не валит preview.
  const oldestAvailable = await getOldestVacancyDate().catch(() => null);

  return NextResponse.json({
    total_estimated: totalEstimated,
    per_query: perQuery,
    oldest_available: oldestAvailable,
    note:
      'Поиск идёт по локальному архиву `hh_vacancies` (то, что обычный парсер спецов + auto-pipeline уже собрали). ' +
      'За периоды до oldest_available данных нет — HH API не хранит вакансии старше ~60 дней.',
  });
}
