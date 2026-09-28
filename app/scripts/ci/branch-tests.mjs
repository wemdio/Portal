#!/usr/bin/env node
/**
 * Какие тесты гонять в CI (блок «Run tests» в .semaphore/semaphore.yml).
 *
 * Ветка test — весь набор: это страховка после слияния, раз остальные ветки
 * гоняют не всё.
 *
 * Остальные ветки — только тесты, связанные с изменениями ветки относительно
 * test (по импортам: jest --findRelatedTests), плюс ВСЕ тесты, которые читают
 * файлы репозитория или запускают процессы сами: миграции, Dockerfile,
 * настройки CI, код воркеров — по импортам таких не найти. Весь набор и на
 * ветке, если менялось то, от чего зависят все тесты сразу (зависимости,
 * настройки jest/TypeScript/Next, общие файлы тестов, CI), или если изменения
 * определить не удалось: сомнение всегда решается в сторону полного прогона.
 *
 * Запуск из app/: node scripts/ci/branch-tests.mjs [аргументы jest]
 *   --dry-run            только показать, что было бы запущено;
 *   CI_TESTS_BASE=<ref>  сравнивать с этим коммитом, а не с общей точкой с
 *                        origin/test (незакоммиченные правки тоже считаются).
 *
 * Замер 28.09.2026: весь набор ~1 мин на 2 ядрах CI, тесты, читающие файлы,
 * ~11 с, типичная правка затрагивает 3–17 файлов тестов из ~300.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = process.cwd();
const JEST_BIN = path.join(APP_DIR, 'node_modules', 'jest', 'bin', 'jest.js');
const dryRun = process.argv.includes('--dry-run');
const jestArgs = process.argv.slice(2).filter((arg) => arg !== '--dry-run');

/** Изменение здесь влияет на все тесты разом — тогда гоняем весь набор. */
const RUN_ALL_WHEN_CHANGED = [
  /^app\/package(-lock)?\.json$/,
  /^app\/patches\//,
  /^app\/(jest\.config|jest\.setup|next\.config|babel\.config)\.[cm]?[jt]s$/,
  /^app\/tsconfig[^/]*\.json$/,
  /^app\/tests\/(helpers|fixtures)\//,
  /(^|\/)__mocks__\//,
  /^app\/scripts\/ci\//,
  /^\.semaphore\//,
];

/** Тест читает файлы или запускает процессы сам, мимо импортов. */
const READS_FILES = /\b(readFileSync|readdirSync|existsSync|readFile|statSync|globSync|child_process)\b/;

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function jest(args, { capture = false } = {}) {
  return spawnSync(
    process.execPath,
    [JEST_BIN, ...args],
    capture ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } : { stdio: 'inherit' },
  );
}

/** Список файлов тестов от самого jest — его правила testMatch/ignore, а не наши копии. */
function listTests(args) {
  const result = jest(['--listTests', ...args], { capture: true });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line) && /\.[cm]?[jt]sx?$/.test(line));
}

function finish(args, summary) {
  console.log(`[tests] ${summary}`);
  if (dryRun) process.exit(0);
  const result = jest(['--watchAll=false', ...jestArgs, ...args]);
  process.exit(result.status ?? 1);
}

function runAll(reason) {
  finish([], `весь набор — ${reason}`);
}

const branch = process.env.SEMAPHORE_GIT_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
if (branch === 'test') runAll('ветка test, страховка после слияния');

let base = process.env.CI_TESTS_BASE ? git(['rev-parse', process.env.CI_TESTS_BASE]) : null;
if (!base) {
  const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
  // В CI клон неглубокий и только своей ветки: test дотягиваем отдельно.
  // Локально ничего не качаем — берём тот origin/test, что уже есть.
  if (process.env.SEMAPHORE === 'true') {
    git(['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth=300'] : []), 'origin', '+refs/heads/test:refs/remotes/origin/test']);
  }
  base = git(['merge-base', 'origin/test', 'HEAD']);
  if (!base && shallow) {
    git(['fetch', '--quiet', '--no-tags', '--deepen=300', 'origin']);
    base = git(['merge-base', 'origin/test', 'HEAD']);
  }
}
if (!base) runAll('не нашлась общая точка с веткой test');

// Сравниваем с рабочим деревом, а не с HEAD: в CI это одно и то же, а локально
// в расчёт попадают и незакоммиченные правки.
const diff = git(['diff', '--name-only', base]);
const untracked = git(['ls-files', '--others', '--exclude-standard', '--full-name']);
if (diff === null || untracked === null) runAll('не удалось получить список изменений');
const changed = [...new Set(`${diff}\n${untracked}`.split('\n').filter(Boolean))];

const trigger = changed.find((file) => RUN_ALL_WHEN_CHANGED.some((re) => re.test(file)));
if (trigger) runAll(`изменён ${trigger}, от него зависят все тесты`);

const appFiles = changed
  .filter((file) => file.startsWith('app/'))
  .map((file) => file.slice('app/'.length))
  .filter((file) => fs.existsSync(path.join(APP_DIR, file)));

const allTests = listTests([]);
if (!allTests || allTests.length === 0) runAll('jest не отдал список тестов');
const readingFiles = allTests.filter((file) => READS_FILES.test(fs.readFileSync(file, 'utf8')));

let related = [];
if (appFiles.length > 0) {
  related = listTests(['--findRelatedTests', ...appFiles]);
  if (!related) runAll('jest не смог подобрать связанные тесты');
}

const selected = [...new Set([...related, ...readingFiles])].sort();
console.log(
  `[tests] ветка ${branch}: изменено файлов ${changed.length} (в app/ — ${appFiles.length}) ` +
    `относительно ${base.slice(0, 9)}`,
);
for (const file of related) console.log(`  связан с изменениями: ${path.relative(APP_DIR, file)}`);
finish(
  ['--passWithNoTests', '--runTestsByPath', ...selected],
  `связанные с изменениями: ${related.length}, читают файлы сами: ${readingFiles.length}, ` +
    `итого ${selected.length} из ${allTests.length}`,
);
