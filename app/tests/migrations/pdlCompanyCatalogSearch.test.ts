/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  '..',
  'supabase',
  'migrations',
  '20260901_0001_pdl_company_catalog_search.sql',
);

describe('shared PDL catalog search RPC', () => {
  it('keeps the export description while preserving the filter-first plan', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('create or replace function public.search_pdl_companies');
    expect(sql).toContain('with m as materialized');
    expect(sql).toContain('p.description');
    expect(sql).toContain("set statement_timeout = '120s'");
    expect(sql).toContain('100000');
    expect(sql).toContain('grant execute on function public.search_pdl_companies');
  });
});
