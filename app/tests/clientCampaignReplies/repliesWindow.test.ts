/** @jest-environment node */

import {
  looksLikeEmail,
  fetchReceivedEmailsWindow,
  fetchLeadInboundEmails,
  REPLIES_WINDOW_PAGES,
} from '@/lib/clientCampaignReplies/repliesWindow';

const mockListEmails = jest.fn();
jest.mock('@/lib/instantly/client', () => ({
  listEmails: (...args: unknown[]) => mockListEmails(...args),
}));

beforeEach(() => jest.clearAllMocks());

describe('looksLikeEmail', () => {
  it('email → true, прочее → false', () => {
    expect(looksLikeEmail('m.guslyakov@mgadget.tech')).toBe(true);
    expect(looksLikeEmail(' a@b.ru ')).toBe(true);
    expect(looksLikeEmail('гусляков')).toBe(false);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
    expect(looksLikeEmail(null)).toBe(false);
  });
});

describe('fetchReceivedEmailsWindow — ленивая пагинация', () => {
  it('неполная первая страница → один запрос, дальше не идём', async () => {
    mockListEmails.mockResolvedValue({ items: [{ id: '1' }], next_starting_after: 'c1' });
    const out = await fetchReceivedEmailsWindow({ campaignId: 'c1' });
    expect(out).toHaveLength(1);
    expect(mockListEmails).toHaveBeenCalledTimes(1);
  });

  it('полные страницы → дотягивает до maxPages, курсор пробрасывается', async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `${n}-${i}` }));
    mockListEmails
      .mockResolvedValueOnce({ items: page(1), next_starting_after: 'cur1' })
      .mockResolvedValueOnce({ items: page(2), next_starting_after: 'cur2' })
      .mockResolvedValueOnce({ items: page(3), next_starting_after: 'cur3' });
    const out = await fetchReceivedEmailsWindow({ campaignId: 'c1' });
    expect(out).toHaveLength(300);
    expect(mockListEmails).toHaveBeenCalledTimes(REPLIES_WINDOW_PAGES);
    expect(mockListEmails.mock.calls[1][0].starting_after).toBe('cur1');
    expect(mockListEmails.mock.calls[2][0].starting_after).toBe('cur2');
  });

  it('средняя страница неполная → стоп, курсор не тянется', async () => {
    const page = (n: number, len: number) => Array.from({ length: len }, (_, i) => ({ id: `${n}-${i}` }));
    mockListEmails
      .mockResolvedValueOnce({ items: page(1, 100), next_starting_after: 'cur1' })
      .mockResolvedValueOnce({ items: page(2, 37), next_starting_after: 'cur2' });
    const out = await fetchReceivedEmailsWindow({ campaignId: 'c1' });
    expect(out).toHaveLength(137);
    expect(mockListEmails).toHaveBeenCalledTimes(2);
  });

  it('limit всегда 100 (потолок API), accountId пробрасывается', async () => {
    mockListEmails.mockResolvedValue({ items: [], next_starting_after: null });
    await fetchReceivedEmailsWindow({ campaignId: 'c1', accountId: 'acc-2' });
    expect(mockListEmails).toHaveBeenCalledWith(
      expect.objectContaining({ campaign_id: 'c1', email_type: 'received', limit: 100 }),
      { accountId: 'acc-2' },
    );
  });
});

describe('fetchLeadInboundEmails', () => {
  it('отдаёт только входящие (ue_type=2), lead нормализуется', async () => {
    mockListEmails.mockResolvedValue({
      items: [
        { id: '1', ue_type: 2 },
        { id: '2', ue_type: 1 },
        { id: '3', ue_type: 3 },
        { id: '4', ue_type: 2 },
      ],
      next_starting_after: null,
    });
    const out = await fetchLeadInboundEmails({ campaignId: 'c1', leadEmail: ' Lead@X.ru ' });
    expect(out.map((e) => e.id)).toEqual(['1', '4']);
    expect(mockListEmails).toHaveBeenCalledWith(
      expect.objectContaining({ campaign_id: 'c1', lead: 'lead@x.ru', limit: 100 }),
      undefined,
    );
  });
});
