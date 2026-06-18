-- Yandex Direct Parser — детальные ошибки в UI.
--
-- До этой миграции в карточке job'а показывалось только число ошибок
-- (`errors_count`), а тексты конкретных ошибок (XMLStock 403, нет баланса,
-- невалидный ключ и т.п.) уходили только в логи воркера. Чтобы отдиагностировать
-- упавший прогон, приходилось лезть на прод-сервер по SSH.
--
-- Колонка `errors_sample` хранит сгруппированный по тексту срез ошибок:
--   [
--     {
--       "message": "XMLStock 403: forbidden",
--       "count": 5400,
--       "first_keyword": "crm для бизнеса",
--       "first_region": "Москва",
--       "last_seen_at": "2026-06-18T12:34:56Z"
--     },
--     ...
--   ]
-- Cap в runner.ts: топ-20 уникальных текстов (по count). Этого хватает для
-- диагностики — обычно все ошибки укладываются в 1-3 типа.

alter table public.yandex_direct_jobs
  add column if not exists errors_sample jsonb not null default '[]'::jsonb;
