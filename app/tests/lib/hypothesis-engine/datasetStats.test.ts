/** @jest-environment node */

jest.mock('server-only', () => ({}));

const mockDatasetQuery = jest.fn();
const mockIsDatasetConfigured = jest.fn();

jest.mock('@/lib/instantlyDataset', () => ({
  datasetQuery: (text: string, params?: unknown[]) => mockDatasetQuery(text, params),
  isDatasetConfigured: () => mockIsDatasetConfigured(),
}));

import { getSegmentStats, getWinnerPatterns } from '@/lib/hypothesisEngine/datasetStats';

type Row = Record<string, unknown>;

/* Фрагменты SQL, по которым диспетчеризуем ответы мока (порядок вызовов не важен). */
const SEGMENT_Q = /WHERE s\.segment ~\* /;
const BASELINE_Q = /WHERE o\.snapshot_id/;
const SUBJECTS_Q = /GROUP BY lower\(btrim/;
const PATTERNS_Q = /GROUP BY t\.pattern/;

/** Ответы по фрагменту SQL; Error → reject. Неузнанный запрос → пустой результат. */
function stubQueries(map: Array<[RegExp, Row[] | Error]>) {
  mockDatasetQuery.mockImplementation((text: string) => {
    for (const [re, val] of map) {
      if (re.test(text)) {
        return val instanceof Error ? Promise.reject(val) : Promise.resolve(val);
      }
    }
    return Promise.resolve([]);
  });
}

/** Параметры n-ного вызова datasetQuery. */
function paramsOf(call: number): unknown[] {
  return mockDatasetQuery.mock.calls[call][1] as unknown[];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDatasetConfigured.mockReturnValue(true);
});

describe('getSegmentStats', () => {
  it('без INSTANTLY_DATASET_DB_URL → null-поля и note, запросов нет', async () => {
    mockIsDatasetConfigured.mockReturnValue(false);

    const res = await getSegmentStats('Логистика', ['logistics']);

    expect(mockDatasetQuery).not.toHaveBeenCalled();
    expect(res).toEqual({
      matched_segments: [],
      campaigns: 0,
      sent: 0,
      replies: 0,
      reply_pct: null,
      baseline_pct: null,
      top_subjects: [],
      note: expect.stringContaining('INSTANTLY_DATASET_DB_URL'),
    });
  });

  it('без терминов → note, запросов нет', async () => {
    const res = await getSegmentStats('  ', []);

    expect(mockDatasetQuery).not.toHaveBeenCalled();
    expect(res.note).toContain('не заданы термины');
  });

  it('матчит термины по сегментам: lowercase, dedupe, word-boundary regex', async () => {
    stubQueries([]);

    await getSegmentStats('Логистика', ['Logistics', '3PL', 'логистика']);

    expect(paramsOf(0)[0]).toBe('(^|[^a-zа-яё0-9])(логистика|logistics|3pl)([^a-zа-яё0-9]|$)');
  });

  it('экранирует regex-спецсимволы в терминах', async () => {
    stubQueries([]);

    await getSegmentStats('IT (SaaS)+', []);

    expect(paramsOf(0)[0]).toBe('(^|[^a-zа-яё0-9])(it \\(saas\\)\\+)([^a-zа-яё0-9]|$)');
  });

  it('агрегирует sent/replies по сегментам, считает reply_pct, baseline и топ-темы', async () => {
    stubQueries([
      [SEGMENT_Q, [
        { segment: 'logistics_transport', campaigns: 10, sent: '50000', replies: '600' },
        { segment: 'food_horeca', campaigns: 5, sent: '20000', replies: '100' },
      ]],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
      [SUBJECTS_Q, [{ subject: 'Тема А' }, { subject: 'Тема Б' }]],
    ]);

    const res = await getSegmentStats('Логистика', ['логистика']);

    expect(res).toEqual({
      matched_segments: ['logistics_transport', 'food_horeca'],
      campaigns: 15,
      sent: 70000,
      replies: 700,
      reply_pct: 1,
      baseline_pct: 1.03, // 37668/3656661 — baseline из research-дока
      top_subjects: ['Тема А', 'Тема Б'],
    });
  });

  it('reply_pct=null и note при sent < 1000, baseline всё равно считается', async () => {
    stubQueries([
      [SEGMENT_Q, [{ segment: 'auto', campaigns: 3, sent: '500', replies: '20' }]],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
    ]);

    const res = await getSegmentStats('Авто', ['auto']);

    expect(res.matched_segments).toEqual(['auto']);
    expect(res.sent).toBe(500);
    expect(res.reply_pct).toBeNull();
    expect(res.baseline_pct).toBe(1.03);
    expect(res.note).toContain('мало данных');
    expect(res.top_subjects).toEqual([]);
  });

  it('нет совпадений сегментов → нули + note; топ-темы не запрашиваются', async () => {
    stubQueries([
      [SEGMENT_Q, []],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
    ]);

    const res = await getSegmentStats('Несуществующая ниша', ['zzz']);

    expect(res.campaigns).toBe(0);
    expect(res.sent).toBe(0);
    expect(res.replies).toBe(0);
    expect(res.reply_pct).toBeNull();
    expect(res.baseline_pct).toBe(1.03);
    expect(res.note).toContain('не совпал');
    // сегментный запрос + baseline, без запроса тем
    expect(mockDatasetQuery).toHaveBeenCalledTimes(2);
  });

  it('baseline_pct=null при крошечном датасете (sent < 1000)', async () => {
    stubQueries([
      [SEGMENT_Q, [{ segment: 'auto', campaigns: 3, sent: '5000', replies: '50' }]],
      [BASELINE_Q, [{ sent: '400', replies: '30' }]],
    ]);

    const res = await getSegmentStats('Авто', ['auto']);

    expect(res.reply_pct).toBe(1);
    expect(res.baseline_pct).toBeNull();
  });

  it('datasetQuery падает → null-поля + note, без throw', async () => {
    stubQueries([
      [SEGMENT_Q, new Error('connection refused')],
      [BASELINE_Q, new Error('connection refused')],
    ]);

    const res = await getSegmentStats('Логистика', ['logistics']);

    expect(res.reply_pct).toBeNull();
    expect(res.baseline_pct).toBeNull();
    expect(res.campaigns).toBe(0);
    expect(res.note).toContain('connection refused');
  });

  it('падение запроса тем не отменяет основную статистику', async () => {
    stubQueries([
      [SEGMENT_Q, [{ segment: 'auto', campaigns: 3, sent: '5000', replies: '100' }]],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
      [SUBJECTS_Q, new Error('statement timeout')],
    ]);

    const res = await getSegmentStats('Авто', ['auto']);

    expect(res.reply_pct).toBe(2);
    expect(res.baseline_pct).toBe(1.03);
    expect(res.top_subjects).toEqual([]);
  });

  it('падение только baseline → статистика есть, baseline null с note', async () => {
    stubQueries([
      [SEGMENT_Q, [{ segment: 'auto', campaigns: 3, sent: '5000', replies: '100' }]],
      [BASELINE_Q, new Error('boom')],
    ]);

    const res = await getSegmentStats('Авто', ['auto']);

    expect(res.reply_pct).toBe(2);
    expect(res.baseline_pct).toBeNull();
    expect(res.note).toContain('baseline');
  });
});

