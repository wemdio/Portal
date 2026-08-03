import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260803_0001_amo_tasks.sql'),
  'utf8',
);

// Список, который уже был актуален в external_sync_runs_source_check до этой
// миграции (см. 20260731_0004_crypto_income.sql) — источники, которые не
// должны отвалиться из-за неполной копипасты CHECK-констрейнта.
const PREVIOUS_SOURCES = [
  'metrika',
  'amo_leads',
  'amo_events',
  'bank_tochka',
  'bank_tbank',
  'attribution',
  'amo_enrich',
  'leads_report_marketing',
  'leads_report_outreach',
  'leads_report_summary',
  'brocard',
  'fx_cbr',
  'expense_rules',
  'meeting_links',
  'crypto_usdt',
];

function extractCheckClause(sql: string): string {
  const match = sql.match(/add constraint external_sync_runs_source_check[\s\S]*?\)\);/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('миграция amo_tasks', () => {
  it('создаёт таблицу amo_tasks', () => {
    expect(SQL).toMatch(/create table if not exists public\.amo_tasks/);
  });

  it('amo_task_id уникален — ключ идемпотентности upsert', () => {
    expect(SQL).toMatch(/amo_task_id\s+bigint\s+not null unique/);
  });

  it('хранит result_text — ради него всё затевается', () => {
    expect(SQL).toMatch(/result_text\s+text/);
  });

  it('хранит raw jsonb not null и synced_at с default now()', () => {
    expect(SQL).toMatch(/raw\s+jsonb\s+not null/);
    expect(SQL).toMatch(/synced_at\s+timestamptz\s+not null default now\(\)/);
  });

  it('индексирует amo_deal_id — основной способ чтения (все задачи сделки)', () => {
    expect(SQL).toMatch(/create index if not exists idx_amo_tasks_deal_id\s+on public\.amo_tasks \(amo_deal_id\)/);
  });

  it('есть частичный индекс под поиск задач-кандидатов продления рядом с датой', () => {
    // Частичный индекс на (amo_deal_id, complete_till) с тем же регэкспом,
    // что предполагается в apply_renewal_marks() (Task 2 плана) — покрывает
    // и «слово в результате», и «дата рядом».
    expect(SQL).toMatch(/create index if not exists idx_amo_tasks_renewal_candidates/);
    expect(SQL).toMatch(/where is_completed and result_text ~\* 'продл\|пролонг'/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(/alter table public\.amo_tasks\s+enable row level security/);
    expect(SQL).not.toMatch(/create policy .* on public\.amo_tasks for select/);
  });

  it('выдаёт гранты service_role', () => {
    expect(SQL).toMatch(/grant all on public\.amo_tasks\s+to service_role/);
  });

  it('условно выдаёт select readonly-роли', () => {
    expect(SQL).toMatch(/grant select on public\.amo_tasks to readonly/);
  });

  it('пересоздаёт констрейнт (drop if exists перед add — идемпотентность миграции)', () => {
    expect(SQL).toMatch(/drop constraint if exists external_sync_runs_source_check/);
    const dropIdx = SQL.indexOf('drop constraint if exists external_sync_runs_source_check');
    const addIdx = SQL.indexOf('add constraint external_sync_runs_source_check');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  it('добавляет amo_tasks в список допустимых источников', () => {
    const clause = extractCheckClause(SQL);
    expect(clause).toContain("'amo_tasks'");
  });

  it('не теряет ни один из уже работающих источников', () => {
    // Незарегистрированное имя роняет main.py вне try/except — весь ночной
    // цикл целиком, а не один источник (см. комментарий в самой миграции).
    const clause = extractCheckClause(SQL);
    for (const name of PREVIOUS_SOURCES) {
      expect(clause).toContain(`'${name}'`);
    }
  });
});
