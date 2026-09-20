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
 * Второе правило в этом файле — зеркальное: `findUnsealedEngineObjects`
 * требует у объектов движков (`he_`/`ve_`) поимённого ОТЗЫВА прав у
 * `anon`/`authenticated`. См. докблок над ним.
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

/** Таблица или функция — у отзыва прав это разные `revoke ... on ...`. */
export type EngineObjectKind = 'table' | 'function';

export interface EngineObjectViolation {
  file: string;
  kind: EngineObjectKind;
  /** Имя без схемы: `he_bases`, `ve_reserve_refill_daily_budget`. */
  name: string;
  /** Заполняется только для особых случаев (маркер без причины). */
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

/*
 * Квалификатор `public.` НЕОБЯЗАТЕЛЕН — и вот почему это не придирка.
 * `search_path` у раннера миграций начинается с `public`, поэтому
 * `create table invoices (...)` создаёт ровно ту же `public.invoices`, что и
 * квалифицированная форма. В дереве так написаны десять существующих
 * объявлений (6 таблиц + 4 функции). Пока регулярки требовали `public.`,
 * такие объекты линт не видел ВООБЩЕ: новая `he_*`/`ve_*` таблица, созданная
 * без квалификатора, уехала бы в прод без отзыва прав, а CI остался бы
 * зелёным. Тихий промах — худший вид промаха для сторожа.
 *
 * Отсюда форма во всех регулярках ниже: `(?:public\.)?ИМЯ\b(?!\s*\.)`.
 *  - `\b(?!\s*\.)` — имя НЕ должно продолжаться точкой. Иначе на
 *    `create table analytics.foo` жадная группа отступила бы по символу и
 *    выдала бы «таблицу `analytic`»: чужая схема должна давать НОЛЬ совпадений,
 *    а не мусорное имя. `\b` не даёт откусить хвост.
 *  - `(?!if\b)` после необязательного `if not exists` — на
 *    `create table if not exists analytics.foo` движок, провалившись на точке,
 *    откатился бы и объявил таблицей слово `if`.
 * Обе ловушки появляются именно от необязательности `public.`; с обязательным
 * квалификатором их не было.
 */

/**
 * Голые цели `alter default privileges ... on tables|sequences|functions`.
 * Это НЕ имена объектов, а ключевые слова, и без квалификатора они выглядят
 * как таблица с таким именем. Отсекаем только неквалифицированную форму:
 * `public.functions` — реальная таблица, `on functions to service_role` —
 * дефолтные привилегии.
 */
const DEFAULT_PRIVILEGE_TARGETS = new Set(['tables', 'sequences', 'functions', 'routines']);

/**
 * Find every `create table [if not exists] [public.]<name>` in the SQL —
 * квалификатор необязателен, см. блок про `(?:public\.)?` выше.
 * Order-preserving, but a table appearing twice in the same file (e.g.
 * idempotent re-declarations) is deduped so callers don't get double
 * violations.
 *
 * `create temp table` сюда не попадает и не должен: `create\s+table` требует
 * `table` сразу за `create`, а временная таблица живёт в `pg_temp`, и грант
 * ей не нужен.
 */
export function extractCreatedTables(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const rx =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?!if\b)(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)/gi;
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

