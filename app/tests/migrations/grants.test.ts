/**
 * End-to-end migration GRANT lint.
 *
 * Walks supabase/migrations/*.sql and asserts that every `create table
 * [public.]X` is matched by at least one `grant ... on [public.]X ... to
 * service_role` somewhere in the migrations tree — except for the
 * pre-existing baseline of 131 legacy tables grandfathered in
 * grants.allowlist.json (those were created back when the migration
 * runner connected as `supabase_admin` and inherited correct ACLs via
 * default privileges; ретроактивно их править — больше шуму чем пользы)
 * плюс две записи в QUALIFIER_GAP_DEBT ниже — там же написано, чем они
 * отличаются и почему лежат отдельно.
 *
 * Схема в обеих формах, с `public.` и без: `search_path` раннера начинается с
 * `public`, поэтому `create table invoices (...)` создаёт ту же самую
 * `public.invoices`. Пока регулярки требовали квалификатор, такие объявления
 * линт не видел вовсе (10 штук в дереве).
 *
 * If you add a brand-new migration that creates a `public.X` and this
 * test fails: add an explicit
 *   `grant all on public.X to service_role;`
 * in the same migration (or a companion *_grants.sql). Do NOT extend
 * the allowlist — that's only for the May-2026 snapshot.
 *
 * Про `authenticated` тут больше не советуем: у таблицы с клиентскими
 * данными табличный грант этой роли — не помощь, а дыра (см. второй describe
 * ниже и 20260920_0001_he_rls_lockdown.sql). Браузер ходит в такие таблицы
 * через API под service_role, а не напрямую через PostgREST.
 *
 * Второй describe — зеркальное правило для таблиц и функций движков вертикалей
 * (`he_`/`ve_`): у них права `anon`/`authenticated` обязаны быть отозваны
 * поимённо.
 */

import fs from 'fs';
import path from 'path';

import {
  extractCreatedTables,
  findMissingServiceRoleGrants,
  findUnsealedEngineObjects,
} from '@/lib/migrationLint';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const ALLOWLIST_PATH = path.resolve(__dirname, './grants.allowlist.json');
const ENGINE_ALLOWLIST_PATH = path.resolve(__dirname, './engineRevokes.allowlist.json');

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

