/**
 * Migration GRANT linter.
 *
 * Self-hosted Supabase footgun: our `ensureDatabase.js` migration runner
 * connects as the `postgres` role, but the default-privileges in schema
 * `public` were configured only for objects created by `supabase_admin`.
 * Result: any `CREATE TABLE public.X` from a migration lands with empty
 * ACLs for `service_role`/`authenticated`/`anon`, and the
 * `supabaseAdmin`-backed API gets `permission denied for table ...` at
 * runtime. This bit us in May 2026 with client_support_threads (incident
 * "Не удалось загрузить тред").
 *
 * Long-term fix is `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ...` (see
 * supabase/migrations/20260509_0003_public_default_privileges_for_postgres.sql).
 * This linter is defense-in-depth: it enforces that every new migration
 * explicitly GRANTs the table to `service_role`, so the fix can't be
 * silently regressed by future schema/role changes.
 *
 * Used by app/tests/migrations/grants.test.ts.
 */

export interface MigrationFile {
  /** Filename only, e.g. `20260509_0002_client_support_grants.sql`. */
  name: string;
  /** Full SQL contents of the migration. */
  sql: string;
}

export interface GrantViolation {
  file: string;
  table: string;
}

/**
 * Strip SQL comments so regexes don't match inside `-- ...` or block
 * comments. Conservative — we don't try to be a real SQL parser, only
 * to avoid the most common false positives.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

/**
 * Find every `create table [if not exists] public.<name>` in the SQL.
 * Order-preserving, but a table appearing twice in the same file (e.g.
 * idempotent re-declarations) is deduped so callers don't get double
 * violations.
 */
export function extractCreatedTables(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const rx = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([A-Za-z_][A-Za-z0-9_]*)/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of cleaned.matchAll(rx)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Find every GRANT statement that mentions `service_role` and targets a
 * concrete `public.X` table. Returns the set of granted table names. A
 * wildcard `grant ... on all tables in schema public to ... service_role`
 * is represented by the special token `*` (a catch-all).
 *
 * Roles in PostgreSQL grant lists may be quoted with `"..."` and separated
 * by commas with arbitrary whitespace — we tolerate both.
 */
export function findGrantsToServiceRole(sql: string): Set<string> {
  const cleaned = stripSqlComments(sql);
  const out = new Set<string>();

  // Wildcard: grant ... on all tables in schema public to ... service_role
  const wildcardRx =
    /grant\s+[\s\S]+?on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+([^;]+);/gi;
  for (const m of cleaned.matchAll(wildcardRx)) {
    const roleList = m[1];
    if (mentionsServiceRole(roleList)) out.add('*');
  }

  // Concrete: grant ... on [table] public.X to ... service_role
  const concreteRx =
    /grant\s+[\s\S]+?on\s+(?:table\s+)?public\.([A-Za-z_][A-Za-z0-9_]*)\s+to\s+([^;]+);/gi;
  for (const m of cleaned.matchAll(concreteRx)) {
    const table = m[1];
    const roleList = m[2];
    if (mentionsServiceRole(roleList)) out.add(table);
  }

  return out;
}

function mentionsServiceRole(roleList: string): boolean {
  const normalised = roleList
    .toLowerCase()
    .replace(/"/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return normalised.includes('service_role');
}

/**
 * Cross-file lint. For every `(file, table)` pair where `file` creates
 * `public.X`, require that *some* migration in the corpus contains a
 * matching GRANT to `service_role` (or a wildcard "all tables" GRANT).
 *
 * Entries listed in `opts.allowlist` (format: `"<file>::<table>"`) are
 * suppressed — that's the May-2026 baseline of grandfathered legacy
 * tables we did not retro-fix.
 */
export function findMissingServiceRoleGrants(
  files: MigrationFile[],
  opts: { allowlist?: Set<string> } = {},
): GrantViolation[] {
  const allowlist = opts.allowlist ?? new Set<string>();

  // Aggregate every GRANT across the whole corpus.
  const globalGranted = new Set<string>();
  for (const f of files) {
    for (const t of findGrantsToServiceRole(f.sql)) {
      globalGranted.add(t);
    }
  }
  const hasWildcard = globalGranted.has('*');

  const violations: GrantViolation[] = [];
  for (const f of files) {
    for (const table of extractCreatedTables(f.sql)) {
      if (hasWildcard) continue;
      if (globalGranted.has(table)) continue;
      const key = `${f.name}::${table}`;
      if (allowlist.has(key)) continue;
      violations.push({ file: f.name, table });
    }
  }
  return violations;
}
