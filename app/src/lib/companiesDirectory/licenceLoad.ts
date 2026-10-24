/**
 * Загрузка снимка лицензий в companies_directory_licences. Общая для ручной
 * загрузки (scripts/fns-sme-licences.ts пишет SQL для psql) и ежемесячного
 * воркера (worker/fnsLicencesCron.ts выполняет те же шаги через pg).
 *
 * Всё идёт одной транзакцией под advisory lock:
 *  - файл старше снимка в таблице отклоняется;
 *  - снимок, слишком непохожий на прежний, отклоняется: так выглядит сменившийся
 *    формат реестра или сломанный разбор, а за месяц реестр меняется на проценты;
 *  - строки файла заменяют прежние, а юрлица, которых в файле нет (лицензию
 *    сдали или вышли из МСП), удаляются — и при повторной загрузке того же снимка.
 */

import type { FnsSmeLicenceRecord } from './fnsSmeLicences';
import { classifyLicenceActivities, type LicenceGroupCode } from './licences';

export interface LicenceRow {
  inn: string;
  groups: LicenceGroupCode[];
  activities: string[];
}

/**
 * Юрлица с лицензией из словаря групп. Повтор ИНН сливается в одну строку:
 * upsert одной транзакцией упал бы на втором вхождении того же ИНН.
 */
export function licenceRowCollector() {
  const byInn = new Map<string, Set<string>>();
  // Видов деятельности несколько тысяч на 260 тысяч юрлиц: одна копия строки на текст.
  const texts = new Map<string, string>();
  return {
    add(record: Pick<FnsSmeLicenceRecord, 'inn' | 'activities'>): void {
      const activities = byInn.get(record.inn) ?? new Set<string>();
      for (const activity of record.activities) {
        const known = texts.get(activity);
        if (known === undefined) texts.set(activity, activity);
        activities.add(known ?? activity);
      }
      byInn.set(record.inn, activities);
    },
    rows(): LicenceRow[] {
      const rows: LicenceRow[] = [];
      for (const [inn, set] of byInn) {
        const activities = [...set];
        const groups = classifyLicenceActivities(activities);
        if (groups.length) rows.push({ inn, groups, activities });
      }
      return rows;
    },
  };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Строка CSV для COPY: ИНН, группы через «|», виды деятельности JSON-массивом. */
export function licenceCsvLine(row: LicenceRow): string {
  return [row.inn, row.groups.join('|'), JSON.stringify(row.activities)].map(csvCell).join(',');
}

/** Дата снимка идёт в SQL текстом, поэтому проверяется строго: ГГГГ-ММ-ДД. */
function assertSnapshotDate(snapshot: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot) || !Number.isFinite(Date.parse(snapshot))) {
    throw new Error(`Неверная дата снимка: ${snapshot}`);
  }
}

/** ДатаСост реестра (ДД.ММ.ГГГГ) → дата снимка (ГГГГ-ММ-ДД). */
export function licenceSnapshotDate(registryDate: string): string {
  const [day, month, year] = registryDate.split('.');
  const snapshot = `${year}-${month}-${day}`;
  assertSnapshotDate(snapshot);
  return snapshot;
}

/**
 * Насколько снимок может отличаться от прежнего за одно обновление. За месяц
 * реестр меняется на проценты; больше — признак сломанного разбора или нового
 * формата. Такой снимок грузится только руками (--allow-big-change).
 */
export const LICENCE_LOAD_LIMITS = {
  totalMin: 0.85,
  totalMax: 1.25,
  /** Группы меньше этого размера не сверяются: в них проценты — шум. */
  groupFloor: 1000,
  groupMin: 0.6,
  groupMax: 1.6,
} as const;

/** Начало транзакции до заполнения временной таблицы src. */
export function licenceLoadHeadSql(snapshot: string): string[] {
  assertSnapshotDate(snapshot);
  return [
    "SET LOCAL statement_timeout = '600s';",
    "SET LOCAL lock_timeout = '15s';",
    "SELECT pg_advisory_xact_lock(hashtextextended('companies_directory_licences:load', 0)) IS NULL AS locked;",
    `DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM public.companies_directory_licences WHERE snapshot_date > DATE '${snapshot}') THEN
    RAISE EXCEPTION 'В таблице снимок новее этого файла (${snapshot}): загрузка остановлена';
  END IF;
END $guard$;`,
    'CREATE TEMP TABLE src(inn text, groups text, activities text) ON COMMIT DROP;',
  ];
}

