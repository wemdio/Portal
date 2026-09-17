\set ON_ERROR_STOP on

-- Хранилище «количества филиалов», полученного из Places API 2GIS.
--
-- В закупленной выгрузке этого поля нет: она приходит 14 колонками, и блока
-- org среди них нет (проверено на боевой базе, включая категорию гостиниц).
-- Настоящее число живёт в API — `items.org.branch_count`, «численность
-- филиалов». Его дотягивает фоновый скрипт sync-branch-counts.mjs.
--
-- Почему отдельная таблица, а не колонка в cards: импорт нового среза делает
-- TRUNCATE public.cards и заливает файл заново. Колонка вместе с ней умерла бы
-- при каждом обновлении датасета, и всё пришлось бы выкупать у 2GIS повторно.
-- Эта таблица живёт своей жизнью, внешнего ключа на cards намеренно нет —
-- иначе TRUNCATE ... CASCADE снёс бы и её.
--
-- Идемпотентно. Запускать после 001_schema.sql:
--   psql $TWOGIS_IMPORT_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/2gis-dataset/002_branch_count.sql

DO $guard$
BEGIN
  IF current_database() <> '2gis_dataset' THEN
    RAISE EXCEPTION
      'Refusing 2GIS branch-count install: expected database 2gis_dataset, got %',
      current_database();
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.card_branch_counts (
  card_id text PRIMARY KEY CHECK (btrim(card_id) <> ''),
  org_id text,
  branch_count integer CHECK (branch_count IS NULL OR branch_count >= 0),
  -- ok — 2GIS вернул организацию; no_org — карточка есть, но она не филиал
  -- организации (парковка, остановка); not_found — 2GIS такой id не знает
  -- (карточка закрылась или id устарел с момента выгрузки).
  status text NOT NULL CHECK (status IN ('ok', 'no_org', 'not_found')),
  synced_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.card_branch_counts IS
  'Число филиалов из Places API 2GIS (items.org.branch_count). Переживает переимпорт cards: внешнего ключа нет намеренно.';

-- Для выбора самых давно обновлённых записей при периодическом обновлении.
CREATE INDEX IF NOT EXISTS card_branch_counts_synced_at_idx
  ON public.card_branch_counts (synced_at);

-- Журнал прогонов: видно, сколько запросов потрачено и когда всё встало.
-- Без него расход оплаченного пакета не отследить.
CREATE TABLE IF NOT EXISTS public.branch_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('fill', 'refresh')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  requests integer NOT NULL DEFAULT 0,
  cards_synced integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'budget_spent', 'quota_exhausted', 'failed')),
  note text
);

CREATE INDEX IF NOT EXISTS branch_sync_runs_started_at_idx
  ON public.branch_sync_runs (started_at DESC);

-- Сколько карточек ещё не спрашивали и сколько это стоит в запросах.
CREATE OR REPLACE VIEW public.branch_sync_progress AS
SELECT
  (SELECT count(*) FROM public.cards) AS cards_total,
  (SELECT count(*) FROM public.card_branch_counts) AS cards_synced,
  (SELECT count(*) FROM public.card_branch_counts WHERE branch_count > 1) AS cards_in_networks,
  (SELECT count(*) FROM public.cards) - (SELECT count(*) FROM public.card_branch_counts) AS cards_pending,
  ceil(
    ((SELECT count(*) FROM public.cards) - (SELECT count(*) FROM public.card_branch_counts))::numeric / 100
  )::bigint AS requests_to_finish;

SELECT * FROM public.branch_sync_progress;
