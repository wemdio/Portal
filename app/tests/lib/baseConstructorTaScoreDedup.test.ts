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

import { stepTAScore } from '@/lib/tools/processingSteps';

interface SentCompany {
  idx: number;
  data: Record<string, string>;
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

  it('scores correctly across a TA_BATCH (10) boundary', async () => {
    // 15 unique companies × 2 rows each = 30 rows → still 15 unique →
    // ceil(15/10) = 2 AI calls; scores must broadcast correctly across the split.
    const bigHeader = ['компания', 'Сайт', 'email', 'Описание'];
    const bigBody: string[][] = [];
    for (let i = 0; i < 15; i++) {
      const c = `C${String(i).padStart(2, '0')}`;
      bigBody.push([c, `${c}.ru`, `a@${c}.ru`, `d-${c}`]);
      bigBody.push([c, `${c}.ru`, `b@${c}.ru`, `d-${c}`]);
    }
    // score = company index (C00 → 0 … C14 → 14)
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const reqBody = JSON.parse(init.body) as { messages: { content: string }[] };
      const companies = JSON.parse(
        reqBody.messages[1].content.split('Компании:\n')[1],
      ) as SentCompany[];
      sentBatches.push(companies);
      const answer = companies.map((c) => ({
        idx: c.idx,
        score: parseInt(c.data['компания'].slice(1), 10),
        reason: `r-${c.data['компания']}`,
      }));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      };
    }) as unknown as typeof fetch;

    const out = await stepTAScore([bigHeader, ...bigBody], 'brief', noop, undefined, {
      keepAllScored: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sentBatches.map((b) => b.length)).toEqual([10, 5]); // batch split 10 + 5
    const rows = out.slice(1);
    expect(rows).toHaveLength(30);
    // every row gets its OWN company's score, broadcast to both of its rows.
    for (const r of rows) {
      const idx = parseInt(r[0].slice(1), 10);
      expect(r[4]).toBe(String(idx));
      expect(r[5]).toBe(`r-${r[0]}`);
    }
  });
});
