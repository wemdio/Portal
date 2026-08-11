/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { TwoGisCard } from '@/lib/twoGis/types';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

// Карточки потока 2GIS под контролем теста.
let cardBatches: TwoGisCard[][] = [];
jest.mock('@/lib/twoGis/repository', () => ({
  iterateTwoGisCards: jest.fn(() => {
    return (async function* () {
      for (const batch of cardBatches) yield batch;
    })();
  }),
  getLatestTwoGisSnapshotId: jest.fn(async () => 7),
}));

import {
  buildGisClassifyIndustries,
  computeGisPullLimit,
  computeGisTopupDeficit,
  GIS_CONSTRUCTOR_YIELD,
  GIS_MAX_SCAN_MULTIPLIER,
  GIS_PULL_OVERSHOOT,
  gisCandidatesToGrid,
  loadGisSignalSeenDomains,
  markGisSignalSeen,
  pullGisTopupCandidates,
  type GisTopupCandidate,
} from '@/lib/outreachos/gisTopup';
import { GRID_HEADER } from '@/lib/outreachos/gridMapping';

function card(id: string, overrides: Partial<TwoGisCard> = {}): TwoGisCard {
  return {
    id,
    name: `Компания ${id}`,
    city_name: 'Москва',
    geometry_name: '',
    post_code: '',
    phone: '',
    email: '',
    website: `https://${id}.example.ru`,
    vkontakte: '',
    instagram: '',
    lon: '',
    lat: '',
    category: 'Транспорт / Грузоперевозки',
    subcategory: 'Грузоперевозки',
    ...overrides,
  };
}

beforeEach(() => {
  cardBatches = [];
  mockDb = createMockSupabase();
});

describe('computeGisTopupDeficit', () => {
  it('дефицит = target − kept, не ниже нуля', () => {
    expect(computeGisTopupDeficit(200, 140)).toBe(60);
    expect(computeGisTopupDeficit(200, 200)).toBe(0);
    expect(computeGisTopupDeficit(200, 250)).toBe(0); // kept больше цели → 0
  });

  it('дробный target усекается', () => {
    expect(computeGisTopupDeficit(200.9, 100)).toBe(100);
  });
});

describe('computeGisPullLimit', () => {
  it('deficit=0 → 0 (топ-ап не запускается)', () => {
    expect(computeGisPullLimit(0, 500)).toBe(0);
  });

  it('cap<=0 → 0', () => {
    expect(computeGisPullLimit(100, 0)).toBe(0);
    expect(computeGisPullLimit(100, -5)).toBe(0);
  });

  it('формула ceil(deficit / yield * overshoot)', () => {
    // 100 / 0.45 * 1.3 = 288.88… → 289
    expect(computeGisPullLimit(100, 500)).toBe(
      Math.ceil((100 / GIS_CONSTRUCTOR_YIELD) * GIS_PULL_OVERSHOOT),
    );
    expect(computeGisPullLimit(100, 500)).toBe(289);
  });

  it('дробный результат округляется вверх (не теряем одного кандидата)', () => {
    // 1 / 0.45 * 1.3 = 2.888… → 3
    expect(computeGisPullLimit(1, 500)).toBe(3);
  });

  it('cap зажимает расчётный лимит', () => {
    // 400 / 0.45 * 1.3 = 1155.5… → 1156, но cap=500
    expect(computeGisPullLimit(400, 500)).toBe(500);
  });
});

