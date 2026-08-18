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

// Архив проверок под контролем теста: «свежие» (недавно проверенные) id из recentIds.
let recentIds = new Set<string>();
const filterRecentlyCheckedIdsMock = jest.fn(async (ids: string[]) => {
  return new Set(ids.filter((id) => !recentIds.has(id)));
});

// Обратный кросс-дедуп §4.2: домены seen-окна OutreachOS под контролем теста.
let outreachosDomains = new Set<string>();
const loadRecentlySeenDomainsMock = jest.fn(async () => outreachosDomains);

jest.mock('@/lib/outreachos/seenEmployers', () => ({
  RECONTACT_AFTER_DAYS: 45,
  loadRecentlySeenDomains: () => loadRecentlySeenDomainsMock(),
}));

jest.mock('@/lib/gisSignalOutreach/seenCompanies', () => ({
  filterUnseenIds: (ids: string[]) => filterUnseenIdsMock(ids),
  filterRecentlyCheckedIds: (ids: string[]) => filterRecentlyCheckedIdsMock(ids),
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

function segment(
  key: string,
  category: string,
  priority: number,
  quotaWeight = 1,
): GisSignalSegment {
  return {
    key,
    label: key,
    instantly_campaign_id: null,
    rubric_groups: [{ category }],
    require_online: false,
    priority,
    enabled: true,
    quota_weight: quotaWeight,
  };
}

beforeEach(() => {
  cardsByCategory = {};
  seenIds = new Set();
  recentIds = new Set();
  outreachosDomains = new Set();
  filterUnseenIdsMock.mockClear();
  filterRecentlyCheckedIdsMock.mockClear();
  loadRecentlySeenDomainsMock.mockClear();
});

describe('computeSegmentQuotas', () => {
  it('равные доли, остаток — первым сегментам', () => {
    expect(computeSegmentQuotas(100, 3)).toEqual([34, 33, 33]);
    expect(computeSegmentQuotas(10, 2)).toEqual([5, 5]);
    expect(computeSegmentQuotas(1, 4)).toEqual([1, 0, 0, 0]);
    expect(computeSegmentQuotas(50, 0)).toEqual([]);
  });

  // Веса (quota_weight) — базы ниш различаются на порядок, и при делении поровну
  // маленькие выключались бы за две недели, пока большие простаивают.
  it('веса задают доли; важна пропорция, а не абсолют', () => {
    // Боевая раскладка 18.08.2026 (сумма весов = daily_limit → квота = вес).
    expect(computeSegmentQuotas(2000, [1002, 362, 336, 150, 150]))
      .toEqual([1002, 362, 336, 150, 150]);
    expect(computeSegmentQuotas(100, [2, 1, 1])).toEqual([50, 25, 25]);
    expect(computeSegmentQuotas(100, [200, 100, 100])).toEqual([50, 25, 25]);
  });

  it('сумма квот всегда равна лимиту: остаток по наибольшей дробной части', () => {
    expect(computeSegmentQuotas(10, [1, 1, 1])).toEqual([4, 3, 3]);
    const quotas = computeSegmentQuotas(2000, [54191, 19597, 18152, 5301, 3635]);
    expect(quotas.reduce((sum, q) => sum + q, 0)).toBe(2000);
    // Порядок сохранён: самой глубокой базе — самая большая квота.
    expect(quotas[0]).toBeGreaterThan(quotas[1]);
    expect(quotas[4]).toBeGreaterThan(0);
  });

  it('нулевой вес — пауза сегмента без выключения', () => {
    expect(computeSegmentQuotas(100, [1, 0, 1])).toEqual([50, 0, 50]);
  });

  it('битые веса не могут оставить прогон без работы', () => {
    // Все нули (напр. колонку добавили, значения не проставили) → делим поровну.
    expect(computeSegmentQuotas(100, [0, 0, 0])).toEqual([34, 33, 33]);
    // Отрицательные и нечисловые — как ноль, остальные работают.
    expect(computeSegmentQuotas(100, [-5, Number.NaN, 3])).toEqual([0, 0, 100]);
  });

  it('нулевой лимит не роняет расчёт', () => {
    expect(computeSegmentQuotas(0, [3, 1])).toEqual([0, 0]);
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

  it('недавно проверенные пропускаются и НЕ жгут квоту сегмента', async () => {
    cardsByCategory = {
      'Медицина': [[card('r1'), card('f1'), card('f2'), card('f3')]],
    };
    recentIds = new Set(['r1']);

    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 2,
      snapshotId: 1,
    });

    // r1 отсеян архивом, квоту 2 добирают свежие f1/f2.
    expect(out.map((c) => c.twogisId)).toEqual(['f1', 'f2']);
    expect(filterRecentlyCheckedIdsMock).toHaveBeenCalledWith(['r1', 'f1', 'f2', 'f3']);
  });

  it('оба фильтра применяются: архив получает только выживших после seen-фильтра', async () => {
    cardsByCategory = {
      'Медицина': [[card('s1'), card('r1'), card('f1')]],
    };
    seenIds = new Set(['s1']);
    recentIds = new Set(['r1']);

    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 100,
      snapshotId: 1,
    });

    expect(filterUnseenIdsMock).toHaveBeenCalledWith(['s1', 'r1', 'f1']);
    // s1 уже отсеян seen-журналом — в архивный lookup не уходит.
    expect(filterRecentlyCheckedIdsMock).toHaveBeenCalledWith(['r1', 'f1']);
    expect(out.map((c) => c.twogisId)).toEqual(['f1']);
  });

  it('обратный кросс-дедуп §4.2: домены seen-окна OutreachOS (45д) отсекаются', async () => {
    cardsByCategory = {
      'Медицина': [[card('o1'), card('o2'), card('f1')]],
    };
    // o1 и o2 — домены site-o1.ru / site-o2.ru из seen-окна OutreachOS.
    outreachosDomains = new Set(['site-o1.ru', 'site-o2.ru']);

    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 100,
      snapshotId: 1,
    });

    expect(out.map((c) => c.twogisId)).toEqual(['f1']);
    expect(loadRecentlySeenDomainsMock).toHaveBeenCalledTimes(1);
  });

  it('кросс-дедуп не жжёт квоту сегмента', async () => {
    cardsByCategory = {
      'Медицина': [[card('o1'), card('f1'), card('f2')]],
    };
    outreachosDomains = new Set(['site-o1.ru']);

    const out = await pullSegmentCandidates([segment('clinics', 'Медицина', 10)], {
      dailyLimit: 2,
      snapshotId: 1,
    });

    expect(out.map((c) => c.twogisId)).toEqual(['f1', 'f2']);
  });
});
