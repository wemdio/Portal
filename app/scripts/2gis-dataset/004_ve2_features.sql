\set ON_ERROR_STOP on

-- 2ГИС → VE2, шаг Ш5 (docs/reports/2026-10-26-2gis-ve2-plan.md, R3 «Страница»):
-- контракт схемы ve2, по которому страница VE2 (src/lib/verticalEngineV2/twoGisPage.ts)
-- читает горячие карточки, и шаги сборки ve2.card_features. Запускается только в
-- Ш5 под «да», под postgres в базе 2gis_dataset; сейчас не запускается.
--
-- Шаг выбирается переменной psql step (по умолчанию install):
--   install — роль сборщика (NOLOGIN), схемы ve2/ve2_build, гранты, build_state,
--             domain_liveness и build_meta; повторный запуск безопасен и вход не трогает;
--   report  — только чтение: домены с наибольшим числом поддоменов (кандидаты в
--             конструкторы сайтов) до наполнения card_features; -v report_limit=… (500);
--   prepare — одной транзакцией вне импорта: пустая ve2.card_features_new. Снимок
--             сборки в ve2_build.build_meta пишет только -v new_build=1 — один раз, в
--             начале сборки, до того как сборщик прочтёт первую карточку; без него
--             prepare лишь сбрасывает таблицу той же сборки и отказывает, если с её
--             начала был импорт;
--   index   — первичный ключ, частичный горячий индекс, VACUUM (ANALYZE); повторный
--             запуск безопасен;
--   swap    — подмена card_features и запись build_state одной транзакцией;
--             нужны -v snapshot_id=… -v features_version=…; текущий снимок, снимок
--             начала сборки (new_build=1) и snapshot_id совпадают; таблица не пуста и
--             видима для VACUUM; любой INSERT/UPDATE/DELETE после index требует index
--             заново; пересборка того же снимка — только с большим features_version.
-- Строки card_features — все кандидаты сборки (сайт свой или на конструкторе,
-- на домене меньше 10 карточек, название не пусто). Одна карточка на домен —
-- уже на странице (DISTINCT ON домена) и в журнале линии ve_twogis_rows, поэтому
-- статического «представителя пары» в таблице нет.
--
-- Вход сборщика — только на окно Ш5 (всё под postgres, под «да»), строго по порядку:
--   1) копия pg_hba.conf окна Ш5: в контейнере main-postgres
--      cp /etc/postgresql/pg_hba.conf /etc/postgresql/pg_hba.conf.bak-<дата>-sh5,
--      затем docker cp той же копии на хост (/root/pg_hba.conf.bak-<дата>-sh5);
--   2) пока роль NOLOGIN (строки ни на что не действуют), в pg_hba.conf до строки
--      `host all all 127.0.0.1/32 trust`:
--        host  2gis_dataset  twogis_ve2_builder  172.16.0.0/12  scram-sha-256
--        host  all           twogis_ve2_builder  all            reject
--      затем SELECT pg_reload_conf(); и проверить pg_hba_file_rules — без них роль
--      вошла бы и в основную базу postgres (CONNECT и TEMP там у PUBLIC);
--   3) только теперь ALTER ROLE twogis_ve2_builder LOGIN; пароль — только
--      SCRAM-верификатором в сессии с выключенным логированием, ровно как в Ш3
--      (README, «VE2 user»); открытый пароль — только в env-файле сборщика (0600,
--      для docker run --env-file);
--   4) после swap: ALTER ROLE twogis_ve2_builder NOLOGIN; завершить его сеансы
--      (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename =
--      'twogis_ve2_builder';); удалить env-файл сборщика. Строки pg_hba сборщика
--      можно оставить: reject защищает.
-- Откат, строго по порядку:
--   1) ALTER ROLE twogis_ve2_builder NOLOGIN; завершить его сеансы; удалить env-файл;
--   2) в 2gis_dataset: DROP SCHEMA ve2, ve2_build CASCADE; DROP OWNED BY
--      twogis_ve2_builder; DROP ROLE twogis_ve2_builder;
--   3) убрать из pg_hba.conf только две строки twogis_ve2_builder (или вернуть копию
--      окна Ш5 из шага 1). НИКОГДА не копию Ш3 /root/pg_hba.conf.bak-20261026 и не
--      sh3/hba_rollback.sh: они снимут и строки twogis_ve2. Затем
--      SELECT pg_reload_conf(); и проверить в pg_hba_file_rules, что строки
--      twogis_ve2 на месте.

DO $guard$
BEGIN
  IF current_database() <> '2gis_dataset' THEN
    RAISE EXCEPTION
      'Refusing VE2 features setup: expected database 2gis_dataset, got %',
      current_database();
  END IF;
