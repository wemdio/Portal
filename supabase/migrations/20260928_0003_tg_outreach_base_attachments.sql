-- TG-аутрич: файлы к первому сообщению (28.09.2026).
--
-- К базе загружаются картинки и документы; контакт получает файл, имя которого
-- указано у него в колонке «картинка»/«файл» таблицы, либо файл «для всех»
-- базы. Файл уходит одним сообщением с текстом первого касания под ним.
-- Сами файлы — в закрытом бакете хранилища, воркер читает их service role.

create table if not exists public.tg_outreach_base_attachments (
  id            uuid primary key default gen_random_uuid(),
  base_id       uuid not null references public.tg_outreach_bases(id) on delete cascade,
  -- Имя, как его пишут в таблице базы (offer.jpg); сверяется без учёта регистра.
  file_name     text not null,
  storage_path  text not null,
  mime_type     text not null,
  size_bytes    bigint not null,
  -- photo — уходит картинкой, document — файлом.
  kind          text not null check (kind in ('photo', 'document')),
  -- Файл «для всех»: его получают контакты без своего файла в таблице. Один на базу.
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

create unique index if not exists tg_outreach_base_attachments_name_uidx
  on public.tg_outreach_base_attachments (base_id, lower(file_name));
create unique index if not exists tg_outreach_base_attachments_default_uidx
  on public.tg_outreach_base_attachments (base_id) where is_default;

alter table public.tg_outreach_base_attachments enable row level security;

-- Политики _all, как у баз (20260806_0003): инструмент командный.
create policy tg_outreach_base_attachments_select_all on public.tg_outreach_base_attachments
  for select to authenticated using (true);
create policy tg_outreach_base_attachments_insert_all on public.tg_outreach_base_attachments
  for insert to authenticated with check (true);
create policy tg_outreach_base_attachments_update_all on public.tg_outreach_base_attachments
  for update to authenticated using (true) with check (true);
create policy tg_outreach_base_attachments_delete_all on public.tg_outreach_base_attachments
  for delete to authenticated using (true);

grant all on public.tg_outreach_base_attachments to service_role;
grant select, insert, update, delete on public.tg_outreach_base_attachments to authenticated;

-- Имя файла из колонки таблицы; пусто — файл «для всех» базы или без файла.
alter table public.tg_outreach_base_contacts
  add column if not exists attachment_name text;

insert into storage.buckets (id, name, public)
values ('tg-outreach-attachments', 'tg-outreach-attachments', false)
on conflict (id) do update set public = excluded.public;
