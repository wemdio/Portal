/**
 * @jest-environment node
 *
 * Spec for the per-company dedup added to stepTAScore (incident 2026-06-26).
 *
 * `split_emails` runs BEFORE `ta_scoring` and explodes one company with N
 * emails into N identical rows (differing only in the email column). The ЦА
 * score depends on the COMPANY, not the email, so scoring every exploded row
 * meant up to ~7× redundant sequential AI calls (real SBIS base: 5289 unique
 * companies blown up to 35525 rows). The step now scores each unique company
 * once and broadcasts the score to all of its rows. Output (rows, columns,
 * the <7 filter, telemetry) must stay identical.
 */

import { stepNameCleanup, stepPersonalize, stepTAScore } from '@/lib/tools/processingSteps';

interface SentCompany {
  idx: number;
  data: Record<string, string>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('stepTAScore — per-company dedup', () => {
  const SCORE: Record<string, number> = { Alpha: 9, Beta: 4, Gamma: 7 };
  const realFetch = global.fetch;
  let sentBatches: SentCompany[][];

  beforeEach(() => {
    sentBatches = [];
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const reqBody = JSON.parse(init.body) as { messages: { content: string }[] };
      const companies = JSON.parse(
        reqBody.messages[1].content.split('Компании:\n')[1],
      ) as SentCompany[];
      sentBatches.push(companies);
      const answer = companies.map((c) => ({
        idx: c.idx,
        score: SCORE[c.data['компания']] ?? 0,
        reason: `r-${c.data['компания']}`,
      }));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      };
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const header = ['компания', 'Сайт', 'email', 'Описание'];
  const body = [
    ['Alpha', 'a.ru', 'a1@a.ru', 'desc A'],
    ['Alpha', 'a.ru', 'a2@a.ru', 'desc A'],
    ['Beta', 'b.ru', 'b1@b.ru', 'desc B'],
    ['Alpha', 'a.ru', 'a3@a.ru', 'desc A'], // same company, non-adjacent
    ['Gamma', '', 'g1@g.ru', 'desc G'], // company present, site empty
  ];
  const noop = async () => {};

  it('scores each unique company once and broadcasts to every row of that company', async () => {
    const out = await stepTAScore([header, ...body], 'brief', noop, undefined, {
      keepAllScored: true,
    });

    // 3 unique companies (Alpha, Beta, Gamma) → one TA_BATCH → one AI call,
    // NOT 5 (one per exploded row).
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sentBatches[0]).toHaveLength(3);
    expect(sentBatches[0].map((c) => c.data['компания'])).toEqual(['Alpha', 'Beta', 'Gamma']);

    expect(out[0]).toEqual([...header, 'ЦА Балл', 'ЦА Причина']);

    const rows = out.slice(1);
    expect(rows).toHaveLength(5); // keepAllScored → no filtering, row count preserved

    // Broadcast: every Alpha row = 9, Beta = 4, Gamma = 7; original order kept.
    expect(rows.map((r) => r[4])).toEqual(['9', '9', '4', '9', '7']);
    expect(rows.map((r) => r[5])).toEqual(['r-Alpha', 'r-Alpha', 'r-Beta', 'r-Alpha', 'r-Gamma']);
    // Per-row email column is left exactly as-is.
    expect(rows.map((r) => r[2])).toEqual(['a1@a.ru', 'a2@a.ru', 'b1@b.ru', 'a3@a.ru', 'g1@g.ru']);
  });

  it('keeps the <7 filter — all rows of a company kept or dropped together', async () => {
    const out = await stepTAScore([header, ...body], 'brief', noop);
    const rows = out.slice(1);
    // Alpha(9)×3 kept, Beta(4) dropped, Gamma(7) kept → 4 rows.
    expect(rows.map((r) => r[0])).toEqual(['Alpha', 'Alpha', 'Alpha', 'Gamma']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports telemetry over ALL rows (row-based, not unique-company-based)', async () => {
    let stats: { pre_filter_rows: number; filtered_out_count: number } | undefined;
    await stepTAScore([header, ...body], 'brief', noop, undefined, {
      onStats: (s) => {
        stats = s;
      },
    });
    expect(stats?.pre_filter_rows).toBe(5); // 5 output rows scored
    expect(stats?.filtered_out_count).toBe(1); // Beta's single row
  });

  it('falls back to per-row scoring when there is no company/site column', async () => {
    const h2 = ['email', 'Описание'];
    const b2 = [
      ['x1@x.ru', 'd1'],
      ['x2@x.ru', 'd2'],
    ];
    await stepTAScore([h2, ...b2], 'brief', noop, undefined, { keepAllScored: true });
    // No company/site → each distinct row is its own key → 2 unique, not collapsed.
    expect(sentBatches[0]).toHaveLength(2);
  });

  it('does NOT leak the email address into the AI prompt (score is per-company)', async () => {
    await stepTAScore([header, ...body], 'brief', noop, undefined, { keepAllScored: true });
    const sent = sentBatches[0];
    expect(sent).toHaveLength(3);
    // The email column is blanked in the company object sent to the model...
    expect(sent.every((c) => c.data['email'] === '')).toBe(true);
    // ...while the scoring-relevant fields remain.
    expect(sent[0].data['компания']).toBe('Alpha');
    expect(sent[0].data['Сайт']).toBe('a.ru');
    expect(sent[0].data['Описание']).toBe('desc A');
  });

  it('bounds concurrent requests and serializes ordered checkpoints across reversed batches', async () => {
    jest.useFakeTimers();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const bigBody = Array.from({ length: 21 }, (_, i) => {
      const c = `C${String(i).padStart(2, '0')}`;
      return ['a', 'b'].map((email) => [c, `${c}.ru`, `${email}@${c}.ru`, `d-${c}`]);
    }).flat();
    const score = (company: string) => 5 + Number(company.slice(1)) % 5;
    const expected = [[...header, 'ЦА Балл', 'ЦА Причина'],
      ...bigBody.map((row) => [...row, String(score(row[0])), `r-${row[0]}`])];
    const requests: Array<{ companies: SentCompany[]; response: ReturnType<typeof deferred<unknown>> }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const companies = JSON.parse(request.messages[1].content.split('Компании:\n')[1]) as SentCompany[];
      const response = deferred<unknown>();
      requests.push({ companies, response });
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      // Count the whole request, including reading the response body.
      return { ok: true, json: () => response.promise.finally(() => { inFlight -= 1; }) } as Response;
    });
    const finish = (index: number, partial = false) => {
      const { companies, response } = requests[index];
      const answers = (partial ? companies.slice(0, 1) : companies).map((c) => ({
        idx: c.idx, score: score(c.data['компания']), reason: `r-${c.data['компания']}`,
      }));
      response.resolve({ choices: [{ message: { content: JSON.stringify({ scores: answers }) },
        finish_reason: partial ? 'length' : 'stop' }] });
    };
    const checkpoints: Array<{ rows: string[][]; saved: ReturnType<typeof deferred<void>> }> = [];
    const progress: number[] = [];
    let activeCheckpoints = 0;
    let maxActiveCheckpoints = 0;
    const pending = stepTAScore([header, ...bigBody], 'brief', async (p) => { progress.push(p); }, undefined, {
      concurrency: 2, keepAllScored: true,
      onCheckpoint: async (rows) => {
        const saved = deferred<void>();
        checkpoints.push({ rows: rows.map((r) => [...r]), saved });
        maxActiveCheckpoints = Math.max(maxActiveCheckpoints, ++activeCheckpoints);
        try { await saved.promise; } finally { activeCheckpoints -= 1; }
      },
    });
    const flush = () => jest.advanceTimersByTimeAsync(0);
    await flush();
    expect(requests.map((r) => r.companies.length)).toEqual([10, 10]);
    finish(1, true); // Second batch finishes before the first, with a partial length response.
    await flush();
    finish(2);
    await flush();
    now = 61_000;
    finish(3);
    await flush();
    expect(checkpoints).toHaveLength(1);
    finish(0); // Its report must wait for the second batch's checkpoint.
    await flush();
    expect(checkpoints).toHaveLength(1);
    now = 122_000;
    checkpoints[0].saved.resolve();
    await flush();
    expect(checkpoints).toHaveLength(2);
    finish(4); // Third batch may run, but must not overtake the queued checkpoint.
    await flush();
    expect(checkpoints).toHaveLength(2);
    checkpoints[1].saved.resolve();
    await flush();
    expect(checkpoints.at(-1)?.rows).toEqual(expected);
    expect(progress).not.toContain(100);
    checkpoints.at(-1)!.saved.resolve();
    expect(await pending).toEqual(expected);
    expect({ maxInFlight, maxActiveCheckpoints, inFlight }).toEqual({ maxInFlight: 2, maxActiveCheckpoints: 1, inFlight: 0 });
    expect(requests.map((r) => r.companies.map((c) => c.data['компания']))).toEqual([
      Array.from({ length: 10 }, (_, i) => `C${String(i).padStart(2, '0')}`),
      Array.from({ length: 10 }, (_, i) => `C${i + 10}`),
      ['C11', 'C12', 'C13', 'C14', 'C15'], ['C16', 'C17', 'C18', 'C19'], ['C20'],
    ]);
    expect(checkpoints.every(({ rows }) => JSON.stringify(rows.slice(1).map((r) => r.slice(0, 4))) === JSON.stringify(bigBody))).toBe(true);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(100);
  });

  // Incident 2026-09-02: valid partial JSON was covered historically, but a
  // genuinely cut-off JSON document kept retrying an unchanged ten-company request.
  it('shrinks truncated requests, keeps prior answers and accepts complete length responses', async () => {
    const requests: number[][] = [];
    const budgets: number[] = [];
    const checkpoints: string[][][] = [];
    const progress: number[] = [];
    const input = [header, ...Array.from({ length: 10 }, (_, i) => [`C${i}`, `c${i}.ru`, '', 'd'])];
    global.fetch = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const companies = JSON.parse(request.messages[1].content.split('Компании:\n')[1]) as SentCompany[];
      requests.push(companies.map((c) => c.idx));
      budgets.push(request.max_tokens);
      const content = requests.length === 1
        ? JSON.stringify({ scores: [{ idx: 0, score: 0, reason: 'real zero' }] })
        : companies.length > 1
          ? '{"scores":[{"idx":1,"score":8,"reason":"cut off'
          : JSON.stringify({ scores: companies.map((c) => ({ idx: c.idx, score: 8, reason: 'ok' })) });
      return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'length' }] }) } as Response;
    });
    const out = await stepTAScore(input, 'brief', async (p) => {
      if (p === 100) expect(checkpoints.at(-1)).toEqual(outcome());
      progress.push(p);
    }, undefined, { keepAllScored: true, onCheckpoint: async (rows) => { checkpoints.push(rows); } });
    function outcome() { return [[...header, 'ЦА Балл', 'ЦА Причина'], ...input.slice(1).map((r, i) => [...r, i === 0 ? '0' : '8', i === 0 ? 'real zero' : 'ok'])]; }
    expect(out).toEqual(outcome());
    expect(budgets.every((budget) => budget === 8000)).toBe(true);
    expect(requests[0]).toHaveLength(10);
    expect(requests.slice(1).every((r) => r.length <= 5 && !r.includes(0))).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(16);
    expect(progress.at(-1)).toBe(100);
  });

  it('bounds persistent truncation and exposes exhausted rows as errors', async () => {
    const sizes: number[] = [];
    global.fetch = jest.fn(async (_url, init) => {
      sizes.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('Компании:\n')[1]).length);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) } as Response;
    });
    const stats = jest.fn();
    const out = await stepTAScore([header, ...Array.from({ length: 10 }, (_, i) => [`C${i}`, '', '', 'd'])], 'brief', noop, undefined, { keepAllScored: true, onStats: stats });
    expect(sizes).toContain(1);
    expect(sizes.length).toBeLessThanOrEqual(16);
    expect(out.slice(1).every((r) => r[4] === '5' && r[5] === 'Ошибка оценки')).toBe(true);
    expect(stats).toHaveBeenLastCalledWith(expect.objectContaining({ failed_rows: 10, failed_batches: 1 }));
  });

  it('retries checkpoint error placeholders but preserves genuine zero and five scores', async () => {
    const h = [...header, 'ЦА Балл', 'ЦА Причина'];
    const out = await stepTAScore([h,
      ['Alpha', 'a.ru', '', 'd', '0', 'real zero'],
      ['Beta', 'b.ru', '', 'd', '5', 'real five'],
      ['Gamma', 'g.ru', '', 'd', '5', 'Ошибка оценки'],
    ], 'brief', noop, undefined, { keepAllScored: true });
    expect(sentBatches.flat().map((c) => c.data['компания'])).toEqual(['Gamma']);
    expect(out.slice(1).map((r) => r[4])).toEqual(['0', '5', '7']);
  });

  it('keeps the request timeout armed until the response body has been read', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      const result = { choices: [{ message: { content: '{"scores":[{"idx":0,"score":8,"reason":"ok"}]}' } }] };
      return { ok: true, json: () => signals.length > 1 ? Promise.resolve(result) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(result), 71_000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('body aborted')); }, { once: true });
      }) } as Response;
    });
    const pending = stepTAScore([header, ['Alpha', 'a.ru', '', 'd']], 'brief', noop, undefined, { keepAllScored: true });
    await jest.advanceTimersByTimeAsync(75_000);
    expect((await pending)[1][4]).toBe('8');
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);
  });

  it('bounds total batch time including rate-limit waits without changing other AI budgets', async () => {
    jest.useFakeTimers();
    const stats = jest.fn();
    let calls = 0;
    global.fetch = jest.fn(async (_url, init) => {
      calls += 1;
      if (calls <= 3) return { ok: false, status: 429, headers: { get: () => '60' }, text: async () => 'rate limited' } as unknown as Response;
      return { ok: true, json: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), 65_000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('deadline')); }, { once: true });
      }) } as Response;
    });
    const started = Date.now();
    let elapsed = 0;
    const pending = stepTAScore([header, ['Alpha', '', '', 'd']], 'brief', noop, undefined, { keepAllScored: true, onStats: stats })
      .then((out) => { elapsed = Date.now() - started; return out; });
    await jest.advanceTimersByTimeAsync(500_000);
    await pending;
    expect(elapsed).toBeLessThanOrEqual(240_000);
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(stats).toHaveBeenLastCalledWith(expect.objectContaining({ failed_rows: 1 }));

    // A rate-limited lane must not restart or lose its successful sibling.
    const concurrentBody = Array.from({ length: 11 }, (_, i) => [`C${i}`, `c${i}.ru`, '', 'd']);
    const concurrentRequests: string[][] = [];
    const concurrentProgress = jest.fn(noop);
    global.fetch = jest.fn(async (_url, init) => {
      const companies = JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('Компании:\n')[1]) as SentCompany[];
      concurrentRequests.push(companies.map((c) => c.data['компания']));
      if (concurrentRequests.length === 1) {
        return { ok: false, status: 429, headers: { get: () => '5' }, text: async () => 'rate limited' } as unknown as Response;
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(companies.map((c) => ({
        idx: c.idx, score: 8, reason: `r-${c.data['компания']}`,
      }))) } }] }) } as Response;
    });
    const concurrent = stepTAScore([header, ...concurrentBody], 'brief', concurrentProgress, undefined, {
      concurrency: 2, keepAllScored: true,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(concurrentRequests).toHaveLength(2);
    expect(concurrentProgress).not.toHaveBeenCalledWith(100);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await concurrent).toEqual([[...header, 'ЦА Балл', 'ЦА Причина'],
      ...concurrentBody.map((row) => [...row, '8', `r-${row[0]}`])]);
    expect(concurrentRequests).toEqual([
      concurrentBody.slice(0, 10).map((r) => r[0]), ['C10'], concurrentBody.slice(0, 10).map((r) => r[0]),
    ]);

    const budgets: number[] = [];
    global.fetch = jest.fn(async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      budgets.push(req.max_tokens);
      return { ok: true, json: async () => ({ choices: [{ message: { content: req.model === 'policy/cleanup' ? '{"companies":[{"idx":0,"name":"Alpha"}]}' : 'hello' } }] }) } as Response;
    });
    await stepNameCleanup([header, ['Alpha', '', '', 'd']], noop);
    await stepPersonalize([header, ['Alpha', '', '', 'd']], 'brief', noop);
    expect(budgets).toEqual([4000, 1500]);
  });

  it('propagates checkpoint failure without completion or subsequent queued writes', async () => {
    const progress = jest.fn(noop);
    await expect(stepTAScore([header, ['Alpha', 'a.ru', '', 'd']], 'brief', progress, undefined, {
      onCheckpoint: async () => { throw new Error('checkpoint unavailable'); },
    })).rejects.toThrow('checkpoint unavailable');
    expect(progress).not.toHaveBeenCalledWith(100);

    jest.useFakeTimers();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const outcomes: Array<{ sibling: string; checkpoints: number; progress: unknown[]; requests: number; falseFailures: number[] }> = [];
    for (const sibling of ['queued report', 'rate-limit retry']) {
      now = 0;
      const responses: Array<ReturnType<typeof deferred<void>>> = [];
      global.fetch = jest.fn(async (_url, init) => {
        const companies = JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('Компании:\n')[1]) as SentCompany[];
        const response = deferred<void>();
        const index = responses.push(response) - 1;
        // Unexpected retries complete immediately, so a regression fails an
        // assertion instead of leaving the test waiting on another deferred.
        if (index < 2) await response.promise;
        if (sibling === 'rate-limit retry' && index === 1) {
          return { ok: false, status: 429, headers: { get: () => '5' }, text: async () => 'rate limited' } as unknown as Response;
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(companies.map((c) => ({
          idx: c.idx, score: 8, reason: 'ok',
        }))) } }] }) } as Response;
      });
      const failedCheckpoint = deferred<void>();
      const queuedProgress = jest.fn(noop);
      const falseFailures: number[] = [];
      const checkpoint = jest.fn(async () => {
        if (checkpoint.mock.calls.length === 1) await failedCheckpoint.promise;
      });
      const rejected = expect(stepTAScore([header,
        ...Array.from({ length: 30 }, (_, i) => [`C${i}`, `c${i}.ru`, '', 'd']),
      ], 'brief', queuedProgress, undefined, {
        concurrency: 2, onCheckpoint: checkpoint,
        onTelemetry: (telemetry) => { if (telemetry.failed_rows) falseFailures.push(telemetry.failed_rows); },
      })).rejects.toThrow('checkpoint unavailable');
      await jest.advanceTimersByTimeAsync(0);
      if (sibling === 'rate-limit retry') {
        responses[1].resolve(); // Enters backoff while the other lane can still finish.
        await jest.advanceTimersByTimeAsync(0);
      }
      now = 61_000;
      responses[0].resolve();
      await jest.advanceTimersByTimeAsync(0);
      if (sibling === 'queued report') {
        now = 121_000;
        responses[1].resolve(); // Queues behind the first still-pending checkpoint.
        await jest.advanceTimersByTimeAsync(0);
      }
      failedCheckpoint.reject(new Error('checkpoint unavailable'));
      await jest.advanceTimersByTimeAsync(5_000);
      await rejected;
      outcomes.push({ sibling, checkpoints: checkpoint.mock.calls.length, progress: queuedProgress.mock.calls,
        requests: responses.length, falseFailures });
    }
    expect(outcomes).toEqual(['queued report', 'rate-limit retry'].map((sibling) => ({
      sibling, checkpoints: 1, progress: [], requests: 2, falseFailures: [],
    })));
  });

  it('does not checkpoint or retry after cancellation during the provider response', async () => {
    let cancelled = false;
    const progress = jest.fn(noop);
    const checkpoint = jest.fn(noop);
    global.fetch = jest.fn(async () => {
      cancelled = true;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"idx":0,"score":8,"reason":"ok"}]' } }] }) } as Response;
    });
    await expect(stepTAScore([header, ['Alpha', '', '', 'd']], 'brief', progress,
      async () => cancelled, { onCheckpoint: checkpoint })).rejects.toThrow('Отменено');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalledWith(100);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
