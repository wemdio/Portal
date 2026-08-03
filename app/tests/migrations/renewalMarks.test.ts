import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260803_0002_renewal_marks.sql'),
  'utf8',
);

// Список, который уже был актуален в external_sync_runs_source_check до этой
// миграции (см. 20260803_0001_amo_tasks.sql) — источники, которые не должны
// отвалиться из-за неполной копипасты CHECK-констрейнта.
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
];

function extractCheckClause(sql: string): string {
  const match = sql.match(/add constraint external_sync_runs_source_check[\s\S]*?\)\);/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('миграция renewal_marks', () => {
  it('создаёт таблицу renewal_marks', () => {
    expect(SQL).toMatch(/create table if not exists public\.renewal_marks/);
  });

  it('transaction_id уникален и ссылается на bank_transactions с cascade', () => {
    expect(SQL).toMatch(
      /transaction_id\s+bigint\s+not null unique\s*\n?\s*references public\.bank_transactions\(id\) on delete cascade/,
    );
  });

  it('ограничивает method списком допустимых значений', () => {
    for (const m of ['task_text', 'project_type', 'manual', 'not_renewal']) {
      expect(SQL).toContain(`'${m}'`);
    }
    expect(SQL).toMatch(
      /check\s*\(method in \('task_text','project_type','manual','not_renewal'\)\)/,
    );
  });

  it('инвариант: is_renewal=false тогда и только тогда, когда method=not_renewal', () => {
    // Без этого констрейнта возможна противоречивая строка «продление=нет»
    // со способом «подтверждено текстом задачи».
    expect(SQL).toMatch(
      /check\s*\(\(is_renewal\s*=\s*false\)\s*=\s*\(method\s*=\s*'not_renewal'\)\)/,
    );
  });

  it('matched_by ссылается на profiles с set null', () => {
    expect(SQL).toMatch(
      /matched_by\s+uuid references public\.profiles\(id\) on delete set null/,
    );
  });

  it('автомат не перезаписывает ручное решение — ни manual, ни not_renewal', () => {
    // Ровно та же ловушка, на которой споткнулась 20260731_0001: условие
    // `<> 'manual'` не защищало not_a_meeting. Здесь оба ручных состояния
    // обязаны быть в одном условии сразу.
    expect(SQL).toMatch(
      /where[\s\S]{0,200}method\s+not in\s*\(\s*'manual'\s*,\s*'not_renewal'\s*\)/i,
    );
  });

  it('не оставляет старое одиночное условие method <> \'manual\' без not_renewal', () => {
    const updateClauses = SQL.match(/on conflict[\s\S]*?where[^;]*;/gi) ?? [];
    expect(updateClauses.length).toBeGreaterThan(0);
    for (const clause of updateClauses) {
      expect(clause).not.toMatch(/method\s*<>\s*'manual'\s*;/i);
    }
  });

  it('кандидаты отсекают первый платёж от ИНН оконной функцией', () => {
    expect(SQL).toMatch(/row_number\(\)\s+over\s*\(\s*partition by bt\.payer_inn/);
    expect(SQL).toMatch(/where ranked\.rn > 1/);
  });

  it('кандидаты требуют is_revenue и credit', () => {
    expect(SQL).toMatch(/bt\.direction = 'credit'/);
    expect(SQL).toMatch(/and bt\.is_revenue/);
  });

  it('дата задачи берётся из updated_at_amo, а не из complete_till', () => {
    // Прямое требование задачи: complete_till — срок задачи, а не момент
    // закрытия. Используем updated_at_amo и явно НЕ используем complete_till
    // как дату сравнения.
    expect(SQL).toMatch(/t\.updated_at_amo at time zone 'Europe\/Moscow'/);
    expect(SQL).not.toMatch(/t\.complete_till at time zone/);
  });

  it('слово продления ищется тем же регэкспом, что и частичный индекс в amo_tasks', () => {
    expect(SQL).toMatch(/result_text ~\* 'продл\|пролонг'/);
  });

  it('окно совпадения по дате — ±14 дней', () => {
    expect(SQL).toMatch(/<= 14/);
  });

  it('сумма из текста задачи ищется через ANY по массиву сумм', () => {
    expect(SQL).toMatch(/c\.amount = any \(amt\.arr\)/);
  });

  it('неоднозначные кандидаты (несколько задач) не выбираются автоматом', () => {
    expect(SQL).toMatch(/count\(\*\) over \(partition by transaction_id\) as n/);
    expect(SQL).toMatch(/where n = 1/);
  });

  it('второй сигнал (project_type) не конкурирует с первым', () => {
    expect(SQL).toMatch(/p\.project_type = 'Продление'/);
    expect(SQL).toMatch(
      /not exists\s*\(\s*select 1 from task_confirmed tc where tc\.transaction_id = pr\.transaction_id\s*\)/,
    );
  });

  it('создаёт apply_renewal_marks()', () => {
    expect(SQL).toMatch(/create or replace function public\.apply_renewal_marks\(\)/);
    expect(SQL).toMatch(/returns integer/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(/alter table public\.renewal_marks\s+enable row level security/);
    expect(SQL).not.toMatch(/create policy .* on public\.renewal_marks for select/);
  });

  it('выдаёт гранты service_role', () => {
    expect(SQL).toMatch(/grant all on public\.renewal_marks\s+to service_role/);
  });

  it('условно выдаёт select readonly-роли', () => {
    expect(SQL).toMatch(/grant select on public\.renewal_marks to readonly/);
  });

  it('пересоздаёт констрейнт (drop if exists перед add — идемпотентность миграции)', () => {
    expect(SQL).toMatch(/drop constraint if exists external_sync_runs_source_check/);
    const dropIdx = SQL.indexOf('drop constraint if exists external_sync_runs_source_check');
    const addIdx = SQL.indexOf('add constraint external_sync_runs_source_check');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  it('добавляет renewal_marks в список допустимых источников', () => {
    const clause = extractCheckClause(SQL);
    expect(clause).toContain("'renewal_marks'");
  });

  it('не теряет ни один из уже работающих источников', () => {
    const clause = extractCheckClause(SQL);
    for (const name of PREVIOUS_SOURCES) {
      expect(clause).toContain(`'${name}'`);
    }
  });
});
