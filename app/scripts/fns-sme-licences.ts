/**
 * Лицензии из единого реестра МСП ФНС → таблица companies_directory_licences.
 *
 *   npm run build:fns-licence-tools
 *   node dist/scripts/fns-sme-licences.cjs --archive data-10102026-structure-12052026.zip --out <dir>
 *
 * Скрипт ничего не пишет в базу. Он читает ZIP реестра (https://www.nalog.gov.ru/opendata/7707329152-rsmp/,
 * выходит 10-го числа) и кладёт в <dir>:
 *   licences.csv       — ИНН юрлица, группы лицензий, виды деятельности;
 *   summary.json       — сколько юрлиц и лицензий по группам;
 *   load-rollback.sql  — загрузка с ROLLBACK: прогон, после которого ничего не меняется;
 *   load-commit.sql    — та же загрузка с COMMIT, запускается только после «да» владельца.
 * SQL идёт одной транзакцией под advisory lock: строки нового снимка заменяют прежние, а юрлица,
 * которых в файле нет (лицензию сдали или вышли из МСП), удаляются — и при повторной загрузке
 * того же снимка тоже. Файл старше снимка в таблице загрузка отклоняет.
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFnsSmeLicencesZip } from '@/lib/companiesDirectory/fnsSmeLicences';
import { LICENCE_GROUPS } from '@/lib/companiesDirectory/licences';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isoDate(registryDate: string): string {
  const [day, month, year] = registryDate.split('.');
  return `${year}-${month}-${day}`;
}

function loadSql(csv: string, snapshot: string, finish: 'COMMIT' | 'ROLLBACK'): string {
  return `BEGIN;
SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '15s';
SELECT 'lock', pg_advisory_xact_lock(hashtextextended('companies_directory_licences:load', 0)) IS NULL;
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM public.companies_directory_licences WHERE snapshot_date > DATE '${snapshot}') THEN
    RAISE EXCEPTION 'В таблице снимок новее этого файла (${snapshot}): загрузка остановлена';
  END IF;
END $guard$;
CREATE TEMP TABLE src(inn text, groups text, activities text) ON COMMIT DROP;
COPY src FROM STDIN WITH (FORMAT csv);
${csv}\\.
SELECT 'rows_in_file', count(*) FROM src;
WITH u AS (
  INSERT INTO public.companies_directory_licences AS l (inn, groups, activities, snapshot_date, updated_at)
  SELECT inn, string_to_array(groups, '|'), array(SELECT jsonb_array_elements_text(activities::jsonb)), DATE '${snapshot}', now()
    FROM src
  ON CONFLICT (inn) DO UPDATE SET groups = excluded.groups, activities = excluded.activities,
    snapshot_date = excluded.snapshot_date, updated_at = excluded.updated_at
  RETURNING (xmax = 0) AS inserted
) SELECT 'inserted', count(*) FILTER (WHERE inserted), 'updated', count(*) FILTER (WHERE NOT inserted) FROM u;
WITH d AS (
  DELETE FROM public.companies_directory_licences l
   WHERE NOT EXISTS (SELECT 1 FROM src s WHERE s.inn = l.inn)
  RETURNING 1
) SELECT 'deleted_not_in_snapshot', count(*) FROM d;
SELECT 'in_companies_directory', count(*) FROM public.companies_directory_licences l
 WHERE EXISTS (SELECT 1 FROM public.companies_directory c WHERE c.inn = l.inn);
${finish};
`;
}

async function main(): Promise<void> {
  const archive = arg('archive');
  const out = arg('out');
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  const perGroup = new Map<string, number>();
  let withGroup = 0;
  const scan = await parseFnsSmeLicencesZip({
    input: createReadStream(archive),
    onRecord(record) {
      if (!record.groups.length) return;
      withGroup += 1;
      for (const group of record.groups) perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
      lines.push([record.inn, record.groups.join('|'), JSON.stringify(record.activities)].map(csvCell).join(','));
    },
  });
  if (!scan.registryDate || !lines.length) throw new Error('В архиве не нашлось юрлиц с лицензиями: проверьте файл');
  const snapshot = isoDate(scan.registryDate);
  const csv = lines.join('\n') + '\n';
  await writeFile(path.join(out, 'licences.csv'), csv);
  await writeFile(path.join(out, 'load-rollback.sql'), loadSql(csv, snapshot, 'ROLLBACK'));
  await writeFile(path.join(out, 'load-commit.sql'), loadSql(csv, snapshot, 'COMMIT'));
  const summary = {
    archive: path.basename(archive), snapshot_date: snapshot, ...scan, legal_entities_with_group: withGroup,
    groups: Object.fromEntries(LICENCE_GROUPS.map((group) => [group.code, perGroup.get(group.code) ?? 0])),
  };
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
