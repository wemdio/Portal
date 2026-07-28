/** @jest-environment node */

/**
 * Tests for lib/hypothesisEngine/caseBank:
 *  - scoreCaseForVertical — взвешенный токен-оверлап вертикали (name+synonyms)
 *    по полям кейса: industry 3 / client_type 2 / task 1, стоп-слова (вкл.
 *    доменно-общие «продажи», «услуги», «доставка»…) не считаются;
 *  - selectCaseForVertical — выбор лучшего кейса проекта: порог MIN_CASE_SCORE,
 *    tie-break upload > site, затем earliest created_at; ничего релевантного → null;
 *  - normalizeCaseText — lowercase + схлопывание пробелов (дедуп-ключ);
 *  - renderClientCaseBlock — блок «КЕЙС КЛИЕНТА» для промптов.
 */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MIN_CASE_SCORE,
  normalizeCaseText,
  renderClientCaseBlock,
  scoreCaseForVertical,
  selectCaseForVertical,
} from '@/lib/hypothesisEngine/caseBank';

const VERTICAL = { name: 'HR-агентства', synonyms: ['массовый подбор', 'рекрутинг'] };
// Токены вертикали: { hr, агентства, массовый, подбор, рекрутинг }.

describe('scoreCaseForVertical — взвешенный токен-оверлап', () => {
  it('попадание в industry даёт вес 3', () => {
    const score = scoreCaseForVertical(
      { industry: 'HR-tech платформа', client_type: '', task: '' },
      VERTICAL,
    );
    // общий токен — «hr» («tech»/«платформа» в вертикали не встречаются)
    expect(score).toBe(3);
  });

  it('попадания в task дают вес 1 каждое', () => {
    const score = scoreCaseForVertical(
      { industry: 'Логистика', client_type: '', task: 'массовый подбор курьеров на склад' },
      VERTICAL,
    );
    // «массовый» + «подбор» из синонима — оба в task
    expect(score).toBe(2);
  });

  it('веса полей: industry 3 / client_type 2 / task 1; один токен в нескольких полях суммируется', () => {
    expect(scoreCaseForVertical({ industry: 'hr' }, { name: 'hr' })).toBe(3);
    expect(scoreCaseForVertical({ client_type: 'hr' }, { name: 'hr' })).toBe(2);
    expect(scoreCaseForVertical({ task: 'hr' }, { name: 'hr' })).toBe(1);
    expect(scoreCaseForVertical({ industry: 'hr', client_type: 'hr', task: 'hr' }, { name: 'hr' })).toBe(6);
  });

  it('уникальные токены: повтор токена в одном поле не накручивает скор', () => {
    const score = scoreCaseForVertical({ task: 'рекрутинг рекрутинг рекрутинг' }, { name: 'рекрутинг' });
    expect(score).toBe(1);
  });

  it('стоп-слова и короткие токены не считаются; «it» (2 символа) считается', () => {
    expect(scoreCaseForVertical({ industry: 'И только' }, { name: 'И тоже' })).toBe(0);
    expect(scoreCaseForVertical({ industry: 'IT-компания' }, { name: 'IT' })).toBe(3);
  });

  it('доменно-общие слова («продажи», «услуги», «доставка»…) — стоп-токены и не дают скор', () => {
    // «продажи» есть и в вертикали, и в кейсе — но это стоп-слово с обеих сторон.
    expect(
      scoreCaseForVertical(
        { industry: 'продажи', task: 'продажи, услуги, доставка' },
        { name: 'продажи', synonyms: ['услуги', 'доставка'] },
      ),
    ).toBe(0);
  });

  it('нет пересечения → 0; пустое название вертикали → 0', () => {
    expect(scoreCaseForVertical({ industry: 'банк' }, VERTICAL)).toBe(0);
    expect(scoreCaseForVertical({ industry: 'hr' }, { name: '' })).toBe(0);
  });
});

