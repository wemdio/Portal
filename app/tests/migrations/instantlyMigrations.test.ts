import fs from 'fs';
import path from 'path';

describe('supabase/instantly-migrations compatibility', () => {
  it('does not assume Supabase service_role exists in local Instantly DB grants', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../../supabase/instantly-migrations/20260520_0001_create_project_period_campaigns.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("exists (select 1 from pg_roles where rolname = 'service_role')");
    expect(sql).toContain("exists (select 1 from pg_roles where rolname = 'instantly')");
    expect(sql).toContain('grant all on public.project_period_instantly_campaigns to instantly');
  });
});

describe('instantly_lead_qualifications — сироты (reply_out_of_campaign, eaccount)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../../supabase/instantly-migrations/20260812_0001_lead_qualifications_out_of_campaign.sql',
  );

  it('добавляет колонки сирот идемпотентно (ADD COLUMN IF NOT EXISTS)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Таблица — операционная instantly-БД; ensureDatabase прокатывает миграции
    // при каждом деплое, поэтому только идемпотентная форма.
    expect(sql).toContain('ALTER TABLE public.instantly_lead_qualifications');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS reply_out_of_campaign boolean NOT NULL DEFAULT false',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS eaccount text');
  });

  it('только ALTER существующей таблицы — новых таблиц и grants не требуется', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    // Новая таблица здесь была бы ошибкой: instantly_lead_qualifications и её
    // service-политика существуют с 20260401_0001_init_instantly_schema.
    expect(sql).not.toContain('create table');
    expect(sql).not.toContain('grant ');
  });
});
