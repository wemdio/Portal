import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260731_0003_meeting_links_sync_source.sql',
  ),
  'utf8',
);

// Список, который уже был актуален в external_sync_runs_source_check до этой
// миграции (см. 20260730_0001_expenses_core.sql) — источники, которые не
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
];

function extractCheckClause(sql: string): string {
  const match = sql.match(/add constraint external_sync_runs_source_check[\s\S]*?\)\);/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('миграция — регистрация meeting_links в external_sync_runs.source', () => {
  it('пересоздаёт констрейнт (drop if exists перед add — идемпотентность миграции)', () => {
    expect(SQL).toMatch(/drop constraint if exists external_sync_runs_source_check/);
    const dropIdx = SQL.indexOf('drop constraint if exists external_sync_runs_source_check');
    const addIdx = SQL.indexOf('add constraint external_sync_runs_source_check');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  it('добавляет meeting_links в список допустимых источников', () => {
    const clause = extractCheckClause(SQL);
    expect(clause).toContain("'meeting_links'");
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
