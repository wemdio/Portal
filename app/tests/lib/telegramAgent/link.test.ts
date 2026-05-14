/** @jest-environment node */

const mockFrom = jest.fn();
const mockVerifyLinkToken = jest.fn();
const mockSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock('@/lib/telegramAgent/linkToken', () => ({
  verifyLinkToken: (...args: unknown[]) => mockVerifyLinkToken(...args),
}));
jest.mock('@/lib/telegramAgent/telegram', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(),
  logError: jest.fn(),
}));

import { handleLinkCommand } from '@/lib/telegramAgent/link';

function selectChain(result: { data: unknown; error: unknown }) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
}

describe('telegramAgent/link', () => {
  const oldBotToken = process.env.TG_AGENT_BOT_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TG_AGENT_BOT_TOKEN = 'agent-token';
    mockVerifyLinkToken.mockReturnValue({ ok: true, userId: 'user-1' });
  });

  afterAll(() => {
    if (oldBotToken === undefined) delete process.env.TG_AGENT_BOT_TOKEN;
    else process.env.TG_AGENT_BOT_TOKEN = oldBotToken;
  });

  it('stores telegram username and names when linking a new account', async () => {
    const insertChain = { insert: jest.fn().mockResolvedValue({ error: null }) };
    mockFrom
      .mockReturnValueOnce(selectChain({ data: null, error: null }))
      .mockReturnValueOnce(selectChain({ data: null, error: null }))
      .mockReturnValueOnce(insertChain);

    await handleLinkCommand(100, 999, 'token', {
      username: 'SergeyPortal',
      firstName: 'Sergey',
      lastName: 'Petrov',
    });

    expect(insertChain.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      telegram_id: '999',
      telegram_username: 'sergeyportal',
      telegram_first_name: 'Sergey',
      telegram_last_name: 'Petrov',
    });
    expect(mockSendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Telegram привязан'));
  });

  it('refreshes username metadata when the same Telegram account is already linked to this user', async () => {
    const updateChain = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: jest.fn().mockImplementation((resolve) => resolve({ error: null })),
    };
    mockFrom
      .mockReturnValueOnce(selectChain({ data: { user_id: 'user-1' }, error: null }))
      .mockReturnValueOnce(updateChain);

    await handleLinkCommand(100, 999, 'token', {
      username: 'FreshName',
      firstName: 'Sergey',
      lastName: null,
    });

    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      telegram_username: 'freshname',
      telegram_first_name: 'Sergey',
      telegram_last_name: null,
    }));
    expect(updateChain.eq).toHaveBeenCalledWith('telegram_id', '999');
    expect(mockSendMessage).toHaveBeenCalledWith(100, expect.stringContaining('уже привязан'));
  });
});
