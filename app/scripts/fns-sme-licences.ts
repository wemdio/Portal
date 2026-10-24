/**
 * Лицензии из единого реестра МСП ФНС → таблица companies_directory_licences.
 *
 *   npm run build:fns-licence-tools
 *   node dist/scripts/fns-sme-licences.cjs --archive data-10102026-structure-12052026.zip --out <dir> [--allow-big-change]
 *
 * Каждый месяц снимок обновляет воркер portal-worker-fns-licences
 * (worker/fnsLicencesCron.ts). Скрипт — для ручной загрузки: после отказа
 * воркера или когда снимок законно сильно отличается от прежнего
 * (--allow-big-change снимает эту сверку).
 *
 * Скрипт ничего не пишет в базу. Он читает ZIP реестра (https://www.nalog.gov.ru/opendata/7707329152-rsmp/,
 * выходит 10-го числа) и кладёт в <dir>:
 *   licences.csv       — ИНН юрлица, группы лицензий, виды деятельности;
 *   summary.json       — сколько юрлиц и лицензий по группам;
 *   load-rollback.sql  — загрузка с ROLLBACK: прогон, после которого ничего не меняется;
 *   load-commit.sql    — та же загрузка с COMMIT, запускается только после «да» владельца.
 * Шаги загрузки общие с воркером: lib/companiesDirectory/licenceLoad.ts.
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFnsSmeLicencesZip } from '@/lib/companiesDirectory/fnsSmeLicences';
import {
  licenceCsvLine,
  licenceLoadHeadSql,
  licenceLoadTailSql,
  licenceRowCollector,
  licenceSnapshotDate,
} from '@/lib/companiesDirectory/licenceLoad';
import { LICENCE_GROUPS } from '@/lib/companiesDirectory/licences';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function loadSql(csv: string, snapshot: string, checkChange: boolean, finish: 'COMMIT' | 'ROLLBACK'): string {
  return [
    'BEGIN;',
    ...licenceLoadHeadSql(snapshot),
    'COPY src FROM STDIN WITH (FORMAT csv);',
    `${csv}\\.`,
    ...licenceLoadTailSql(snapshot, { checkChange }),
    `${finish};`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const archive = arg('archive');
  const out = arg('out');
  const checkChange = !process.argv.includes('--allow-big-change');
  await mkdir(out, { recursive: true });
  const collector = licenceRowCollector();
  const scan = await parseFnsSmeLicencesZip({
    input: createReadStream(archive),
    onRecord: (record) => collector.add(record),
  });
  const rows = collector.rows();
  if (!scan.registryDate || !rows.length) throw new Error('В архиве не нашлось юрлиц с лицензиями: проверьте файл');
  const snapshot = licenceSnapshotDate(scan.registryDate);
  const perGroup = new Map<string, number>();
  for (const row of rows) for (const group of row.groups) perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
  const csv = rows.map(licenceCsvLine).join('\n') + '\n';
  await writeFile(path.join(out, 'licences.csv'), csv);
  await writeFile(path.join(out, 'load-rollback.sql'), loadSql(csv, snapshot, checkChange, 'ROLLBACK'));
  await writeFile(path.join(out, 'load-commit.sql'), loadSql(csv, snapshot, checkChange, 'COMMIT'));
  const summary = {
    archive: path.basename(archive), snapshot_date: snapshot, ...scan, legal_entities_with_group: rows.length,
    change_check: checkChange,
    groups: Object.fromEntries(LICENCE_GROUPS.map((group) => [group.code, perGroup.get(group.code) ?? 0])),
  };
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
