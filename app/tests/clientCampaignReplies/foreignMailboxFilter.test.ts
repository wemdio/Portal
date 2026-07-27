/** @jest-environment node */

import {
  normalizeMailbox,
  partitionForeignEmails,
  resolveClientMailboxes,
  getClientMailboxPool,
  filterForeignEmails,
} from '@/lib/clientCampaignReplies/foreignMailboxFilter';

// ── Моки внешних зависимостей ────────────────────────────────────────────────

const mockGetCampaign = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
}));

// cached() в тестах — без кэша, просто вызываем fetcher.
jest.mock('@/lib/clientCache', () => ({
  cached: (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const mockLogInfo = jest.fn(async (..._args: unknown[]) => {});
const mockLogWarn = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/lib/loggerServer', () => ({
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
  logWarn: (...args: unknown[]) => mockLogWarn(...args),
  logError: jest.fn(async () => {}),
}));

// Минимальный стаб supabase-клиента: from(table).select(...).eq(...) → { data }.
const dbRows: Record<string, Array<{ email_account_ids?: unknown }>> = {};
jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => Promise.resolve({ data: dbRows[table] ?? [] }),
        }),
      }),
    };
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(dbRows)) delete dbRows[key];
});

// ── normalizeMailbox ─────────────────────────────────────────────────────────

describe('normalizeMailbox', () => {
  it('тримит и приводит к нижнему регистру', () => {
    expect(normalizeMailbox('  Aleksey@IT-LS.ru ')).toBe('aleksey@it-ls.ru');
  });

  it('null/undefined/пустую строку → null', () => {
    expect(normalizeMailbox(null)).toBeNull();
    expect(normalizeMailbox(undefined)).toBeNull();
    expect(normalizeMailbox('   ')).toBeNull();
  });
});

// ── partitionForeignEmails ───────────────────────────────────────────────────

describe('partitionForeignEmails', () => {
  const own = { id: '1', eaccount: 'intro@outreach-os.ru' };
  const foreign = { id: '2', eaccount: 'aleksey@it-ls.ru' };
  const noAccount = { id: '3', eaccount: undefined };
  const pool = new Set(['intro@outreach-os.ru', 'hello@polzamsg.ru']);

  it('pool=null → всё видимо (fail-open при неизвестной принадлежности)', () => {
    const { visible, hidden } = partitionForeignEmails([own, foreign], null);
    expect(visible).toHaveLength(2);
    expect(hidden).toHaveLength(0);
  });

  it('pool пустой → всё видимо (fail-open)', () => {
    const { visible, hidden } = partitionForeignEmails([own, foreign], new Set());
    expect(visible).toHaveLength(2);
    expect(hidden).toHaveLength(0);
  });

  it('скрывает письмо, полученное чужим ящиком (кейс 26.07)', () => {
    const { visible, hidden } = partitionForeignEmails([own, foreign], pool);
    expect(visible).toEqual([own]);
    expect(hidden).toEqual([foreign]);
  });

  it('письмо без eaccount остаётся видимым (нечего проверять)', () => {
    const { visible, hidden } = partitionForeignEmails([noAccount], pool);
    expect(visible).toEqual([noAccount]);
    expect(hidden).toHaveLength(0);
  });

  it('матч ящика регистронезависим', () => {
    const upper = { id: '4', eaccount: 'Intro@Outreach-OS.ru' };
    const { visible, hidden } = partitionForeignEmails([upper], pool);
    expect(visible).toEqual([upper]);
    expect(hidden).toHaveLength(0);
  });
});

// ── getClientMailboxPool ─────────────────────────────────────────────────────

describe('getClientMailboxPool', () => {
  it('собирает union из пресетов и запусков, нормализуя адреса', async () => {
    dbRows['client_campaign_presets'] = [{ email_account_ids: ['A@x.ru', 'b@y.ru'] }];
    dbRows['client_campaign_launches'] = [
      { email_account_ids: ['c@z.ru'] },
      { email_account_ids: null }, // null = «весь пул пресета», адресов не добавляет
      { email_account_ids: [42, 'd@w.ru'] }, // мусор в jsonb не роняет сборку
    ];
    const pool = await getClientMailboxPool('user-1');
    expect([...pool].sort()).toEqual(['a@x.ru', 'b@y.ru', 'c@z.ru', 'd@w.ru']);
  });

  it('без пресетов и запусков → пустое множество', async () => {
    const pool = await getClientMailboxPool('user-1');
    expect(pool.size).toBe(0);
  });
});

// ── resolveClientMailboxes ───────────────────────────────────────────────────

describe('resolveClientMailboxes', () => {
  it('объединяет email_list кампании и пул клиента', async () => {
    mockGetCampaign.mockResolvedValue({ email_list: ['Sender@Cmp.ru'] });
    dbRows['client_campaign_presets'] = [{ email_account_ids: ['preset@x.ru'] }];
    const boxes = await resolveClientMailboxes('user-1', 'camp-1');
    expect(boxes).not.toBeNull();
    expect(boxes!.has('sender@cmp.ru')).toBe(true);
    expect(boxes!.has('preset@x.ru')).toBe(true);
  });

  it('email_list пуст и пула нет → null (fail-open)', async () => {
    mockGetCampaign.mockResolvedValue({ email_list: [] });
    const boxes = await resolveClientMailboxes('user-1', 'camp-1');
    expect(boxes).toBeNull();
  });

  it('Instantly API упал → опираемся на пул клиента, не роняем запрос', async () => {
    mockGetCampaign.mockRejectedValue(new Error('429 rate limit'));
    dbRows['client_campaign_presets'] = [{ email_account_ids: ['preset@x.ru'] }];
    const boxes = await resolveClientMailboxes('user-1', 'camp-1');
    expect(boxes).not.toBeNull();
    expect(boxes!.has('preset@x.ru')).toBe(true);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('email_list не массив (защита от формы ответа) → пул или null', async () => {
    mockGetCampaign.mockResolvedValue({ email_list: null });
    const boxes = await resolveClientMailboxes('user-1', 'camp-1');
    expect(boxes).toBeNull();
  });
});

// ── filterForeignEmails ──────────────────────────────────────────────────────

describe('filterForeignEmails', () => {
  it('возвращает видимые и логирует скрытые', async () => {
    const own = { id: '1', eaccount: 'a@x.ru' };
    const foreign = { id: '2', eaccount: 'stranger@other.ru' };
    const out = await filterForeignEmails(
      [own, foreign],
      new Set(['a@x.ru']),
      { campaignId: 'camp-1', userId: 'user-1' },
    );
    expect(out).toEqual([own]);
    expect(mockLogInfo).toHaveBeenCalledWith(
      'client.replies.foreign_mailbox_hidden',
      expect.stringContaining('1'),
      expect.objectContaining({ campaignId: 'camp-1', userId: 'user-1' }),
    );
  });

  it('без скрытых — без логов', async () => {
    const own = { id: '1', eaccount: 'a@x.ru' };
    const out = await filterForeignEmails([own], new Set(['a@x.ru']), { campaignId: 'c', userId: 'u' });
    expect(out).toEqual([own]);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});