END
$guard$;

\if :{?step}
\else
  \set step install
\endif
SELECT :'step' = 'install' AS ve2_install, :'step' = 'report' AS ve2_report, :'step' = 'prepare' AS ve2_prepare,
  :'step' = 'index' AS ve2_index, :'step' = 'swap' AS ve2_swap,
  :'step' IN ('install', 'report', 'prepare', 'index', 'swap') AS ve2_known_step \gset
\if :ve2_known_step
\else
  DO $unknown$ BEGIN RAISE EXCEPTION 'Unknown step: expected install, report, prepare, index or swap'; END $unknown$;
\endif

\if :ve2_install
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twogis_ve2_builder') THEN
    CREATE ROLE twogis_ve2_builder NOLOGIN NOINHERIT CONNECTION LIMIT 2;
  END IF;
END
$role$;

-- LOGIN/NOLOGIN здесь не задаём: повторный install посреди окна Ш5 не выключает вход.
ALTER ROLE twogis_ve2_builder NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 2;
-- Только для входа самого сборщика: на SET ROLE эти настройки не действуют, поэтому
-- шаги этого файла (под postgres) ставят свои пределы сами.
ALTER ROLE twogis_ve2_builder SET statement_timeout = '120s';
ALTER ROLE twogis_ve2_builder SET lock_timeout = '3s';
ALTER ROLE twogis_ve2_builder SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE twogis_ve2_builder SET max_parallel_workers_per_gather = 0;
ALTER ROLE twogis_ve2_builder SET maintenance_work_mem = '256MB';

GRANT CONNECT ON DATABASE "2gis_dataset" TO twogis_ve2_builder;
GRANT USAGE ON SCHEMA public TO twogis_ve2_builder;
GRANT SELECT ON public.cards, public.card_subcategories, public.dataset_snapshots, public.facet_subcategories
  TO twogis_ve2_builder;

-- ve2 — то, что читает VE2; ve2_build — промежуточные таблицы и выгрузка новизны
-- из основной базы, читателю недоступны.
CREATE SCHEMA IF NOT EXISTS ve2 AUTHORIZATION twogis_ve2_builder;
CREATE SCHEMA IF NOT EXISTS ve2_build AUTHORIZATION twogis_ve2_builder;
REVOKE ALL ON SCHEMA ve2, ve2_build FROM PUBLIC;
GRANT USAGE ON SCHEMA ve2 TO twogis_ve2;
ALTER DEFAULT PRIVILEGES FOR ROLE twogis_ve2_builder IN SCHEMA ve2 GRANT SELECT ON TABLES TO twogis_ve2;

-- Постоянные таблицы создаёт сам сборщик: права по умолчанию дадут читателю SELECT.
SET ROLE twogis_ve2_builder;

CREATE TABLE IF NOT EXISTS ve2.build_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id bigint NOT NULL CHECK (snapshot_id > 0),
  features_version integer NOT NULL CHECK (features_version > 0),
  built_at timestamptz NOT NULL,
  card_rows bigint NOT NULL CHECK (card_rows >= 0),
  hot_rows bigint NOT NULL CHECK (hot_rows >= 0)
);

-- Живость сайта — по правилам читателя сайта VE2, иначе горячую карточку гейт не
-- прочтёт. Источник истины — relevanceEvidence.ts, fetchEvidencePage; сборщику Ш5
-- лучше вызывать оттуда чистый предикат, если его удастся вынести (не в 3a):
--   начать с https://host; http://host — только если https не прошёл;
--   не больше 3 переходов, каждый — на тот же host (с точностью до www), только
--   порты 80/443;
--   шага https→http нет: такой сайт 'http', только если проходит сам http://host;
--   на каждом шаге все A-записи — публичные IPv4;
--   ответ 2xx с content-type ровно text/html, text/plain или application/xhtml+xml
--   и телом не больше 1 МБ, прочитанным за 5 с.
-- outcome = 'live' только так; scheme — схема старта, которая прошла. Другие
-- переходы — 'off_domain', другой ответ или содержимое — 'http_error'.
-- Строка 2ГИС получает http://host, только если scheme = 'http'.
CREATE TABLE IF NOT EXISTS ve2.domain_liveness (
  host text PRIMARY KEY CHECK (host = lower(host) AND host !~ '^www\.'),
  site_domain text NOT NULL CHECK (site_domain = lower(site_domain)),
  outcome text NOT NULL CHECK (outcome IN ('live', 'no_dns', 'no_answer', 'http_error', 'off_domain', 'parked')),
  scheme text CHECK (scheme IN ('https', 'http')),
  http_status smallint,
  checked_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 1 CHECK (attempts > 0),
  CHECK (outcome <> 'live' OR scheme IS NOT NULL)
);

