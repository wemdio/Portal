import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';

/**
 * Единый словарь статусов наружу. Внутри инструменты называют их вразнобой:
 * у конструктора баз `pending/processing/completed`, у Google Maps сразу
 * `queued`, у Яндекс.Карт `pending/running/completed/failed`. Перевод делает
 * адаптер — внешний скрипт видит один словарь на все инструменты.
 */
export type BenchStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export type JobRow = Record<string, unknown>;

/** Что витрина отдаёт про задачу — одинаково для всех инструментов. */
export interface BenchJobView {
  id: string;
  tool: string;
  status: BenchStatus;
  progress: { done: number; total: number | null };
  rows_found: number;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

/**
 * Остановку поддерживают не все инструменты: у большинства нет ни ручки
 * остановки, ни статуса «остановлена» в ограничении таблицы. Адаптер
 * объявляет это явно, а `GET /tools` публикует — чтобы внешний разработчик
 * узнавал об ограничении из ответа API, а не пробами.
 */
export type BenchStopSupport =
  | { supported: true; stoppedStatus: string }
  | { supported: false; reason: string };

/**
 * Откуда берутся результаты задачи. Инструменты устроены двумя способами, и
 * притворяться, что способ один, значило бы городить фальшивую таблицу для
 * половины из них.
 *
 * `table` — строки в отдельной таблице со ссылкой на задачу (Яндекс.Карты,
 * Google Maps, поисковый парсер). Листаются курсором по id.
 *
 * `inline` — массив прямо в поле строки задачи (конструктор баз хранит
 * результат в `data`, TG-парсер в `result_users`). Листается по номеру
 * элемента: в JSON-массиве нет ни id, ни порядка, кроме позиции.
 */
export type BenchResultsSource =
  | { kind: 'table'; table: string; jobColumn: string; orderColumn: string }
  | { kind: 'inline'; field: string };

export interface BenchJobTool {
  id: string;
  kind: 'job';
  title: string;
  /** Таблица задач, куда адаптер пишет строку. */
  table: string;
  /**
   * Разграничение внутри общей таблицы. HH, ATS и англоязычный найм живут в
   * одной `parser_jobs` и различаются полем `parser_type`; без этого фильтра
   * список задач HH возвращал бы ещё и чужие ATS-задачи, показывая их как
   * HH-задачи. У инструментов с собственной таблицей поля нет.
   */
  scope?: { column: string; value: string };
  paramsSchema: ZodType;
  /**
   * Строка задачи ровно в том виде, в каком её создаёт сам портал — воркер
   * не должен отличать задачу витрины от задачи человека.
   *
   * `params` здесь `unknown`: реестр про конкретные параметры инструмента не
   * знает, приведение делает сам адаптер после разбора своей схемой.
   */
  buildRow(params: unknown, ownerId: string): JobRow;
  mapStatus(row: JobRow): BenchStatus;
  progress(row: JobRow): { done: number; total: number | null };
  rowsFound(row: JobRow): number;
  errorOf(row: JobRow): string | null;
  finishedAt(row: JobRow): string | null;
  results: BenchResultsSource;
  stop: BenchStopSupport;
}

export interface BenchSearchPage {
  rows: unknown[];
  cursor: string | null;
  has_more: boolean;
}

/**
 * Откуда поисковый источник берёт данные — и, соответственно, что именно
 * сторожит доступ к ним.
 *
 * `robot` — обычные таблицы основной базы через клиент учётки-робота. Доступ
 * ограничивают правила самой БД, ровно как у живого сотрудника.
 *
 * `shared-reference` — общий справочник, который у нас читают все внутренние
 * пользователи одинаково: у его строк нет владельца, поэтому и разграничивать
 * по владельцу нечего. 2GIS вообще живёт в отдельной базе и ходит туда прямым
 * соединением, «наша база баз» — служебным вызовом.
 *
 * Признак нужен, чтобы обход клиента робота был осознанным и видимым в
 * контракте, а не случайностью, которую заметят через полгода. Защита таких
 * источников держится на двух вещах: инструмента нет в списке ключа — доступа
 * нет вовсе; есть — объём ограничен суточной нормой строк.
 */
export type BenchSearchAccess = 'robot' | 'shared-reference';

export interface BenchSearchTool {
  id: string;
  kind: 'search';
  title: string;
  access: BenchSearchAccess;
  filtersSchema: ZodType;
  run(args: {
    db: SupabaseClient;
    filters: unknown;
    limit: number;
    cursor: string | null;
  }): Promise<BenchSearchPage>;
}

// Метода `count` здесь намеренно нет. Базы поиска большие (в pdl_companies
// 13 млн строк), и `select(count: 'exact')` по ним идёт секундами — портал
// поэтому считает не точно, а оценкой планировщика в отдельной ручке.
// Точный подсчёт наружу не обещаем; `POST /search/count` появится вместе с
// механизмом оценки в следующем плане.

export type BenchTool = BenchJobTool | BenchSearchTool;
