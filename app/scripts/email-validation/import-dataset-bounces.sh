#!/usr/bin/env bash
# Отказы Instantly из датасета → public.email_bounce_import (основная БД), для
# учёта отказов в валидаторе почты (supabase/migrations/20261026_0090_email_bounce_history.sql).
#
# Запускать на prod-хосте 139.60.162.24 от root ПОСЛЕ деплоя этой миграции.
# Это запись в production-БД: только с явного согласия владельца. Повторный
# запуск безопасен (upsert по адресу).
#
# Берутся адреса со статусом лида «отказ» (raw_leads.status = -1), у которых
# отказ — последнее, что с ними было: ни ответа, ни отписки, ни открытия или
# доставки в другой кампании после последнего отказа. Такие признаки значат, что
# ящик живой, а отказ был по политике (например, блок отправляющего ящика).
# Новые отказы после 12.10.2026 валидатор и так видит через вебхук
# (instantly_activity_events). Повторный запуск дописывает и обновляет, но не
# удаляет строки, которые больше не подходят.
set -euo pipefail

{
  echo "create temp table bounce_stage (email text primary key, last_bounced_at timestamptz not null, bounces integer not null);"
  echo "copy bounce_stage from stdin with (format csv);"
  docker exec instantly-postgres-prod psql -U instantly -d instantly_dataset -v ON_ERROR_STOP=1 -At -c "copy (
    select lower(btrim(email)),
           max(timestamp_last_contact) filter (where status = -1),
           count(*) filter (where status = -1)
    from raw_leads
    where email like '%@%' and timestamp_last_contact is not null
    group by 1
    having bool_or(status = -1)
       and max(coalesce(email_reply_count, 0)) = 0
       and not coalesce(bool_or(status = -2), false)
       and max(timestamp_last_contact) filter (where status = -1)
           >= coalesce(max(timestamp_last_contact) filter (where status is distinct from -1), '-infinity')
       and max(timestamp_last_contact) filter (where status = -1)
           >= coalesce(max(timestamp_last_open), '-infinity')
  ) to stdout with (format csv)"
  echo '\.'
  cat <<'SQL'
insert into public.email_bounce_import (email, last_bounced_at, bounces, source)
select email, last_bounced_at, bounces, 'instantly_lead_status' from bounce_stage
on conflict (email) do update
  set last_bounced_at = greatest(public.email_bounce_import.last_bounced_at, excluded.last_bounced_at),
      bounces = excluded.bounces,
      imported_at = now();
select count(*) as imported_rows, max(last_bounced_at) as newest_bounce from public.email_bounce_import;
SQL
} | docker exec -i main-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f -