-- Снимок, с которого начата текущая сборка (пишет prepare): swap сверяет с ним,
-- а не только с переданным -v snapshot_id.
CREATE TABLE IF NOT EXISTS ve2_build.build_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id bigint NOT NULL CHECK (snapshot_id > 0),
  prepared_at timestamptz NOT NULL
);

RESET ROLE;
-- Таблицы прошлых запусков (созданные до прав по умолчанию).
GRANT SELECT ON ALL TABLES IN SCHEMA ve2 TO twogis_ve2;
\endif

\if :ve2_report
\if :{?report_limit}
\else
  \set report_limit 500
\endif
-- Кандидаты в конструкторы сайтов: домены, под которыми больше всего разных
-- поддоменов (от трёх). Домен здесь — приближение (две последние метки, три — для
-- com.ru и подобных); точный ключ — veTwoGisSiteDomain (twoGisRows.ts). Список
-- сверить с VE_TWO_GIS_SITE_BUILDERS до наполнения card_features.
BEGIN READ ONLY;
SET LOCAL ROLE twogis_ve2_builder;
SET LOCAL statement_timeout = '600s';
SET LOCAL max_parallel_workers_per_gather = 0;
DO $import$
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtext('portal:2gis-dataset:snapshot-import')) THEN
    RAISE EXCEPTION 'A 2GIS snapshot import is running';
  END IF;
END
$import$;
WITH site AS (
  SELECT regexp_replace(lower(substring(regexp_replace(
      split_part(regexp_replace(btrim(c.website), '[[:space:],;|]+', ' ', 'g'), ' ', 1),
      '^[[:alpha:]][[:alnum:]+.-]*://', ''), '^[^/?#:]+')), '^(www\.)+', '') AS host
  FROM public.cards c
  WHERE c.has_website
),
domain AS (
  SELECT host, CASE WHEN host ~ '\.(com|net|org|pp|msk|spb)\.ru$|\.ru\.com$|\.com\.ua$'
      THEN substring(host FROM '[^.]+\.[^.]+\.[^.]+$') ELSE substring(host FROM '[^.]+\.[^.]+$') END AS site_domain
  FROM site
  WHERE host LIKE '%.%'
)
SELECT site_domain, count(DISTINCT host) AS hosts, count(*) AS cards
FROM domain
WHERE site_domain IS NOT NULL
GROUP BY site_domain
HAVING count(DISTINCT host) >= 3
ORDER BY count(DISTINCT host) DESC, count(*) DESC
LIMIT :'report_limit'::integer;
ROLLBACK;
\endif

\if :ve2_prepare
\if :{?new_build}
\else
  \set new_build 0
\endif
-- Одна транзакция: импорт не идёт. new_build=1 начинает сборку на текущем снимке;
-- без него — та же сборка, и снимок с её начала не должен смениться.
BEGIN;
SET LOCAL ROLE twogis_ve2_builder;
SET LOCAL lock_timeout = '3s';
SELECT set_config('ve2.new_build', :'new_build', true);
DO $meta$
DECLARE
  new_build text := current_setting('ve2.new_build');
  current_snapshot bigint;
  prepared_snapshot bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtext('portal:2gis-dataset:snapshot-import')) THEN
    RAISE EXCEPTION 'A 2GIS snapshot import is running';
  END IF;
  IF new_build NOT IN ('0', '1') THEN
    RAISE EXCEPTION 'new_build must be 0 or 1, got %', new_build;
  END IF;
  SELECT ds.id INTO current_snapshot FROM public.dataset_snapshots ds ORDER BY ds.imported_at DESC, ds.id DESC LIMIT 1;
  IF current_snapshot IS NULL THEN
    RAISE EXCEPTION 'No 2GIS snapshot is imported';
  END IF;
  SELECT bm.snapshot_id INTO prepared_snapshot FROM ve2_build.build_meta bm WHERE bm.singleton;
  IF new_build = '1' THEN
    INSERT INTO ve2_build.build_meta (singleton, snapshot_id, prepared_at)
    VALUES (true, current_snapshot, now())
    ON CONFLICT (singleton) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id, prepared_at = EXCLUDED.prepared_at;
  ELSIF prepared_snapshot IS NULL THEN
    RAISE EXCEPTION 'No build is started — start one with -v new_build=1 before the builder reads any card';
  ELSIF prepared_snapshot <> current_snapshot THEN
    RAISE EXCEPTION 'Import since this build started — start a new build with -v new_build=1';
  END IF;
