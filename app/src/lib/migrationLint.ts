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
 * Единственное исключение — таблицы, у которых права `service_role` отобраны
 * явным поимённым `revoke all on public.X from service_role`. Это не забытый
 * GRANT, а противоположное намерение: к таблице не ходят напрямую, запись и
 * чтение идут через функции с `SECURITY DEFINER`. Требовать GRANT в таком
 * случае значило бы требовать снять замок. См. `findServiceRoleRevokes`.
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
  /** Set only for special cases (e.g. an exemption marker with no reason). */
  note?: string;
}

/**
 * Opt-out marker for tables that intentionally grant direct access to
 * NOBODY, `service_role` included. Written next to the create table:
 *
 *   -- grants-lint: no-service-role-grant public.my_table — reason
 *
 * Why this exists: the linter assumes a new table is meant to be reached
 * directly by the app, which holds for almost every table. Occasionally the
 * opposite is true — the table is sealed with RLS plus `revoke all` from
 * every role, and the app reaches it only through a SECURITY DEFINER
 * function. That is how the client-report rollup activation works: a direct
 * insert would bypass the "run is verified" check the migration exists to
 * enforce. For such a table `grant all ... to service_role` is not a lint
 * fix, it is the very hole the migration was written to close.
 *
 * The reason is MANDATORY and must sit on the marker line itself (following
 * comment lines are free to elaborate): silently exempting something from a
 * privilege check is exactly how such checks rot. A marker without a reason
 * is not accepted and is reported separately.
 */
const EXEMPTION_RX =
  /--\s*grants-lint:\s*no-service-role-grant\s+public\.([A-Za-z_][A-Za-z0-9_]*)([^\n\r]*)/gi;

/**
 * Tables this file declares an intentional exemption for. The value is the
 * stated reason (empty string = marker present, reason missing). Reads the
 * raw SQL: the marker lives in a comment, so it must be seen before
 * stripSqlComments removes it.
 */
export function findGrantExemptions(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(EXEMPTION_RX)) {
    const reason = m[2].replace(/^[\s—:-]+/, '').trim();
    // First marker wins: a duplicate without a reason must not erase the reason.
    if (!out.has(m[1])) out.set(m[1], reason);
  }
  return out;
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

/**
 * Найти таблицы, у которых права `service_role` отобраны ЯВНО и поимённо:
 * `revoke all on [table] public.X from service_role`.
 *
 * Это заявление автора миграции: «к таблице не ходят напрямую». Такие таблицы
 * пишутся и читаются только через функции с `SECURITY DEFINER`, а сама таблица
 * заперта на все роли. Требовать для неё GRANT значило бы требовать снять
 * замок, ради которого её и заперли.
 *
 * Оптовый `revoke ... on all tables in schema public` СОЗНАТЕЛЬНО не
 * распознаётся: одна такая строка выключила бы проверку для всего дерева
 * миграций. Замок засчитывается, только если названа конкретная таблица.
 */
export function findServiceRoleRevokes(sql: string): Set<string> {
  const cleaned = stripSqlComments(sql);
  const out = new Set<string>();

  const rx =
    /revoke\s+[\s\S]+?on\s+(?:table\s+)?public\.([A-Za-z_][A-Za-z0-9_]*)\s+from\s+([^;]+);/gi;
  for (const m of cleaned.matchAll(rx)) {
    if (mentionsServiceRole(m[2])) out.add(m[1]);
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
 *
 * Separately from the allowlist (frozen at the May-2026 snapshot), a marker
 * `-- grants-lint: no-service-role-grant public.X — reason` in the same file
 * that creates the table also suppresses a violation; see EXEMPTION_RX. That
 * one is for tables sealed on purpose.
 */
export function findMissingServiceRoleGrants(
  files: MigrationFile[],
  opts: { allowlist?: Set<string> } = {},
): GrantViolation[] {
  const allowlist = opts.allowlist ?? new Set<string>();

  // Aggregate every GRANT across the whole corpus.
  const globalGranted = new Set<string>();
  // Тем же охватом собираем явные REVOKE: замок может стоять не в той же
  // миграции, что создала таблицу, — ровно как и GRANT.
  const globalRevoked = new Set<string>();
  for (const f of files) {
    for (const t of findGrantsToServiceRole(f.sql)) {
      globalGranted.add(t);
    }
    for (const t of findServiceRoleRevokes(f.sql)) {
      globalRevoked.add(t);
    }
  }
  const hasWildcard = globalGranted.has('*');

  const violations: GrantViolation[] = [];
  for (const f of files) {
    const exemptions = findGrantExemptions(f.sql);
    for (const table of extractCreatedTables(f.sql)) {
      if (hasWildcard) continue;
      if (globalGranted.has(table)) continue;
      // Явно заперта — см. findServiceRoleRevokes. Проверка идёт после GRANT:
      // если права и выданы, и отобраны, таблица уже отсеяна строкой выше, и
      // спорить с порядком выполнения этот линт всё равно не умеет.
      if (globalRevoked.has(table)) continue;
      const key = `${f.name}::${table}`;
      if (allowlist.has(key)) continue;
      const reason = exemptions.get(table);
      if (reason !== undefined) {
        if (reason.length > 0) continue;
        violations.push({
          file: f.name,
          table,
          note: 'есть маркер grants-lint, но не указана причина — допишите её после имени таблицы',
        });
        continue;
      }
      violations.push({ file: f.name, table });
    }
  }
  return violations;
}
