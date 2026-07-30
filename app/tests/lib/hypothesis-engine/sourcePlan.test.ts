/** @jest-environment node */

import { HeSourcePlanSchema } from '@/lib/hypothesisEngine/schemas';
import { buildSourcePlanMessages } from '@/lib/hypothesisEngine/prompts/sourcePlan';

describe('HeSourcePlanSchema — валидные payload', () => {
  it('companies_directory с directory_filters проходит, лишние поля отбрасываются', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        {
          source: 'companies_directory',
          rationale: 'Производители БАД по ОКВЭД 10/21 с email для холодной цепочки',
          directory_filters: { okvedCodes: ['10', '21.2'], hasEmail: true, includeIp: false },
          unexpected_field: 'drop me',
        },
      ],
      plan_note: 'тоже лишнее',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tasks[0].directory_filters?.okvedCodes).toEqual(['10', '21.2']);
      expect((r.data.tasks[0] as Record<string, unknown>).unexpected_field).toBeUndefined();
      expect((r.data as Record<string, unknown>).plan_note).toBeUndefined();
    }
  });

  it('hh_live с hh_query проходит', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        {
          source: 'hh_live',
          rationale: 'Компании, нанимающие коммерческого директора — сигнал роста отдела продаж',
          hh_query: { text: '"коммерческий директор"', area: '1', date_from: '2026-06-01' },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('yandex_maps и google_maps с maps_query проходят', () => {
    for (const source of ['yandex_maps', 'google_maps'] as const) {
      const r = HeSourcePlanSchema.safeParse({
        tasks: [
          {
            source,
            rationale: 'Локальный бизнес ниши вне таксономии реестра',
            maps_query: { queries: ['стоматология', 'автосервис'], geo: 'Москва' },
          },
        ],
      });
      expect(r.success).toBe(true);
    }
  });

  it('смешанный план из 4 задач проходит', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        { source: 'companies_directory', rationale: 'r', directory_filters: {} },
        { source: 'hh_live', rationale: 'r', hh_query: { text: 'HRD' } },
        { source: 'yandex_maps', rationale: 'r', maps_query: { queries: ['кофейня'] } },
        { source: 'google_maps', rationale: 'r', maps_query: { queries: ['автомойка'], geo: 'СПб' } },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe('HeSourcePlanSchema — невалидные payload', () => {
  it('источник без обязательного под-объекта отклоняется (каждый из 4)', () => {
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'companies_directory', rationale: 'r' }] }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'hh_live', rationale: 'r' }] }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'yandex_maps', rationale: 'r' }] }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'google_maps', rationale: 'r' }] }).success,
    ).toBe(false);
  });

  it('чужой под-объект не заменяет обязательный', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        { source: 'companies_directory', rationale: 'r', hh_query: { text: 'q' } },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('невалидные коды ОКВЭД отклоняются, класс XX и группа XX.X — нет', () => {
    const base = { source: 'companies_directory', rationale: 'r' };
    for (const bad of ['6', '620', '62.01', '62.1.1', 'XX', '62.', ' 62']) {
      expect(
        HeSourcePlanSchema.safeParse({
          tasks: [{ ...base, directory_filters: { okvedCodes: [bad] } }],
        }).success,
      ).toBe(false);
    }
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ ...base, directory_filters: { okvedCodes: ['62', '62.0'] } }],
      }).success,
    ).toBe(true);
  });

  it('пустой план и план из 5 задач отклоняются', () => {
    expect(HeSourcePlanSchema.safeParse({ tasks: [] }).success).toBe(false);
    const task = { source: 'hh_live', rationale: 'r', hh_query: { text: 'q' } };
    expect(HeSourcePlanSchema.safeParse({ tasks: Array(5).fill(task) }).success).toBe(false);
  });

  it('неизвестный источник и пустой rationale отклоняются', () => {
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'linkedin', rationale: 'r' }] }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'hh_live', rationale: '', hh_query: { text: 'q' } }],
      }).success,
    ).toBe(false);
  });

  it('пустой hh text, пустой maps queries и запрос длиннее 300 символов отклоняются', () => {
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'hh_live', rationale: 'r', hh_query: { text: '' } }],
      }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'hh_live', rationale: 'r', hh_query: { text: 'q'.repeat(301) } }],
      }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'yandex_maps', rationale: 'r', maps_query: { queries: [] } }],
      }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'yandex_maps', rationale: 'r', maps_query: { queries: ['q'.repeat(301)] } }],
      }).success,
    ).toBe(false);
  });
});

describe('buildSourcePlanMessages — контекст в сообщениях', () => {
  it('user-сообщение содержит вертикаль, гипотезы и типы компаний', () => {
    const msgs = buildSourcePlanMessages({
      verticalName: 'Производители БАД',
      verticalSummary: 'Контрактные производства добавок',
      synonyms: ['БАДы', 'добавки'],
      hypotheses: [
        { title: 'Малые бренды БАД', description: 'выходят на маркетплейсы', tier: 2 },
        { title: 'Контрактные производства', tier: 3 },
      ],
      companyTypes: ['производитель БАД', 'контрактное производство'],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    const user = msgs[1].content;
    expect(user).toContain('Производители БАД');
    expect(user).toContain('Малые бренды БАД');
    expect(user).toContain('Контрактные производства');
    expect(user).toContain('производитель БАД');
    expect(user).toContain('[tier 2]');
    // Требование JSON без markdown — в системном промпте
    expect(msgs[0].content).toContain('ТОЛЬКО JSON');
  });

  it('минимальный вход (без summary/synonyms/companyTypes) рендерится с заглушками', () => {
    const msgs = buildSourcePlanMessages({
      verticalName: 'HR-агентства',
      hypotheses: [{ title: 'Рекрутинговые бутики' }],
    });
    const user = msgs[1].content;
    expect(user).toContain('HR-агентства');
    expect(user).toContain('Рекрутинговые бутики');
    expect(user).toContain('—');
  });
});
