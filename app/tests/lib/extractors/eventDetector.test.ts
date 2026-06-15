/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { detectEventSignals } from '@/lib/enrich/extractors/eventDetector';
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
    text: 'В Казани уже открылись, в Питере следующий запуск в июне.',
    date: '2026-04-30',
  },
];

describe('detectEventSignals — guards', () => {
  it('returns {} when no API key is configured', async () => {
    setApiKey(null);
    // logInfo шлёт в Supabase application_logs — без мока fetch пойдёт
    // в реальную сеть и тест отвалится по таймауту.
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} when there is too little content to analyze', async () => {
    setApiKey('test-key');
    mockLlmResponse({ event_opening: true });
    const result = await detectEventSignals({ socialPosts: [], blogText: 'hi', aboutText: '' });
    expect(result).toEqual({});
    // LLM (router.requesty.ai) should never be called for tiny content.
    // logInfo internally posts to Supabase application_logs — отфильтровываем
    // те вызовы и проверяем ИМЕННО LLM-endpoint.
    const llmCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('router.requesty.ai'),
    );
    expect(llmCalls).toHaveLength(0);
  });

  it('returns {} on LLM HTTP error (best-effort, never throws)', async () => {
    setApiKey('test-key');
    mockLlmError(503);
    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });

  it('returns {} when LLM responds with malformed JSON', async () => {
    setApiKey('test-key');
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'not-json' } }],
      }),
    })) as unknown as typeof fetch;
    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result).toEqual({});
  });
});

describe('detectEventSignals — parsing', () => {
  beforeEach(() => {
    setApiKey('test-key');
  });

  it('parses all 4 signals with their summaries', async () => {
    mockLlmResponse({
      event_opening: true,
      event_opening_summary: 'Открытие на Тверской 5 августа 2026.',
      event_redesign: false,
      event_redesign_summary: '',
      event_renovation: true,
      event_renovation_summary: 'Закрытие на ремонт основного зала с 1 по 30 июня.',
      event_geo: ['Москва', 'Казань', 'Санкт-Петербург'],
      event_geo_summary: 'Штаб в Москве, точки в Казани и Питере.',
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });

    expect(result.event_opening).toBe(true);
    expect(result.event_opening_summary).toContain('Тверской');
    expect(result.event_redesign).toBe(false);
    // false signal → no summary written, keeps the xlsx tidy
    expect(result.event_redesign_summary).toBeUndefined();
    expect(result.event_renovation).toBe(true);
    expect(result.event_renovation_summary).toContain('ремонт');
    expect(result.event_geo).toEqual(['Москва', 'Казань', 'Санкт-Петербург']);
    expect(result.event_geo_summary).toContain('Москве');
  });

  it('drops summary when signal is true but summary is too short / empty', async () => {
    mockLlmResponse({
      event_opening: true,
      event_opening_summary: '',
      event_redesign: true,
      event_redesign_summary: 'aa',
      event_renovation: false,
      event_geo: [],
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });

    expect(result.event_opening).toBe(true);
    expect(result.event_opening_summary).toBeUndefined();
    expect(result.event_redesign).toBe(true);
    expect(result.event_redesign_summary).toBeUndefined();
  });

  it('truncates very long summaries to a hard max', async () => {
    mockLlmResponse({
      event_opening: true,
      event_opening_summary: 'X'.repeat(2000),
      event_redesign: false,
      event_renovation: false,
      event_geo: [],
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect((result.event_opening_summary ?? '').length).toBeLessThanOrEqual(400);
  });

  it('de-duplicates cities case-insensitively, preserves first casing', async () => {
    mockLlmResponse({
      event_opening: false,
      event_redesign: false,
      event_renovation: false,
      event_geo: ['Москва', 'москва', 'МОСКВА', 'Казань', 'Казань'],
      event_geo_summary: '',
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result.event_geo).toEqual(['Москва', 'Казань']);
  });

  it('drops geo entirely (undefined) when LLM returns []', async () => {
    mockLlmResponse({
      event_opening: false,
      event_redesign: false,
      event_renovation: false,
      event_geo: [],
      event_geo_summary: 'no cities',
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result.event_geo).toBeUndefined();
    // No cities → no geo_summary either (would be misleading).
    expect(result.event_geo_summary).toBeUndefined();
  });

  it('ignores non-boolean signal values from a misbehaving LLM', async () => {
    mockLlmResponse({
      event_opening: 'yes',
      event_redesign: 1,
      event_renovation: null,
      event_geo: ['Москва'],
    });

    const result = await detectEventSignals({ socialPosts: SAMPLE_POSTS });
    expect(result.event_opening).toBeUndefined();
    expect(result.event_redesign).toBeUndefined();
    expect(result.event_renovation).toBeUndefined();
    expect(result.event_geo).toEqual(['Москва']);
  });

  it('sends posts + blog + about as separate sections in the prompt', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ event_opening: false, event_redesign: false, event_renovation: false, event_geo: [] }) } }],
      }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await detectEventSignals({
      socialPosts: SAMPLE_POSTS,
      blogText: 'Сегодня мы запустили новое меню сезонных коктейлей.',
      aboutText: 'Сеть из 5 ресторанов авторской кухни. Основана в 2018 году.',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('[ПОСТЫ ИЗ СОЦСЕТЕЙ]');
    expect(userMsg).toContain('[telegram');
    expect(userMsg).toContain('[ПОСЛЕДНИЙ ПОСТ БЛОГА]');
    expect(userMsg).toContain('новое меню');
    expect(userMsg).toContain('[О КОМПАНИИ]');
    expect(userMsg).toContain('Основана в 2018');
  });

  it('uses a niche-agnostic system prompt (no HoReCa lock-in)', async () => {
    setApiKey('test-key');
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ event_opening: false, event_redesign: false, event_renovation: false, event_geo: [] }) } }],
      }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await detectEventSignals({ socialPosts: SAMPLE_POSTS });

    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const sys = body.messages.find((m) => m.role === 'system')!.content.toLowerCase();
    expect(sys).toContain('любой ниши');
    expect(sys).not.toContain('horeca');
  });

  it('detects a non-HoReCa opening (new office)', async () => {
    setApiKey('test-key');
    mockLlmResponse({
      event_opening: true,
      event_opening_summary: 'Открыли новый офис разработки в Новосибирске.',
      event_redesign: false,
      event_renovation: false,
      event_geo: ['Новосибирск'],
    });
    const result = await detectEventSignals({
      socialPosts: [{ network: 'telegram', url: 'https://t.me/s/itco', text: 'Открыли новый офис разработки в Новосибирске! Теперь наша команда из 30 разработчиков работает в новом пространстве на Красном проспекте.', date: '2026-06-01' }],
    });
    expect(result.event_opening).toBe(true);
    expect(result.event_geo).toEqual(['Новосибирск']);
  });
});
