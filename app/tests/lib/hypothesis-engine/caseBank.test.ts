/** @jest-environment node */

/**
 * Tests for lib/hypothesisEngine/caseBank:
 *  - scoreCaseForVertical — pure токен-оверлап вертикали (name+synonyms)
 *    по industry/client_type/task кейса;
 *  - selectCaseForVertical — выбор лучшего кейса проекта (min score 1,
 *    ничего релевантного → null);
 *  - renderClientCaseBlock — блок «КЕЙС КЛИЕНТА» для промптов.
 */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  renderClientCaseBlock,
  scoreCaseForVertical,
  selectCaseForVertical,
} from '@/lib/hypothesisEngine/caseBank';

const VERTICAL = { name: 'HR-агентства', synonyms: ['массовый подбор', 'рекрутинг'] };

describe('scoreCaseForVertical — токен-оверлап', () => {
  it('совпадение по токену из названия вертикали (case-insensitive)', () => {
    const score = scoreCaseForVertical(
      { industry: 'HR-tech платформа', client_type: '', task: '' },
      VERTICAL,
    );
    // общий токен — «hr» («tech»/«платформа» в вертикали не встречаются)
    expect(score).toBe(1);
  });

  it('синонимы вертикали тоже дают скор', () => {
    const score = scoreCaseForVertical(
      { industry: 'Логистика', client_type: '', task: 'массовый подбор курьеров на склад' },
      VERTICAL,
    );
    // «массовый» + «подбор» из синонима
    expect(score).toBe(2);
  });

  it('сканируются все три поля: industry, client_type, task', () => {
    const byClientType = scoreCaseForVertical({ client_type: 'HR-агентство' }, { name: 'hr' });
    expect(byClientType).toBe(1);
    const byTask = scoreCaseForVertical({ task: 'рекрутинг водителей' }, { name: 'логистика', synonyms: ['рекрутинг'] });
    expect(byTask).toBe(1);
  });

  it('стоп-слова и короткие токены не считаются; «it» (2 символа) считается', () => {
    expect(scoreCaseForVertical({ industry: 'И только' }, { name: 'И тоже' })).toBe(0);
    expect(scoreCaseForVertical({ industry: 'IT-компания' }, { name: 'IT' })).toBe(1);
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
      { id: 'c-log', project_id: 'p1', industry: 'Логистика', client_type: '', task: 'доставка', created_at: '2026-01-01' },
      { id: 'c-hr', project_id: 'p1', industry: 'HR-tech', client_type: '', task: '', created_at: '2026-01-02' },
      { id: 'c-best', project_id: 'p1', industry: 'HR-tech', client_type: 'кадровое агентство', task: 'массовый подбор курьеров', created_at: '2026-01-03' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected?.id).toBe('c-best');
  });

  it('при равном скоре побеждает более ранний (created_at asc)', async () => {
    // mockSupabase не сортирует — сидим строки уже в порядке created_at asc.
    const db = seed([
      { id: 'c-first', project_id: 'p1', industry: 'HR', client_type: '', task: '', created_at: '2026-01-01' },
      { id: 'c-second', project_id: 'p1', industry: 'hr', client_type: '', task: '', created_at: '2026-01-02' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', { name: 'HR' });
    expect(selected?.id).toBe('c-first');
  });

  it('кейсы чужого проекта не участвуют', async () => {
    const db = seed([
      { id: 'c-other', project_id: 'p2', industry: 'HR', client_type: '', task: 'массовый подбор', created_at: '2026-01-01' },
    ]);
    const selected = await selectCaseForVertical(db as unknown as SupabaseClient, 'p1', VERTICAL);
    expect(selected).toBeNull();
  });

  it('нет релевантных кейсов (score < 1) → null', async () => {
    const db = seed([
      { id: 'c-bank', project_id: 'p1', industry: 'Банки', client_type: 'enterprise', task: 'кредитный конвейер', created_at: '2026-01-01' },
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
});