describe('pullGisTopupCandidates', () => {
  const rubricGroups = [{ category: 'Транспорт / Грузоперевозки', mode: 'all' as const }];

  it('дедуп-матрица: excludeDomains (seen outreachos / gis_signal / батч HH+SJ)', async () => {
    cardBatches = [[card('a1'), card('a2'), card('a3'), card('a4')]];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 10,
      snapshotId: 7,
      excludeDomains: new Set(['a2.example.ru', 'a4.example.ru']),
    });
    expect(res.candidates.map((c) => c.twogisId)).toEqual(['a1', 'a3']);
    expect(res.pulled).toBe(4); // внутренний дедуп пропустил всех
    expect(res.excludedDropped).toBe(2);
  });

  it('внутри-прогонный дедуп по twogis_id и по домену', async () => {
    cardBatches = [
      [
        card('x1'),
        card('x1'), // тот же twogis_id (карточка в двух рубриках)
        card('x2', { website: 'https://x1.example.ru' }), // тот же домен, другой id
        card('y1'),
      ],
    ];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 10,
      snapshotId: 7,
      excludeDomains: new Set(),
    });
    expect(res.candidates.map((c) => c.twogisId)).toEqual(['x1', 'y1']);
    expect(res.pulled).toBe(2);
  });

  it('пропускает карточки без id/сайта и с непарсящимся доменом', async () => {
    cardBatches = [
      [
        card('ok'),
        card('', { name: 'Без id' }),
        card('no-site', { website: '' }),
        card('bad-site', { website: '%%%' }),
      ],
    ];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 10,
      snapshotId: 7,
      excludeDomains: new Set(),
    });
    expect(res.candidates.map((c) => c.twogisId)).toEqual(['ok']);
    expect(res.pulled).toBe(1);
  });

  it('лимит останавливает добор', async () => {
    cardBatches = [[card('c1'), card('c2'), card('c3'), card('c4')]];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 2,
      snapshotId: 7,
      excludeDomains: new Set(),
    });
    expect(res.candidates.map((c) => c.twogisId)).toEqual(['c1', 'c2']);
  });

  it('страховка maxScan: исключающие множества съели выдачу → скан обрывается', async () => {
    // limit=2 → maxScan = 2 * GIS_MAX_SCAN_MULTIPLIER. Все карточки исключены.
    const total = 2 * GIS_MAX_SCAN_MULTIPLIER + 50;
    const batch = Array.from({ length: total }, (_, i) => card(`s${i}`));
    cardBatches = [batch];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 2,
      snapshotId: 7,
      excludeDomains: new Set(batch.map((c) => `${c.id}.example.ru`)),
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.scanned).toBeLessThanOrEqual(2 * GIS_MAX_SCAN_MULTIPLIER + 1);
    expect(res.scanned).toBeLessThan(total);
  });

  it('пустой рубрикатор → ничего не тянем', async () => {
    cardBatches = [[card('c1')]];
    const res = await pullGisTopupCandidates({
      rubricGroups: [],
      limit: 10,
      snapshotId: 7,
      excludeDomains: new Set(),
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.scanned).toBe(0);
  });

  it('маппинг карточки → кандидат (twogisId/name/site/city/category/subcategory)', async () => {
    cardBatches = [
      [card('m1', { name: 'АвтоГруз', city_name: 'Казань', category: 'Кат', subcategory: 'Суб' })],
    ];
    const res = await pullGisTopupCandidates({
      rubricGroups,
      limit: 10,
      snapshotId: 7,
      excludeDomains: new Set(),
    });
    expect(res.candidates[0]).toEqual({
      twogisId: 'm1',
      name: 'АвтоГруз',
      site: 'https://m1.example.ru',
      cityName: 'Казань',
      category: 'Кат',
      subcategory: 'Суб',
    });
  });
});

