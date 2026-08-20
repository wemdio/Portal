/** @jest-environment node */

/**
 * Инцидент 15–17.08.2026, рецидив 20.08.2026.
 *
 * Две running-кампании на пересекающихся лидах: гард от повтора есть только на
 * шаге invite (processInviteStep смотрит на lead.status), а у шага message его
 * нет вовсе. Обе кампании шлют в один и тот же чат лида (li_leads.chat_id один
 * на человека), поэтому получатель видит, как один и тот же собеседник дважды
 * присылает один и тот же абзац. Так дубли получили Владислав Склизков, Дмитрий
 * Артёмов, Станислав Принцманн и Ольга Мальцева — Склизков через пять минут
 * ответил «Не интересно».
 *
 * 18.08 кампанию-двойника остановили руками, 20.08 её запустили заново и
 * пересечение вернулось: 153 лида. Организационная договорённость «один человек —
 * одна активная кампания» не держится, поэтому нужен гард в коде: если этот
 * самый текст уже уходил этому человеку, второй раз он не уйдёт.
 */

import { createLiOutreachMockDb } from '../helpers/liOutreachDb';

const mockDb = createLiOutreachMockDb();
const dbState = mockDb.state;

mockDb.registerRpc('li_campaign_increment_invite', async () => ({ data: 1, error: null }));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb.client;
  },
}));

let sendMessageCalls: string[] = [];
let startChatCalls: string[] = [];

jest.mock('@/lib/liOutreach/unipileClient', () => {
  class UnipileError extends Error {
    status: number;
    body: string;
    constructor(message: string, status: number, body: string) {
      super(message);
      this.name = 'UnipileError';
      this.status = status;
      this.body = body;
    }
  }
  class UnipileClient {
    constructor(_dsn: string, _key: string, _accountId?: string | null) {}
    sendInvite(): Promise<Record<string, unknown>> {
      return Promise.resolve({ id: 'invite-ok' });
    }
    getProviderId(): Promise<string> {
      return Promise.resolve('provider-already-set');
    }
    sendMessage(_chatId: string, text: string): Promise<Record<string, unknown>> {
      sendMessageCalls.push(text);
      return Promise.resolve({ id: 'msg-ok' });
    }
    startChat(_id: string, text: string): Promise<Record<string, unknown>> {
      startChatCalls.push(text);
      return Promise.resolve({ id: 'chat-new' });
    }
  }
  return {
    UnipileClient,
    UnipileError,
    extractPublicIdentifier: (s: string): string | null => s,
    extractActivityUrn: (): null => null,
  };
});

jest.mock('@/lib/liOutreach/aiService', () => ({
  parseMessageTemplate: (s: string): string => s,
  leadToInfo: (): Record<string, unknown> => ({}),
  personalizeInviteMessage: async (s: string): Promise<string> => s,
  personalizeFollowUp: async (s: string): Promise<string> => s,
}));

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';

/** Реальный текст третьего шага RuFunders-кампаний. */
const STEP_MESSAGE =
  'Иван, живой пример: у клиента было 25+ подрядчиков в 7 странах — договоры, инвойсы и выплаты в трёх разных сервисах.';

type HistoryEntry = { role: string; content: string; ts?: string };

