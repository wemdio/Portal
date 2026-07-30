/** @jest-environment node */

/**
 * Tests for PATCH /api/tools/hypothesis-engine/chains/[id].
 *
 * Два контракта:
 *
 *   { letter_index, variant_index } — swap A/B-варианта:
 *   200 -> { letters }: выбранный A/B-вариант становится основным — subject/body
 *          письма меняются местами с variants[variant_index], прежний основной
 *          уходит в variants на его место. Остальные письма и поля
 *          (wait_days, segment_variants) не трогаются.
 *   400 -> { error } для битых / выходящих за диапазон letter_index, variant_index.
 *   404 -> { error } для неизвестной цепочки.
 *
 *   { letters: [...] } — полная замена массива писем (инлайн-редактор шага 3):
 *   200 -> { letters }: нормализованный массив (1..6 писем, непустое body ≤50000,
 *          subject null|≤500, wait_days клампится в 0..90, у первого письма — 0,
 *          неизвестные поля отброшены). Варианты/сегменты валидируются и проходят.
 *   400 -> { error } для невалидных писем; 404 -> { error } для чужой цепочки.
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

describe('PATCH chains — замена писем (letters): happy path', () => {
  it('полная замена: правка subject/body/wait_days + добавление письма', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          // Правим первое письмо; его варианты и сегменты проходят как были.
          {
            subject: 'Тема A1 — правка',
            body: 'Тело A1 — правка',
            wait_days: 0,
            variants: [{ subject: 'Тема B1', body: 'Тело B1' }],
            segment_variants: [{ when: 'сегмент X', text: 'дописка для сегмента' }],
          },
          // Правим второе письмо: новая пауза.
          { subject: 'Тема A2 — правка', body: 'Тело A2', wait_days: 5 },
          // Добавляем третье письмо.
          { subject: null, body: 'Третье письмо', wait_days: 2 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: TestLetter[] };
    expect(body.letters).toEqual([
      {
        subject: 'Тема A1 — правка',
        body: 'Тело A1 — правка',
        wait_days: 0,
        variants: [{ subject: 'Тема B1', body: 'Тело B1' }],
        segment_variants: [{ when: 'сегмент X', text: 'дописка для сегмента' }],
      },
      { subject: 'Тема A2 — правка', body: 'Тело A2', wait_days: 5 },
      { subject: null, body: 'Третье письмо', wait_days: 2 },
    ]);

    // Сохранено в he_chains одним update тем же нормализованным массивом.
    expect(mockDb.updates).toHaveLength(1);
    expect(mockDb.updates[0].table).toBe('he_chains');
    expect(mockDb.updates[0].filters).toEqual([{ column: 'id', op: 'eq', value: 'c1' }]);
    expect(storedLetters()).toEqual(body.letters);
  });

  it('удаление письма: массив из одного письма заменяет два', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: 'Тема A1', body: 'Тело A1', wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: TestLetter[] };
    expect(body.letters).toEqual([{ subject: 'Тема A1', body: 'Тело A1', wait_days: 0 }]);
    expect(storedLetters()).toHaveLength(1);
  });

  it('неизвестные поля письма отбрасываются, а не отклоняются', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          {
            subject: 'S1',
            body: 'B1',
            wait_days: 0,
            id: 'hack',
            is_user_added: true,
            extra: { x: 1 },
          },
          { subject: null, body: 'B2', wait_days: 3, letter_index: 2, updated_at: 'x' },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: Array<Record<string, unknown>> };
    expect(body.letters[0]).toEqual({ subject: 'S1', body: 'B1', wait_days: 0 });
    expect(body.letters[1]).toEqual({ subject: null, body: 'B2', wait_days: 3 });
    expect(storedLetters()[0]).not.toHaveProperty('id');
  });

  it('первое письмо всегда уходит с wait_days=0', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          { subject: null, body: 'Первое', wait_days: 7 },
          { subject: null, body: 'Второе', wait_days: 3 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: TestLetter[] };
    expect(body.letters[0].wait_days).toBe(0);
    expect(body.letters[1].wait_days).toBe(3);
    expect(storedLetters()[0].wait_days).toBe(0);
  });

  it('wait_days клампится в 0..90 и приводится к целому', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          { subject: null, body: 'Первое', wait_days: 0 },
          { subject: null, body: 'Слишком долго', wait_days: 120 },
          { subject: null, body: 'Отрицательная', wait_days: -5 },
          { subject: null, body: 'Дробная', wait_days: 2.7 },
        ],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { letters: TestLetter[] };
    expect(body.letters.map((l) => l.wait_days)).toEqual([0, 90, 0, 2]);
  });

  it('404 для неизвестной цепочки', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: null, body: 'B', wait_days: 0 }] }, 'nope'),
      paramsFor('nope'),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH chains — замена писем (letters): валидация', () => {
  it('400 на пустое тело письма', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: null, body: '', wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 на тело из одних пробелов', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: null, body: '   \n  ', wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 на тело длиннее 50000 символов', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: null, body: 'x'.repeat(50_001), wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 когда писем больше 6', async () => {
    const letters = Array.from({ length: 7 }, (_, i) => ({
      subject: null,
      body: `Письмо ${i + 1}`,
      wait_days: i,
    }));
    const res = await PATCH(makeReq({ letters }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()).toHaveLength(2);
  });

  it('400 на пустой массив писем', async () => {
    const res = await PATCH(makeReq({ letters: [] }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()).toHaveLength(2);
  });

  it('400 на тему длиннее 500 символов', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: 's'.repeat(501), body: 'B', wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 на тему не-строку и не-null', async () => {
    const res = await PATCH(
      makeReq({ letters: [{ subject: 5, body: 'B', wait_days: 0 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 на битый A/B-вариант (пустое тело варианта)', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          { subject: null, body: 'B', wait_days: 0, variants: [{ subject: null, body: '' }] },
        ],
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('400 на битый сегментный вариант (без when)', async () => {
    const res = await PATCH(
      makeReq({
        letters: [
          { subject: null, body: 'B', wait_days: 0, segment_variants: [{ text: 'x' }] },
        ],
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });

  it('letters не массив → 400 по swap-валидации (нет letter_index)', async () => {
    const res = await PATCH(makeReq({ letters: 'nope' }), params);
    expect(res.status).toBe(400);
    expect(storedLetters()[0].subject).toBe('Тема A1');
  });
});
