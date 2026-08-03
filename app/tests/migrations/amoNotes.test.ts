import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260803_0003_amo_notes.sql'),
  'utf8',
);

// Список, который уже был актуален в external_sync_runs_source_check до этой
// миграции (см. 20260803_0002_renewal_marks.sql) — источники, которые не
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
  'amo_tasks',
  'renewal_marks',
];

function extractCheckClause(sql: string): string {
  const match = sql.match(/add constraint external_sync_runs_source_check[\s\S]*?\)\);/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('миграция amo_notes', () => {
  it('создаёт таблицу amo_notes', () => {
    expect(SQL).toMatch(/create table if not exists public\.amo_notes/);
  });

  it('amo_note_id уникален — ключ идемпотентности upsert', () => {
    expect(SQL).toMatch(/amo_note_id\s+bigint\s+not null unique/);
  });

  it('amo_deal_id обязателен (not null)', () => {
    expect(SQL).toMatch(/amo_deal_id\s+bigint\s+not null/);
  });

  it('хранит note_type и text', () => {
    expect(SQL).toMatch(/note_type\s+text/);
    expect(SQL).toMatch(/text\s+text/);
  });

  it('хранит created_at_amo timestamptz — единственную метку времени комментария', () => {
    expect(SQL).toMatch(/created_at_amo\s+timestamptz/);
  });

  it('хранит raw jsonb not null и synced_at с default now()', () => {
    expect(SQL).toMatch(/raw\s+jsonb\s+not null/);
    expect(SQL).toMatch(/synced_at\s+timestamptz\s+not null default now\(\)/);
  });

  it('индексирует amo_deal_id — основной способ чтения (все комментарии сделки)', () => {
    expect(SQL).toMatch(/create index if not exists idx_amo_notes_deal_id\s+on public\.amo_notes \(amo_deal_id\)/);
  });

  it('индексирует (amo_deal_id, created_at_amo) под поиск продлений — обычный btree, без частичного регэксп-индекса', () => {
    // Задача явно просила решить и обосновать выбор, а не скопировать
    // приём idx_amo_tasks_renewal_candidates (частичный индекс с ~* в
    // предикате) из 20260803_0001_amo_tasks.sql без проверки на живой БД.
    expect(SQL).toMatch(/create index if not exists idx_amo_notes_deal_created\s+on public\.amo_notes \(amo_deal_id, created_at_amo\)/);
  });

  it('объясняет комментарием, почему НЕ повторён частичный регэксп-индекс из amo_tasks', () => {
    expect(SQL).toMatch(/не проверен на живой БД/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(/alter table public\.amo_notes\s+enable row level security/);
    expect(SQL).not.toMatch(/create policy .* on public\.amo_notes for select/);
  });

  it('выдаёт гранты service_role', () => {
    expect(SQL).toMatch(/grant all on public\.amo_notes\s+to service_role/);
  });

  it('условно выдаёт select readonly-роли', () => {
    expect(SQL).toMatch(/grant select on public\.amo_notes to readonly/);
  });

  it('пересоздаёт констрейнт (drop if exists перед add — идемпотентность миграции)', () => {
    expect(SQL).toMatch(/drop constraint if exists external_sync_runs_source_check/);
    const dropIdx = SQL.indexOf('drop constraint if exists external_sync_runs_source_check');
    const addIdx = SQL.indexOf('add constraint external_sync_runs_source_check');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  it('добавляет amo_notes в список допустимых источников', () => {
    const clause = extractCheckClause(SQL);
    expect(clause).toContain("'amo_notes'");
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
