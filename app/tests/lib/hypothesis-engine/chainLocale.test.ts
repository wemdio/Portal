/** @jest-environment node */

/**
 * Locale-keyed chain: CHAIN_REGULATIONS, системный блок генерации, критик и
 * рерайт выбираются по языку цепочки (he_chains.language). RU — исходные
 * русские тексты (поведение не меняется), EN — перевод по смыслу, PL —
 * перевода системных блоков пока нет, используется RU-вариант.
 *
 * Плюс контракт POST /api/tools/hypothesis-engine/verticals/[id]/chain:
 * дефолт language — по market проекта (us → en, ru/отсутствует → ru),
 * явный language в body в приоритете.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

import {
  CHAIN_REGULATIONS,
  buildChainCriticMessages,
  buildChainMessages,
  buildChainRewriteMessages,
  type ChainPromptInput,
} from '@/lib/hypothesisEngine/prompts/chain';

const baseChainInput: Omit<ChainPromptInput, 'language'> = {
  verticalName: 'HR-агентства',
  verticalSummary: 'сводка',
  synonyms: ['рекрутинг'],
  hypotheses: [],
  briefText: '{}',
};

const twoLetters = [
  { subject: 'Тема 1', body: 'Тело 1' },
  { subject: 'Тема 2', body: 'Тело 2' },
];

describe('CHAIN_REGULATIONS — locale-keyed словарь', () => {
  it('ru — исходный русский регламент', () => {
    expect(CHAIN_REGULATIONS.ru).toContain('# Регламент аутрич-писем');
  });

  it('en — английский перевод регламента по смыслу', () => {
    expect(CHAIN_REGULATIONS.en).toContain('# Outreach email regulations');
    expect(CHAIN_REGULATIONS.en).not.toContain('# Регламент аутрич-писем');
  });

  it('pl — перевода пока нет, осознанно используется RU-вариант', () => {
    expect(CHAIN_REGULATIONS.pl).toBe(CHAIN_REGULATIONS.ru);
  });
});

describe('buildChainMessages — системный блок по языку цепочки', () => {
  it('ru: системный промпт на русском (поведение не изменилось)', () => {
    const [system] = buildChainMessages({ ...baseChainInput, language: 'ru' });
    expect(system.content).toContain('Ты пишешь холодные B2B-цепочки для агентства Polza');
    expect(system.content).toContain('# Регламент аутрич-писем');
  });

  it('en: системный промпт и регламент на английском', () => {
    const [system, , , task] = buildChainMessages({ ...baseChainInput, language: 'en' });
    expect(system.content).toContain('You write cold B2B sequences for the Polza agency');
    expect(system.content).toContain('# Outreach email regulations');
    expect(system.content).not.toContain('# Регламент аутрич-писем');
    // Пин: локализованная задача (TASK_PROMPTS.en) не сломана.
    expect(task.content).toContain('Write a sequence of 4 emails');
  });

  it('pl: перевода системного блока нет — RU-вариант', () => {
    const [plSystem] = buildChainMessages({ ...baseChainInput, language: 'pl' });
    const [ruSystem] = buildChainMessages({ ...baseChainInput, language: 'ru' });
    expect(plSystem.content).toBe(ruSystem.content);
  });
});

describe('buildChainCriticMessages — критик по языку цепочки', () => {
  it('ru: русский критик (поведение не изменилось)', () => {
    const [system, user] = buildChainCriticMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      language: 'ru',
    });
    expect(system.content).toContain('скептичный занятой ЛПР');
    expect(system.content).toContain('# Регламент аутрич-писем');
    expect(user.content).toContain('ВЕРТИКАЛЬ:');
    expect(user.content).toContain('«можно отправлять»');
    expect(user.content).toContain('по-русски');
  });

  it('en: критик и регламент на английском, вердикт и problem/fix — по-английски', () => {
    const [system, user] = buildChainCriticMessages({
      verticalName: 'HR agencies',
      letters: twoLetters,
      language: 'en',
    });
    expect(system.content).toContain('skeptical busy decision-maker');
    expect(system.content).toContain('# Outreach email regulations');
    expect(system.content).not.toContain('# Регламент аутрич-писем');
    expect(user.content).toContain('VERTICAL:');
    expect(user.content).toContain('language: English');
    expect(user.content).toContain('"ready to send"');
    expect(user.content).toContain('in English');
    expect(user.content).not.toContain('по-русски');
  });

  it('pl: перевода критика нет — RU-вариант', () => {
    const [plSystem] = buildChainCriticMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      language: 'pl',
    });
    const [ruSystem] = buildChainCriticMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      language: 'ru',
    });
    expect(plSystem.content).toBe(ruSystem.content);
  });
});

describe('buildChainRewriteMessages — рерайт по языку цепочки', () => {
  const critique = {
    verdict: 'нужна перепись',
    issues: [{ letter_index: 1, problem: 'проблема', fix: 'фикс' }],
  };

  it('ru: русский рерайт (поведение не изменилось)', () => {
    const [system, materials, , task] = buildChainRewriteMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      critique,
      language: 'ru',
    });
    expect(system.content).toContain('senior email outreach редактор агентства Polza');
    expect(system.content).toContain('# Регламент аутрич-писем');
    expect(materials.content).toContain('ИСХОДНАЯ ЦЕПОЧКА');
    expect(task.content).toContain('Перепиши цепочку по критике выше');
  });

  it('en: система и материалы рерайта на английском', () => {
    const [system, materials, , task] = buildChainRewriteMessages({
      verticalName: 'HR agencies',
      letters: twoLetters,
      critique,
      language: 'en',
    });
    expect(system.content).toContain('senior email outreach editor at the Polza agency');
    expect(system.content).toContain('# Outreach email regulations');
    expect(system.content).not.toContain('# Регламент аутрич-писем');
    expect(materials.content).toContain('SOURCE SEQUENCE');
    expect(materials.content).toContain('language: English');
    expect(task.content).toContain('Rewrite the sequence per the critique above');
  });

  it('pl: перевода системы рерайта нет — RU-вариант', () => {
    const [plSystem] = buildChainRewriteMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      critique,
      language: 'pl',
    });
    const [ruSystem] = buildChainRewriteMessages({
      verticalName: 'HR-агентства',
      letters: twoLetters,
      critique,
      language: 'ru',
    });
    expect(plSystem.content).toBe(ruSystem.content);
  });
});

/* ─────────── POST verticals/[id]/chain: дефолт языка по market ─────────── */

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/tools/hypothesis-engine/verticals/[id]/chain/route';

