/** @jest-environment node */

import {
  hhArchiveTool,
  searchParserTool,
  yandexDirectTool,
} from '@/lib/bench/tools/moreParsers';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

describe('адаптер архива HH', () => {
  const valid = {
    search_queries: ['менеджер по продажам'],
    date_from: '2026-01-01',
    date_to: '2026-06-30',
  };

  it('принимает корректные параметры', () => {
    expect(hhArchiveTool.paramsSchema.safeParse(valid).success).toBe(true);
  });

  it('отвергает перевёрнутый период', () => {
    expect(
      hhArchiveTool.paramsSchema.safeParse({ ...valid, date_from: '2026-06-30', date_to: '2026-01-01' })
        .success,
    ).toBe(false);
  });

  it('отвергает дату не в том формате', () => {
    expect(hhArchiveTool.paramsSchema.safeParse({ ...valid, date_from: '01.01.2026' }).success).toBe(
      false,
    );
  });

  it('подставляет владельца', () => {
    const row = hhArchiveTool.buildRow(hhArchiveTool.paramsSchema.parse(valid), OWNER);
    expect(row.user_id).toBe(OWNER);
    expect(row.area).toBe('113');
  });

  it('прогресс считается в чанках дат', () => {
    expect(hhArchiveTool.progress({ processed_chunks: 3, total_chunks: 12 })).toEqual({
      done: 3,
      total: 12,
    });
  });

  it('отмену показывает как остановку и поддерживает её', () => {
    expect(hhArchiveTool.mapStatus({ status: 'cancelled' })).toBe('stopped');
    expect(hhArchiveTool.stop).toEqual({ supported: true, stoppedStatus: 'cancelled' });
  });
});

describe('адаптер поискового парсера', () => {
  it('требует хотя бы один запрос', () => {
    expect(searchParserTool.paramsSchema.safeParse({ queries: [] }).success).toBe(false);
  });

  it('ограничивает глубину выдачи', () => {
    expect(
      searchParserTool.paramsSchema.safeParse({ queries: ['x'], search_depth: 500 }).success,
    ).toBe(false);
  });

  it('считает число запросов в задачу', () => {
    const params = searchParserTool.paramsSchema.parse({ queries: ['a', 'b', 'c'] });
    const row = searchParserTool.buildRow(params, OWNER);
    expect(row.total_queries).toBe(3);
    expect(row.user_id).toBe(OWNER);
  });

  it('остановки не поддерживает и говорит об этом', () => {
    expect(searchParserTool.stop.supported).toBe(false);
  });
});

describe('адаптер Яндекс.Директа', () => {
  it('в ручном режиме требует ключи', () => {
    expect(
      yandexDirectTool.paramsSchema.safeParse({ keyword_mode: 'manual', keywords: [] }).success,
    ).toBe(false);
  });

  it('в режиме AI требует описание аудитории', () => {
    expect(
      yandexDirectTool.paramsSchema.safeParse({ keyword_mode: 'ai', audience: '  ' }).success,
    ).toBe(false);
  });

  it('режим AI с описанием проходит без ключей', () => {
    expect(
      yandexDirectTool.paramsSchema.safeParse({
        keyword_mode: 'ai',
        audience: 'студии дизайна интерьера',
      }).success,
    ).toBe(true);
  });

  it('считает найденным то, что реально сохранится', () => {
    // found_advertisers считает и дубли, saved_total — уникальные домены.
    expect(yandexDirectTool.rowsFound({ found_advertisers: 900, saved_total: 240 })).toBe(240);
  });

  it('поддерживает настоящую отмену', () => {
    expect(yandexDirectTool.stop).toEqual({ supported: true, stoppedStatus: 'cancelled' });
  });
});
