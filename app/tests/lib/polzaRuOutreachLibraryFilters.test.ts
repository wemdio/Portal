import {
  EMPTY_QUERY,
  MIN_CASE_LEADS,
  applyListQuery,
  isBelowLeadBar,
  leadsOf,
  paginate,
  type ListQuery,
  type Rec,
} from '@/components/polzaRuOutreach/libraryFilters';

const CASE_FIELDS = ['public_name', 'case_id', 'case_text_short'] as const;

function makeCase(over: Partial<Rec> & { id: string }): Rec {
  return {
    status: 'approved',
    public_name: 'Кейс',
    case_id: 'case',
    case_text_short: 'текст',
    industry_groups: [],
    leads_count: 10,
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function q(over: Partial<ListQuery> = {}): ListQuery {
  return { ...EMPTY_QUERY, ...over };
}

describe('leadsOf', () => {
  it('читает число, строку и дробное значение', () => {
    expect(leadsOf(makeCase({ id: '1', leads_count: 26 }))).toBe(26);
    expect(leadsOf(makeCase({ id: '2', leads_count: '17' }))).toBe(17);
    expect(leadsOf(makeCase({ id: '3', leads_count: '20,5' }))).toBe(20.5);
  });

  it('пустое и мусорное значение — null', () => {
    expect(leadsOf(makeCase({ id: '1', leads_count: null }))).toBeNull();
    expect(leadsOf(makeCase({ id: '2', leads_count: '' }))).toBeNull();
    expect(leadsOf(makeCase({ id: '3', leads_count: 'много' }))).toBeNull();
  });

  it('ноль лидов — это ноль, а не отсутствие значения', () => {
    expect(leadsOf(makeCase({ id: '1', leads_count: 0 }))).toBe(0);
  });
});

describe('isBelowLeadBar', () => {
  it('утверждённый кейс ниже порога помечается', () => {
    expect(isBelowLeadBar(makeCase({ id: '1', leads_count: MIN_CASE_LEADS - 1 }))).toBe(true);
    expect(isBelowLeadBar(makeCase({ id: '2', leads_count: null }))).toBe(true);
  });

  it('ровно порог — проходит', () => {
    expect(isBelowLeadBar(makeCase({ id: '1', leads_count: MIN_CASE_LEADS }))).toBe(false);
  });

  it('черновик не помечается независимо от лидов', () => {
    expect(isBelowLeadBar(makeCase({ id: '1', status: 'draft', leads_count: 0 }))).toBe(false);
  });
});

describe('applyListQuery', () => {
  const rows: Rec[] = [
    makeCase({ id: 'a', public_name: 'АДК Транс', case_id: 'adk_trans', leads_count: 179, industry_groups: ['auto_logistics'] }),
    makeCase({ id: 'b', public_name: 'INK Agency', case_id: 'ink_agency', leads_count: 5, industry_groups: ['digital_agency'] }),
    makeCase({ id: 'c', public_name: 'Brosto.pro', case_id: 'brosto', status: 'draft', leads_count: 16, industry_groups: ['digital_agency'] }),
    makeCase({ id: 'd', public_name: 'Компас С', case_id: 'compass_c', leads_count: null, industry_groups: [] }),
  ];

  it('ищет по названию, ID и тексту, не различая регистр', () => {
    expect(applyListQuery(rows, q({ query: 'адк' }), CASE_FIELDS).map((r) => r.id)).toEqual(['a']);
    expect(applyListQuery(rows, q({ query: 'INK_AGENCY' }), CASE_FIELDS).map((r) => r.id)).toEqual(['b']);
  });

  it('не ищет по полям вне списка', () => {
    expect(applyListQuery(rows, q({ query: 'approved' }), CASE_FIELDS)).toHaveLength(0);
  });

  it('фильтрует по статусу и по отраслевой группе', () => {
    expect(applyListQuery(rows, q({ status: 'draft' }), CASE_FIELDS).map((r) => r.id)).toEqual(['c']);
    expect(applyListQuery(rows, q({ industry: 'digital_agency' }), CASE_FIELDS).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('сортирует по лидам, пустые значения всегда в конце', () => {
    expect(applyListQuery(rows, q({ sort: 'leads_desc' }), CASE_FIELDS).map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(applyListQuery(rows, q({ sort: 'leads_asc' }), CASE_FIELDS).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('сортирует по названию по-русски: кириллица идёт перед латиницей', () => {
    expect(applyListQuery(rows, q({ sort: 'name' }), CASE_FIELDS).map((r) => r.id)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('без сортировки порядок исходного списка сохраняется', () => {
    expect(applyListQuery(rows, q(), CASE_FIELDS).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('не мутирует исходный массив', () => {
    const before = rows.map((r) => r.id);
    applyListQuery(rows, q({ sort: 'leads_desc' }), CASE_FIELDS);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('paginate', () => {
  const rows = Array.from({ length: 44 }, (_, i) => i);

  it('режет по 20 и считает страницы', () => {
    const first = paginate(rows, 0);
    expect(first.rows).toHaveLength(20);
    expect(first.totalPages).toBe(3);
    expect(first.from).toBe(0);

    const last = paginate(rows, 2);
    expect(last.rows).toHaveLength(4);
    expect(last.from).toBe(40);
  });

  it('кламает страницу за пределами диапазона', () => {
    expect(paginate(rows, 99).page).toBe(2);
    expect(paginate(rows, -3).page).toBe(0);
  });

  it('пустой список — одна страница без строк', () => {
    const empty = paginate([], 5);
    expect(empty.rows).toEqual([]);
    expect(empty.totalPages).toBe(1);
    expect(empty.page).toBe(0);
  });
});
