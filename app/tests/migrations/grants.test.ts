/**
 * End-to-end migration GRANT lint.
 *
 * Walks supabase/migrations/*.sql and asserts that every `create table
 * public.X` is matched by at least one `grant ... on public.X ... to
 * service_role` somewhere in the migrations tree — except for the
 * pre-existing baseline of 128 legacy tables grandfathered in
 * grants.allowlist.json (those were created back when the migration
 * runner connected as `supabase_admin` and inherited correct ACLs via
 * default privileges; ретроактивно их править — больше шуму чем пользы).
 *
 * If you add a brand-new migration that creates a `public.X` and this
 * test fails: add an explicit
 *   `grant all on public.X to service_role;`
 *   `grant select, insert, update on public.X to authenticated;`
 * in the same migration (or a companion *_grants.sql). Do NOT extend
 * the allowlist — that's only for the May-2026 snapshot.
 */

import fs from 'fs';
import path from 'path';

import { findMissingServiceRoleGrants } from '@/lib/migrationLint';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const ALLOWLIST_PATH = path.resolve(__dirname, './grants.allowlist.json');

function readMigrations() {
  const names = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  return names.map((name) => ({
    name,
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

function readAllowlist(): Set<string> {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('grants.allowlist.json must be a JSON array of "file::table" strings');
  }
  return new Set(parsed.map((entry) => String(entry)));
}

describe('supabase/migrations GRANT lint', () => {
  it('every newly-created public.X has a GRANT to service_role', () => {
    const files = readMigrations();
    const allowlist = readAllowlist();
    const violations = findMissingServiceRoleGrants(files, { allowlist });

    if (violations.length > 0) {
      const lines = violations
        .map((v) => `  - ${v.file} :: public.${v.table}${v.note ? ` (${v.note})` : ''}`)
        .join('\n');
      const msg =
        'Migration GRANT lint failed. The following tables are created in ' +
        'supabase/migrations/ but no GRANT to service_role exists anywhere ' +
        'in the migrations tree. Add e.g.:\n\n' +
        '  grant all on public.<table> to service_role;\n' +
        '  grant select, insert, update on public.<table> to authenticated;\n\n' +
        'either in the same file or a companion *_grants.sql. Do NOT extend ' +
        'tests/migrations/grants.allowlist.json — that snapshot is frozen.\n\n' +
        'If the table is sealed ON PURPOSE (RLS + revoke all, reached only ' +
        'through a SECURITY DEFINER function), do NOT add the grant — it would ' +
        'open exactly the hole the migration closes. Mark it instead, next to ' +
        'the create table, stating why:\n\n' +
        '  -- grants-lint: no-service-role-grant public.<table> — reason\n\n' +
        `Violations:\n${lines}`;
      throw new Error(msg);
    }

    expect(violations).toEqual([]);
  });

  it('the legacy allowlist never grows beyond its frozen size', () => {
    // Frozen at the May-2026 snapshot of 128 legacy (file, table) pairs.
    // If you genuinely need to add an entry, you almost certainly forgot
    // an explicit GRANT — fix the migration instead of the allowlist.
    const allowlist = readAllowlist();
    expect(allowlist.size).toBeLessThanOrEqual(128);
  });
});
