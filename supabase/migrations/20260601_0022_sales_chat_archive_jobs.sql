-- «Анализатор сейлз-переписок»: офлайн-выгрузка ВСЕХ диалогов одного аккаунта
-- в ZIP-архив (1 диалог = 1 DOCX, как существующий per-dialog export).
--
-- UI кладёт заявку в эту таблицу — отдельный воркер `saleschatarchive` поллит
-- pending-строки, генерит DOCX по каждому диалогу, стримит ZIP в S3
-- (multipart), сохраняет s3_key и кладёт ссылку через presigned URL.
-- Уникальный частичный индекс гарантирует не больше одного активного
-- задания на аккаунт; index на (status, created_at) ускоряет poll.

create table if not exists public.sales_chat_archive_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sales_chat_accounts(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,

  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error')),

  dialogs_total integer,
  dialogs_done integer not null default 0,

  s3_bucket text,
  s3_key text,
  file_size_bytes bigint,

  error_message text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_sales_chat_archive_jobs_account_created
  on public.sales_chat_archive_jobs(account_id, created_at desc);

create index if not exists idx_sales_chat_archive_jobs_pending
  on public.sales_chat_archive_jobs(status, created_at)
  where status in ('pending', 'running');

-- Не плодим параллельные задания на один и тот же аккаунт.
create unique index if not exists idx_sales_chat_archive_jobs_one_active
  on public.sales_chat_archive_jobs(account_id)
  where status in ('pending', 'running');

-- RLS включён без permissive-политик — доступ только через service role
-- (API-роуты после requireSalesChatAccess и воркер).
alter table public.sales_chat_archive_jobs enable row level security;

grant all on public.sales_chat_archive_jobs to service_role;
grant select, insert, update on public.sales_chat_archive_jobs to authenticated;
