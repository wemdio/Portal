-- Снапшоты проектов с активным периодом не писались вовсе: PostgREST-upsert
-- с onConflict (period_id, recorded_at) не может использовать ЧАСТИЧНЫЙ
-- уникальный индекс (WHERE period_id IS NOT NULL) как ON CONFLICT-арбитр —
-- PostgREST не передаёт WHERE-предикат, Postgres отвечает 42P10, ошибка
-- логировалась и глоталась. На 2026-07-06 в project_contacts_history было
-- 0 строк с period_id при 9 активных периодах.
--
-- Полный уникальный индекс даёт ту же гарантию для period_id IS NOT NULL
-- (NULLS DISTINCT по умолчанию: legacy-строки с NULL period_id не конфликтуют)
-- и матчится как арбитр — уже задеплоенный воркер начинает писать period-строки
-- сразу, не дожидаясь деплоя кода.

drop index if exists public.idx_pch_period_date;
create unique index if not exists idx_pch_period_date
  on public.project_contacts_history(period_id, recorded_at);
