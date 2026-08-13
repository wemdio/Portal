/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Миграции вне транзакции.
 *
 * Раннер оборачивает каждую миграцию в begin/commit — это правильно по
 * умолчанию: половина применённой миграции хуже, чем ни одной. Но
 * `create index concurrently` внутри транзакции запрещён Postgres'ом, а
 * именно он нужен, чтобы построить индекс на горячей таблице, не блокируя
 * запись. Отсюда явный опт-ин маркером в самом файле миграции.
 */

const {
  isNoTransactionMigration,
  splitSqlStatements,
} = require('../../scripts/db/ensureDatabase.js') as {
  isNoTransactionMigration: (sql: string) => boolean;
  splitSqlStatements: (sql: string) => string[];
};

describe('isNoTransactionMigration', () => {
  it('узнаёт маркер отдельной строкой', () => {
    expect(isNoTransactionMigration('-- migrate:no-transaction\ncreate index ...;')).toBe(true);
  });

  it('терпит лишние пробелы и регистр', () => {
    expect(isNoTransactionMigration('--   MIGRATE:No-Transaction   \nselect 1;')).toBe(true);
  });

  it('маркер не обязан быть первой строкой', () => {
    expect(isNoTransactionMigration('-- пояснение\n-- migrate:no-transaction\nselect 1;')).toBe(true);
  });

  it('обычная миграция маркером не считается', () => {
    expect(isNoTransactionMigration('create table public.x (id int);')).toBe(false);
  });

  // Иначе рассказ о маркере в комментарии превратил бы обычную миграцию в
  // нетранзакционную — то есть в незаметно теряющую атомарность.
  it('упоминание внутри текста маркером не считается', () => {
    expect(
      isNoTransactionMigration('-- см. migrate:no-transaction в соседней миграции\nselect 1;'),
    ).toBe(false);
  });
});

describe('splitSqlStatements', () => {
  it('делит по точке с запятой и выбрасывает пустые', () => {
    expect(splitSqlStatements('select 1;\n\nselect 2;\n;\n')).toEqual(['select 1', 'select 2']);
  });

  it('последний statement без точки с запятой не теряется', () => {
    expect(splitSqlStatements('select 1;\nselect 2')).toEqual(['select 1', 'select 2']);
  });

  it('точка с запятой внутри строкового литерала не делит', () => {
    expect(splitSqlStatements("select 'a;b';select 2")).toEqual(["select 'a;b'", 'select 2']);
  });

  it('удвоенная кавычка внутри литерала не сбивает разбор', () => {
    expect(splitSqlStatements("select 'it''s; fine';select 2")).toEqual([
      "select 'it''s; fine'",
      'select 2',
    ]);
  });

  it('точка с запятой в строчном комментарии не делит', () => {
    expect(splitSqlStatements('select 1 -- ; не разделитель\n;select 2')).toEqual([
      'select 1 -- ; не разделитель',
      'select 2',
    ]);
  });

  it('точка с запятой в блочном комментарии не делит', () => {
    expect(splitSqlStatements('select 1 /* ; тоже нет */;select 2')).toEqual([
      'select 1 /* ; тоже нет */',
      'select 2',
    ]);
  });

  it('точка с запятой в кавычках идентификатора не делит', () => {
    expect(splitSqlStatements('select "стран;ное";select 2')).toEqual([
      'select "стран;ное"',
      'select 2',
    ]);
  });

  // Долларовые кавычки (тела функций) корректно разобрать этим сканером
  // нельзя, а молча разрезать функцию пополам — худший из возможных исходов.
  // Такие миграции обязаны оставаться транзакционными, где файл уходит в
  // Postgres целиком одним запросом и парсер нам не нужен вовсе.
  it('долларовые кавычки отвергаются явной ошибкой, а не режутся молча', () => {
    expect(() =>
      splitSqlStatements("create function f() returns int as $$ begin return 1; end $$;"),
    ).toThrow(/долларов/i);
  });
});
