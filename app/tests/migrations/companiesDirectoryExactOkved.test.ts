/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260719_0001_companies_directory_exact_okved.sql',
);

describe('companies directory exact OKVED migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ');

  it('walks OKVED descendants through parent_code instead of assuming dot-only hierarchy', () => {
    expect(sql).toContain('with recursive picked(code) as');
    expect(sql).toContain('join picked p on ch.parent_code = p.code');
  });

  it('uses exact OKVED first and only falls back to the mapped code when exact data is absent', () => {
    expect(sql).toContain('c.okved_code_exact is not null');
    expect(sql).toContain('starts_with(c.okved_code_exact, px)');
    expect(sql).toContain(
      'c.okved_code_exact is null and _okved_codes is not null and c.okved_code = any(_okved_codes)',
    );
  });

  it('fails closed when requested codes do not exist in the reference', () => {
    expect(sql).toContain('p_okved_prefixes is null');
    expect(sql).not.toContain('_okved_codes is null or');
  });
});