/** Конец транзакции после заполнения src: сверка с прежним снимком, замена, итоги. */
export function licenceLoadTailSql(snapshot: string, options: { checkChange: boolean }): string[] {
  assertSnapshotDate(snapshot);
  const limits = LICENCE_LOAD_LIMITS;
  const change = `DO $change$
DECLARE
  was bigint;
  now_rows bigint;
  groups_changed text;
BEGIN
  SELECT count(*) INTO was FROM public.companies_directory_licences;
  SELECT count(*) INTO now_rows FROM src;
  IF was > 0 AND (now_rows < was * ${limits.totalMin} OR now_rows > was * ${limits.totalMax}) THEN
    RAISE EXCEPTION 'Снимок слишком отличается от прежнего: было % юрлиц, стало %', was, now_rows;
  END IF;
  SELECT string_agg(format('%s: %s → %s', o.g, o.n, coalesce(f.n, 0)), '; ' ORDER BY o.g) INTO groups_changed
    FROM (SELECT g, count(*) AS n FROM public.companies_directory_licences, unnest(groups) g GROUP BY g) o
    LEFT JOIN (SELECT g, count(*) AS n FROM src, unnest(string_to_array(src.groups, '|')) g GROUP BY g) f USING (g)
   WHERE o.n >= ${limits.groupFloor}
     AND (coalesce(f.n, 0) < o.n * ${limits.groupMin} OR coalesce(f.n, 0) > o.n * ${limits.groupMax});
  IF groups_changed IS NOT NULL THEN
    RAISE EXCEPTION 'Группы лицензий изменились слишком сильно: %', groups_changed;
  END IF;
END $change$;`;
  return [
    'SELECT count(*) AS rows_in_file FROM src;',
    ...(options.checkChange ? [change] : []),
    `WITH u AS (
  INSERT INTO public.companies_directory_licences AS l (inn, groups, activities, snapshot_date, updated_at)
  SELECT inn, string_to_array(groups, '|'), array(SELECT jsonb_array_elements_text(activities::jsonb)), DATE '${snapshot}', now()
    FROM src
  ON CONFLICT (inn) DO UPDATE SET groups = excluded.groups, activities = excluded.activities,
    snapshot_date = excluded.snapshot_date, updated_at = excluded.updated_at
  RETURNING (xmax = 0) AS inserted
) SELECT count(*) FILTER (WHERE inserted) AS inserted, count(*) FILTER (WHERE NOT inserted) AS updated FROM u;`,
    `WITH d AS (
  DELETE FROM public.companies_directory_licences l
   WHERE NOT EXISTS (SELECT 1 FROM src s WHERE s.inn = l.inn)
  RETURNING 1
) SELECT count(*) AS deleted FROM d;`,
    `SELECT count(*) AS in_companies_directory FROM public.companies_directory_licences l
 WHERE EXISTS (SELECT 1 FROM public.companies_directory c WHERE c.inn = l.inn);`,
  ];
}

/** Снимок не прошёл проверки: файл сам по себе не годится, повтор того же файла ничего не даст. */
export class LicenceSnapshotRefusedError extends Error {}

/**
 * Отказ проверок снимка: пустой снимок или RAISE EXCEPTION из SQL выше (SQLSTATE
 * P0001) — файл старше снимка в таблице или слишком непохож на прежний. В
 * отличие от сбоя сети или базы, повтор того же файла ничего не изменит.
 */
export function isLicenceSnapshotRefusal(error: unknown): boolean {
  return error instanceof LicenceSnapshotRefusedError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P0001');
}

export interface LicenceSqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface LicenceLoadResult {
  rowsInFile: number;
  inserted: number;
  updated: number;
  deleted: number;
  inCompaniesDirectory: number;
}

const INSERT_BATCH = 5000;

/** Загрузка через pg-клиент: те же шаги, что в SQL для psql, только src заполняется пачками. */
export async function applyLicenceSnapshot(
  db: LicenceSqlClient,
  rows: readonly LicenceRow[],
  snapshot: string,
  options: { checkChange: boolean } = { checkChange: true },
): Promise<LicenceLoadResult> {
  if (!rows.length) throw new LicenceSnapshotRefusedError('В снимке нет юрлиц с лицензией: загрузка остановлена');
  const totals: Record<string, unknown> = {};
  await db.query('BEGIN');
  try {
    for (const sql of licenceLoadHeadSql(snapshot)) await db.query(sql);
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      const part = rows.slice(start, start + INSERT_BATCH);
      await db.query('INSERT INTO src (inn, groups, activities) SELECT * FROM unnest($1::text[], $2::text[], $3::text[])', [
        part.map((row) => row.inn),
        part.map((row) => row.groups.join('|')),
        part.map((row) => JSON.stringify(row.activities)),
      ]);
    }
    for (const sql of licenceLoadTailSql(snapshot, options)) Object.assign(totals, (await db.query(sql)).rows[0]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return {
    rowsInFile: Number(totals.rows_in_file),
    inserted: Number(totals.inserted),
    updated: Number(totals.updated),
    deleted: Number(totals.deleted),
    inCompaniesDirectory: Number(totals.in_companies_directory),
  };
}
