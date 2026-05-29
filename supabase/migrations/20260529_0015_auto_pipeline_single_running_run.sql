-- Lock: не более одного активного (running) прогона auto-pipeline на клиента.
--
-- Крон (00:00 МСК) и ручной запуск могли пересечься → два прогона конкурировали
-- за HH/scrape/Mailganer, тормозили друг друга и дважды жгли кэш. Partial unique
-- index делает вторую вставку running-записи невозможной (23505) — startRunRow
-- ловит это и аккуратно пропускает запуск (не ошибка).
--
-- closeStaleRuns() в startRunRow помечает зависшие (>4ч) running как failed ДО
-- вставки, поэтому брошенный после краша/редеплоя прогон не заблокирует новый.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_auto_pipeline_running_per_client
  ON public.client_auto_pipeline_runs (client_user_id)
  WHERE status = 'running';
