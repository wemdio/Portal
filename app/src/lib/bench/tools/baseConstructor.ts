import { z } from 'zod';
import { AVAILABLE_STEPS } from '@/lib/tools/processingSteps';
import type { BenchJobTool, JobRow } from '../types';

/**
 * Конструктор баз. Отличается от парсеров двумя вещами.
 *
 * Первое: на вход подаётся сама база — массив строк, первая из которых
 * заголовки. Он же и хранится в задаче, и результат дописывается туда же
 * (колонка `data`), поэтому результаты у него `inline`, а не отдельной
 * таблицей.
 *
 * Второе: он поддерживает НАСТОЯЩУЮ отмену. Воркер (app/src/lib/tools/
 * baseConstructorWorker.ts) проверяет `isCancelled()` между шагами и на
 * длинных шагах, и бросает «Отменено» — то есть оплаченная работа
 * действительно прекращается, а не просто меняется надпись.
 */

// Список шагов берётся из того же реестра, по которому работает портал, —
// иначе витрина и портал разошлись бы при первом же новом шаге.
const stepKeys = AVAILABLE_STEPS.map((s) => s.key) as [string, ...string[]];

const paramsSchema = z
  .object({
    // Первая строка — заголовки, дальше данные. Ровно та форма, которую
    // принимает портал.
    data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(2).max(50_000),
    selected_steps: z.array(z.enum(stepKeys)).min(1),
    step_config: z.record(z.string(), z.unknown()).default({}),
    file_name: z.string().min(1).max(300).optional(),
  })
  .strict()
  // Договор шагов, который портал проверяет на сервере: без брифа «Оценка
  // ЦА» отбрасывает все строки ниже порога — то есть молча теряет базу.
  // Без промпта персонализация выдаёт мусор. Ловим это на входе, а не после.
  .refine(
    (v) =>
      !v.selected_steps.includes('ta_scoring') ||
      typeof v.step_config.brief === 'string' && v.step_config.brief.trim().length > 0,
    { message: 'Для шага «Оценка ЦА» нужен непустой brief в step_config' },
  )
  .refine(
    (v) =>
      !v.selected_steps.includes('personalization') ||
      typeof v.step_config.prompt === 'string' && v.step_config.prompt.trim().length > 0,
    { message: 'Для шага «Персонализация» нужен непустой prompt в step_config' },
  );

type Params = z.infer<typeof paramsSchema>;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const baseConstructorTool: BenchJobTool = {
  id: 'base-constructor',
  kind: 'job',
  title: 'Конструктор баз',
  table: 'base_constructor_jobs',
  paramsSchema,

  buildRow(params, ownerId) {
    const p = params as Params;
    return {
      user_id: ownerId,
      file_name: p.file_name ?? null,
      data: p.data,
      selected_steps: p.selected_steps,
      step_config: p.step_config,
      initial_row_count: p.data.length - 1,
      total_steps: p.selected_steps.length,
      // status не задаём: у таблицы default 'pending', и воркер сам его
      // подхватит — ровно как при постановке задачи из портала.
    };
  },

  mapStatus(row: JobRow) {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'processing':
        return 'running';
      case 'completed':
        return 'done';
      case 'cancelled':
        return 'stopped';
      default:
        return 'failed';
    }
  },

  // Прогресс здесь считается в шагах обработки, а не в строках: «шаг 3 из 7»
  // — то, что видит человек в портале.
  progress(row: JobRow) {
    const total = num(row.total_steps);
    return { done: num(row.current_step), total: total || null };
  },

  rowsFound(row: JobRow) {
    const stats = row.result_stats as { final_rows?: unknown } | null;
    const final = num(stats?.final_rows);
    // Пока задача не завершилась, итога ещё нет — показываем исходный объём,
    // чтобы поле не было пустым и не выглядело как «ничего не нашли».
    return final || num(row.initial_row_count);
  },

  errorOf(row: JobRow) {
    return text(row.error_message);
  },

  finishedAt(row: JobRow) {
    return text(row.completed_at);
  },

  // Результат дописывается в ту же колонку `data`, откуда читались исходные
  // строки. Отдельной таблицы результатов у инструмента нет.
  results: { kind: 'inline', field: 'data' },

  stop: { supported: true, stoppedStatus: 'cancelled' },
};
