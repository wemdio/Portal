/** @jest-environment node */

jest.mock('server-only', () => ({}));

import type { TwoGisCard } from '@/lib/twoGis/types';
import type { GisSignalSegment } from '@/lib/gisSignalOutreach/config';

// Карточки по category рубрикатора: ключ — category, значение — батчи карточек.
let cardsByCategory: Record<string, TwoGisCard[][]> = {};

jest.mock('@/lib/twoGis/repository', () => ({
  iterateTwoGisCards: jest.fn((filters: { rubricGroups?: Array<{ category: string }> }) => {
    const category = filters.rubricGroups?.[0]?.category ?? '';
    const batches = cardsByCategory[category] ?? [];
    return (async function* () {
      for (const batch of batches) yield batch;
    })();
  }),
}));

// seen-журнал под контролем теста: содержит id из seenIds.
let seenIds = new Set<string>();
const filterUnseenIdsMock = jest.fn(async (ids: string[]) => {
  return new Set(ids.filter((id) => !seenIds.has(id)));
});

jest.mock('@/lib/gisSignalOutreach/seenCompanies', () => ({
  filterUnseenIds: (ids: string[]) => filterUnseenIdsMock(ids),
  markSeen: jest.fn(async () => {}),
}));

import { computeSegmentQuotas, pullSegmentCandidates } from '@/lib/gisSignalOutreach/segments';

function card(id: string, overrides: Partial<TwoGisCard> = {}): TwoGisCard {
  return {
    id,
    name: `Компания ${id}`,
    city_name: 'Москва',
    geometry_name: '',
    post_code: '',
    phone: '+7 495 000-00-00',
    email: '',
    website: `https://site-${id}.ru`,
    vkontakte: '',
    instagram: '',
    lon: '37.6',
    lat: '55.7',
    category: 'Медицина',
    subcategory: 'Стоматологии',
    ...overrides,
  };
}

function segment(key: string, category: string, priority: number): GisSignalSegment {
  return {
    key,
    label: key,
    instantly_campaign_id: null,
    rubric_groups: [{ category }],
    require_online: false,
    priority,
    enabled: true,
  };
}

beforeEach(() => {
  cardsByCategory = {};
  seenIds = new Set();
  filterUnseenIdsMock.mockClear();
});

describe('computeSegmentQuotas', () => {
  it('равные доли, остаток — первым сегментам', () => {
    expect(computeSegmentQuotas(100, 3)).toEqual([34, 33, 33]);
    expect(computeSegmentQuotas(10, 2)).toEqual([5, 5]);
    expect(computeSegmentQuotas(1, 4)).toEqual([1, 0, 0, 0]);
    expect(computeSegmentQuotas(50, 0)).toEqual([]);
  });
});

describe('pullSegmentCandidates', () => {
  it('исключает twogis_id из seen-журнала (батчевый lookup)', async () => {
    cardsByCategory = {
      'Медицина': [[card('a1'), card('a2'), card('a3')]],
    };
    seenIds = new Set(['a2']);

    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 100,
      snapshotId: 1,
    });

    expect(out.map((c) => c.twogisId)).toEqual(['a1', 'a3']);
    expect(filterUnseenIdsMock).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
  });

  it('cross-segment дедуп: компанию забирает первый по приоритету сегмент', async () => {
    // Одна и та же карточка x1 накрывается рубриками обоих сегментов.
    cardsByCategory = {
      'Медицина': [[card('m1'), card('x1')]],
      'Образование': [[card('x1'), card('s2')]],
    };
    const segments = [
      segment('clinics', 'Медицина', 10), // приоритет выше — идёт первым
      segment('schools', 'Образование', 20),
    ];

    const out = await pullSegmentCandidates(segments, { dailyLimit: 100, snapshotId: 1 });

    const byId = new Map(out.map((c) => [c.twogisId, c.segmentKey]));
    expect(byId.get('x1')).toBe('clinics'); // НЕ schools
    expect(byId.get('m1')).toBe('clinics');
    expect(byId.get('s2')).toBe('schools');
    expect(out).toHaveLength(3); // x1 посчитан один раз
  });

  it('per-сегментная квота: daily_limit делится поровну, остаток — первым', async () => {
    cardsByCategory = {
      'Медицина': [[card('m1'), card('m2'), card('m3'), card('m4')]],
      'Образование': [[card('s1'), card('s2'), card('s3'), card('s4')]],
    };
    // 5 на 2 сегмента → квоты [3, 2]: первый сегмент добирает остаток.
    const out = await pullSegmentCandidates(
      [segment('clinics', 'Медицина', 10), segment('schools', 'Образование', 20)],
      { dailyLimit: 5, snapshotId: 1 },
    );

    const clinics = out.filter((c) => c.segmentKey === 'clinics');
    const schools = out.filter((c) => c.segmentKey === 'schools');
    expect(clinics.map((c) => c.twogisId)).toEqual(['m1', 'm2', 'm3']);
    expect(schools.map((c) => c.twogisId)).toEqual(['s1', 's2']);
  });

  it('карточки без сайта или id пропускаются', async () => {
    cardsByCategory = {
      'Медицина': [[card('ok'), card('no-site', { website: '' }), card('', { name: 'Без id' })]],
    };
    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 100,
      snapshotId: 1,
    });
    expect(out.map((c) => c.twogisId)).toEqual(['ok']);
  });
});
