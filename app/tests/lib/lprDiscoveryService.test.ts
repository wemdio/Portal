/** @jest-environment node */

const mockFrom = jest.fn();
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));

const mockSuggestByName = jest.fn();
const mockHasDadataKey = jest.fn();
jest.mock('@/lib/enrich/dadataClient', () => ({
  suggestByName: (...args: unknown[]) => mockSuggestByName(...args),
  hasDadataKey: () => mockHasDadataKey(),
}));

describe('LPR discovery defaults', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('defaults to cis provider when env not set', async () => {
    delete process.env.LPR_DEFAULT_PROVIDER;
    const { LPR_CONFIG } = await import('@/lib/lpr/config');
    expect(LPR_CONFIG.DEFAULT_PROVIDER).toBe('cis');
  });

  it('returns LPR contacts from company_contacts', async () => {
    const jobQuery = createMockQuery({ data: { user_id: 'u-1' }, error: null });
    const companiesQuery = createMockQuery({
      data: [{ id: 'c-1', name: 'ООО Альфа', short_name: 'Альфа', brand_name: null, site: 'alfa.ru' }],
      error: null,
    });
    const contactsQuery = createMockQuery({
      data: [{
        company_id: 'c-1',
        full_name: 'Иван Петров',
        first_name: 'Иван',
        last_name: 'Петров',
        title: 'Генеральный директор',
        role_guess: 'ceo',
        channel_phone: '+79990001122',
        channel_email: 'ceo@alfa.ru',
        channel_tg_username: null,
        score: 80,
      }],
      error: null,
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'lpr_jobs') return jobQuery;
      if (table === 'companies') return companiesQuery;
      if (table === 'company_contacts') return contactsQuery;
      return createMockQuery({ data: null, error: null });
    });

    const { discoverLpr } = await import('@/lib/lpr/lprDiscoveryService');
    const result = await discoverLpr('job-1', { company: { company_name: 'Альфа' } });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.full_name).toBe('Иван Петров');
    expect(result.candidates[0]?.work_email).toBe('ceo@alfa.ru');
  });

  it('uses dadata management contact when no contacts found', async () => {
    const jobQuery = createMockQuery({ data: { user_id: 'u-2' }, error: null });
    const companiesQuery = createMockQuery({ data: [], error: null });
    const companyInsertQuery = createMockQuery({
      data: { id: 'c-2', name: 'ООО Бета', short_name: 'Бета', brand_name: null, site: null },
      error: null,
    });
    const contactsQuery = createMockQuery({
      data: [{
        company_id: 'c-2',
        full_name: 'Мария Иванова',
        first_name: null,
        last_name: null,
        title: 'Генеральный директор',
        role_guess: 'ceo',
        channel_phone: null,
        channel_email: null,
        channel_tg_username: null,
        score: 78,
      }],
      error: null,
    });
    const upsertContactQuery = createMockQuery({ data: null, error: null });

    mockHasDadataKey.mockReturnValue(true);
    mockSuggestByName.mockResolvedValue({
      value: 'ООО Бета',
      data: {
        inn: '7701234567',
        name: { full_with_opf: 'ООО Бета', short_with_opf: 'Бета' },
        management: { name: 'Мария Иванова', post: 'Генеральный директор' },
        address: { data: { city: 'Москва', region: 'Москва' } },
        ogrn: '1027700000000',
      },
    });

    const sequence = [jobQuery, companiesQuery, companyInsertQuery, upsertContactQuery, contactsQuery];
    mockFrom.mockImplementation(() => sequence.shift() ?? createMockQuery({ data: null, error: null }));

    const { discoverLpr } = await import('@/lib/lpr/lprDiscoveryService');
    const result = await discoverLpr('job-2', { company: { company_name: 'Бета' } });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.full_name).toBe('Мария Иванова');
  });
});

function createMockQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  const chainFn = () => query;
  query.select = jest.fn(chainFn);
  query.eq = jest.fn(chainFn);
  query.ilike = jest.fn(chainFn);
  query.in = jest.fn(chainFn);
  query.order = jest.fn(chainFn);
  query.limit = jest.fn(chainFn);
  query.upsert = jest.fn(chainFn);
  query.insert = jest.fn(chainFn);
  query.single = jest.fn(() => Promise.resolve(result));
  query.then = (resolve: (v: unknown) => void) => { resolve(result); };
  return query;
}
