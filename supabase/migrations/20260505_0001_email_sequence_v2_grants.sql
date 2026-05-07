-- Fix: «permission denied for table email_sequence_v2_runs» на проде.
--
-- Причина: на нашем self-hosted Supabase для схемы public НЕ настроен
-- ALTER DEFAULT PRIVILEGES ... GRANT ... TO authenticated, anon. Без этого
-- свежесозданные таблицы недоступны PostgREST даже при включённом RLS:
-- Postgres режет до проверки policies.
--
-- Старая v1 (email_sequence_runs/segments/letters) работает по историческим
-- причинам (видимо, grant'ы выданы вручную через Dashboard ещё тогда).
-- v2 такого «наследства» нет, поэтому выдаём явно.
--
-- Идемпотентно: повторный GRANT — no-op.

grant select, insert, update, delete on public.email_sequence_v2_runs to authenticated;
grant select, insert, update, delete on public.email_sequence_v2_letters to authenticated;