describe('loadGisSignalSeenDomains', () => {
  it('собирает домены всех записей (lowercase, без null)', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_seen_companies: [
          { twogis_id: 'id-1', domain: 'Domain1.RU', company_name: null, segment_key: 'edu' },
          { twogis_id: 'id-2', domain: null, company_name: null, segment_key: 'remont' },
          { twogis_id: 'id-3', domain: 'b.ru', company_name: null, segment_key: 'edu' },
        ],
      },
    });
    const domains = await loadGisSignalSeenDomains();
    expect(domains).not.toBeNull();
    expect([...domains!].sort()).toEqual(['b.ru', 'domain1.ru']);
  });

  it('чанкует выборку по 1000 (range-пагинация, >1000 записей)', async () => {
    // mockSupabase.range не слайсит (shared helper, не трогаем) — для теста
    // пагинации подставляем минимальный range-честный double вместо него.
    const rows = Array.from({ length: 2100 }, (_, i) => ({
      twogis_id: `id-${i}`,
      domain: `d${i}.ru`,
    }));
    let rangeCalls = 0;
    mockDb = {
      from: () => ({
        select: () => ({
          range: async (from: number, to: number) => {
            rangeCalls += 1;
            return { data: rows.slice(from, to + 1), error: null };
          },
        }),
      }),
    } as unknown as MockSupabaseClient;
    const domains = await loadGisSignalSeenDomains();
    expect(domains!.size).toBe(2100);
    expect(rangeCalls).toBe(3); // 1000 + 1000 + 100
  });

  it('fail-closed: сбой БД → null (топ-ап пропускаем)', async () => {
    mockDb = createMockSupabase({
      tables: { gis_signal_seen_companies: [] },
      errorTables: { gis_signal_seen_companies: 'connection reset' },
    });
    await expect(loadGisSignalSeenDomains()).resolves.toBeNull();
  });
});

describe('gisCandidatesToGrid', () => {
  it('заголовок GRID_HEADER + строки [name, site, city, пустой Email]', () => {
    const grid = gisCandidatesToGrid([
      { twogisId: '1', name: 'АвтоГруз', site: 'https://a.ru', cityName: 'Казань', category: 'К', subcategory: 'С' },
    ]);
    expect(grid[0]).toEqual([...GRID_HEADER]);
    expect(grid[1]).toEqual(['АвтоГруз', 'https://a.ru', 'Казань', '']);
  });
});

describe('buildGisClassifyIndustries', () => {
  it('домен → [category, subcategory]; пустые части отбрасываются', () => {
    const candidates: GisTopupCandidate[] = [
      { twogisId: '1', name: 'A', site: 'https://a.ru', cityName: '', category: 'Транспорт', subcategory: 'Грузоперевозки' },
      { twogisId: '2', name: 'B', site: 'https://b.ru', cityName: '', category: 'Оборудование', subcategory: '' },
      { twogisId: '3', name: 'C', site: 'https://c.ru', cityName: '', category: '', subcategory: '' },
    ];
    const map = buildGisClassifyIndustries(candidates);
    expect(map.get('a.ru')).toEqual(['Транспорт', 'Грузоперевозки']);
    expect(map.get('b.ru')).toEqual(['Оборудование']);
    expect(map.get('c.ru')).toEqual([]);
  });
});

describe('markGisSignalSeen', () => {
  it('upsert по twogis_id с ignoreDuplicates, segment_key=null', async () => {
    mockDb = createMockSupabase({ tables: { gis_signal_seen_companies: [] } });
    await markGisSignalSeen([
      { twogis_id: 't1', domain: 'a.ru', company_name: 'A' },
      { twogis_id: 't2', domain: null, company_name: null },
    ]);
    expect(mockDb.upserts).toHaveLength(1);
    expect(mockDb.upserts[0].table).toBe('gis_signal_seen_companies');
    expect(mockDb.upserts[0].onConflict).toBe('twogis_id');
    expect(mockDb.upserts[0].rows).toEqual([
      { twogis_id: 't1', domain: 'a.ru', company_name: 'A', segment_key: null },
      { twogis_id: 't2', domain: null, company_name: null, segment_key: null },
    ]);
  });

  it('сбой БД после ретраев → throw (журнал критичен)', async () => {
    mockDb = createMockSupabase({
      tables: { gis_signal_seen_companies: [] },
      errorTables: { gis_signal_seen_companies: 'db down' },
    });
    await expect(
      markGisSignalSeen([{ twogis_id: 't1', domain: 'a.ru', company_name: null }]),
    ).rejects.toThrow('markGisSignalSeen upsert failed after retries');
  }, 15000);

  it('пустой вход → никаких вызовов', async () => {
    mockDb = createMockSupabase();
    await markGisSignalSeen([]);
    expect(mockDb.upserts).toHaveLength(0);
  });
});