END
$meta$;
DROP TABLE IF EXISTS ve2.card_features_new;
-- Одна строка на карточку-кандидата. Флаги — чистые функции сборщика, версия —
-- features_version (в флаге базы и в build_state).
CREATE TABLE ve2.card_features_new (
  card_id text NOT NULL CHECK (btrim(card_id) <> ''),                                  -- = public.cards.id
  features_version integer NOT NULL CHECK (features_version > 0),
  host text NOT NULL CHECK (host ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' AND host !~ '^www\.'),  -- punycode, без www/пути/запроса
  -- veTwoGisSiteDomain(host): весь хост на конструкторе сайтов, иначе домен по tldts.
  registrable_domain text NOT NULL CHECK (registrable_domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'
    AND (host = registrable_domain OR right(host, length(registrable_domain) + 1) = '.' || registrable_domain)),
  site_kind text NOT NULL CHECK (site_kind IN ('own', 'builder')),
  site_scheme text NOT NULL DEFAULT 'https' CHECK (site_scheme IN ('https', 'http')),  -- из domain_liveness.scheme
  domain_cards integer NOT NULL CHECK (domain_cards BETWEEN 1 AND 9),                 -- карточек с сайтом на этом домене
  region_code text CHECK (region_code ~ '^[0-9]{2}$'),                                 -- коды FEDERAL_DISTRICTS
  region_source text CHECK (region_source IN ('ops', 'ops_prefix', 'city')),
  city_key text NOT NULL,                                                              -- veTwoGisCityKey(city_name)
  is_non_company boolean NOT NULL,
  is_private_rubric boolean NOT NULL,
  is_ip_name boolean NOT NULL,
  is_government boolean NOT NULL,
  in_directory_site boolean NOT NULL,
  in_directory_email boolean NOT NULL,
  in_yandex boolean NOT NULL,
  liveness text NOT NULL CHECK (liveness IN ('live', 'no_dns', 'no_answer', 'http_error', 'off_domain', 'parked', 'unchecked')),
  -- Горячая — новый для нас и живой домен: только такие читает страница VE2.
  hot boolean GENERATED ALWAYS AS (NOT (in_directory_site OR in_directory_email OR in_yandex) AND liveness = 'live') STORED,
  CHECK ((region_code IS NULL) = (region_source IS NULL)),
  CHECK (liveness <> 'unchecked' OR in_directory_site OR in_directory_email OR in_yandex)
);
COMMIT;
SELECT snapshot_id, prepared_at FROM ve2_build.build_meta;
\endif

\if :ve2_index
-- Повторный запуск после обрыва доходит до VACUUM: ключ и индекс не создаются дважды.
SET ROLE twogis_ve2_builder;
SET max_parallel_maintenance_workers = 0;
DO $pkey$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 've2.card_features_new'::regclass AND contype = 'p') THEN
    ALTER TABLE ve2.card_features_new ADD CONSTRAINT card_features_new_pkey PRIMARY KEY (card_id);
  END IF;
END
$pkey$;
-- Страница читает только горячие строки: Index Only Scan по этому индексу (Heap Fetches 0 после VACUUM).
CREATE INDEX IF NOT EXISTS card_features_new_hot_idx ON ve2.card_features_new (card_id)
  INCLUDE (registrable_domain, host, site_scheme, region_code, city_key, is_non_company, is_private_rubric,
    is_ip_name, is_government)
  WHERE hot;
VACUUM (ANALYZE) ve2.card_features_new;
RESET max_parallel_maintenance_workers;
RESET ROLE;
\endif

\if :ve2_swap
\if :{?snapshot_id}
\else
  DO $missing$ BEGIN RAISE EXCEPTION 'swap needs -v snapshot_id=… -v features_version=…'; END $missing$;
\endif
\if :{?features_version}
\else
  DO $missing$ BEGIN RAISE EXCEPTION 'swap needs -v snapshot_id=… -v features_version=…'; END $missing$;
\endif
-- Одна транзакция: импорт не идёт, текущий снимок — тот, на котором начата сборка
-- (prepare -v new_build=1), и тот, что передан; иначе ничего не меняется (ROLLBACK).
-- После импорта сборку начинают заново: prepare -v new_build=1 и полный проход сборщика.
BEGIN;
SET LOCAL ROLE twogis_ve2_builder;
SET LOCAL lock_timeout = '3s';
SELECT set_config('ve2.expected_snapshot_id', :'snapshot_id', true),
  set_config('ve2.expected_features_version', :'features_version', true);
