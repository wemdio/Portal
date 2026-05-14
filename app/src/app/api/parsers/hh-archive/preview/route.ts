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
import { HH_API_BASE } from '@/lib/parsers/hhArchive/parser';

export const dynamic = 'force-dynamic';

const USER_AGENT =
  process.env.HH_ARCHIVE_USER_AGENT ?? 'PolzaAgency-Portal/1.0 (hello@polzaagency.ru)';
const OAUTH_TOKEN = process.env.HH_OAUTH_TOKEN || undefined;

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

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (OAUTH_TOKEN) headers.Authorization = `Bearer ${OAUTH_TOKEN}`;

  // По одному мини-запросу на каждый search_query. Все параллельно, чтобы
  // не ждать 30 секунд если у юзера 20 запросов. HH рейт-лимит на 20
  // одновременных запросов спокойно держит (это не парсинг, это 1 запрос
  // с per_page=1 = микро-payload).
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      const params = new URLSearchParams();
      params.set('text', q);
      params.set('per_page', '1');
      params.set('page', '0');
      params.set('area', area);
      if (archived) params.set('archived', 'true');
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      try {
        const res = await fetch(`${HH_API_BASE}?${params.toString()}`, { headers });
        if (!res.ok) {
          return { query: q, found: 0, error: `HH ${res.status}` };
        }
        const json = (await res.json()) as { found?: number };
        return { query: q, found: Number(json.found ?? 0), error: null };
      } catch (e) {
        return {
          query: q,
          found: 0,
          error: e instanceof Error ? e.message : 'fetch failed',
        };
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
