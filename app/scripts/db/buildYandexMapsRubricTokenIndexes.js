/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Строит индексы по токенам рубрик каталога Яндекс.Карт, не блокируя запись.
 *
 * Зачем отдельный скрипт, а не миграция. Обычный `create index` держит на
 * таблице SHARE — запись запрещена на всё время постройки, а это минуты на
 * 9,9 млн строк. В каталог непрерывно пишет фоновый обход, миграции идут в
 * транзакции с `lock_timeout = 30s`, и 08.08.2026 деплой на этом встал:
 * `55P03 canceling statement due to lock timeout`, откат миграции
 * `20260807_0004`, прод остался на старой сборке. Окна без записи не бывает,
 * поэтому повтор деплоя упирался бы в то же самое.
 *
 * `create index concurrently` в миграцию не положить: раннер применяет каждый
 * файл в транзакции, а concurrently в транзакции запрещён. Отсюда — разовый
 * скрипт, который гоняют вручную ДО деплоя:
 *
 *   docker run --rm --network host --env-file .env <образ portal> \
 *     node scripts/db/buildYandexMapsRubricTokenIndexes.js
 *
 * Идёт долго (на боевых 9,9 млн строк — десятки минут на индекс), поэтому
 * запускать лучше под `screen`/`nohup`: обрыв соединения обрывает и постройку.
 * Ничего страшного при этом не происходит — остаётся invalid-индекс, который
 * повторный запуск снесёт и построит заново.
 *
 * Скрипт идемпотентный и безопасный для повторов:
 *   - готовый (valid) индекс пропускается;
 *   - недостроенный (invalid) сносится и строится заново;
 *   - `yandex_maps_rubric_tokens` создаётся здесь же, потому что индексы по
 *     выражению без неё построить нельзя, а миграция ещё не применена.
 *
 * Определения функции и индексов продублированы с миграции
 * `supabase/migrations/20260807_0004_yandex_maps_catalog_rubric_tokens.sql`
 * (иначе порядок «сначала индексы, потом миграция» не собрать). Что копии не
 * разошлись, проверяет app/tests/migrations/yandexMapsRubricTokenIndexes.test.ts.
 */
const { Client } = require('pg');
const {
  loadEnvFiles,
  resolveDbUrl,
  shouldUseSsl,
  connectionConfigWithIPv4,
} = require('./ensureDatabase');

const TABLE = 'public.yandex_maps_company_catalog';

/** Дословно как в миграции 20260807_0004 — сверяется тестом. */
const RUBRIC_TOKENS_FUNCTION_SQL = `create or replace function public.yandex_maps_rubric_tokens(
  p_categories text,
  p_subcategories text
)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_agg(distinct token), '{}'::text[])
    from (
      select btrim(lower(t)) as token
        from unnest(string_to_array(replace(coalesce(p_categories, ''), ' | ', ' / '), ' / ')) t
      union all
      select btrim(lower(t))
        from unnest(string_to_array(coalesce(p_subcategories, ''), ', ')) t
    ) tokens
   where token <> ''
     and octet_length(token) <= 2000
$$;`;

/** Имена и `using`-часть — дословно как в миграции; сверяется тестом. */
const INDEXES = [
  {
    name: 'idx_ymc_rubric_tokens',
    using: 'gin (public.yandex_maps_rubric_tokens(categories, subcategories))',
  },
  {
    name: 'idx_ymc_tokens_city',
    using: 'gin (public.yandex_maps_rubric_tokens(categories, subcategories), city)',
  },
  {
    name: 'idx_ymc_tokens_region',
    using: 'gin (public.yandex_maps_rubric_tokens(categories, subcategories), region)',
  },
];

function log(message) {
  console.log(`[ymc-indexes] ${message}`);
}

function humanDuration(startedAt) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
}

/**
 * Есть ли индекс и достроен ли он. `indisvalid = false` означает оборванный
 * concurrently: имя занято, а планировщик таким индексом не пользуется.
 */
async function indexState(client, name) {
  const { rows } = await client.query(
    `select x.indisvalid
       from pg_index x
       join pg_class i on i.oid = x.indexrelid
      where i.relname = $1
        and i.relnamespace = 'public'::regnamespace
        and x.indrelid = $2::regclass`,
    [name, TABLE],
  );
  if (!rows.length) return 'absent';
  return rows[0].indisvalid ? 'valid' : 'invalid';
}

async function indexSize(client, name) {
  const { rows } = await client.query(
    `select pg_size_pretty(pg_relation_size(($1)::regclass)) as size`,
    [`public.${name}`],
  );
  return rows[0] ? rows[0].size : '?';
}