function readJsonAllowlist(file: string): Set<string> {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(file)} must be a JSON array of strings`);
  }
  return new Set(parsed.map((entry) => String(entry)));
}

/**
 * Два промаха САМОГО правила, вскрытые 20.09.2026 вместе с починкой регулярок
 * (`lib/migrationLint`: квалификатор `public.` стал необязательным).
 *
 * Почему они НЕ в grants.allowlist.json: тот снимок заморожен 12.05.2026 и
 * покрывает объекты по 09.05 включительно. Эти две таблицы созданы ПОЗЖЕ —
 * 18.05 и 06.07 — и должны были упереться в правило ещё тогда. Не упёрлись
 * только потому, что объявлены без `public.` и линт их не видел. Дописать их
 * в «замороженный майский снимок» значило бы задним числом объявить промах
 * правила его же исключением — снимок обязан оставаться честным.
 *
 * Живой дыры в правах тут нет: обе созданы после
 * 20260509_0003_public_default_privileges_for_postgres.sql, и `service_role`
 * получает права дефолтными привилегиями. Не хватает ровно явного GRANT —
 * страховки на случай, если дефолтные привилегии снова слетят (ради чего линт
 * и написан).
 *
 * Список ТОЛЬКО сокращается: закрывается companion-миграцией
 * `grant all on public.<table> to service_role;`, после чего запись удаляется
 * отсюда. Пополнять его нельзя — новая запись означает забытый GRANT.
 */
const QUALIFIER_GAP_DEBT = [
  '20260518_0003_create_invoices.sql::invoices',
  '20260706_0002_outreachos_suppression.sql::outreachos_suppression',
];

function readAllowlist(): Set<string> {
  return new Set([...readJsonAllowlist(ALLOWLIST_PATH), ...QUALIFIER_GAP_DEBT]);
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
        '  grant all on public.<table> to service_role;\n\n' +
        'either in the same file or a companion *_grants.sql. Do NOT extend ' +
        'tests/migrations/grants.allowlist.json — that snapshot is frozen.\n\n' +
        'If the table is sealed ON PURPOSE (RLS + revoke all, reached only ' +
        'through a SECURITY DEFINER function), do NOT add the grant — it would ' +
        'open exactly the hole the migration closes. Say so in one of two ways. ' +
        'An explicit lock, picked up anywhere in the migrations tree:\n\n' +
        '  revoke all on table public.<table> from service_role;\n\n' +
        'or, when there is nothing to revoke, a marker in the same file that ' +
        'creates the table — the reason after the name is mandatory:\n\n' +
        '  -- grants-lint: no-service-role-grant public.<table> — reason\n\n' +
        `Violations:\n${lines}`;
      throw new Error(msg);
    }

    expect(violations).toEqual([]);
  });

  it('the legacy allowlist never grows beyond its frozen size', () => {
    // Снимок майской (2026) легаси-базы. 20.09.2026 пересчитан со 128 до 131:
    // квалификатор `public.` в регулярке стал необязательным, и линт ВПЕРВЫЕ
    // увидел три таблицы, объявленные без него (email_subscriptions,
    // instantly_lead_imports, bot_known_chats). Все три — из файлов от 14.02,
    // 02.03 и 14.04, то есть ровно та же популяция, которую снимок и замораживал:
    // число сдвинулось потому, что снимок был неполным, а не потому, что долг
    // вырос. Новее 09.05.2026 здесь по-прежнему нет ничего (см. QUALIFIER_GAP_DEBT).
    //
    // If you genuinely need to add an entry, you almost certainly forgot
    // an explicit GRANT — fix the migration instead of the allowlist.
    const allowlist = readJsonAllowlist(ALLOWLIST_PATH);
    expect(allowlist.size).toBeLessThanOrEqual(131);
  });

  /**
   * Дыра, из-за которой оба правила этого файла молчали: регулярки требовали
   * `public.<имя>`, а `search_path` раннера начинается с `public`, и десяток
   * объявлений в дереве написаны без квалификатора. Такой объект линт не видел
   * ВООБЩЕ — новая `he_*`/`ve_*` таблица без `public.` уехала бы в прод без
   * отзыва прав, а CI остался бы зелёным.
   *
   * Провалить этот тест в будущем может ровно одно: кто-то «упростит» регулярку
   * обратно к обязательному квалификатору.
   */
  it('sees objects declared without the public. qualifier', () => {
    const seen = new Set(readMigrations().flatMap((f) => extractCreatedTables(f.sql)));
    // Объявлены как `create table if not exists <имя> (` — без схемы.
    for (const table of ['email_subscriptions', 'invoices', 'outreachos_suppression']) {
      expect(seen.has(table)).toBe(true);
    }

    // Главный случай — правило движков: неквалифицированная `ve_*` обязана
    // считаться нарушением, а не пропадать из выдачи.
    const unsealed = findUnsealedEngineObjects([
      { name: '20260920_0002_engine_no_qualifier.sql', sql: 'create table ve_unqualified (id int);' },
    ]);
    expect(unsealed).toEqual([
      { file: '20260920_0002_engine_no_qualifier.sql', kind: 'table', name: 've_unqualified' },
    ]);
  });
});

/**
 * Зеркальное правило для движков вертикалей (engine lint).
 *
 * Класс ошибки, который оно ловит:
 * `20260509_0003_public_default_privileges_for_postgres.sql:52-68` выдаёт
 * `authenticated` полный DML, а `anon` — select на КАЖДУЮ будущую таблицу,
 * созданную раннером миграций. Автор новой `he_*`/`ve_*` таблицы об этом не
 * знает и отзыв не пишет — так `he_bases` (строки лидов с почтой), `he_projects`
 * (брифы) и `he_templates` (тексты писем) месяц были читаемы любым
 * самозарегистрировавшимся пользователем через PostgREST. Забыть отзыв тут
 * ничего не ломает и потому не замечается — ровно поэтому нужен сторож.
 *
 * Правило узкое (только `he_`/`ve_`) намеренно: у остальных таблиц Portal
 * прямой доступ браузера — штатный сценарий, а у движков его нет ни одного.
 */
describe('supabase/migrations engine (he_/ve_) revoke lint', () => {
  it('every he_/ve_ table and function revokes anon+authenticated by name', () => {
    const files = readMigrations();
    const allowlist = readJsonAllowlist(ENGINE_ALLOWLIST_PATH);
    const violations = findUnsealedEngineObjects(files, { allowlist });

    if (violations.length > 0) {
      const lines = violations
        .map((v) => `  - ${v.file} :: ${v.kind} public.${v.name}${v.note ? ` (${v.note})` : ''}`)
        .join('\n');
      const msg =
        'Engine revoke lint failed. Tables and functions prefixed he_/ve_ hold ' +
        'per-tenant client data and are reached only through service_role, but ' +
        'ALTER DEFAULT PRIVILEGES hands anon/authenticated access to every new ' +
        'object the migration runner creates. Take it back by name in the same ' +
        'migration:\n\n' +
        '  revoke all privileges on table public.<name> from public, anon, authenticated;\n' +
        '  grant all on table public.<name> to service_role, postgres;\n\n' +
        'For a function:\n\n' +
        '  revoke all on function public.<name>(<args>) from public, anon, authenticated;\n' +
        '  grant execute on function public.<name>(<args>) to service_role, postgres;\n\n' +
        '`revoke ... from public` alone is NOT enough — anon/authenticated hold a ' +
        'direct grant, not one inherited through PUBLIC.\n\n' +
        'If the revoke is there but dynamic (an `execute format(...)` loop the ' +
        'regex cannot see), declare it in the same file — the reason is ' +
        'mandatory:\n\n' +
        '  -- grants-lint: engine-open public.<name> — reason\n\n' +
        'Do NOT extend tests/migrations/engineRevokes.allowlist.json — that ' +
        'snapshot is the frozen V2 debt and only ever shrinks.\n\n' +
        `Violations:\n${lines}`;
      throw new Error(msg);
    }

    expect(violations).toEqual([]);
  });

  it('the engine allowlist never grows beyond its frozen size', () => {
    // Снимок на 20.09.2026: 38 объектов V2 (13 таблиц + 25 функций), у которых
    // отзыва нет либо он динамический. Все 12 таблиц `he_*` из этого долга уже
    // вышли — 20260920_0001_he_rls_lockdown.sql. Список только уменьшается:
    // новая запись означает, что забыли revoke в свежей миграции, а не что
    // долг вырос законно.
    const allowlist = readJsonAllowlist(ENGINE_ALLOWLIST_PATH);
    expect(allowlist.size).toBeLessThanOrEqual(38);
  });
});
