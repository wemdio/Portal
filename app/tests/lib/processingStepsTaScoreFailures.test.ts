/**
 * @jest-environment node
 *
 * Диагностика провалов шага «Оценка ЦА» (разбор 04.08.2026).
 *
 * Симптом: в результате строки с баллом 5 и подписью «Ошибка оценки». Это не
 * вердикт ИИ, а заглушка: запрос упал, и вся пачка из 10 компаний получила
 * фиктивный балл. Разобрать причину было невозможно — `catch` глотал ошибку,
 * не записывая ни статуса, ни текста.
 *
 * Замеры по проду: 0 из 69 строк, 10 из 154, 98 из 304 — падают отдельные
 * пачки, а не все. Повторы в коде были (любой код ошибки повторялся), но
 * расписание 1.5+3+6с укладывается в ~10 секунд, а окно лимита запросов у
 * провайдера — около минуты, и заголовок Retry-After игнорировался.
 *
 * Здесь фиксируем два инварианта:
 *   1. planAiRetry — на какие коды повторять, сколько ждать и когда сдаться.
 *   2. stepTAScore — провал пачки виден в телеметрии с причиной, а не молча.
 */

import { planAiRetry, stepTAScore } from '@/lib/tools/processingSteps';

describe('planAiRetry — расписание повторов', () => {
  it('на «постоянных» ошибках не тратит попытки: смысла повторять нет', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const d = planAiRetry({ status, attempt: 0 });
      expect(d.retry).toBe(false);
      expect(d.kind).toBe('permanent');
    }
  });

  it('лимит запросов повторяет, и ждёт заметно дольше серверной ошибки', () => {
    const rate = planAiRetry({ status: 429, attempt: 0 });
    const server = planAiRetry({ status: 503, attempt: 0 });
    expect(rate.retry).toBe(true);
    expect(rate.kind).toBe('rate_limit');
    // Окно лимита у провайдера — около минуты; полторы секунды его не пересидят.
    expect(rate.delayMs).toBeGreaterThanOrEqual(5_000);
    expect(rate.delayMs).toBeGreaterThan(server.delayMs);
  });

  it('уважает Retry-After, если провайдер его прислал', () => {
    const d = planAiRetry({ status: 429, attempt: 0, retryAfterSec: 20 });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(20_000);
  });

  it('Retry-After ограничен сверху: провайдер не должен вешать джоб на час', () => {
    const d = planAiRetry({ status: 429, attempt: 0, retryAfterSec: 3600 });
    expect(d.delayMs).toBeLessThanOrEqual(60_000);
  });

  it('серверные ошибки повторяет с нарастающей паузой', () => {
    const first = planAiRetry({ status: 502, attempt: 0 });
    const second = planAiRetry({ status: 502, attempt: 1 });
    expect(first.retry).toBe(true);
    expect(first.kind).toBe('server');
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it('сетевую ошибку (статуса нет) повторяет', () => {
    const d = planAiRetry({ status: null, attempt: 0 });
    expect(d.retry).toBe(true);
    expect(d.kind).toBe('network');
  });

  it('после последней попытки сдаётся независимо от кода', () => {
    const d = planAiRetry({ status: 429, attempt: 3, maxRetries: 3 });
    expect(d.retry).toBe(false);
    expect(d.kind).toBe('exhausted');
  });
});