  // Concrete: grant ... on [table] [public.]X to ... service_role
  //
  // Квалификатор здесь тоже необязателен — иначе правка регулярок на создании
  // объектов (см. блок выше) сделала бы нарушителем `client_companies_search_exports`:
  // грант у него есть, но написан без `public.`. Линт обязан видеть обе формы
  // с обеих сторон, иначе снимок нарушений врёт.
  //
  // `[^;]+?` вместо `[\s\S]+?`: ленивый префикс не должен переползать через
  // `;` в СОСЕДНИЙ оператор и выдавать чужое имя за выданный грант — с
  // необязательным `public.` таких «фантомных» имён стало бы больше, а фантом
  // молча гасит нарушение. `\bon` — по той же причине: без границы слова
  // совпадало бы «on» внутри слова (`functi|on `).
  const concreteRx =
    /grant\s+[^;]+?\bon\s+(?:table\s+)?(public\.)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)\s+to\s+([^;]+);/gi;
  for (const m of cleaned.matchAll(concreteRx)) {
    const qualified = Boolean(m[1]);
    const table = m[2];
    const roleList = m[3];
    if (!qualified && DEFAULT_PRIVILEGE_TARGETS.has(table.toLowerCase())) continue;
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
 *
 * Квалификатор `public.` необязателен — зеркально гранту выше: замок, написанный
 * без него, обязан засчитываться, иначе линт потребует GRANT для запертой
 * таблицы.
 */
export function findServiceRoleRevokes(sql: string): Set<string> {
  const cleaned = stripSqlComments(sql);
  const out = new Set<string>();

  const rx =
    /revoke\s+[^;]+?\bon\s+(?:table\s+)?(public\.)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)\s+from\s+([^;]+);/gi;
  for (const m of cleaned.matchAll(rx)) {
    if (!m[1] && DEFAULT_PRIVILEGE_TARGETS.has(m[2].toLowerCase())) continue;
    if (mentionsServiceRole(m[3])) out.add(m[2]);
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

/* ────────────────────────────────────────────────────────────────────────
 * Правило 2: объекты движков (`he_`/`ve_`) обязаны отзывать права поимённо.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Префиксы движков вертикалей: V1 (`he_`, английский кабинет `/client/eng`)
 * и V2 (`ve_`, внутренний RU-движок). Правило намеренно узкое: это
 * мультиарендные таблицы с клиентскими данными (строки лидов с почтой,
 * брифы, тексты писем), и у них нет ни одного сценария, где прямой доступ
 * браузера под `authenticated` был бы нужен — весь код ходит под
 * `service_role`. Распространять правило на всё дерево нельзя: 25 из 40
 * таблиц-движков и десятки прочих таблиц Portal отзыва не делают, правило
 * «по всем» покрасило бы CI в день включения.
 */
const ENGINE_PREFIX_RX = /^(?:he|ve)_/;

/**
 * Маркер-исключение для объекта движка, который сознательно оставлен без
 * статического отзыва. Пишется рядом с созданием объекта:
 *
 *   -- grants-lint: engine-open public.ve_foo — reason
 *
 * Реальный повод, ради которого маркер существует: отзыв, выполненный
 * динамически. `20260903_0001_vertical_engine_v2_contact_supply.sql:521-536`
 * отзывает права циклом `execute format('revoke all on function %s from
 * public, anon, authenticated, service_role', f.signature)` — регулярка такой
 * отзыв не видит в принципе, и без маркера это 21 ложное нарушение.
 *
 * Причина обязательна и должна стоять на самой строке маркера — молча
 * выключенная проверка привилегий ровно так и протухает.
 */
const ENGINE_EXEMPTION_RX =
  /--\s*grants-lint:\s*engine-open\s+public\.([A-Za-z_][A-Za-z0-9_]*)([^\n\r]*)/gi;

/** Объекты, для которых этот файл заявляет осознанное исключение. */
export function findEngineExemptions(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(ENGINE_EXEMPTION_RX)) {
    const reason = m[2].replace(/^[\s—:-]+/, '').trim();
    // Первый маркер выигрывает: дубль без причины не должен стереть причину.
    if (!out.has(m[1])) out.set(m[1], reason);
  }
  return out;
}

/** Ключ объекта в множествах и в allowlist: `table:he_bases`. */
function engineKey(kind: EngineObjectKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * Найти созданные в файле таблицы и функции с префиксом движка.
 *
 * `create or replace function` считается созданием: повторный `or replace`
 * в более поздней миграции — это та же функция, и отзыв прав у неё всё
 * равно должен где-то в дереве существовать.
 */
export function extractCreatedEngineObjects(
  sql: string,
): { kind: EngineObjectKind; name: string }[] {
  const cleaned = stripSqlComments(sql);
  const seen = new Set<string>();
  const out: { kind: EngineObjectKind; name: string }[] = [];

  const push = (kind: EngineObjectKind, name: string) => {
    if (!ENGINE_PREFIX_RX.test(name)) return;
    const key = engineKey(kind, name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };

  // Квалификатор `public.` необязателен — см. блок выше. Для правила движков
  // это и есть дыра из ревью: `create table ve_foo (...)` без `public.`
  // уезжал бы в прод без отзыва прав, а CI оставался бы зелёным.
  const tableRx =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?!if\b)(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)/gi;
  for (const m of cleaned.matchAll(tableRx)) push('table', m[1]);

  const functionRx =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)/gi;
  for (const m of cleaned.matchAll(functionRx)) push('function', m[1]);

  return out;
}

/**
 * Найти объекты, у которых права отобраны ПОИМЁННО у `anon` И `authenticated`.
 *
 * Почему обе роли обязательны, а `from public` недостаточно: права этим двум
 * ролям выданы прямым грантом из
 * `20260509_0003_public_default_privileges_for_postgres.sql:52-68`
 * (`alter default privileges for role postgres ... to authenticated` / `anon`),
 * а не через псевдороль PUBLIC. Отзыв у PUBLIC их не трогает — именно на этом
 * августовские миграции V2 и оставили `security definer`-функции вызываемыми
 * через PostgREST RPC.
 *
 * Одним `revoke` можно закрыть список объектов (`revoke all on table public.a,
 * public.b from ...`), поэтому из левой части берутся все `public.X`.
 * Оптовый `revoke ... on all tables in schema public` сознательно не
 * распознаётся — одна такая строка выключила бы правило для всего дерева.
 *
 * ЕДИНСТВЕННОЕ место, где `public.` остаётся ОБЯЗАТЕЛЬНЫМ (в остальных
 * регулярках он необязателен, см. блок выше). Здесь имена берутся не с
 * фиксированной позиции `on … from`, а сканированием всей левой части, где
 * вперемешку лежат привилегии, слова `all`/`table`/`function` и сигнатуры
 * функций с именами параметров. Без якоря `public.` сюда попал бы параметр
 * вроде `ve_limit int` — и объект `ve_limit` молча считался бы запертым. Это
 * ровно тот тихий промах, который правило и ловит, поэтому промахиваемся в
 * ГРОМКУЮ сторону: неквалифицированный отзыв не засчитается, тест упадёт и
 * попросит ту самую квалифицированную форму, которую печатает в подсказке.
 */
export function findEngineRevokes(
  sql: string,
): Set<string> {
  const cleaned = stripSqlComments(sql);
  const out = new Set<string>();

  // Левая часть (привилегии + цели) до `from`, правая — список ролей.
  // `[\s\S]` — потому что боевой revoke переносится на несколько строк.
  const rx = /revoke\b([\s\S]*?)\bfrom\s+([^;]*);/gi;
  for (const m of cleaned.matchAll(rx)) {
    const targets = m[1];
    const roles = m[2];
    if (!mentionsRole(roles, 'anon') || !mentionsRole(roles, 'authenticated')) continue;
    if (/\ball\s+(?:tables|functions|routines|sequences)\s+in\s+schema\b/i.test(targets)) continue;
    // `revoke ... on public.X` без ключевого слова — это TABLE (умолчание SQL).
    const kind: EngineObjectKind = /\bon\s+function\b/i.test(targets) ? 'function' : 'table';
    for (const t of targets.matchAll(/public\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (ENGINE_PREFIX_RX.test(t[1])) out.add(engineKey(kind, t[1]));
    }
  }

  return out;
}

function mentionsRole(roleList: string, role: string): boolean {
  return roleList
    .toLowerCase()
    .replace(/"/g, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(role);
}

/**
 * Кросс-файловый линт. Для каждого созданного объекта с префиксом `he_`/`ve_`
 * требует, чтобы ГДЕ-ТО в дереве миграций нашёлся поимённый отзыв прав у
 * `anon` и `authenticated` (замок может стоять не в той же миграции, что
 * создала объект, — ровно как и GRANT в правиле выше).
 *
 * Пары из `opts.allowlist` (формат `"<file>::<kind>:<name>"`) подавляются —
 * это замороженный снимок объектов V2, которые отзыва не делают. Снимок
 * фиксирует долг, а не разрешает его наращивать: у новых объектов движков
 * отзыв обязан быть в самой миграции.
 *
 * Единица учёта — ОБЪЕКТ, а не пара (файл, объект): одна и та же функция
 * пересоздаётся через `create or replace` в нескольких миграциях, и нарушение
 * по ней ровно одно. Файлом нарушения считается первая миграция, создавшая
 * объект, — иначе запись в allowlist «переезжала» бы на следующее пересоздание
 * и снимок начинал бы врать.
 */
export function findUnsealedEngineObjects(
  files: MigrationFile[],
  opts: { allowlist?: Set<string> } = {},
): EngineObjectViolation[] {
  const allowlist = opts.allowlist ?? new Set<string>();

  const globalSealed = new Set<string>();
  for (const f of files) {
    for (const key of findEngineRevokes(f.sql)) globalSealed.add(key);
  }

  // key → первое создание объекта + заявленная причина исключения, если она
  // написана в любой из создающих его миграций.
  const created = new Map<
    string,
    { file: string; kind: EngineObjectKind; name: string; reason?: string }
  >();
  for (const f of files) {
    const exemptions = findEngineExemptions(f.sql);
    for (const { kind, name } of extractCreatedEngineObjects(f.sql)) {
      const key = engineKey(kind, name);
      const prev = created.get(key);
      const reason = exemptions.get(name);
      if (!prev) {
        created.set(key, { file: f.name, kind, name, reason });
      } else if (prev.reason === undefined || prev.reason.length === 0) {
        // Маркер с причиной мог появиться в более поздней миграции —
        // засчитываем его, но файл нарушения остаётся прежним.
        if (reason !== undefined) prev.reason = reason;
      }
    }
  }

  const violations: EngineObjectViolation[] = [];
  for (const [key, obj] of created) {
    if (globalSealed.has(key)) continue;
    if (allowlist.has(`${obj.file}::${key}`)) continue;
    if (obj.reason !== undefined) {
      if (obj.reason.length > 0) continue;
      violations.push({
        file: obj.file,
        kind: obj.kind,
        name: obj.name,
        note: 'есть маркер grants-lint, но не указана причина — допишите её после имени объекта',
      });
      continue;
    }
    violations.push({ file: obj.file, kind: obj.kind, name: obj.name });
  }
  return violations;
}
