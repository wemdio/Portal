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
