/** @jest-environment node */

/**
 * Tests for lib/hypothesisEngine/tgNotify — TG-уведомления создателю проекта
 * о финале research-пайплайна «Движка вертикалей»:
 *  - композиция текстов (плюрализация, HTML-escape, обрезка ошибки, URL);
 *  - резолв chat_id через telegram_links (user_id → telegram_id);
 *  - skip-ветки (нет токена/проекта/created_by/привязки) — молча, без бросков;
 *  - notify* никогда не бросают, даже если sendMessage упал.
 */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildHeToolUrl,
  buildResearchDoneMessage,
  buildResearchFailedMessage,
  notifyHeResearchDone,
  notifyHeResearchFailed,
  pluralRu,
  resolveTelegramChatId,
} from '@/lib/hypothesisEngine/tgNotify';
import { sendMessage } from '@/lib/telegramAgent/telegram';

jest.mock('@/lib/telegramAgent/telegram', () => ({
  sendMessage: jest.fn(),
}));

const sendMessageMock = sendMessage as jest.MockedFunction<typeof sendMessage>;

const ENV_KEYS = ['TG_AGENT_BOT_TOKEN', 'PORTAL_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.TG_AGENT_BOT_TOKEN = 'test-agent-token';
  delete process.env.PORTAL_PUBLIC_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function makeDb(seedTables: Record<string, Record<string, unknown>[]> = {}) {
  return createMockSupabase({
    tables: {
      he_projects: [
        { id: 'p1', name: 'Acme <Corp>', created_by: 'u1' },
        { id: 'p-nouser', name: 'NoUser', created_by: null },
        { id: 'p-nolink', name: 'NoLink', created_by: 'u2' },
      ],
      telegram_links: [{ user_id: 'u1', telegram_id: '123456' }],
      he_verticals: [
        { id: 'v1', project_id: 'p1' },
        { id: 'v2', project_id: 'p1' },
        { id: 'v3', project_id: 'p1' },
        { id: 'vX', project_id: 'other' },
      ],
      he_hypotheses: Array.from({ length: 11 }, (_, i) => ({ id: `h${i}`, project_id: 'p1' })),
      ...seedTables,
    },
  }) as unknown as SupabaseClient;
}

const collectLog = () => {
  const lines: string[] = [];
  const log = (level: string, msg: string) => lines.push(`${level}: ${msg}`);
  return { lines, log };
};

describe('pluralRu', () => {
  it('one/few/many по правилам русского языка', () => {
    const f = (n: number) => pluralRu(n, 'вертикаль', 'вертикали', 'вертикалей');
    expect(f(1)).toBe('вертикаль');
    expect(f(2)).toBe('вертикали');
    expect(f(4)).toBe('вертикали');
    expect(f(5)).toBe('вертикалей');
    expect(f(11)).toBe('вертикалей'); // исключение 11–14
    expect(f(14)).toBe('вертикалей');
    expect(f(21)).toBe('вертикаль');
    expect(f(22)).toBe('вертикали');
    expect(f(25)).toBe('вертикалей');
    expect(f(101)).toBe('вертикаль');
  });
});

describe('buildHeToolUrl', () => {
  it('абсолютный URL из PORTAL_PUBLIC_URL, trailing slash срезается', () => {
    process.env.PORTAL_PUBLIC_URL = 'https://portal.example.com/';
    expect(buildHeToolUrl()).toBe('https://portal.example.com/tools/hypothesis-engine');
  });

  it('фолбэк на NEXT_PUBLIC_SITE_URL', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://portal.example.com';
    expect(buildHeToolUrl()).toBe('https://portal.example.com/tools/hypothesis-engine');
  });

  it('без base env — относительный путь', () => {
    expect(buildHeToolUrl()).toBe('/tools/hypothesis-engine');
  });
});

