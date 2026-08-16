/** @jest-environment node */

jest.mock('server-only', () => ({}));

/**
 * Право ответить на «сироту» — письмо, которое провайдер не привязал к кампании.
 *
 * У обычного ответа принадлежность доказывает кампания (campaign_id письма
 * совпадает с кампанией клиента). У сироты campaign_id пуст, поэтому право
 * доказывается ящиком-получателем. Это единственное место, где отправка письма
 * от лица клиента разрешается НЕ по кампании, поэтому тест пинит именно отказы:
 * каждая непройденная проверка должна давать null, а не «ну ладно».
 */

interface Row {
  lead_email: string | null;
  eaccount: string | null;
}

let row: Row | null = null;
let queryError: { message: string } | null = null;
let capturedFilters: Record<string, unknown> = {};
let clientMailboxes: Set<string> | null = null;

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return {
      from: () => {
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            capturedFilters[col] = val;
            return builder;
          },
          limit: () => builder,
          maybeSingle: () =>
            Promise.resolve(queryError ? { data: null, error: queryError } : { data: row, error: null }),
        };
        return builder;
      },
    };
  },
}));

jest.mock('@/lib/clientCampaignReplies/foreignMailboxFilter', () => {
  const actual = jest.requireActual('@/lib/clientCampaignReplies/foreignMailboxFilter');
  return { ...actual, resolveClientMailboxes: jest.fn(async () => clientMailboxes) };
});

import { resolveStrayAccess } from '@/lib/clientCampaignReplies/strayAccess';

const BASE = {
  emailId: 'email-1',
  campaignId: 'cmp-1',
  userId: 'user-A',
  accountId: null,
  eaccount: 'reachout@outreach-contact.online',
};

beforeEach(() => {
  row = { lead_email: 'v.popov@contrust.bz', eaccount: 'reachout@outreach-contact.online' };
  queryError = null;
  capturedFilters = {};
  clientMailboxes = new Set(['reachout@outreach-contact.online']);
});

describe('resolveStrayAccess', () => {
  it('свой ящик + известная сирота → доступ, отдаёт адрес лида из нашей записи', async () => {
    await expect(resolveStrayAccess(BASE)).resolves.toEqual({
      leadEmail: 'v.popov@contrust.bz',
    });
  });

  it('ищет строго сироту ЭТОЙ кампании по id письма', async () => {
    await resolveStrayAccess(BASE);
    // Без любого из трёх фильтров чужая/несиротская строка стала бы пропуском.
    expect(capturedFilters).toEqual({
      instantly_email_id: 'email-1',
      campaign_id: 'cmp-1',
      reply_out_of_campaign: true,
    });
  });

  it('записи о сироте нет → отказ', async () => {
    row = null;
    await expect(resolveStrayAccess(BASE)).resolves.toBeNull();
  });

  it('БД ответила ошибкой → отказ (fail-closed, а не «пропустим»)', async () => {
    queryError = { message: 'connection reset by peer' };
    await expect(resolveStrayAccess(BASE)).resolves.toBeNull();
  });

  it('ящик письма не совпал с ящиком в нашей записи → отказ', async () => {
    row = { lead_email: 'v.popov@contrust.bz', eaccount: 'team@outreach-contact.ru' };
    await expect(resolveStrayAccess(BASE)).resolves.toBeNull();
  });

  it('ящик не принадлежит клиенту → отказ', async () => {
    clientMailboxes = new Set(['someone-else@other.tld']);
    await expect(resolveStrayAccess(BASE)).resolves.toBeNull();
  });

  it('пул ящиков клиента определить не удалось → отказ', async () => {
    // На ПОКАЗ неопределённость fail-open'ится (partitionForeignEmails), но
    // отправка письма от лица клиента при неизвестной принадлежности — нет.
    clientMailboxes = null;
    await expect(resolveStrayAccess(BASE)).resolves.toBeNull();
  });

  it('у письма нет ящика → отказ (проверять нечего)', async () => {
    await expect(resolveStrayAccess({ ...BASE, eaccount: null })).resolves.toBeNull();
  });

  it('регистр ящика не важен', async () => {
    row = { lead_email: 'v.popov@contrust.bz', eaccount: 'ReachOut@Outreach-Contact.Online' };
    await expect(
      resolveStrayAccess({ ...BASE, eaccount: 'REACHOUT@outreach-contact.online' }),
    ).resolves.toEqual({ leadEmail: 'v.popov@contrust.bz' });
  });

  it('лид в записи пуст → доступ есть, адрес null (тред соберётся без него)', async () => {
    row = { lead_email: null, eaccount: 'reachout@outreach-contact.online' };
    await expect(resolveStrayAccess(BASE)).resolves.toEqual({ leadEmail: null });
  });
});
