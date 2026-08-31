/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Досье Vertical Engine v2 не должно принимать число строк общей директории
 * за число компаний или готовых контактов. Для него нужен отдельный read-only
 * RPC: общий companies-directory count обслуживает другие поверхности Portal
 * и его семантику менять нельзя.
 */
describe('Vertical Engine v2 directory stats migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('vertical_engine_v2_directory_stats'));
  const text = migrationName
    ? fs.readFileSync(path.join(migrationsDir, migrationName), 'utf8')
    : '';

  it('adds a v2-only stats RPC without changing the shared directory counter', () => {
    expect(migrationName).toBeDefined();
    expect(text).toMatch(/create or replace function public\.ve_directory_segment_stats\s*\(/i);
    expect(text).toMatch(/\bp_okved_prefixes\b/i);
    expect(text).toMatch(/\bp_include_ip\b/i);
    expect(text).toMatch(/public\.companies_directory\b/i);
    expect(text).not.toMatch(
      /(?:create or replace|drop)\s+function\s+(?:if exists\s+)?public\.companies_directory_count_rpc/i,
    );
    expect(text).not.toMatch(/\bhe_/i);
  });

  it('deduplicates companies by non-empty INN and keeps missing-INN rows separate', () => {
    expect(text).toMatch(
      /coalesce\s*\(\s*nullif\s*\(\s*btrim\s*\(\s*c\.inn\s*\)\s*,\s*''\s*\)\s*,\s*'row:'\s*\|\|\s*c\.id::text\s*\)/i,
    );
    expect(text).toMatch(/\bcompany_key\b/i);
    expect(text).toMatch(/group by\s+company_key/i);
    expect(text).toMatch(/['"]companies_unique_total['"]/i);
    expect(text).toMatch(/['"]directory_rows_total['"]/i);
  });

  it('separates known-any-row contacts from contacts on rows matching the exact filters', () => {
    // A company qualifies when at least one directory row matches the supplied
    // market/hypothesis filters. Dossier availability may use a contact known
    // on ANY row of that INN; exact-plan estimates also expose the stricter
    // matched-row-only counter. These are deliberately not interchangeable.
    expect(text).toMatch(/\bqualifying_companies\s+as\s*\(/i);
    expect(text).toMatch(
      /known_contact_rows\s+as\s*\([\s\S]+join public\.companies_directory\s+known_row[\s\S]+known_row\.inn[\s\S]+company_inn[\s\S]+company_inn\s+is\s+not\s+null/i,
    );
    expect(text).toMatch(
      /known_contact_rows\s+as\s*\([\s\S]+union all[\s\S]+known_row\.id\s*=\s*[\s\S]+matched_row_id[\s\S]+company_inn\s+is\s+null/i,
    );
    expect(text).toMatch(/known_contact_rollup\s+as\s*\([\s\S]+from\s+known_contact_rows/i);
    expect(text).toMatch(/matched_contact_rollup\s+as\s*\([\s\S]+from\s+eligible/i);

    expect(text).toMatch(
      /known_contact_rollup\s+as\s*\([\s\S]+bool_or\s*\(\s*nullif\s*\(\s*btrim\s*\(\s*email\s*\)\s*,\s*''\s*\)\s+is\s+not\s+null\s*\)\s+as\s+has_email/i,
    );
    expect(text).toMatch(
      /matched_contact_rollup\s+as\s*\([\s\S]+bool_or\s*\(\s*nullif\s*\(\s*btrim\s*\(\s*email\s*\)\s*,\s*''\s*\)\s+is\s+not\s+null\s*\)\s+as\s+has_email/i,
    );
    expect(text).toMatch(
      /count\s*\(\s*\*\s*\)\s+filter\s*\(\s*where\s+known\.has_email\s*\)\s+as\s+companies_with_email/i,
    );
    expect(text).toMatch(
      /count\s*\(\s*\*\s*\)\s+filter\s*\(\s*where\s+matched\.has_email\s*\)\s+as\s+matched_companies_with_email/i,
    );
    for (const field of [
      'companies_with_email',
      'companies_with_phone',
      'companies_with_any_contact',
      'matched_companies_with_email',
      'matched_companies_with_phone',
      'matched_companies_with_any_contact',
    ]) {
      expect(text).toContain(`'${field}'`);
    }
  });

  it('keeps the full-directory aggregate behind the service role', () => {
    expect(text).toMatch(
      /revoke all on function public\.ve_directory_segment_stats[\s\S]+from public, anon, authenticated/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.ve_directory_segment_stats[\s\S]+to service_role, postgres/i,
    );
    expect(text).not.toMatch(
      /grant execute on function public\.ve_directory_segment_stats[\s\S]+to authenticated/i,
    );
  });
});
