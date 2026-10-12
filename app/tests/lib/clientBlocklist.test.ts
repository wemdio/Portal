/**
 * Чёрный список контактов клиента — чистая логика normalize/filter.
 *
 * Это та логика, на которую опирается фильтрация лидов при каждом запуске
 * кампании (runClientLaunch) и ежедневном догрузе авто-пайплайна (appendLeads):
 * заблокированный адрес НЕ должен пройти в Instantly ни в каком регистре
 * и ни с какими пробелами.
 */
import {
  BLOCKLIST_MAX_ENTRIES,
  getBlockedEmailSet,
  normalizeBlockedEmail,
  filterBlockedLeads,
} from '@/lib/clientBlocklist/blockedContacts';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  filterClientDomainLeads,
  getClientExcludedDomainSuffixes,
  isClientDomainExcluded,
} from '@/lib/clientBlocklist/domainPolicy';
import {
  filterVeProjectExcludedRows, getVeProjectExclusionIdentity, loadVeProjectExclusions,
  matchVeProjectExclusion, normalizeVeExclusionDomain, validateVeProjectExclusionInput,
  type VeProjectExclusions,
} from '@/lib/verticalEngineV2/projectExclusions';

describe('client company-domain policy', () => {
  const clientId = '0a6d90e1-91d0-404e-b508-6b031bda7cfd';

  it('excludes only Mailganer .com sites, with normalized hostnames and stable lead identities', () => {
    expect(getClientExcludedDomainSuffixes(clientId)).toEqual(['.com']);
    expect(getClientExcludedDomainSuffixes('another-client')).toEqual([]);
    for (const site of ['example.com', ' HTTPS://WWW.Example.COM.:443/contact ', '//sub.example.com/path']) {
      expect(isClientDomainExcluded(clientId, site)).toBe(true);
      expect(isClientDomainExcluded('another-client', site)).toBe(false);
    }
    for (const site of ['example.com.ru', 'example.ru/com', 'example.ru?site=example.com', 'example.company', '', null]) {
      expect(isClientDomainExcluded(clientId, site)).toBe(false);
    }
    const leads = [
      { email: 'one@example.ru', website: 'https://company.com' },
      { email: 'two@gmail.com', website: 'company.ru' },
      { email: 'three@example.ru', custom_variables: { domain: 'company.com' } },
      { email: 'four@gmail.com' },
      { email: 'five@company.com.ru', website: 'company.com.ru' },
    ];
    const result = filterClientDomainLeads(leads, clientId);
    expect(result.blockedCount).toBe(2);
    expect(result.kept).toEqual([leads[1], leads[3], leads[4]]);
    expect(result.kept[0]).toBe(leads[1]);
    expect(filterClientDomainLeads(leads, 'another-client').kept).toEqual(leads);

    // VE2 project rules use known company identifiers only, without site requests.
    const rules: VeProjectExclusions = { projectId: 've-project', revision: 1,
      inns: ['7701234567'], domains: ['company.ru', 'xn--e1afmkfd.xn--p1ai', 'tenant.github.io'], updated_at: null };
    const audience = [
      { email: 'one@gmail.com', ИНН: '7701234567' },
      { email: 'two@branch.company.ru' },
      { email: 'three@gmail.com', Сайт: 'HTTPS://WWW.COMPANY.RU./contacts' },
      { email: 'four@notcompany.ru' },
      { email: 'five@company.ru.evil.test' },
      { email: 'six@mail.ru' },
      { email: 'seven@other.test', custom_variables: { Сайт: 'https://пример.рф' } },
      { email: 'eight@other.test', _ve_company_identity: { inns: ['7701234567'], domains: [] } },
      { email: 'nine@other.test', website: 'tenant.github.io' },
      { email: 'ten@other.test', website: 'other.github.io' },
    ];
    const filtered = filterVeProjectExcludedRows(audience, rules);
    expect(filtered.kept).toEqual([audience[3], audience[4], audience[5], audience[9]]);
    expect(filtered.blockedCount).toBe(6);
    expect(filtered.unidentifiedCount).toBe(4); // INN missing; unmatched rows deliberately stay.
    expect(filtered.kept[0]).toBe(audience[3]);
    expect(filterVeProjectExcludedRows(audience, { ...rules, projectId: 'other', inns: [], domains: [] }).kept).toBe(audience);
    expect(getVeProjectExclusionIdentity(audience[6])).toEqual({ inns: [], domains: ['other.test', 'xn--e1afmkfd.xn--p1ai'] });
    expect(matchVeProjectExclusion({ email: 'x@gmail.com', website: 'company.ru/not/a/company-name' }, rules)).toBe('domain');
    expect(matchVeProjectExclusion({ email: 'x@gmail.com', company: 'company.ru', note: 'ИНН 7701234567' }, rules)).toBeNull();
    expect(matchVeProjectExclusion({ website: 'company.ru' }, { ...rules, domains: ['branch.company.ru'], inns: [] })).toBeNull();
    for (const invalid of ['com', 'co.uk', 'github.io', 'mail.ru', 'gmail.com', 'vk.com/client', '127.0.0.1',
      'https://company.ru@evil.test', 'javascript:company.ru', '*.company.ru', 'company..ru', 'x@company.ru']) {
      expect(normalizeVeExclusionDomain(invalid)).toBeNull();
    }
    expect(validateVeProjectExclusionInput({ revision: 0, inns: ['7701234567', '7701234567'],
      domains: ['https://www.Company.ru/path', 'company.ru'] })).toEqual({ ok: true, revision: 0, inns: ['7701234567'], domains: ['company.ru'] });
    expect(validateVeProjectExclusionInput({ revision: 0, inns: ['770123456'], domains: ['mail.ru'] })).toMatchObject({ ok: false });
    expect(validateVeProjectExclusionInput({ revision: -1, inns: [], domains: [] })).toMatchObject({ ok: false });
    expect(validateVeProjectExclusionInput({ revision: 0, inns: Array(10001).fill('7701234567'), domains: [] })).toMatchObject({ ok: false });
  });
});