async function buildIndexes(client) {
  let built = 0;
  let skipped = 0;

  for (const index of INDEXES) {
    const state = await indexState(client, index.name);

    if (state === 'valid') {
      skipped += 1;
      log(`${index.name}: уже построен (${await indexSize(client, index.name)}), пропускаем`);
      continue;
    }

    if (state === 'invalid') {
      // Остаток оборванной постройки. `create ... if not exists` его бы
      // пропустил и оставил каталог без рабочего индекса навсегда.
      log(`${index.name}: найден недостроенный индекс, сносим`);
      await client.query(`drop index concurrently if exists public.${index.name}`);
    }

    log(`${index.name}: строим (concurrently, запись не блокируется)…`);
    const startedAt = Date.now();
    await client.query(
      `create index concurrently ${index.name} on ${TABLE} using ${index.using}`,
    );
    built += 1;
    log(`${index.name}: готов за ${humanDuration(startedAt)} (${await indexSize(client, index.name)})`);
  }

  return { built, skipped };
}

async function main() {
  loadEnvFiles();

  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    console.error('[ymc-indexes] Не задан URL базы данных (DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL).');
    process.exit(1);
  }

  const ssl = shouldUseSsl(dbUrl) ? { rejectUnauthorized: false } : undefined;
  const client = new Client(await connectionConfigWithIPv4(dbUrl, ssl));
  await client.connect();

  try {
    // concurrently сам по себе идёт часами на большой таблице — потолка на
    // длительность быть не должно. lock_timeout при этом нужен: concurrently
    // берёт ShareUpdateExclusive, который конфликтует с другими DDL и VACUUM
    // FULL, и лучше отвалиться с понятной ошибкой, чем висеть в очереди.
    await client.query('set statement_timeout = 0');
    await client.query("set lock_timeout = '60s'");
    // GIN строится по временной куче в памяти; на дефолтных 64 МБ это лишние
    // проходы по диску. Значение с запасом, но не настолько, чтобы задеть
    // остальные процессы на сервере.
    const workMem = (process.env.YMC_INDEX_MAINTENANCE_WORK_MEM || '512MB').trim();
    if (!/^\d+\s*(kB|MB|GB)$/i.test(workMem)) {
      throw new Error(`YMC_INDEX_MAINTENANCE_WORK_MEM: ожидается вида "512MB", получено "${workMem}"`);
    }
    await client.query(`set maintenance_work_mem = '${workMem}'`);

    const { rows: tableRows } = await client.query(
      `select to_regclass($1) is not null as present`,
      [TABLE],
    );
    if (!tableRows[0] || !tableRows[0].present) {
      log(`Таблицы ${TABLE} нет — строить нечего. Сначала миграции каталога.`);
      return;
    }

    // reltuples, а не count(*): точный подсчёт — это seq scan по 13 ГБ, и он
    // тут нужен только чтобы человек в логе увидел масштаб. -1 означает «после
    // создания таблицы analyze не гоняли».
    const { rows: sizeRows } = await client.query(
      `select pg_size_pretty(pg_table_size(c.oid)) as size, c.reltuples::bigint as rows_estimate
         from pg_class c
        where c.oid = ($1)::regclass`,
      [TABLE],
    );
    const estimate = Number(sizeRows[0].rows_estimate);
    log(
      `Каталог: ${sizeRows[0].size}` +
        (estimate >= 0 ? `, примерно ${estimate.toLocaleString('ru-RU')} строк` : ''),
    );

    // Функция нужна раньше индексов по ней, а миграция 20260807_0004 ещё не
    // применена — она как раз и ждёт этих индексов.
    await client.query('create extension if not exists btree_gin');
    await client.query(RUBRIC_TOKENS_FUNCTION_SQL);

    const { built, skipped } = await buildIndexes(client);

    if (built > 0) {
      // Планировщику нужна статистика по новому выражению, иначе он какое-то
      // время будет оценивать его вслепую и может не выбрать индекс.
      log('Обновляем статистику (analyze)…');
      const startedAt = Date.now();
      await client.query(`analyze ${TABLE}`);
      log(`analyze за ${humanDuration(startedAt)}`);
    }

    log(`Готово: построено ${built}, пропущено как готовые ${skipped}. Можно запускать деплой.`);
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ymc-indexes] Ошибка:', err && err.message ? err.message : err);
    console.error(
      '[ymc-indexes] Недостроенный индекс останется в базе как invalid — повторный запуск снесёт его и построит заново.',
    );
    process.exit(1);
  });
}

module.exports = { RUBRIC_TOKENS_FUNCTION_SQL, INDEXES, TABLE };