describe('getWinnerPatterns', () => {
  it('сегментный фильтр + лимит параметризованы, reply_pct посчитан, гейт sent >= 300 в SQL', async () => {
    stubQueries([
      [PATTERNS_Q, [
        { pattern: 'Тема А', sent: '4000', replies: '120' },
        { pattern: 'Тема Б', sent: '1000', replies: '5' },
      ]],
    ]);

    const res = await getWinnerPatterns(['Logistics'], 3);

    expect(res).toEqual([
      { pattern: 'Тема А', reply_pct: 3, sent: 4000 },
      { pattern: 'Тема Б', reply_pct: 0.5, sent: 1000 },
    ]);
    expect(paramsOf(0)).toEqual(['(^|[^a-zа-яё0-9])(logistics)([^a-zа-яё0-9]|$)', 3]);
    expect(mockDatasetQuery.mock.calls[0][0]).toMatch(/>= 300/);
  });

  it('пустые hints → без сегментного фильтра (param null), limit по умолчанию 5', async () => {
    stubQueries([[PATTERNS_Q, []]]);

    const res = await getWinnerPatterns([]);

    expect(res).toEqual([]);
    expect(paramsOf(0)).toEqual([null, 5]);
  });

  it('пустые pattern-строки отфильтровываются', async () => {
    stubQueries([[PATTERNS_Q, [{ pattern: null, sent: '1000', replies: '10' }]]]);

    expect(await getWinnerPatterns(['auto'])).toEqual([]);
  });

  it('datasetQuery падает → [] без throw', async () => {
    stubQueries([[PATTERNS_Q, new Error('down')]]);

    await expect(getWinnerPatterns(['auto'])).resolves.toEqual([]);
  });

  it('без INSTANTLY_DATASET_DB_URL → [], запросов нет', async () => {
    mockIsDatasetConfigured.mockReturnValue(false);

    expect(await getWinnerPatterns(['auto'])).toEqual([]);
    expect(mockDatasetQuery).not.toHaveBeenCalled();
  });
});