describe('getBlockedEmailSet', () => {
  it('loads one transactionally consistent snapshot beyond the PostgREST row cap', async () => {
    const emails = Array.from(
      { length: 1_002 },
      (_, index) => `blocked-${index}@example.test`,
    );
    const db = createMockSupabase({
      rpcHandlers: {
        client_blocklist_snapshot: () => ({
          data: { count: emails.length, emails },
        }),
      },
    });

    const blocked = await getBlockedEmailSet(db as unknown as SupabaseClient, 'client-1');

    expect(blocked.size).toBe(emails.length);
    expect(blocked.has('blocked-1001@example.test')).toBe(true);
    expect(db.rpcCalls).toEqual([{
      fn: 'client_blocklist_snapshot',
      params: { p_client_user_id: 'client-1' },
    }]);

    const projects = createMockSupabase({ tables: { ve_project_exclusions: [
      { project_id: 'one', revision: 1, inns: ['7701234567'], domains: ['company.ru'], updated_at: '2026-10-12T00:00:00Z' },
      { project_id: 'two', revision: 2, inns: [], domains: ['other.ru'], updated_at: null },
    ] } });
    expect(await loadVeProjectExclusions(projects as unknown as SupabaseClient, 'one')).toMatchObject({ projectId: 'one', revision: 1, domains: ['company.ru'] });
    expect(await loadVeProjectExclusions(projects as unknown as SupabaseClient, 'missing')).toMatchObject({ revision: 0, domains: [], inns: [] });
    const unavailable = createMockSupabase({ errorTables: { ve_project_exclusions: 'unavailable' } });
    await expect(loadVeProjectExclusions(unavailable as unknown as SupabaseClient, 'one')).rejects.toThrow('Не удалось проверить');
    const corrupt = createMockSupabase({ tables: { ve_project_exclusions: [{ project_id: 'one', revision: 1, inns: ['bad'], domains: [] }] } });
    await expect(loadVeProjectExclusions(corrupt as unknown as SupabaseClient, 'one')).rejects.toThrow('повреждён');
  });

  it('fails closed instead of returning a truncated oversized blocklist', async () => {
    const db = createMockSupabase({
      rpcHandlers: {
        client_blocklist_snapshot: () => ({
          data: { count: BLOCKLIST_MAX_ENTRIES + 1, emails: [] },
        }),
      },
    });

    await expect(
      getBlockedEmailSet(db as unknown as SupabaseClient, 'client-1'),
    ).rejects.toThrow();
  });

  it('fails closed when the snapshot payload is incomplete', async () => {
    const db = createMockSupabase({
      rpcHandlers: {
        client_blocklist_snapshot: () => ({
          data: { count: 2, emails: ['one@example.test'] },
        }),
      },
    });

    await expect(
      getBlockedEmailSet(db as unknown as SupabaseClient, 'client-1'),
    ).rejects.toThrow();
  });
});

describe('normalizeBlockedEmail', () => {
  it('lowercases and trims a valid email', () => {
    expect(normalizeBlockedEmail('  Ivan.Petrov@Company.RU ')).toBe('ivan.petrov@company.ru');
  });

  it('rejects garbage: empty, non-string, no @, spaces inside, short TLD', () => {
    expect(normalizeBlockedEmail('')).toBeNull();
    expect(normalizeBlockedEmail('   ')).toBeNull();
    expect(normalizeBlockedEmail(null)).toBeNull();
    expect(normalizeBlockedEmail(42)).toBeNull();
    expect(normalizeBlockedEmail('not-an-email')).toBeNull();
    expect(normalizeBlockedEmail('a b@company.ru')).toBeNull();
    expect(normalizeBlockedEmail('a@b.c')).toBeNull();
  });

  it('rejects absurdly long input (320+ chars)', () => {
    const long = `${'a'.repeat(320)}@x.com`;
    expect(normalizeBlockedEmail(long)).toBeNull();
  });
});

describe('filterBlockedLeads', () => {
  const lead = (email: string): LeadCreatePayload => ({ email }) as LeadCreatePayload;

  it('returns the same array untouched when the blocklist is empty', () => {
    const leads = [lead('a@x.com'), lead('b@x.com')];
    const res = filterBlockedLeads(leads, new Set());
    expect(res.kept).toBe(leads);
    expect(res.blockedCount).toBe(0);
  });

  it('cuts blocked emails case-insensitively', () => {
    const leads = [lead('Negative@Corp.RU'), lead('ok@corp.ru'), lead(' negative@corp.ru ')];
    const res = filterBlockedLeads(leads, new Set(['negative@corp.ru']));
    expect(res.kept.map((l) => l.email)).toEqual(['ok@corp.ru']);
    expect(res.blockedCount).toBe(2);
  });

  it('keeps leads with unparseable emails (upstream validation owns those)', () => {
    const leads = [lead('broken'), lead('fine@corp.ru')];
    const res = filterBlockedLeads(leads, new Set(['someone@else.ru']));
    expect(res.kept.map((l) => l.email)).toEqual(['broken', 'fine@corp.ru']);
    expect(res.blockedCount).toBe(0);
  });

  it('blocks every lead when all are listed', () => {
    const leads = [lead('a@x.com'), lead('b@x.com')];
    const res = filterBlockedLeads(leads, new Set(['a@x.com', 'b@x.com']));
    expect(res.kept).toEqual([]);
    expect(res.blockedCount).toBe(2);
  });
});
