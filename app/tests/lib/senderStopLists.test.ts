/** @jest-environment node */
/**
 * Стоп-листы клиента и проекта для «Рассылки»: кого нельзя заливать в базу и
 * кого снимать с идущей кампании. Чистая логика без БД.
 */

jest.mock('server-only', () => ({}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ensureCampaignStopListChecked,
  matchSenderStopList,
  recipientWebsites,
  STOPLIST_FRESH_MS,
  stopListIsEmpty,
  type SenderStopList,
} from '@/lib/sender/stopLists';

const MAILGANER = '0a6d90e1-91d0-404e-b508-6b031bda7cfd';

function list(overrides: Partial<SenderStopList> = {}): SenderStopList {
  return {
    clientUserId: 'client-1',
    projectId: 'project-1',
    client: { emails: new Set(['boss@acme.ru']), domains: new Set(['rival.ru']) },
    projectEmails: new Set(['partner@ok.ru']),
    ...overrides,
  };
}

describe('matchSenderStopList', () => {
  it('закрывает адрес клиента, домен клиента по адресу и по сайту, адрес проекта', () => {
    expect(matchSenderStopList(list(), { email: 'Boss@Acme.ru' })).toBe('client_blocklist');
    expect(matchSenderStopList(list(), { email: 'info@shop.rival.ru' })).toBe('client_blocklist');
    expect(matchSenderStopList(list(), { email: 'info@gmail.com', vars: { website: 'https://www.rival.ru/contacts' } })).toBe('client_blocklist');
    expect(matchSenderStopList(list(), { email: 'partner@ok.ru' })).toBe('project_block');
    expect(matchSenderStopList(list(), { email: 'info@notrival.ru', vars: { сайт: 'notrival.ru' } })).toBeNull();
  });

  it('политика доменов клиента смотрит сайт компании, а не бесплатный ящик', () => {
    const mailganer = list({ clientUserId: MAILGANER, client: { emails: new Set(), domains: new Set() }, projectEmails: new Set() });
    expect(stopListIsEmpty(mailganer)).toBe(false);
    expect(matchSenderStopList(mailganer, { email: 'info@gmail.com', vars: { site: 'example.com' } })).toBe('client_blocklist');
    expect(matchSenderStopList(mailganer, { email: 'info@example.com', vars: { site: 'example.ru' } })).toBeNull();
  });

  it('берёт сайт из колонок базы под разными именами', () => {
    expect(recipientWebsites({ company_website: 'a.ru', name: 'Иван', домен: 'b.ru', url: '' })).toEqual(['a.ru', 'b.ru']);
  });
});

/** База с одной кампанией: from(...).select(...).eq(...).maybeSingle() → строка. */
function campaignDb(row: Record<string, unknown>): SupabaseClient {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe('ensureCampaignStopListChecked без базы Instantly (запуск по расписанию)', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('кампанию без клиента и проекта запускает', async () => {
    const db = campaignDb({ id: 'c1', client_user_id: null, project_id: null, stoplist_checked_at: null });
    await expect(ensureCampaignStopListChecked(db, null, 'c1')).resolves.toBeUndefined();
  });

  it('с клиентом запускает только по свежей сверке', async () => {
    const fresh = campaignDb({ id: 'c1', client_user_id: 'u1', project_id: null, stoplist_checked_at: ago(60_000) });
    await expect(ensureCampaignStopListChecked(fresh, null, 'c1')).resolves.toBeUndefined();

    const stale = campaignDb({ id: 'c1', client_user_id: 'u1', project_id: null, stoplist_checked_at: ago(STOPLIST_FRESH_MS + 60_000) });
    await expect(ensureCampaignStopListChecked(stale, null, 'c1')).rejects.toThrow('свежей сверки нет');

    const never = campaignDb({ id: 'c1', client_user_id: 'u1', project_id: null, stoplist_checked_at: null });
    await expect(ensureCampaignStopListChecked(never, null, 'c1')).rejects.toThrow('свежей сверки нет');
  });
});
