import type { ExistingAccountRow } from './tdataImport';

/**
 * Страница выборки. Не больше PostgREST max-rows, иначе хвост обрежется молча.
 */
export const DEDUPE_PAGE = 1000;

/** Потолок на случай неожиданно разросшейся таблицы: упёрлись — отказываем. */
export const DEDUPE_MAX_ROWS = 200_000;

/** Ответ одной страницы — ровно то, что от него читает выборка. */
export interface DedupePage {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
  count: number | null;
}

/**
 * Ровно тот кусок supabase-js, который нужен этой выборке.
 *
 * Узкий интерфейс вместо полного клиента: он и документирует использованную
 * поверхность, и позволяет прогнать все ветки на заглушке — включая те, что на
 * живой базе воспроизвести нечем (обрезка ответа сервером, расхождение с
 * COUNT).
 */
export interface DedupeReader {
  from(table: string): {
    select(
      columns: string,
      options: { count: 'exact' },
    ): {
      order(
        column: string,
        options: { ascending: boolean },
      ): {
        range(from: number, to: number): PromiseLike<DedupePage>;
      };
    };
  };
}

export type LoadAccountsResult = { rows: ExistingAccountRow[] } | { error: string };

/**
 * Прочитать все аккаунты портала, по которым идёт сверка дублей.
 *
 * Страницами через `.range()`: на голом `select` PostgREST отдал бы только
 * первые max-rows строк и никак об этом не сообщил. Недочитанная сверка
 * опасна ровно так же, как упавшая, — оба случая выглядят как «дублей нет» и
 * пропускают в базу второй аккаунт с тем же ключом авторизации.
 *
 * Полноту проверяем не по длине последней страницы, а сравнением с COUNT на
 * сервере: короткая страница означает и «данные кончились», и «PostgREST
 * обрезал ответ своим max-rows», а на глаз эти случаи неразличимы. Любое
 * расхождение, обрыв и упор в потолок возвращают ошибку, а не короткий список.
 *
 * Порядок фиксируем по `id`: без ORDER BY страницы могут перекрываться и
 * терять строки между запросами.
 */
export async function loadAccountsForDedupe(db: DedupeReader): Promise<LoadAccountsResult> {
  const rows: ExistingAccountRow[] = [];
  let total: number | null = null;

  for (let from = 0; from < DEDUPE_MAX_ROWS; from += DEDUPE_PAGE) {
    const { data, error, count } = await db
      .from('tg_outreach_accounts')
      .select('tg_user_id, session_data, tg_outreach_campaigns(name)', { count: 'exact' })
      .order('id', { ascending: true })
      .range(from, from + DEDUPE_PAGE - 1);

    if (error) return { error: error.message };
    if (typeof count === 'number') total = count;

    const page = data ?? [];
    for (const row of page) {
      const rowCampaign = (row as { tg_outreach_campaigns?: { name?: string } | null })
        .tg_outreach_campaigns;
      // Пустой tg_user_id обязан остаться null: Number(null) даёт 0, и в
      // сверке появился бы несуществующий аккаунт с id 0.
      const rawUserId = (row as { tg_user_id?: number | string | null }).tg_user_id;
      rows.push({
        tg_user_id: rawUserId === null || rawUserId === undefined ? null : Number(rawUserId),
        campaign_name: rowCampaign?.name ?? null,
        session_data: (row as { session_data?: string | null }).session_data ?? null,
      });
    }

    // Дочитали ровно до конца — не запрашиваем страницу за последней строкой:
    // на диапазон целиком за пределами таблицы PostgREST отвечает 416, и
    // здоровое чтение выглядело бы как сбой.
    if (total !== null && rows.length >= total) break;
    if (page.length < DEDUPE_PAGE) break;
  }

  if (total === null) return { error: 'база не сообщила, сколько всего аккаунтов' };
  if (rows.length !== total) {
    return { error: `прочитано ${rows.length} аккаунтов из ${total} — сверка неполная` };
  }

  return { rows };
}