const params = { params: Promise.resolve({ id: 'v1' }) };

function makeReq(body?: unknown): NextRequest {
  return new Request('http://x/api/tools/hypothesis-engine/verticals/v1/chain', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function seed(project: Record<string, unknown> | null) {
  mockDb = createMockSupabase({
    tables: {
      he_verticals: [{ id: 'v1', project_id: 'p1' }],
      he_projects: project ? [{ id: 'p1', ...project }] : [],
      he_jobs: [],
    },
  });
}

async function enqueuedLanguage(res: Response): Promise<string> {
  const body = (await res.json()) as { job: { payload: { language: string } } };
  return body.job.payload.language;
}

describe('POST verticals/[id]/chain — дефолт language по market проекта', () => {
  it('без body.language: market=us → language=en', async () => {
    seed({ market: 'us' });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);
    expect(await enqueuedLanguage(res)).toBe('en');
  });

  it('без body.language: market=ru → language=ru', async () => {
    seed({ market: 'ru' });
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);
    expect(await enqueuedLanguage(res)).toBe('ru');
  });

  it('без body.language: проект без market (legacy) → language=ru', async () => {
    seed({});
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(201);
    expect(await enqueuedLanguage(res)).toBe('ru');
  });

  it('явный body.language в приоритете над market (us + pl → pl)', async () => {
    seed({ market: 'us' });
    const res = await POST(makeReq({ language: 'pl' }), params);
    expect(res.status).toBe(201);
    expect(await enqueuedLanguage(res)).toBe('pl');
  });

  it('невалидный body.language → 400 (поведение не изменилось)', async () => {
    seed({ market: 'us' });
    const res = await POST(makeReq({ language: 'de' }), params);
    expect(res.status).toBe(400);
    expect(mockDb.inserts).toHaveLength(0);
  });
});
