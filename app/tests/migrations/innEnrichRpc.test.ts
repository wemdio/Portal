/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Locks the inn_enrich_fetch RPC migration (internal /tools/inn-enrich tool).
 *
 * Why a NEW function instead of extending companies_directory_fetch_rpc:
 * the shared fetch RPC is the production backend of both «Наша база баз»
 * and the client companies-search (and, transitively, ENG paths). The
 * enrichment tool needs fields the shared RPC deliberately does not expose
 * (director FIO, okpo, pf_reg_number, branch_code, gln, registry_status…),
 * so it gets an isolated function — changes here can never break those
 * surfaces.
 *
 * Contract points the tool relies on:
 *  - best-row-per-INN: companies_directory holds multiple rows per INN
 *    (different source files); DISTINCT ON picks the most complete one
 *    (contacts outrank financials), ties break on the lowest id for
 *    determinism.
 *  - okved_code coalesces the exact code over the mapped one, matching the
 *    2026-07 exact-ОКВЭД logic already live in prod.
 *  - service_role only: the tool calls it through supabaseAdmin; anonymous
 *    and client-role access to a full-directory dump must stay closed.
 */
describe('inn_enrich_fetch RPC migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('inn_enrich_fetch'));

  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('defines the function with the full enrichment field set', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');

    expect(sql).toMatch(/create or replace function public\.inn_enrich_fetch\(\s*p_inn_list text\[\]\s*\)/i);

    for (const col of [
      'name', 'inn', 'kpp', 'ogrn', 'address', 'phones', 'email', 'website',
      'registry_status', 'registration_date',
      'director_last_name', 'director_first_name', 'director_middle_name',
      'activity_type', 'employees_count', 'revenue', 'cost',
      'edo_id', 'egais', 'okpo', 'pf_reg_number', 'branch_code', 'gln',
    ]) {
      expect(sql).toContain(`c.${col}`);
    }

    // ОКВЭД: exact побеждает mapped, название — из справочника.
    expect(sql).toMatch(/coalesce\(c\.okved_code_exact, c\.okved_code\) as okved_code/i);
    expect(sql).toMatch(/left join public\.okved_reference/i);
    expect(sql).toMatch(/ok\.name as okved_name/i);
  });

  it('picks the most complete row per INN (distinct on + weighted score)', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/distinct on \(c\.inn\)/i);
    // Контакты весят больше финансов — смысл тула: добыть точку контакта.
    expect(sql).toMatch(/c\.phones[\s\S]*then 3/i);
    expect(sql).toMatch(/c\.email[\s\S]*then 3/i);
    expect(sql).toMatch(/c\.website[\s\S]*then 2/i);
    // Детерминированный tiebreak.
    expect(sql).toMatch(/c\.id asc/i);
    expect(sql).toMatch(/c\.inn = any\(p_inn_list\)/i);
  });

  it('is service_role only', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/revoke execute on function public\.inn_enrich_fetch\(text\[\]\)[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.inn_enrich_fetch\(text\[\]\)[\s\S]*to service_role/i);
    expect(sql).not.toMatch(/grant execute on function public\.inn_enrich_fetch[\s\S]*to authenticated/i);
  });
});
