/** @jest-environment node */

/**
 * Tests for PATCH /api/tools/hypothesis-engine/chains/[id].
 *
 *   200 -> { letters }: выбранный A/B-вариант становится основным — subject/body
 *          письма меняются местами с variants[variant_index], прежний основной
 *          уходит в variants на его место. Остальные письма и поля
 *          (wait_days, segment_variants) не трогаются.
 *   400 -> { error } для битых / выходящих за диапазон letter_index, variant_index.
 *   404 -> { error } для неизвестной цепочки.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

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

import { PATCH } from '@/app/api/tools/hypothesis-engine/chains/[id]/route';

interface TestLetter {
  subject: string | null;
  body: string;
  wait_days: number;
  variants?: Array<{ subject: string | null; body: string }>;
  segment_variants?: Array<{ when: string; text: string }>;
}

function makeChain(): { id: string; vertical_id: string; language: string; letters: TestLetter[] } {
  return {
    id: 'c1',
    vertical_id: 'v1',
    language: 'ru',
    letters: [
      {
        subject: 'Тема A1',
        body: 'Тело A1',
        wait_days: 0,
        variants: [{ subject: 'Тема B1', body: 'Тело B1' }],
        segment_variants: [{ when: 'сегмент X', text: 'дописка для сегмента' }],
      },
      { subject: 'Тема A2', body: 'Тело A2', wait_days: 3 },
    ],
  };
}

function makeReq(body: unknown, id = 'c1'): NextRequest {
  return new Request(`http://x/api/tools/hypothesis-engine/chains/${id}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'c1' }) };
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

function storedLetters(): TestLetter[] {
  return mockDb.getRows('he_chains')[0].letters as TestLetter[];
}

beforeEach(() => {
  mockDb = createMockSupabase({ tables: { he_chains: [makeChain()] } });
});

describe('PATCH chains — валидация тела', () => {
  it('returns 400 when letter_index is missing', async () => {
    const res = await PATCH(makeReq({ variant_index: 0 }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 when variant_index is missing', async () => {
    const res = await PATCH(makeReq({ letter_index: 0 }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-integer letter_index', async () => {
    const res = await PATCH(makeReq({ letter_index: 0.5, variant_index: 0 }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a negative variant_index', async () => {
    const res = await PATCH(makeReq({ letter_index: 0, variant_index: -1 }), params);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-number letter_index', async () => {
    const res = await PATCH(makeReq({ letter_index: '0', variant_index: 0 }), params);
    expect(res.status).toBe(400);
  });
});

describe('PATCH chains — индексы вне диапазона', () => {
  it('returns 400 when letter_index is beyond the letters array', async () => {
    const res = await PATCH(makeReq({ letter_index: 5, variant_index: 0 }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('returns 400 when variant_index is beyond the variants array', async () => {
    const res = await PATCH(makeReq({ letter_index: 0, variant_index: 3 }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('returns 400 when the letter has no variants at all', async () => {
    const res = await PATCH(makeReq({ letter_index: 1, variant_index: 0 }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()[1].subject).toBe('Тема A2');
  });
});

describe('PATCH chains — цепочка не найдена', () => {
  it('returns 404 for an unknown chain id', async () => {
    const res = await PATCH(
      makeReq({ letter_index: 0, variant_index: 0 }, 'nope'),
      paramsFor('nope'),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH chains — happy path', () => {
  it('swaps primary subject/body with the chosen variant and returns { letters }', async () => {
    const res = await PATCH(makeReq({ letter_index: 0, variant_index: 0 }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: TestLetter[] };
    const swapped = body.letters[0];
    // Вариант B стал основным.
    expect(swapped.subject).toBe('Тема B1');
    expect(swapped.body).toBe('Тело B1');
    // Прежний основной ушёл в variants на место выбранного.
    expect(swapped.variants).toEqual([{ subject: 'Тема A1', body: 'Тело A1' }]);
    // Прочие поля письма не тронуты.
    expect(swapped.wait_days).toBe(0);
    expect(swapped.segment_variants).toEqual([{ when: 'сегмент X', text: 'дописка для сегмента' }]);
    // Другое письмо цепочки не изменилось.
    expect(body.letters[1]).toEqual({ subject: 'Тема A2', body: 'Тело A2', wait_days: 3 });
  });

  it('persists the swapped letters to he_chains via a single update', async () => {
    const res = await PATCH(makeReq({ letter_index: 0, variant_index: 0 }), params);
    expect(res.status).toBe(200);

    expect(mockDb.updates).toHaveLength(1);
    expect(mockDb.updates[0].table).toBe('he_chains');
    expect(mockDb.updates[0].filters).toEqual([{ column: 'id', op: 'eq', value: 'c1' }]);

    const stored = storedLetters();
    expect(stored[0].subject).toBe('Тема B1');
    expect(stored[0].body).toBe('Тело B1');
    expect(stored[0].variants).toEqual([{ subject: 'Тема A1', body: 'Тело A1' }]);
    expect(stored[0].segment_variants).toEqual([
      { when: 'сегмент X', text: 'дописка для сегмента' },
    ]);
    expect(stored[1]).toEqual({ subject: 'Тема A2', body: 'Тело A2', wait_days: 3 });
  });

  it('swaps back and forth: второй обмен возвращает исходный основной', async () => {
    const first = await PATCH(makeReq({ letter_index: 0, variant_index: 0 }), params);
    expect(first.status).toBe(200);
    const second = await PATCH(makeReq({ letter_index: 0, variant_index: 0 }), params);
    expect(second.status).toBe(200);

    const body = (await second.json()) as { letters: TestLetter[] };
    expect(body.letters[0].subject).toBe('Тема A1');
    expect(body.letters[0].body).toBe('Тело A1');
    expect(body.letters[0].variants).toEqual([{ subject: 'Тема B1', body: 'Тело B1' }]);
  });
});
