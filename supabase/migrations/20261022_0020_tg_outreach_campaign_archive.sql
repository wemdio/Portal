-- Архив кампаний TG-аутрича: кампания уходит из списка, но не удаляется —
-- аккаунты, базы и история остаются, её можно вернуть. Причина обязательна:
-- через месяц «почему эта кампания в архиве» помнит только эта строка.
alter table public.tg_outreach_campaigns
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;
