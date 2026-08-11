/**
 * @jest-environment node
 */
import {
  loadAccountsForDedupe,
  DEDUPE_PAGE,
  type DedupePage,
  type DedupeReader,
} from '@/lib/tgOutreach/existingAccounts';

type Row = Record<string, unknown>;

interface StubOptions {
  /** Потолок строк на один ответ на стороне PostgREST (db-max-rows). */
  maxRows?: number;
  /** Уронить запрос с этим номером (нумерация с нуля). */
  failOnCall?: number;
  /** Подменить серверный COUNT — в норме он равен числу строк. */
  countOverride?: number | null;
}

/**
 * Заглушка PostgREST: режет запрошенный диапазон, умеет обрезать ответ своим
 * потолком и отдаёт COUNT по всей таблице, а не по странице. Ровно эти
 * поведения и проверяем — на живой базе их не воспроизвести.
 */
function makeReader(rows: Row[], options: StubOptions = {}) {
  const calls: Array<{ from: number; to: number }> = [];

  const reader: DedupeReader = {
    from: () => ({
      select: () => ({
        order: () => ({
          range: (from: number, to: number): PromiseLike<DedupePage> => {
            const call = calls.length;
            calls.push({ from, to });

            if (options.failOnCall === call) {
              return Promise.resolve({
                data: null,
                error: { message: 'соединение с базой оборвалось' },
                count: null,
              });
            }

            const requested = to - from + 1;
            const size = Math.min(requested, options.maxRows ?? Number.MAX_SAFE_INTEGER);
            return Promise.resolve({
              data: rows.slice(from, from + size),
              error: null,
              count: 'countOverride' in options ? (options.countOverride ?? null) : rows.length,
            });
          },
        }),
      }),
    }),
  };

  return { reader, calls };
}

const manyRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    tg_user_id: i + 1,
    session_data: `sess-${i + 1}`,
    tg_outreach_campaigns: { name: 'ATOL' },
  }));

/** Успешный результат или падение теста — чтобы не разветвлять каждый expect. */
function expectRows(result: Awaited<ReturnType<typeof loadAccountsForDedupe>>) {
  if ('error' in result) throw new Error(`ожидались строки, получена ошибка: ${result.error}`);
  return result.rows;
}

describe('loadAccountsForDedupe', () => {
  it('на пустой таблице возвращает пустой список за один запрос', async () => {
    const { reader, calls } = makeReader([]);

    expect(expectRows(await loadAccountsForDedupe(reader))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('читает таблицу короче страницы одним запросом', async () => {
    const { reader, calls } = makeReader(manyRows(500));

    expect(expectRows(await loadAccountsForDedupe(reader))).toHaveLength(500);
    expect(calls).toHaveLength(1);
  });

  it('склеивает несколько страниц', async () => {
    const { reader, calls } = makeReader(manyRows(DEDUPE_PAGE * 2 + 500));

    const rows = expectRows(await loadAccountsForDedupe(reader));

    expect(rows).toHaveLength(DEDUPE_PAGE * 2 + 500);
    expect(calls).toHaveLength(3);
    // Страницы идут подряд и не перекрываются — иначе строки бы задвоились.
    expect(calls.map((c) => c.from)).toEqual([0, DEDUPE_PAGE, DEDUPE_PAGE * 2]);
    expect(rows[rows.length - 1].tg_user_id).toBe(DEDUPE_PAGE * 2 + 500);
  });

  it('не запрашивает страницу за последней строкой, когда строк ровно на страницы', async () => {
    // На диапазон целиком за пределами таблицы PostgREST отвечает 416, и
    // здоровое чтение выглядело бы как сбой.
    const { reader, calls } = makeReader(manyRows(DEDUPE_PAGE * 2));

    expect(expectRows(await loadAccountsForDedupe(reader))).toHaveLength(DEDUPE_PAGE * 2);
    expect(calls).toHaveLength(2);
  });

  it('отказывается сверять, если сервер обрезал ответ своим потолком', async () => {
    // db-max-rows ниже нашей страницы: каждая страница приходит короткой, и
    // цикл считает, что данные кончились. Ловит это только сверка с COUNT.
    const { reader } = makeReader(manyRows(2500), { maxRows: 500 });

    const result = await loadAccountsForDedupe(reader);

    expect(result).toEqual({ error: 'прочитано 500 аккаунтов из 2500 — сверка неполная' });
  });

  it('отдаёт ошибку, а не куски, если запрос упал на середине', async () => {
    const { reader } = makeReader(manyRows(2500), { failOnCall: 1 });

    const result = await loadAccountsForDedupe(reader);

    expect(result).toEqual({ error: 'соединение с базой оборвалось' });
  });

  it('отказывается сверять, если база не сообщила COUNT', async () => {
    const { reader } = makeReader(manyRows(10), { countOverride: null });

    const result = await loadAccountsForDedupe(reader);

    expect(result).toEqual({ error: 'база не сообщила, сколько всего аккаунтов' });
  });

  it('отказывается, когда прочитано меньше, чем обещал COUNT', async () => {
    // Тот же барьер ловит и упор в потолок цикла: оттуда выход ведёт в эту же
    // проверку, а не в отдельную ветку.
    const { reader } = makeReader(manyRows(0), { countOverride: 5_000_000 });

    const result = await loadAccountsForDedupe(reader);

    expect('error' in result && result.error).toContain('сверка неполная');
  });

  it('сохраняет пустой tg_user_id и отсутствие кампании', async () => {
    // Number(null) даёт 0 — в сверке появился бы несуществующий аккаунт с id 0
    // и мог бы «съесть» настоящего кандидата.
    const { reader } = makeReader([
      { tg_user_id: null, session_data: 'sess-a', tg_outreach_campaigns: null },
      { tg_user_id: '777', session_data: null, tg_outreach_campaigns: { name: 'ATOL' } },
    ]);

    expect(expectRows(await loadAccountsForDedupe(reader))).toEqual([
      {
        tg_user_id: null,
        campaign_name: null,
        session_data: 'sess-a',
        session_name: null,
        phone: null,
        tg_username: null,
        first_name: null,
        last_name: null,
      },
      {
        tg_user_id: 777,
        campaign_name: 'ATOL',
        session_data: null,
        session_name: null,
        phone: null,
        tg_username: null,
        first_name: null,
        last_name: null,
      },
    ]);
  });

  it('доносит опознавательные поля до сверки', async () => {
    // Без них сообщение о пропуске называет кампанию, но не аккаунт, и
    // оператору нечего искать в списке.
    const { reader } = makeReader([{
      tg_user_id: 111,
      session_data: 'sess-a',
      session_name: 'acc_17',
      phone: '+79991234567',
      tg_username: 'ivanp',
      first_name: 'Иван',
      last_name: 'Петров',
      tg_outreach_campaigns: { name: 'Profitsol 3.0' },
    }]);

    expect(expectRows(await loadAccountsForDedupe(reader))[0]).toEqual({
      tg_user_id: 111,
      campaign_name: 'Profitsol 3.0',
      session_data: 'sess-a',
      session_name: 'acc_17',
      phone: '+79991234567',
      tg_username: 'ivanp',
      first_name: 'Иван',
      last_name: 'Петров',
    });
  });
});
