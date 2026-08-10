/**
 * @jest-environment node
 *
 * Скрипт тянет `pg`, а тот в jsdom не грузится (нет TextEncoder).
 *
 * Индексы по токенам рубрик каталога Яндекс.Карт живут в двух местах:
 *
 *   - supabase/migrations/20260807_0004_yandex_maps_catalog_rubric_tokens.sql —
 *     проверяет, что они построены, и строит сам только на маленькой базе;
 *   - app/scripts/db/buildYandexMapsRubricTokenIndexes.js — строит их
 *     concurrently на большой, до деплоя.
 *
 * Дублирование вынужденное: скрипт по замыслу запускают ДО миграции, значит
 * определения функции и индексов он обязан нести с собой. Тест следит, чтобы
 * копии не разошлись, и чтобы в миграцию не вернулась блокирующая постройка —
 * именно она 08.08.2026 уронила деплой по `55P03` (обычный `create index`
 * держит SHARE на таблице, а в каталог непрерывно пишет фоновый обход).
 */

import fs from 'fs';
import path from 'path';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260807_0004_yandex_maps_catalog_rubric_tokens.sql',
);
const BOUNDED_MARK_SEEN_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260810_0003_yandex_maps_catalog_mark_seen_bounded.sql',
);
const SCRIPT_RELATIVE_PATH = 'scripts/db/buildYandexMapsRubricTokenIndexes.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RUBRIC_TOKENS_FUNCTION_SQL, INDEXES } = require('../../scripts/db/buildYandexMapsRubricTokenIndexes.js') as {
  RUBRIC_TOKENS_FUNCTION_SQL: string;
  INDEXES: Array<{ name: string; using: string }>;
};

const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

/** Пробелы и переводы строк роли не играют — сравниваем смысл, не вёрстку. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
}

describe('индексы по токенам рубрик каталога Яндекс.Карт', () => {
  it('скрипт и миграция объявляют yandex_maps_rubric_tokens одинаково', () => {
    // Индекс по выражению привязан к телу функции: разъедутся определения —
    // на стенде и на бою окажутся разные индексы под одним именем.
    expect(normalise(migrationSql)).toContain(normalise(RUBRIC_TOKENS_FUNCTION_SQL));
  });

  it('скрипт и миграция знают один и тот же набор индексов', () => {
    const normalisedMigration = normalise(migrationSql);
    for (const index of INDEXES) {
      expect(normalisedMigration).toContain(index.name);
      expect(normalisedMigration).toContain(normalise(index.using));
    }
    expect(INDEXES.map((index) => index.name).sort()).toEqual([
      'idx_ymc_rubric_tokens',
      'idx_ymc_tokens_city',
      'idx_ymc_tokens_region',
    ]);
  });

  it('миграция не строит индексы вне guard-блока', () => {
    // Внутри `do $ymc$ ... $ymc$` постройка разрешена: туда попадают только
    // маленькие базы, где блокировать некого. Снаружи — нет: на боевых 13 ГБ
    // это ACCESS SHARE на минуты и падение деплоя по lock_timeout.
    const sql = stripSqlComments(migrationSql);
    const guardStart = sql.indexOf('do $ymc$');
    const guardEnd = sql.indexOf('$ymc$;', guardStart + 1);
    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);

    for (const match of sql.matchAll(/create\s+index/gi)) {
      const at = match.index ?? -1;
      expect(at).toBeGreaterThan(guardStart);
      expect(at).toBeLessThan(guardEnd);
    }
  });

  it('миграция подсказывает, чем построить индексы', () => {
    // Текст ошибки — единственное, что увидит дежурный в алерте о падении
    // деплоя (в Telegram уходит хвост вывода миграций).
    expect(migrationSql).toContain(SCRIPT_RELATIVE_PATH);
    expect(fs.existsSync(path.resolve(__dirname, '../../', SCRIPT_RELATIVE_PATH))).toBe(true);
  });
});

describe('bounded Yandex Maps catalog missing streak', () => {
  it('stops rewriting rows after the closure threshold is reached', () => {
    const migrationExists = fs.existsSync(BOUNDED_MARK_SEEN_MIGRATION_PATH);
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const sql = stripSqlComments(
      fs.readFileSync(BOUNDED_MARK_SEEN_MIGRATION_PATH, 'utf8'),
    );
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.yandex_maps_catalog_mark_seen/i,
    );
    expect(sql).toMatch(/and\s+c\.missing_streak\s*<\s*2/i);
  });
});