describe('stepTAScore — провал пачки виден в телеметрии', () => {
  const realFetch = global.fetch;
  const noop = async () => {};
  const header = ['компания', 'Сайт', 'email', 'Описание'];

  interface SentCompany {
    idx: number;
    data: Record<string, string>;
  }

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /** 403 — «постоянная» ошибка: повторов не будет, тест не ждёт пауз. */
  function failWith(status: number, body = '{"error":{"message":"nope"}}') {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
      headers: { get: () => null },
    })) as unknown as typeof fetch;
  }

  function readSentCompanies(init: { body: string }): SentCompany[] {
    const reqBody = JSON.parse(init.body) as { messages: { content: string }[] };
    return JSON.parse(reqBody.messages[1].content.split('Компании:\n')[1]) as SentCompany[];
  }

  function okWithContent(content: unknown, finishReason: 'stop' | 'length' = 'stop') {
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
          finish_reason: finishReason,
        }],
      }),
    };
  }

  it('finish_reason=length: повторяет только отсутствующие оценки и сохраняет уже полученные', async () => {
    const sentIndexes: number[][] = [];
    let call = 0;
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      call += 1;
      sentIndexes.push(readSentCompanies(init).map((company) => company.idx));
      return call === 1
        ? okWithContent([
            { idx: 0, score: 0, reason: 'Настоящий нулевой балл' },
            { idx: 2, score: 8, reason: 'Подходит' },
          ], 'length')
        : okWithContent([{ idx: 1, score: 9, reason: 'Подходит после повтора' }]);
    }) as unknown as typeof fetch;

    let stats: { failed_rows: number; failed_batches: number; length_responses: number } | undefined;
    const out = await stepTAScore(
      [
        header,
        ['Alpha', 'a.ru', 'a@a.ru', 'd'],
        ['Beta', 'b.ru', 'b@b.ru', 'd'],
        ['Gamma', 'g.ru', 'g@g.ru', 'd'],
      ],
      'brief',
      noop,
      undefined,
      { keepAllScored: true, onStats: (s) => { stats = s; } },
    );

    expect(sentIndexes).toEqual([[0, 1, 2], [1]]);
    expect(out.slice(1).map((row) => row[4])).toEqual(['0', '9', '8']);
    expect(out.slice(1).map((row) => row[5])).toEqual([
      'Настоящий нулевой балл',
      'Подходит после повтора',
      'Подходит',
    ]);
    expect(stats?.failed_rows).toBe(0);
    expect(stats?.failed_batches).toBe(0);
    expect(stats?.length_responses).toBe(1);
  });

  it('finish_reason=length с полным валидным массивом принимает, но учитывает в телеметрии', async () => {
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const companies = readSentCompanies(init);
      return okWithContent(
        companies.map((company) => ({ idx: company.idx, score: 8, reason: `r-${company.idx}` })),
        'length',
      );
    }) as unknown as typeof fetch;

    let stats: { failed_rows: number; failed_batches: number; length_responses: number } | undefined;
    const out = await stepTAScore(
      [header, ['Alpha', 'a.ru', 'a@a.ru', 'd'], ['Beta', 'b.ru', 'b@b.ru', 'd']],
      'brief',
      noop,
      undefined,
      { keepAllScored: true, onStats: (s) => { stats = s; } },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(out.slice(1).map((row) => row[4])).toEqual(['8', '8']);
    expect(stats?.failed_rows).toBe(0);
    expect(stats?.failed_batches).toBe(0);
    expect(stats?.length_responses).toBe(1);
  });

  it('принимает массив оценок в JSON-обёртке вместо молчаливых нулей', async () => {
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const companies = readSentCompanies(init);
      return okWithContent({
        scores: companies.map((company) => ({
          idx: company.idx,
          score: company.idx === 0 ? 7 : 8,
          reason: `r-${company.idx}`,
        })),
      });
    }) as unknown as typeof fetch;

    const out = await stepTAScore(
      [header, ['Alpha', 'a.ru', 'a@a.ru', 'd'], ['Beta', 'b.ru', 'b@b.ru', 'd']],
      'brief',
      noop,
      undefined,
      { keepAllScored: true },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(out.slice(1).map((row) => row[4])).toEqual(['7', '8']);
    expect(out.slice(1).map((row) => row[5])).toEqual(['r-0', 'r-1']);
  });

  it('не засчитывает дубли и чужие индексы как оценку нужной компании', async () => {
    const sentIndexes: number[][] = [];
    let call = 0;
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      call += 1;
      sentIndexes.push(readSentCompanies(init).map((company) => company.idx));
      return call === 1
        ? okWithContent([
            { idx: 0, score: 2, reason: 'Первый дубль' },
            { idx: 0, score: 'сломано', reason: 'Испорченный второй дубль' },
            { idx: 99, score: 10, reason: 'Чужой индекс' },
            { idx: 2, score: 8, reason: 'Корректный ответ' },
          ])
        : okWithContent([
            { idx: 0, score: 7, reason: 'Alpha после повтора' },
            { idx: 1, score: 9, reason: 'Beta после повтора' },
          ]);
    }) as unknown as typeof fetch;

    const out = await stepTAScore(
      [
        header,
        ['Alpha', 'a.ru', 'a@a.ru', 'd'],
        ['Beta', 'b.ru', 'b@b.ru', 'd'],
        ['Gamma', 'g.ru', 'g@g.ru', 'd'],
      ],
      'brief',
      noop,
      undefined,
      { keepAllScored: true },
    );

    expect(sentIndexes).toEqual([[0, 1, 2], [0, 1]]);
    expect(out.slice(1).map((row) => row[4])).toEqual(['7', '9', '8']);
    expect(out.slice(1).map((row) => row[5])).toEqual([
      'Alpha после повтора',
      'Beta после повтора',
      'Корректный ответ',
    ]);
  });

  it('после исчерпания length-повторов помечает только нерешённые компании явной ошибкой', async () => {
    const sentIndexes: number[][] = [];
    let call = 0;
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      call += 1;
      sentIndexes.push(readSentCompanies(init).map((company) => company.idx));
      return call === 1
        ? okWithContent([{ idx: 0, score: 8, reason: 'Alpha оценена' }], 'length')
        : okWithContent([], 'length');
    }) as unknown as typeof fetch;

    let stats: {
      failed_rows: number;
      failed_batches: number;
      length_responses: number;
      errors: Array<{ reason: string; count: number }>;
    } | undefined;
    const out = await stepTAScore(
      [header, ['Alpha', 'a.ru', 'a@a.ru', 'd'], ['Beta', 'b.ru', 'b@b.ru', 'd']],
      'brief',
      noop,
      undefined,
      { keepAllScored: true, onStats: (s) => { stats = s; } },
    );

    expect(sentIndexes).toEqual([[0, 1], [1], [1], [1]]);
    expect(out.slice(1).map((row) => row[4])).toEqual(['8', '5']);
    expect(out.slice(1).map((row) => row[5])).toEqual(['Alpha оценена', 'Ошибка оценки']);
    expect(stats?.failed_rows).toBe(1);
    expect(stats?.failed_batches).toBe(1);
    expect(stats?.length_responses).toBe(4);
    expect(stats?.errors[0]?.reason).toMatch(/finish_reason=length/i);
  });

  it('сообщает, сколько строк осталось без оценки и почему', async () => {
    failWith(403);
    let stats: {
      failed_rows: number;
      failed_batches: number;
      errors: Array<{ reason: string; count: number }>;
    } | undefined;

    const out = await stepTAScore(
      [header, ['Alpha', 'a.ru', 'a@a.ru', 'd'], ['Beta', 'b.ru', 'b@b.ru', 'd']],
      'brief',
      noop,
      undefined,
      { keepAllScored: true, onStats: (s) => { stats = s as typeof stats; } },
    );

    expect(stats?.failed_batches).toBe(1);
    expect(stats?.failed_rows).toBe(2);
    // Причина должна содержать код ответа — иначе разбирать нечего.
    expect(stats?.errors?.[0]?.reason).toMatch(/403/);
    expect(stats?.errors?.[0]?.count).toBe(1);

    // Поведение самих строк не меняем: та же заглушка, что и раньше.
    const rows = out.slice(1);
    expect(rows.map((r) => r[4])).toEqual(['5', '5']);
    expect(rows.map((r) => r[5])).toEqual(['Ошибка оценки', 'Ошибка оценки']);
  });

  it('при успехе телеметрия провалов пустая', async () => {
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const reqBody = JSON.parse(init.body) as { messages: { content: string }[] };
      const companies = JSON.parse(reqBody.messages[1].content.split('Компании:\n')[1]) as { idx: number }[];
      const answer = companies.map((c) => ({ idx: c.idx, score: 8, reason: 'ok' }));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
    }) as unknown as typeof fetch;

    let stats: { failed_rows: number; failed_batches: number } | undefined;
    await stepTAScore([header, ['Alpha', 'a.ru', 'a@a.ru', 'd']], 'brief', noop, undefined, {
      keepAllScored: true,
      onStats: (s) => { stats = s as typeof stats; },
    });

    expect(stats?.failed_batches).toBe(0);
    expect(stats?.failed_rows).toBe(0);
  });

  it('resume с checkpoint не вызывает AI повторно для уже оценённых компаний', async () => {
    const sentCompanies: string[][] = [];
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const companies = readSentCompanies(init);
      sentCompanies.push(companies.map((company) => company.data['компания']));
      return okWithContent(
        companies.map((company) => ({
          idx: company.idx,
          score: company.data['компания'] === 'Beta' ? 9 : 8,
          reason: `fresh-${company.data['компания']}`,
        })),
      );
    }) as unknown as typeof fetch;

    const checkpointedHeader = [...header, 'ЦА Балл', 'ЦА Причина'];
    const out = await stepTAScore(
      [
        checkpointedHeader,
        ['Alpha', 'a.ru', 'a@a.ru', 'd', '8', 'checkpoint-alpha'],
        ['Beta', 'b.ru', 'b@b.ru', 'd', '', ''],
        ['Gamma', 'g.ru', 'g@g.ru', 'd', '7', 'checkpoint-gamma'],
      ],
      'brief',
      noop,
      undefined,
      { keepAllScored: true },
    );

    expect(sentCompanies).toEqual([['Beta']]);
    expect(out[0]).toEqual(checkpointedHeader);
    expect(out.slice(1).map((row) => row.slice(4, 6))).toEqual([
      ['8', 'checkpoint-alpha'],
      ['9', 'fresh-Beta'],
      ['7', 'checkpoint-gamma'],
    ]);
  });

  it('пишет checkpoint после AI-батча до финальной фильтрации', async () => {
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const companies = readSentCompanies(init);
      return okWithContent(
        companies.map((company) => ({
          idx: company.idx,
          score: company.data['компания'] === 'Alpha' ? 5 : 8,
          reason: `r-${company.data['компания']}`,
        })),
      );
    }) as unknown as typeof fetch;

    const checkpoints: string[][][] = [];
    const out = await stepTAScore(
      [
        header,
        ['Alpha', 'a.ru', 'a@a.ru', 'd'],
        ['Beta', 'b.ru', 'b@b.ru', 'd'],
      ],
      'brief',
      noop,
      undefined,
      {
        onCheckpoint: async (rows) => {
          checkpoints.push(rows);
        },
      },
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0][0]).toEqual([...header, 'ЦА Балл', 'ЦА Причина']);
    expect(checkpoints[0].slice(1).map((row) => row.slice(4, 6))).toEqual([
      ['5', 'r-Alpha'],
      ['8', 'r-Beta'],
    ]);
    expect(out.slice(1).map((row) => row[0])).toEqual(['Beta']);
  });

  it('считает провалы по пачкам: упавшая пачка не портит статистику успешной', async () => {
    // 15 уникальных компаний → две пачки (10 + 5). Первая падает, вторая проходит.
    let call = 0;
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 403, text: async () => 'denied', headers: { get: () => null } };
      }
      const reqBody = JSON.parse(init.body) as { messages: { content: string }[] };
      const companies = JSON.parse(reqBody.messages[1].content.split('Компании:\n')[1]) as { idx: number }[];
      const answer = companies.map((c) => ({ idx: c.idx, score: 9, reason: 'ok' }));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
    }) as unknown as typeof fetch;

    const body = Array.from({ length: 15 }, (_, i) => [`C${i}`, `c${i}.ru`, `e${i}@c.ru`, 'd']);
    let stats: { failed_rows: number; failed_batches: number } | undefined;
    await stepTAScore([header, ...body], 'brief', noop, undefined, {
      keepAllScored: true,
      onStats: (s) => { stats = s as typeof stats; },
    });

    expect(stats?.failed_batches).toBe(1);
    expect(stats?.failed_rows).toBe(10);
  });

  it('пустой ответ модели — это провал с внятной причиной, а не «оценка 0»', async () => {
    // Пустой content ронял JSON.parse('') и попадал в тот же немой catch.
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    })) as unknown as typeof fetch;

    let stats: { failed_batches: number; errors: Array<{ reason: string }> } | undefined;
    await stepTAScore([header, ['Alpha', 'a.ru', 'a@a.ru', 'd']], 'brief', noop, undefined, {
      keepAllScored: true,
      onStats: (s) => { stats = s as typeof stats; },
    });

    expect(stats?.failed_batches).toBe(1);
    expect(stats?.errors?.[0]?.reason).toMatch(/пуст/i);
  });
});
