/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { pickLatestNews } from '@/lib/enrich/extractors/socialLatestNewsDetector';
import type { SocialPost } from '@/lib/enrich/extractors/socialPostsExtractor';

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function setApiKey(key: string | null) {
  if (key === null) {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
  } else {
    process.env.OPENROUTER_SIGNALS_API_KEY = key;
  }
}

function mockLlmResponse(body: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }),
  })) as unknown as typeof fetch;
}

function mockLlmError(status = 500) {
  global.fetch = jest.fn(async () => ({
    ok: false,
    status,
    text: async () => 'err body',
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

const SAMPLE_POSTS: SocialPost[] = [
  {
    network: 'telegram',
    url: 'https://t.me/s/brand',
    text: 'Открываем новый филиал на Тверской 5 августа! Готовим запуск.',
    date: '2026-05-12',
  },
  {
    network: 'vk',
    url: 'https://m.vk.com/brand',
    text: 'С праздником, друзья! Желаем всего самого лучшего.',
    date: '2026-05-09',
  },
];

describe('pickLatestNews — guards', () => {
  it('returns {} when no posts are provided', async () => {
    setApiKey('test-key');
    // logInfo шлёт в Supabase application_logs — без мока fetch пойдёт в реальную сеть.
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await pickLatestNews({ socialPosts: [] });
    expect(result).toEqual({});
    // Проверим что LLM endpoint не дёрнулся
    const llmCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('router.requesty.ai'),
    );
    expect(llmCalls).toHaveLength(0);
  });

  it('returns {} when no API key is configured', async () => {
    setApiKey(null);
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} on LLM HTTP error', async () => {
    setApiKey('test-key');
    mockLlmError(503);
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} on malformed JSON response', async () => {
    setApiKey('test-key');
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'not-json-at-all' } }],
      }),
    })) as unknown as typeof fetch;
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} when LLM picks index = -1 (no post is good enough)', async () => {
    setApiKey('test-key');
    mockLlmResponse({ index: -1, reason: 'all posts are promotional fluff' });
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} when LLM picks an out-of-range index', async () => {
    setApiKey('test-key');
    mockLlmResponse({ index: 99 });
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });
});

describe('pickLatestNews — formatting', () => {
  beforeEach(() => {
    setApiKey('test-key');
  });

  it('formats the picked post as "date [url] — text"', async () => {
    mockLlmResponse({ index: 0, reason: 'opening a new office' });
    const result = await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(result.social_latest_news).toBe(
      '2026-05-12 [https://t.me/s/brand] — Открываем новый филиал на Тверской 5 августа! Готовим запуск.',
    );
  });

  it('falls back to em-dash when post has no date', async () => {
    mockLlmResponse({ index: 0 });
    const result = await pickLatestNews({
      socialPosts: [{ network: 'telegram', url: 'https://t.me/s/x', text: 'some news' }],
    });
    expect(result.social_latest_news).toBe('— [https://t.me/s/x] — some news');
  });

  it('truncates text >300 chars with an ellipsis', async () => {
    mockLlmResponse({ index: 0 });
    const longText = 'X'.repeat(500);
    const result = await pickLatestNews({
      socialPosts: [{ network: 'telegram', url: 'https://t.me/s/x', text: longText, date: '2026-06-01' }],
    });
    const expectedText = `${'X'.repeat(300)}…`;
    expect(result.social_latest_news).toBe(`2026-06-01 [https://t.me/s/x] — ${expectedText}`);
  });

  it('sends posts as enumerated list to the LLM', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ index: 0 }) } }],
      }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await pickLatestNews({ socialPosts: SAMPLE_POSTS });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('[ПОСТЫ]');
    expect(userMsg).toContain('0. [telegram | 2026-05-12]');
    expect(userMsg).toContain('1. [vk | 2026-05-09]');
  });
});
