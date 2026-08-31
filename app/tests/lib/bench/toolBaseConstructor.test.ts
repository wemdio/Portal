/** @jest-environment node */

import { baseConstructorTool } from '@/lib/bench/tools/baseConstructor';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const DATA = [
  ['company', 'site'],
  ['Альфа', 'alpha.ru'],
];

describe('адаптер конструктора баз', () => {
  it('принимает базу и шаги', () => {
    const parsed = baseConstructorTool.paramsSchema.safeParse({
      data: DATA,
      selected_steps: ['remove_empty', 'dedup_full'],
    });
    expect(parsed.success).toBe(true);
  });

  it('требует хотя бы заголовок и одну строку', () => {
    expect(
      baseConstructorTool.paramsSchema.safeParse({
        data: [['company']],
        selected_steps: ['remove_empty'],
      }).success,
    ).toBe(false);
  });

  it('не пропускает выдуманный шаг', () => {
    expect(
      baseConstructorTool.paramsSchema.safeParse({
        data: DATA,
        selected_steps: ['выдуманный_шаг'],
      }).success,
    ).toBe(false);
  });

  it('«Оценка ЦА» без брифа отвергается', () => {
    // Пустой бриф молча отбрасывает все строки ниже порога — это потеря
    // базы, а не просто неудачный запуск.
    const parsed = baseConstructorTool.paramsSchema.safeParse({
      data: DATA,
      selected_steps: ['ta_scoring'],
      step_config: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('«Оценка ЦА» с брифом проходит', () => {
    expect(
      baseConstructorTool.paramsSchema.safeParse({
        data: DATA,
        selected_steps: ['ta_scoring'],
        step_config: { brief: 'B2B студии дизайна' },
      }).success,
    ).toBe(true);
  });

  it('персонализация без промпта отвергается', () => {
    expect(
      baseConstructorTool.paramsSchema.safeParse({
        data: DATA,
        selected_steps: ['personalization'],
        step_config: { prompt: '   ' },
      }).success,
    ).toBe(false);
  });

  it('строит строку задачи с владельцем и счётчиками', () => {
    const params = baseConstructorTool.paramsSchema.parse({
      data: DATA,
      selected_steps: ['remove_empty', 'dedup_full'],
    });
    const row = baseConstructorTool.buildRow(params, OWNER) as Record<string, unknown>;
    expect(row.user_id).toBe(OWNER);
    expect(row.initial_row_count).toBe(1);
    expect(row.total_steps).toBe(2);
    // status не задаём: у таблицы есть default 'pending'.
    expect(row.status).toBeUndefined();
  });

  it('переводит статусы, отмену показывает как остановку', () => {
    expect(baseConstructorTool.mapStatus({ status: 'pending' })).toBe('queued');
    expect(baseConstructorTool.mapStatus({ status: 'processing' })).toBe('running');
    expect(baseConstructorTool.mapStatus({ status: 'completed' })).toBe('done');
    expect(baseConstructorTool.mapStatus({ status: 'cancelled' })).toBe('stopped');
    expect(baseConstructorTool.mapStatus({ status: 'failed' })).toBe('failed');
  });

  it('прогресс считается в шагах обработки', () => {
    expect(baseConstructorTool.progress({ current_step: 3, total_steps: 7 })).toEqual({
      done: 3,
      total: 7,
    });
  });

  it('до завершения показывает исходный объём, после — итоговый', () => {
    expect(baseConstructorTool.rowsFound({ initial_row_count: 500, result_stats: null })).toBe(500);
    expect(
      baseConstructorTool.rowsFound({ initial_row_count: 500, result_stats: { final_rows: 312 } }),
    ).toBe(312);
  });

  it('результаты лежат внутри самой задачи', () => {
    expect(baseConstructorTool.results).toEqual({ kind: 'inline', field: 'data' });
  });

  it('поддерживает настоящую отмену', () => {
    expect(baseConstructorTool.stop).toEqual({ supported: true, stoppedStatus: 'cancelled' });
  });
});
