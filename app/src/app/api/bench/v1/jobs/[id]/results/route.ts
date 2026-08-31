import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertToolAllowed, authenticateBench, isBenchAuth } from '@/lib/bench/auth';
import { benchError } from '@/lib/bench/errors';
import { logBenchRequest } from '@/lib/bench/journal';
import { checkBenchLimits } from '@/lib/bench/limits';
import { getBenchTool } from '@/lib/bench/registry';
import { BENCH_FILE_URL_TTL_SECONDS, signBenchResultUrl } from '@/lib/bench/resultFile';
import { applyToolScope } from '@/lib/bench/scope';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BenchJobTool } from '@/lib/bench/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Строка задачи с единственным нужным полем (без поля — только проверка, что
 * задача вообще видна роботу).
 *
 * Имя поля приходит из реестра инструментов, поэтому выражение для `select()`
 * собирается шаблонной строкой. По такому выражению supabase-js выводит форму
 * строки на уровне типов, и на union из всех возможных полей вывод
 * вырождается: в файловой ветке получалось «нельзя индексировать по string»
 * (TS7015), в inline — «слишком глубокий вывод типов» (TS2589). Поэтому
 * выражение объявлено обычной `string` — вывод обрывается здесь, а форму
 * ответа вызывающий код всё равно проверяет в рантайме (`typeof`,
 * `Array.isArray`), а не полагается на типы.
 */
async function selectJobField(
  db: SupabaseClient,
  jobTool: BenchJobTool,
  id: string,
  field?: string,
): Promise<Record<string, unknown> | null> {
  const columns: string = field ? `id, ${field}` : 'id';
  const { data } = await applyToolScope(
    db.from(jobTool.table).select(columns).eq('id', id),
    jobTool,
  ).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const started = Date.now();
  const auth = await authenticateBench(req);
  if (!isBenchAuth(auth)) return auth;

  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const toolId = sp.get('tool') ?? '';

  const finish = async (response: NextResponse, rows: number) => {
    await logBenchRequest({
      keyId: auth.key.id,
      tool: toolId || null,
      action: 'results',
      statusCode: response.status,
      // Отданные строки идут в журнал: по ним считается суточная норма, и
      // это главный ограничитель постепенной выкачки наших баз.
      rowsReturned: rows,
      durationMs: Date.now() - started,
    });
    return response;
  };

  const tool = getBenchTool(toolId);
  if (!tool || tool.kind !== 'job') {
    return finish(benchError('not_found', `Инструмент «${toolId}» не найден`), 0);
  }

  const denied = assertToolAllowed(auth.key, tool.id);
  if (denied) return finish(denied, 0);

  const limited = await checkBenchLimits(auth.key, 'results');
  if (limited) return finish(limited, 0);

  const jobTool = tool as BenchJobTool;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(sp.get('limit')) || DEFAULT_LIMIT));
  const cursor = sp.get('cursor');

  // Результаты у инструментов лежат тремя способами — отдельной таблицей,
  // массивом в самой строке задачи или файлом в хранилище. Проверка «задача
  // моя» во всех случаях идёт через клиент робота, то есть её выполняет RLS.
  if (jobTool.results.kind === 'file') {
    const { bucket, pathField } = jobTool.results;
    const job = await selectJobField(auth.db, jobTool, id, pathField);
    if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

    const path = typeof job[pathField] === 'string' ? (job[pathField] as string) : null;
    if (!path) {
      return finish(
        benchError('conflict', 'Результат ещё не готов — дождитесь завершения задачи'),
        0,
      );
    }

    // Ссылка временная и ведёт ровно на один файл этой задачи. Постоянную
    // выдавать нельзя: она пережила бы и отзыв ключа, и увольнение
    // подрядчика.
    const url = await signBenchResultUrl(bucket, path);
    if (!url) {
      return finish(benchError('server_error', 'Не удалось выдать ссылку на результат'), 0);
    }

    return finish(
      NextResponse.json({
        kind: 'file',
        url,
        expires_in_seconds: BENCH_FILE_URL_TTL_SECONDS,
      }),
      1,
    );
  }

  if (jobTool.results.kind === 'inline') {
    const field = jobTool.results.field;
    const job = await selectJobField(auth.db, jobTool, id, field);
    if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

    const all = Array.isArray(job[field]) ? (job[field] as unknown[]) : [];
    // У элементов JSON-массива нет ни id, ни порядка, кроме позиции —
    // поэтому здесь курсор это номер элемента, а не идентификатор строки.
    const from = Math.max(0, Number(cursor) || 0);
    const page = all.slice(from, from + limit);
    const hasMore = from + page.length < all.length;

    return finish(
      NextResponse.json({
        rows: page,
        cursor: hasMore ? String(from + page.length) : null,
        has_more: hasMore,
      }),
      page.length,
    );
  }

  // Сперва убеждаемся, что задача видна роботу. Без этого пришлось бы
  // полагаться только на RLS дочерней таблицы, а она у разных инструментов
  // написана по-разному — родителя проверяем явно.
  const job = await selectJobField(auth.db, jobTool, id);
  if (!job) return finish(benchError('not_found', 'Задача не найдена'), 0);

  // Курсор, а не смещение: результаты дописываются воркером прямо во время
  // выгрузки, и offset на растущей таблице теряет и дублирует строки.
  let query = auth.db
    .from(jobTool.results.table)
    .select('*')
    .eq(jobTool.results.jobColumn, id)
    .order('id', { ascending: true })
    .limit(limit);
  if (cursor) query = query.gt('id', cursor);

  const { data, error } = await query;
  if (error) return finish(benchError('server_error', error.message), 0);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length === limit;
  const last = rows[rows.length - 1];

  return finish(
    NextResponse.json({
      rows,
      cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    }),
    rows.length,
  );
}