function seed(history: HistoryEntry[]): void {
  mockDb.reset();
  sendMessageCalls = [];
  startChatCalls = [];
  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID,
      user_id: USER_ID,
      name: 'YouGo_RuFunders_Olesya_Wave1',
      account_id: ACCOUNT_ID,
      lead_list_id: null,
      status: 'running',
      steps: [
        { type: 'invite', message: 'hi' },
        { type: 'wait', days: 2 },
        { type: 'message', message: STEP_MESSAGE },
      ],
      use_ai: false,
      ai_prompt_invite: null,
      ai_prompt_chat: null,
      stop_on_reply: true,
      min_delay: 1,
      max_delay: 1,
      daily_invite_limit: 25,
      invites_sent_today: 0,
      last_invite_date: new Date().toISOString().slice(0, 10),
      welcome_message: null,
      message_existing_connections: false,
      use_ai_welcome: false,
      use_ai_followup: false,
    },
  ];
  dbState.rows.li_settings = [
    {
      id: 's-1',
      user_id: USER_ID,
      unipile_dsn: 'api.example.com:443',
      unipile_api_key: 'k',
      openai_api_key: '',
      openai_model: 'gpt-4o-mini',
      webhook_secret: '',
      proxy_url: '',
    },
  ];
  dbState.rows.li_accounts = [
    {
      id: ACCOUNT_ID,
      user_id: USER_ID,
      unipile_account_id: 'unipile-acc-1',
      name: 'Olessya Sadyrina',
      is_active: true,
      cooldown_until: null,
      cooldown_reason: null,
    },
  ];
  dbState.rows.li_leads = [
    {
      id: 'lead-1',
      user_id: USER_ID,
      lead_list_id: null,
      linkedin_id: 'provider-lead-1',
      public_identifier: 'lead-1',
      profile_url: 'https://www.linkedin.com/in/lead-1',
      name: 'Иван',
      first_name: 'Иван',
      last_name: '',
      position: null,
      company: null,
      chat_id: 'chat-existing',
      status: 'connected',
      account_id: ACCOUNT_ID,
      conversation_history: history,
      extra_data: {},
      last_activity: null,
    },
  ];
  dbState.rows.li_campaign_leads = [
    {
      id: 'cl-lead-1',
      campaign_id: CAMPAIGN_ID,
      lead_id: 'lead-1',
      current_step: 2,
      status: 'in_progress',
      next_action_at: null,
      user_replied: false,
      invite_accepted: true,
      error_message: null,
      created_at: '2026-01-01T00:00:00.000Z',
      lead: dbState.rows.li_leads[0],
    },
  ];
  dbState.rows.li_campaign_logs = [];
}

function lastLeadUpdate(): { status?: unknown; error_message?: unknown } {
  const updates = dbState.updates.filter(
    (u) => u.table === 'li_campaign_leads' && u.filters.id === 'cl-lead-1',
  );
  return (updates[updates.length - 1]?.data ?? {}) as { status?: unknown; error_message?: unknown };
}

describe('processMessageStep — гард от повторной отправки того же текста', () => {
  it('не отправляет текст, который этому лиду уже уходил (дубль из кампании-двойника)', () => {
    seed([{ role: 'assistant', content: STEP_MESSAGE, ts: '2026-08-19T09:00:00.000Z' }]);

    return runCampaignTick(CAMPAIGN_ID, USER_ID).then(() => {
      expect(sendMessageCalls).toEqual([]);
      expect(startChatCalls).toEqual([]);
    });
  });

  it('снимает лида с этой кампании, чтобы следующий шаг не дублировался тоже', async () => {
    seed([{ role: 'assistant', content: STEP_MESSAGE, ts: '2026-08-19T09:00:00.000Z' }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const upd = lastLeadUpdate();
    expect(upd.status).toBe('skipped');
    expect(String(upd.error_message)).toMatch(/уже отправл/i);
  });

  it('игнорирует разницу в пробелах и регистре — для человека это тот же текст', async () => {
    seed([
      {
        role: 'assistant',
        content: `  ${STEP_MESSAGE.toUpperCase()}\n\n`,
        ts: '2026-08-19T09:00:00.000Z',
      },
    ]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageCalls).toEqual([]);
  });

  it('нормальную отправку не трогает: в истории другой текст', async () => {
    seed([
      { role: 'assistant', content: 'Здравствуйте! Спасибо за коннект.', ts: '2026-08-18T09:00:00.000Z' },
      { role: 'user', content: 'Добрый день', ts: '2026-08-18T10:00:00.000Z' },
    ]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageCalls).toEqual([STEP_MESSAGE]);
    expect(lastLeadUpdate().status).not.toBe('skipped');
  });

  it('не путает наши сообщения с чужими: тот же текст, но его прислал лид', async () => {
    // Совпадение по роли обязательно. Иначе процитировавший нас лид навсегда
    // заблокировал бы собственную рассылку.
    seed([{ role: 'user', content: STEP_MESSAGE, ts: '2026-08-19T09:00:00.000Z' }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageCalls).toEqual([STEP_MESSAGE]);
  });

  it('пустая история никого не блокирует', async () => {
    seed([]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageCalls).toEqual([STEP_MESSAGE]);
  });
});
