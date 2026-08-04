/** @jest-environment node */

/**
 * Регрессия на «permission denied for table tg_outreach_warmup_runs».
 *
 * Роут запуска прогрева пишет в tg_outreach_warmup_runs пользовательским
 * клиентом (insert + delete на откате), а не под service_role. Если у
 * authenticated снова останется только select — кнопка «Начать прогрев»
 * молча сломается, и узнают об этом от оператора, а не от CI.
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), '../supabase/migrations');

function allMigrationsSql(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => fs.readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8'))
    .join('\n');
}

describe('tg_outreach_warmup_runs: права на запись для UI', () => {
  const sql = allMigrationsSql();

  it('authenticated имеет grant на insert и delete', () => {
    const grants = sql.match(
      /grant\s+([^;]*?)\s+on\s+public\.tg_outreach_warmup_runs\s+to\s+authenticated\s*;/gi,
    );
    expect(grants).not.toBeNull();
    const granted = (grants ?? []).join(' ').toLowerCase();
    expect(granted).toMatch(/insert/);
    expect(granted).toMatch(/delete/);
  });

  it('есть RLS-политики на insert и delete для authenticated', () => {
    expect(sql).toMatch(
      /create policy\s+\S+\s+on public\.tg_outreach_warmup_runs\s+for insert to authenticated/i,
    );
    expect(sql).toMatch(
      /create policy\s+\S+\s+on public\.tg_outreach_warmup_runs\s+for delete to authenticated/i,
    );
  });

  it('воркер сохраняет полный доступ под service_role', () => {
    expect(sql).toMatch(
      /grant all on public\.tg_outreach_warmup_runs to service_role\s*;/i,
    );
  });
});
