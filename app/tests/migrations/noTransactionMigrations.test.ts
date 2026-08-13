/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Сторож на миграции, помеченные `-- migrate:no-transaction`.
 *
 * Такая миграция применяется без begin/commit и разбивается на statements
 * сканером в ensureDatabase.js. Две ошибки автора видны только на проде во
 * время деплоя, поэтому ловим их здесь:
 *
 *   1) долларовые кавычки — сканер их не разбирает и падает;
 *   2) неидемпотентный statement — упавшая на середине миграция не пишется в
 *      tracking-таблицу и при следующем деплое пойдёт заново с начала.
 */

import fs from 'fs';
import path from 'path';

const {
  isNoTransactionMigration,
  splitSqlStatements,
} = require('../../scripts/db/ensureDatabase.js') as {
  isNoTransactionMigration: (sql: string) => boolean;
  splitSqlStatements: (sql: string) => string[];
};

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

function readNoTransactionMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }))
    .filter((f) => isNoTransactionMigration(f.sql));
}

describe('миграции вне транзакции', () => {
  const files = readNoTransactionMigrations();

  it('такие миграции вообще есть — иначе сторож ничего не охраняет', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => f.name))('%s разбивается на statements без ошибки', (name) => {
    const file = files.find((f) => f.name === name) as { name: string; sql: string };
    expect(() => splitSqlStatements(file.sql)).not.toThrow();
  });

  // Атомарности у такой миграции нет: упав на середине, она оставит применённой
  // первую половину и пойдёт заново при следующем деплое. Единственная защита —
  // идемпотентность каждого statement.
  it.each(files.map((f) => f.name))('%s состоит только из идемпотентных statements', (name) => {
    const file = files.find((f) => f.name === name) as { name: string; sql: string };
    const notIdempotent = splitSqlStatements(file.sql).filter(
      (s) => !/\bif\s+(not\s+)?exists\b/i.test(s),
    );
    expect(notIdempotent).toEqual([]);
  });
});