describe('selectCaseForVertical — выбор лучшего кейса проекта', () => {
  function seed(cases: Array<Record<string, unknown>>) {
    return createMockSupabase({ tables: { he_cases: cases } });
  }

  it('возвращает кейс с максимальным скором', async () => {
    const db = seed([
      { id: 'c-log', project_id: 'p1', source: 'site', industry: 'Логистика', client_type: '', task: 'доставка', created_at: '2026-01-01' },
      { id: 'c-hr', project_id: 'p1', source: 'site', industry: 'HR-tech', client_type: '', task: '', created_at: '2026-01-02' },
      { id: 'c-best', project_id: 'p1', source: 'site', industry: 'HR-tech', client_type: 'кадровое агентство', task: 'массовый подбор курьеров', created_at: '2026-01-03' },
    ]);
    // c-log: 0 («доставка» — стоп); c-hr: 3 (industry); c-best: 3 + 2 (task) = 5.
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected?.id).toBe('c-best');
  });

  it('попадание в industry бьёт task-only кейс даже с более ранним created_at', async () => {
    const db = seed([
      { id: 'c-task', project_id: 'p1', source: 'site', industry: '', client_type: '', task: 'массовый подбор курьеров', created_at: '2026-01-01' },
      { id: 'c-ind', project_id: 'p1', source: 'site', industry: 'HR-tech', client_type: '', task: '', created_at: '2026-01-02' },
    ]);
    // c-task: 2 (два task-попадания); c-ind: 3 (industry).
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected?.id).toBe('c-ind');
  });

  it('порог отбора равен 3: одно task-попадание (скор 1) не выбирается', async () => {
    expect(MIN_CASE_SCORE).toBe(3);
    const db = seed([
      { id: 'c-weak', project_id: 'p1', source: 'site', industry: '', client_type: '', task: 'рекрутинг водителей', created_at: '2026-01-01' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected).toBeNull();
  });

  it('граница порога: client_type (2) + task (1) = 3 — выбирается', async () => {
    const db = seed([
      { id: 'c-weak', project_id: 'p1', source: 'site', industry: '', client_type: '', task: 'рекрутинг водителей', created_at: '2026-01-01' },
      { id: 'c-combo', project_id: 'p1', source: 'site', industry: '', client_type: 'HR-агентство', task: 'рекрутинг водителей', created_at: '2026-01-02' },
    ]);
    // c-weak: 1; c-combo: 2 (hr в client_type) + 1 (рекрутинг в task) = 3.
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected?.id).toBe('c-combo');
  });

  it('generic-токены не выбирают wrong-industry кейс («продажи»/«услуги»/«доставка» — стоп)', async () => {
    const db = seed([
      { id: 'c-sales', project_id: 'p1', source: 'site', industry: 'продажи', client_type: '', task: 'продажи, услуги, доставка', created_at: '2026-01-01' },
    ]);
    // Вертикаль целиком из generic-слов → токенов нет → скор 0.
    const onlyGeneric = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', {
      name: 'продажи',
      synonyms: ['услуги', 'доставка'],
    });
    expect(onlyGeneric).toBeNull();
    // У вертикали есть специфичный токен «авто», но кейс его не содержит —
    // generic-совпадения скора не дают.
    const withSpecific = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', { name: 'продажи авто' });
    expect(withSpecific).toBeNull();
  });

  it('при равном скоре и источнике побеждает более ранний (created_at asc)', async () => {
    // mockSupabase не сортирует — сидим строки уже в порядке created_at asc.
    const db = seed([
      { id: 'c-first', project_id: 'p1', source: 'site', industry: 'HR', client_type: '', task: '', created_at: '2026-01-01' },
      { id: 'c-second', project_id: 'p1', source: 'site', industry: 'hr', client_type: '', task: '', created_at: '2026-01-02' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', { name: 'HR' });
    expect(selected?.id).toBe('c-first');
  });

  it('tie-break: при равном скоре upload бьёт site, даже если site раньше', async () => {
    const db = seed([
      { id: 'c-site', project_id: 'p1', source: 'site', industry: 'HR', client_type: '', task: '', created_at: '2026-01-01' },
      { id: 'c-upload', project_id: 'p1', source: 'upload', industry: 'hr', client_type: '', task: '', created_at: '2026-01-02' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', { name: 'HR' });
    expect(selected?.id).toBe('c-upload');
  });

  it('tie-break: ранний upload не уступает более позднему site с тем же скором', async () => {
    const db = seed([
      { id: 'c-upload', project_id: 'p1', source: 'upload', industry: 'HR', client_type: '', task: '', created_at: '2026-01-01' },
      { id: 'c-site', project_id: 'p1', source: 'site', industry: 'hr', client_type: '', task: '', created_at: '2026-01-02' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', { name: 'HR' });
    expect(selected?.id).toBe('c-upload');
  });

  it('кейсы чужого проекта не участвуют', async () => {
    const db = seed([
      { id: 'c-other', project_id: 'p2', source: 'site', industry: 'HR', client_type: '', task: 'массовый подбор', created_at: '2026-01-01' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected).toBeNull();
  });

  it('нет релевантных кейсов (score < MIN_CASE_SCORE) → null', async () => {
    const db = seed([
      { id: 'c-bank', project_id: 'p1', source: 'site', industry: 'Банки', client_type: 'enterprise', task: 'кредитный конвейер', created_at: '2026-01-01' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected).toBeNull();
  });

  it('пустой кейс-банк → null', async () => {
    const db = seed([]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected).toBeNull();
  });

  it('ошибка БД пробрасывается с контекстом', async () => {
    const db = createMockSupabase({ errorTables: { he_cases: 'db down' } });
    await expect(
      selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL),
    ).rejects.toThrow('he_cases read: db down');
  });
});

describe('normalizeCaseText — ключ дедупа', () => {
  it('lowercase + схлопывание пробельных последовательностей + trim', () => {
    expect(normalizeCaseText('  Кейс\n\tПро   X  ')).toBe('кейс про x');
  });

  it('одинаковый текст с разным форматированием совпадает, разный — различается', () => {
    expect(normalizeCaseText('Рост конверсии  120%')).toBe(normalizeCaseText('рост конверсии 120%'));
    expect(normalizeCaseText('Рост конверсии 120%')).not.toBe(normalizeCaseText('рост конверсии 121%'));
  });
});

describe('renderClientCaseBlock — блок для промптов', () => {
  it('рендерит заголовок и все поля, metrics — плоским списком', () => {
    const block = renderClientCaseBlock({
      industry: 'Ритейл',
      client_type: 'сеть кофеен',
      task: 'закрыть 120 позиций бариста',
      metrics: { 'закрыто_позиций': 120, 'срок': '2 месяца' },
      result: 'все точки открылись в срок',
      text: 'Сеть кофеен открывала новые точки. Подобрали 120 бариста.',
    });
    expect(block).toContain('КЕЙС КЛИЕНТА (доказательство, использовать один раз):');
    expect(block).toContain('Индустрия: Ритейл');
    expect(block).toContain('Тип клиента: сеть кофеен');
    expect(block).toContain('закрыто_позиций: 120');
    expect(block).toContain('Результат: все точки открылись в срок');
    expect(block).toContain('Сеть кофеен открывала новые точки.');
  });

  it('пустые поля и metrics — прочерки, без падений', () => {
    const block = renderClientCaseBlock({
      industry: '', client_type: '', task: '', metrics: {}, result: '', text: 'Описание.',
    });
    expect(block).toContain('Индустрия: —');
    expect(block).toContain('Метрики: —');
  });

  it('null-поля из строки БД — тоже прочерки (HeCase nullable)', () => {
    const block = renderClientCaseBlock({
      industry: null, client_type: null, task: null, metrics: {}, result: null, text: 'Описание.',
    });
    expect(block).toContain('Индустрия: —');
    expect(block).toContain('Тип клиента: —');
    expect(block).toContain('Задача: —');
    expect(block).toContain('Результат: —');
  });
});
