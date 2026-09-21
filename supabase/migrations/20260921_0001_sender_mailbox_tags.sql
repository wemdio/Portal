-- Теги ящиков рассылки.
--
-- На вкладке «Ящики» лежит пул в несколько сотен адресов одним постраничным
-- списком, и признака принадлежности у ящика нет: какие домены чьи, какие
-- греются, какие отведены под конкретный проект — держится в голове.
--
-- Тег здесь — категория, а не метка: владельцем принято правило «один ящик —
-- один тег». Поэтому связь живёт колонкой в самих ящиках, а не отдельной
-- таблицей связей: пара «ящик — тег» физически не может задвоиться.
create table if not exists public.sender_mailbox_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- «Wolly» и «wolly» — это опечатка, а не два тега: уникальность без регистра.
create unique index if not exists idx_sender_mailbox_tags_name
  on public.sender_mailbox_tags (lower(name));

-- on delete set null: удалить тег — значит снять метку с ящиков, а не унести
-- их за собой. Обход строк в коде для этого не нужен.
alter table public.sender_mailboxes
  add column if not exists tag_id uuid
  references public.sender_mailbox_tags(id) on delete set null;

-- Под фильтр списка по тегу.
create index if not exists idx_sender_mailboxes_tag
  on public.sender_mailboxes (tag_id);

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- Как и остальные sender_*: только service_role, люди ходят через
-- /api/tools/sender/** с проверкой доступа.
alter table public.sender_mailbox_tags enable row level security;

grant all on public.sender_mailbox_tags to service_role;

comment on table public.sender_mailbox_tags is
  'Tags (categories) for sender mailboxes. One mailbox has at most one tag: the link is sender_mailboxes.tag_id, not a join table.';
comment on column public.sender_mailboxes.tag_id is
  'Тег ящика, он же категория. Один ящик — один тег; удаление тега обнуляет колонку.';
