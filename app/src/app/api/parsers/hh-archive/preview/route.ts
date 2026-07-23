/**
 * POST /api/parsers/hh-archive/preview
 *
 * Pre-flight estimate: дёргает HH API с per_page=1 для каждого
 * search_query + первый чанк по дате, чтобы показать юзеру сколько
 * вакансий найдётся ДО запуска тяжёлого парсинга.
 *
 * Зачем: главная защита от «упс, выбрал всю РФ за 5 лет и запустил».
 * Юзер видит «найдено 8 234 вакансий — продолжить?» и сам решает
 * (либо сужает фильтры, либо разрешает большой прогон).
 *
 * Тратит ~N мини-API-запросов (per_page=1, дёшево) — для каждого
 * search_query один запрос. Безопасно для rate limit.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { HH_API_BASE, parseAreas } from '@/lib/parsers/hhArchive/parser';
import { fetchWithRetry, HHApiError } from '@/lib/parsers/hhParser';
import { logInfo, logWarn } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

// Все походы на HH идут через общий fetchWithRetry: он подключён к RU-прокси
// (PROXY_URLS), троттлит одновременные запросы (HH_MAX_CONCURRENCY) и
// ретраит 429/403/5xx с backoff'ом. HH с 2026-04-15 требует OAuth
// (HH_ACCESS_TOKEN) и российский IP — без прокси с прод-сервера в Торонто
// приходит 403 либо TCP-сброс (fetch failed).

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface PreviewRequest {
  search_queries?: unknown;
  area?: unknown;
  date_from?: unknown;
  date_to?: unknown;
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
  const archived = body.archived !== false; // default true

  // Всё через общий fetchWithRetry — глобальный throttle кэпит одновременные
  // запросы (HH_MAX_CONCURRENCY, дефолт 2), так что Promise.all тут = de-facto
  // очередь на 2 запроса за раз с задержкой. Ретраев мало (2 попытки),
  // чтобы preview не залипал при недоступности прокси/HH.
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      const params = new URLSearchParams();
      params.set('text', q);
      params.set('per_page', '1');
      params.set('page', '0');
      const areas = parseAreas(area);
      if (areas.length === 0) params.append('area', '113');
      else for (const a of areas) params.append('area', a);
      if (archived) params.set('archived', 'true');
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      const url = `${HH_API_BASE}?${params.toString()}`;
      try {
        const json = await fetchWithRetry<{ found?: number }>(url, {
          maxRetries: 2,
          timeoutMs: 15_000,
        });
        const found = Number(json.found ?? 0);
        // Диагностический лог: чтобы после деплоя видеть в prod-логах,
        // возвращает ли HH API реальные числа с `archived=true` или молча
        // отдаёт 0 (тогда `archived` на api.hh.ru не поддерживается и надо
        // будет переходить на скрейп hh.ru/search/vacancy).
        void logInfo(
          'parser.hh_archive.preview.query',
          'HH archive preview query',
          {
            userId: user.id,
            query: q,
            area,
            date_from: dateFrom,
            date_to: dateTo,
            archived,
            found,
          },
        );
        return { query: q, found, error: null };
      } catch (e) {
        const message = e instanceof HHApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'fetch failed';
        void logWarn(
          'parser.hh_archive.preview.query.failed',
          'HH archive preview query failed',
          {
            userId: user.id,
            query: q,
            error: message,
            status: e instanceof HHApiError ? e.status : undefined,
          },
        );
        return { query: q, found: 0, error: message };
      }
    }),
  );

  // Cумма НЕ равна реальному размеру выгрузки — пересечения по vacancy_id
  // между запросами не учтены. Но это нормально для estimation: лучше
  // показать «верхнюю границу» юзеру, чем недооценить и упереться в cap.
  const totalEstimated = perQuery.reduce((s, r) => s + r.found, 0);

  return NextResponse.json({
    total_estimated: totalEstimated,
    per_query: perQuery,
    note: 'Сумма по запросам без учёта пересечений. Фактически выгрузится меньше или равно этому числу.',
  });
}
