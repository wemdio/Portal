/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260807_0001_hh_vacancies_employer_id.sql',
);

const sql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

const backfillPath = path.resolve(
  __dirname,
  '../../../supabase/operator-sql/20260807_hh_vacancies_employer_id_backfill.sql',
);

const backfillSql = fs.existsSync(backfillPath)
  ? fs.readFileSync(backfillPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

describe('hh_vacancies employer_id migration', () => {
  it('adds a nullable employer_id column without touching existing columns', () => {
    expect(sql).toContain('alter table public.hh_vacancies');
    expect(sql).toMatch(/add column if not exists employer_id text/);
    // Чисто аддитивная миграция: существующие колонки/индексы/RLS не трогаем,
    // чтобы не сломать автоматизации, читающие таблицу по явным спискам колонок.
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('alter column');
    expect(sql).not.toContain('drop index');
  });

  it('does not backfill inside the transactional migration (table is huge)', () => {
    // hh_vacancies пополняется на ~10-30К строк/день — массовый UPDATE в
    // транзакционной миграции держал бы lock на всей таблице.
    expect(sql).not.toContain('update public.hh_vacancies');
  });

  it('ships an idempotent batched backfill as operator SQL', () => {
    expect(backfillSql).toContain('update public.hh_vacancies');
    expect(backfillSql).toContain("substring(company_url from '/employer/(\\d+)')");
    expect(backfillSql).toContain('employer_id is null');
    // Батчевание через LIMIT — оператор гоняет скрипт до 0 affected rows.
    expect(backfillSql).toContain('limit');
  });
});
