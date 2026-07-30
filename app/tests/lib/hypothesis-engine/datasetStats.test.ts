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
const BASELINE_Q = /FROM latest l\s*$/; // baseline — единственный запрос, оканчивающийся на FROM latest l
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

/** SQL-текст n-ного вызова datasetQuery. */
function sqlOf(call: number): string {
  return String(mockDatasetQuery.mock.calls[call][0]);
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

  it('маппит вертикаль на макро-метку датасета (словарь), regex строится по метке', async () => {
    stubQueries([]);

    await getSegmentStats('Логистика', ['Logistics', '3PL', 'логистика']);

    expect(paramsOf(0)[0]).toBe('(^|[^a-zа-яё0-9])(logistics_transport)([^a-zа-яё0-9]|$)');
  });

  it('вне словаря — свободный матч по терминам: lowercase, dedupe, экранирование', async () => {
    stubQueries([]);

    await getSegmentStats('ZZZ (Qq)+', []);

    expect(paramsOf(0)[0]).toBe('(^|[^a-zа-яё0-9])(zzz \\(qq\\)\\+)([^a-zа-яё0-9]|$)');
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

  it('datasetQuery падает → generic-note без утечки pg-ошибки (host:port только в лог)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stubQueries([
        [SEGMENT_Q, new Error('connect ECONNREFUSED 10.0.0.1:5432')],
        [BASELINE_Q, new Error('connect ECONNREFUSED 10.0.0.1:5432')],
      ]);

      const res = await getSegmentStats('Логистика', ['logistics']);

      expect(res.reply_pct).toBeNull();
      expect(res.baseline_pct).toBeNull();
      expect(res.campaigns).toBe(0);
      expect(res.note).toBe('датасет временно недоступен');
      expect(res.note).not.toContain('10.0.0.1');
      expect(res.note).not.toContain('ECONNREFUSED');
      // сырой текст ошибки — только в серверный лог
      const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('ECONNREFUSED 10.0.0.1:5432');
    } finally {
      errSpy.mockRestore();
    }
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

/*
 * Snapshot-дедупликация: ночные снапшоты partial (только активные кампании),
 * полный refresh — по воскресеньям. Запросы обязаны суммировать по per-campaign
 * DISTINCT ON поверх всех ok-снапшотов, а не пиниться к v_latest_snapshot.
 * Мок не исполняет SQL, поэтому здесь — формальные инварианты текста запросов.
 */
describe('snapshot dedupe (защита от занижения в ночные снапшоты)', () => {
  it('segment и baseline: DISTINCT ON (o.campaign_id) по ok-снапшотам, свежесть по started_at DESC, без v_latest_snapshot', async () => {
    stubQueries([]);

    await getSegmentStats('Логистика', ['logistics']);

    expect(mockDatasetQuery).toHaveBeenCalledTimes(2); // сегменты пустые → темы не запрашиваются
    for (const sql of [sqlOf(0), sqlOf(1)]) {
      expect(sql).toContain('DISTINCT ON (o.campaign_id)');
      expect(sql).toMatch(/JOIN dataset_snapshots ds ON ds\.id = o\.snapshot_id AND ds\.ok/);
      expect(sql).toMatch(/ORDER BY o\.campaign_id, ds\.started_at DESC/);
      expect(sql).not.toContain('v_latest_snapshot');
      expect(sql).not.toMatch(/snapshot_id = \(SELECT id FROM/);
    }
    // суммы идут из дедуп-CTE latest, а не из сырой snap-таблицы
    expect(sqlOf(0)).toMatch(/LEFT JOIN latest l ON l\.campaign_id = s\.campaign_id/);
    expect(sqlOf(0)).toMatch(/sum\(l\.emails_sent_count\)/);
    expect(sqlOf(1)).toMatch(/FROM latest l/);
  });

  it('step-запросы (темы, паттерны): DISTINCT ON (campaign_id, step_n, variant_n), без v_latest_snapshot', async () => {
    stubQueries([
      [SEGMENT_Q, [{ segment: 'auto', campaigns: 3, sent: '5000', replies: '100' }]],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
      [SUBJECTS_Q, []],
    ]);

    await getSegmentStats('Авто', ['auto']);

    const subjSql = sqlOf(2);
    expect(subjSql).toContain('DISTINCT ON (a.campaign_id, a.step_n, a.variant_n)');
    expect(subjSql).toMatch(/JOIN dataset_snapshots ds ON ds\.id = a\.snapshot_id AND ds\.ok/);
    expect(subjSql).toMatch(/ORDER BY a\.campaign_id, a\.step_n, a\.variant_n, ds\.started_at DESC/);
    expect(subjSql).not.toContain('v_latest_snapshot');
    expect(subjSql).toMatch(/JOIN latest_step a/);

    stubQueries([[PATTERNS_Q, []]]);
    await getWinnerPatterns(['auto']);

    const patSql = sqlOf(3);
    expect(patSql).toContain('DISTINCT ON (a.campaign_id, a.step_n, a.variant_n)');
    expect(patSql).not.toContain('v_latest_snapshot');
    expect(patSql).toMatch(/JOIN latest_step a/);
  });

  it('ночной partial-снапшот: data-rich вертикаль не зануляется гейтом (sent из полного дедуп-агрегата)', async () => {
    // DB-side дедуп отдаёт последнее известное состояние КАЖДОЙ кампании, поэтому
    // даже когда ночной снапшот накрыл лишь часть кампаний, агрегат сегмента полный.
    stubQueries([
      [SEGMENT_Q, [{ segment: 'medical_pharma', campaigns: 120, sent: '240000', replies: '3600' }]],
      [BASELINE_Q, [{ sent: '3656661', replies: '37668' }]],
    ]);

    const res = await getSegmentStats('Фармацевтика', []);

    expect(paramsOf(0)[0]).toBe('(^|[^a-zа-яё0-9])(medical_pharma)([^a-zа-яё0-9]|$)');
    expect(res.matched_segments).toEqual(['medical_pharma']);
    expect(res.campaigns).toBe(120);
    expect(res.sent).toBe(240000);
    expect(res.reply_pct).toBe(1.5);
    expect(res.note).toBeUndefined();
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

import { matchSegmentLabels } from '@/lib/hypothesisEngine/datasetStats';

describe('matchSegmentLabels — маппинг RU-вертикалей на 14 макро-меток датасета', () => {
  it('«Логистика, склад и ВЭД» → logistics_transport', () => {
    expect(matchSegmentLabels(['Логистика, склад и ВЭД'])).toEqual(['logistics_transport']);
  });
  it('«HR-услуги и HR-tech» с синонимами → education_hr', () => {
    expect(matchSegmentLabels(['HR-услуги и HR-tech', 'кадровые агентства', 'аутстаффинг персонала'])).toEqual(['education_hr']);
  });
  it('короткий ключ hr не срабатывает на «охрана»', () => {
    expect(matchSegmentLabels(['Физическая охрана объектов'])).toEqual([]);
  });
  it('«ИТ: вендоры и интеграторы» → it_software_saas', () => {
    expect(matchSegmentLabels(['ИТ: вендоры и интеграторы', 'B2B SaaS'])).toEqual(['it_software_saas']);
  });
  it('мультиматч: финтех-банк → finance_legal (+ возможные смежные)', () => {
    expect(matchSegmentLabels(['Финтех и банки'])).toContain('finance_legal');
  });

  /* ── префикс-стемы '^' (граница только слева) ── */
  it('стем ^фарм: «Фармацевтика» → medical_pharma', () => {
    expect(matchSegmentLabels(['Фармацевтика'])).toEqual(['medical_pharma']);
  });
  it('стем ^агро: «Агропромышленный комплекс» → agriculture', () => {
    expect(matchSegmentLabels(['Агропромышленный комплекс'])).toContain('agriculture');
    expect(matchSegmentLabels(['Агрохолдинг'])).toEqual(['agriculture']);
  });
  it('«Банки» → finance_legal (стем ^банки; одиночный «банк» — по-прежнему полная граница)', () => {
    expect(matchSegmentLabels(['Банки'])).toEqual(['finance_legal']);
    expect(matchSegmentLabels(['Частные банкиры'])).toEqual(['finance_legal']);
    expect(matchSegmentLabels(['Банкетные залы'])).not.toContain('finance_legal');
  });

  /* ── полная граница по маркеру '=' для слов >4 символов ── */
  it('«Автосалоны» НЕ матчится на beauty_wellness (=салон по границе слова)', () => {
    expect(matchSegmentLabels(['Автосалоны'])).toEqual([]);
    expect(matchSegmentLabels(['Салон красоты'])).toEqual(['beauty_wellness']);
  });
  it('«Персональные данные» НЕ матчится на education_hr (=персонал по границе слова)', () => {
    expect(matchSegmentLabels(['Персональные данные'])).toEqual([]);
    expect(matchSegmentLabels(['Персонал для отеля'])).toEqual(['education_hr']);
  });
  it('«Медиация» НЕ матчится на marketing_media_events, «медиа-агентство» — матчится', () => {
    expect(matchSegmentLabels(['Медиация и медианные переговоры'])).toEqual([]);
    expect(matchSegmentLabels(['Медиа-агентство'])).toEqual(['marketing_media_events']);
  });

  /* ── сужение over-match ключей ── */
  it('«Косметический ремонт» НЕ матчится на beauty_wellness, «косметология» — матчится', () => {
    expect(matchSegmentLabels(['Косметический ремонт офисов'])).toEqual([]);
    expect(matchSegmentLabels(['Косметология'])).toEqual(['beauty_wellness']);
  });
  it('«подбор» без контекста персонала НЕ матчится на education_hr, «подбор персонала» — матчится', () => {
    expect(matchSegmentLabels(['Подбор площадок для мероприятий'])).toEqual([]);
    expect(matchSegmentLabels(['Подбор персонала для отеля'])).toEqual(['education_hr']);
  });
});