DO $swap$
DECLARE
  expected_snapshot bigint := current_setting('ve2.expected_snapshot_id')::bigint;
  expected_version integer := current_setting('ve2.expected_features_version')::integer;
  current_snapshot bigint;
  prepared_snapshot bigint;
  built_snapshot bigint;
  built_version integer;
  heap_pages bigint;
  visible_pages integer;
  total_rows bigint;
  hot_total bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtext('portal:2gis-dataset:snapshot-import')) THEN
    RAISE EXCEPTION 'A 2GIS snapshot import is running';
  END IF;
  SELECT ds.id INTO current_snapshot FROM public.dataset_snapshots ds ORDER BY ds.imported_at DESC, ds.id DESC LIMIT 1;
  IF current_snapshot IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'Current snapshot % is not the built snapshot %', current_snapshot, expected_snapshot;
  END IF;
  SELECT bm.snapshot_id INTO prepared_snapshot FROM ve2_build.build_meta bm WHERE bm.singleton;
  IF prepared_snapshot IS NULL THEN
    RAISE EXCEPTION 've2_build.build_meta is empty: start the build with prepare -v new_build=1';
  END IF;
  IF prepared_snapshot <> expected_snapshot THEN
    RAISE EXCEPTION 'The build was started on snapshot %, not on snapshot %', prepared_snapshot, expected_snapshot;
  END IF;
  -- Пересборка того же снимка с той же версией не сделала бы флаги близнецов устаревшими.
  SELECT bs.snapshot_id, bs.features_version INTO built_snapshot, built_version FROM ve2.build_state bs WHERE bs.singleton;
  IF built_snapshot = expected_snapshot AND built_version >= expected_version THEN
    RAISE EXCEPTION 'Rebuild of snapshot % needs features_version above %', expected_snapshot, built_version;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 've2' AND indexname = 'card_features_new_hot_idx') THEN
    RAISE EXCEPTION 'Run step index before swap';
  END IF;
  IF EXISTS (SELECT 1 FROM ve2.card_features_new WHERE features_version <> expected_version) THEN
    RAISE EXCEPTION 'card_features_new has rows of another features_version than %', expected_version;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE hot) INTO total_rows, hot_total FROM ve2.card_features_new;
  IF total_rows = 0 THEN
    RAISE EXCEPTION 'card_features_new is empty';
  END IF;
  -- Любой INSERT/UPDATE/DELETE после index снимает видимость страниц, а relallvisible
  -- остаётся от VACUUM: такие правки видны по счётчику с последнего ANALYZE шага index.
  -- Счётчик сеанс сборщика сбрасывает в статистику после коммита (не позже его выхода),
  -- swap идёт отдельным psql позже.
  IF COALESCE((SELECT st.n_mod_since_analyze FROM pg_stat_user_tables st
      WHERE st.relid = 've2.card_features_new'::regclass), 0) > 0 THEN
    RAISE EXCEPTION 'card_features_new changed after step index — re-run step index';
  END IF;
  -- Index Only Scan страницы без похода в таблицу — только по карте видимости после VACUUM.
  -- Сравниваем с настоящим размером таблицы, а не с relpages последнего VACUUM: строки,
  -- дописанные после index, лежат на ещё не видимых страницах.
  SELECT c.relallvisible, pg_relation_size(c.oid) / current_setting('block_size')::integer
  INTO visible_pages, heap_pages
  FROM pg_class c WHERE c.oid = 've2.card_features_new'::regclass;
  IF visible_pages < heap_pages * 0.95 THEN
    RAISE EXCEPTION 'VACUUM has not marked card_features_new all-visible (long transaction?) — re-run step index';
  END IF;
  DROP TABLE IF EXISTS ve2.card_features;
  ALTER TABLE ve2.card_features_new RENAME TO card_features;
  ALTER TABLE ve2.card_features RENAME CONSTRAINT card_features_new_pkey TO card_features_pkey;
  ALTER INDEX ve2.card_features_new_hot_idx RENAME TO card_features_hot_idx;
  INSERT INTO ve2.build_state (singleton, snapshot_id, features_version, built_at, card_rows, hot_rows)
  VALUES (true, expected_snapshot, expected_version, now(), total_rows, hot_total)
  ON CONFLICT (singleton) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id, features_version = EXCLUDED.features_version,
    built_at = EXCLUDED.built_at, card_rows = EXCLUDED.card_rows, hot_rows = EXCLUDED.hot_rows;
END
$swap$;
COMMIT;
-- Для отдельной правки настроек под «да» (snapshot_id, features_version, built_at).
SELECT snapshot_id, features_version, built_at, card_rows, hot_rows FROM ve2.build_state;
\endif