describe('buildResearchDoneMessage / buildResearchFailedMessage', () => {
  it('done: плюрализация и экранирование имени', () => {
    const text = buildResearchDoneMessage({
      projectName: 'Acme <Corp>',
      verticalsCount: 3,
      hypothesesCount: 11,
      url: 'https://portal.example.com/tools/hypothesis-engine',
    });
    expect(text).toBe(
      '✅ Исследование готово: Acme &lt;Corp&gt; — 3 вертикали из 11 гипотез.\n' +
      'Смотреть: https://portal.example.com/tools/hypothesis-engine',
    );
  });

  it('failed: стадия + ошибка, длинная ошибка обрезается', () => {
    const longError = `boom ${'x'.repeat(500)}`;
    const text = buildResearchFailedMessage({
      projectName: 'Acme',
      stage: 'evidence',
      error: longError,
      url: '/tools/hypothesis-engine',
    });
    expect(text).toContain('❌ Исследование не удалось: Acme — стадия evidence: boom ');
    expect(text).toContain('Подробнее: /tools/hypothesis-engine');
    expect(text.length).toBeLessThan(longError.length);
    expect(text).toContain('…');
  });
});

describe('resolveTelegramChatId', () => {
  it('telegram_id строкой → число', async () => {
    await expect(resolveTelegramChatId(makeDb(), 'u1')).resolves.toBe(123456);
  });

  it('нет привязки → null', async () => {
    await expect(resolveTelegramChatId(makeDb(), 'u2')).resolves.toBeNull();
  });

  it('битый telegram_id → null', async () => {
    const db = makeDb({ telegram_links: [{ user_id: 'u3', telegram_id: 'not-a-number' }] });
    await expect(resolveTelegramChatId(db, 'u3')).resolves.toBeNull();
  });
});

describe('notifyHeResearchDone', () => {
  it('шлёт «готово» владельцу проекта с подсчётом вертикалей/гипотез', async () => {
    process.env.PORTAL_PUBLIC_URL = 'https://portal.example.com';
    const { lines, log } = collectLog();
    await notifyHeResearchDone(makeDb(), 'p1', log);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessageMock.mock.calls[0];
    expect(chatId).toBe(123456);
    expect(text).toContain('✅ Исследование готово: Acme &lt;Corp&gt; — 3 вертикали из 11 гипотез.');
    expect(text).toContain('Смотреть: https://portal.example.com/tools/hypothesis-engine');
    expect(lines.some((l) => l.startsWith('info: he-notify: sent'))).toBe(true);
  });

  it('без TG_AGENT_BOT_TOKEN — skip с warn, sendMessage не вызывается', async () => {
    delete process.env.TG_AGENT_BOT_TOKEN;
    const { lines, log } = collectLog();
    await notifyHeResearchDone(makeDb(), 'p1', log);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('TG_AGENT_BOT_TOKEN'))).toBe(true);
  });

  it('created_by пуст — skip, sendMessage не вызывается', async () => {
    await notifyHeResearchDone(makeDb(), 'p-nouser', collectLog().log);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('у владельца нет привязки Telegram — skip, sendMessage не вызывается', async () => {
    const { lines, log } = collectLog();
    await notifyHeResearchDone(makeDb(), 'p-nolink', log);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('нет привязанного Telegram'))).toBe(true);
  });

  it('проект не найден — skip, не бросает', async () => {
    await expect(notifyHeResearchDone(makeDb(), 'missing', collectLog().log)).resolves.toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('sendMessage упал — не бросает, пишет error в log', async () => {
    sendMessageMock.mockRejectedValue(new Error('tg api 500'));
    const { lines, log } = collectLog();
    await expect(notifyHeResearchDone(makeDb(), 'p1', log)).resolves.toBeUndefined();
    expect(lines.some((l) => l.startsWith('error: he-notify') && l.includes('tg api 500'))).toBe(true);
  });
});

describe('notifyHeResearchFailed', () => {
  it('шлёт «не удалось» со стадией и ошибкой', async () => {
    await notifyHeResearchFailed(makeDb(), 'p1', 'evidence', 'serper quota exceeded', collectLog().log);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessageMock.mock.calls[0];
    expect(chatId).toBe(123456);
    expect(text).toContain('❌ Исследование не удалось: Acme &lt;Corp&gt; — стадия evidence: serper quota exceeded');
    expect(text).toContain('Подробнее: /tools/hypothesis-engine'); // без base env — относительный путь
  });

  it('sendMessage упал — не бросает', async () => {
    sendMessageMock.mockRejectedValue(new Error('network down'));
    await expect(
      notifyHeResearchFailed(makeDb(), 'p1', 'clustering', 'llm timeout', collectLog().log),
    ).resolves.toBeUndefined();
  });
});
