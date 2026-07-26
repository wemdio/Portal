-- 021: индексы под дашборд «Нагрузка почт» (/analytics/mailbox-load).
--
-- Зачем: страница тормозила не из-за объёма ответа (он десятки КБ), а из-за трёх
-- отсутствующих индексов. Диагностика 25.07.2026, полный разбор — в коммите
-- вместе с правками app/src/lib/instantly/mailboxLoad.ts.
--
-- Все три — ДОБАВЛЯЮЩИЕ: ничего не удаляют и не меняют данные. CONCURRENTLY,
-- чтобы не брать ACCESS EXCLUSIVE на raw_emails (2.1M+ строк) и не блокировать
-- ночной синк.
--
-- ─── КАК ПРИМЕНЯТЬ (не автоматизировано!) ───────────────────────────────────
-- Миграции ЭТОЙ папки не запускает ни CI, ни деплой: Semaphore автоматически
-- прогоняет только supabase/migrations/ (основная БД, через ensureDatabase.js) и
-- supabase/instantly-migrations/ (операционная instantly-БД, через контейнер
-- instantly-migrator). Аналитический датасет — руками.
--
-- НЕ через q.mjs: node-postgres отправляет весь файл одним simple query, Postgres
-- оборачивает его в неявную транзакцию, и CREATE INDEX CONCURRENTLY падает с
-- «cannot run inside a transaction block». Плюс в q.mjs statement_timeout=60s,
-- а индекс по raw_emails строится дольше.
--
-- Запускать НА СЕРВЕРЕ 139, по одному стейтменту (каждый -c = отдельная
-- транзакция, что и требуется для CONCURRENTLY):
--
--   docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset \
--     -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_campaigns_email_tag_list_gin ON raw_campaigns USING GIN (email_tag_list);"
--
-- ...и так же для двух остальных индексов ниже.
--
-- Проверить результат:
--   docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset \
--     -c "SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid::regclass::text IN ('raw_campaigns_email_tag_list_gin','portal_project_campaigns_campaign_idx','raw_emails_uetype_time_eaccount_idx');"
--
-- Если indisvalid = false (CONCURRENTLY прервался) — DROP INDEX и построить заново.
-- Порядок относительно деплоя кода не важен: запросы работают и без индексов,
-- просто медленнее.

-- ── 1. Главный: связь тег → кампании ────────────────────────────────────────
-- Запрос «тег → специалист/клиент» (mailboxLoad.ts, specRows) джойнит кампании
-- через `raw_campaigns.email_tag_list @> ARRAY[tag_id]`. На TEXT[] без GIN это
-- вырождается в перебор всех ~1881 кампаний с проверкой вхождения массива на
-- каждую пару (тег × кампания). GIN превращает это в индексный поиск.
-- Замечание на будущее: результат этого запроса вообще не зависит от выбранного
-- дня, т.е. пересчитывается идентично на каждую загрузку страницы — кандидат на
-- кеш/материализацию, если после индекса всё ещё будет заметно.
CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_campaigns_email_tag_list_gin
  ON raw_campaigns USING GIN (email_tag_list);

-- ── 2. Обратная сторона того же джойна ──────────────────────────────────────
-- PK на portal_project_campaigns — (project_id, campaign_id), т.е. по
-- campaign_id ведущего индекса нет, а джойн идёт именно `ppc.campaign_id = c.id`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS portal_project_campaigns_campaign_idx
  ON portal_project_campaigns (campaign_id);

-- ── 3. Дневной агрегат отправок по ящикам ───────────────────────────────────
-- Все запросы дашборда считают «сколько писем ушло за день» через
-- `WHERE ue_type = 1 AND timestamp_email >= $1 AND < $1+1 GROUP BY eaccount`.
-- Сейчас есть отдельно (timestamp_email) и отдельно (ue_type) — планировщик берёт
-- диапазон по времени и перепроверяет ue_type в куче построчно. Композит с
-- eaccount в конце делает это index-only и убирает heap-recheck.
CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_emails_uetype_time_eaccount_idx
  ON raw_emails (ue_type, timestamp_email, eaccount);

COMMENT ON INDEX raw_campaigns_email_tag_list_gin IS
  'Дашборд нагрузки почт: тег → кампании через email_tag_list @> ARRAY[tag_id]. Без GIN — перебор всех кампаний.';
COMMENT ON INDEX portal_project_campaigns_campaign_idx IS
  'Джойн по campaign_id (PK ведёт с project_id, поэтому нужен отдельный).';
COMMENT ON INDEX raw_emails_uetype_time_eaccount_idx IS
  'Дневной агрегат отправок по ящикам: (ue_type, timestamp_email, eaccount) — покрывающий, без heap-recheck по ue_type.';
