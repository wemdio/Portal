-- "Цепочки писем 2.0" — улучшенный инструмент:
-- Этап 1: загрузка брифа PDF/DOCX, извлечение ценностей продукта.
-- Этап 2: ввод сегмента + правок заказчика, опционально операторы персонализации.
-- Этап 3: AI генерирует цепочку писем (4-6), пользователь редактирует/добавляет/удаляет.
--
-- Отдельные таблицы _v2 не модифицируют существующие email_sequence_* таблицы.

create table if not exists public.email_sequence_v2_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'extracting_values', 'values_ready', 'generating_letters', 'completed', 'failed', 'cancelled')),

  -- Метаданные брифа (для отображения в списке).
  company_name text,

  -- Этап 1: бриф (исходный текст и сгенерированные ценности).
  brief_file_name text,
  brief_file_key text,
  brief_text text,
  values_text text,
  values_generated_at timestamptz,

  -- Этап 2: сегмент / правки / операторы персонализации.
  segment_text text,
  customer_edits text,
  personalization_operators text,

  -- Конфигурация моделей.
  values_model text,
  writer_model text,

  -- Опционально: путь к загруженному пользователем регламенту/структуре/примерам.
  -- Если пусто — подтягиваем дефолтный набор из Storage.
  custom_regulation_key text,
  custom_structure_key text,
  custom_examples_keys jsonb,

  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_sequence_v2_runs_user_id
  on public.email_sequence_v2_runs(user_id, created_at desc);

create table if not exists public.email_sequence_v2_letters (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.email_sequence_v2_runs(id) on delete cascade,
  letter_index integer not null check (letter_index between 1 and 50),
  subject text,
  body text not null default '',
  is_user_added boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_email_sequence_v2_letters_unique
  on public.email_sequence_v2_letters(run_id, letter_index);
create index if not exists idx_email_sequence_v2_letters_run
  on public.email_sequence_v2_letters(run_id);

-- Авто-обновление updated_at.
create or replace function public.set_email_sequence_v2_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_email_sequence_v2_runs_set_updated_at on public.email_sequence_v2_runs;
create trigger trg_email_sequence_v2_runs_set_updated_at
  before update on public.email_sequence_v2_runs
  for each row execute function public.set_email_sequence_v2_updated_at();

drop trigger if exists trg_email_sequence_v2_letters_set_updated_at on public.email_sequence_v2_letters;
create trigger trg_email_sequence_v2_letters_set_updated_at
  before update on public.email_sequence_v2_letters
  for each row execute function public.set_email_sequence_v2_updated_at();

-- RLS
alter table public.email_sequence_v2_runs enable row level security;
alter table public.email_sequence_v2_letters enable row level security;

drop policy if exists email_sequence_v2_runs_select_own on public.email_sequence_v2_runs;
create policy email_sequence_v2_runs_select_own
  on public.email_sequence_v2_runs
  for select
  using (auth.uid() = user_id);

drop policy if exists email_sequence_v2_runs_insert_own on public.email_sequence_v2_runs;
create policy email_sequence_v2_runs_insert_own
  on public.email_sequence_v2_runs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists email_sequence_v2_runs_update_own on public.email_sequence_v2_runs;
create policy email_sequence_v2_runs_update_own
  on public.email_sequence_v2_runs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists email_sequence_v2_runs_delete_own on public.email_sequence_v2_runs;
create policy email_sequence_v2_runs_delete_own
  on public.email_sequence_v2_runs
  for delete
  using (auth.uid() = user_id);

drop policy if exists email_sequence_v2_letters_select_own on public.email_sequence_v2_letters;
create policy email_sequence_v2_letters_select_own
  on public.email_sequence_v2_letters
  for select
  using (
    exists (
      select 1 from public.email_sequence_v2_runs r
      where r.id = email_sequence_v2_letters.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_v2_letters_insert_own on public.email_sequence_v2_letters;
create policy email_sequence_v2_letters_insert_own
  on public.email_sequence_v2_letters
  for insert
  with check (
    exists (
      select 1 from public.email_sequence_v2_runs r
      where r.id = email_sequence_v2_letters.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_v2_letters_update_own on public.email_sequence_v2_letters;
create policy email_sequence_v2_letters_update_own
  on public.email_sequence_v2_letters
  for update
  using (
    exists (
      select 1 from public.email_sequence_v2_runs r
      where r.id = email_sequence_v2_letters.run_id
        and r.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.email_sequence_v2_runs r
      where r.id = email_sequence_v2_letters.run_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists email_sequence_v2_letters_delete_own on public.email_sequence_v2_letters;
create policy email_sequence_v2_letters_delete_own
  on public.email_sequence_v2_letters
  for delete
  using (
    exists (
      select 1 from public.email_sequence_v2_runs r
      where r.id = email_sequence_v2_letters.run_id
        and r.user_id = auth.uid()
    )
  );
