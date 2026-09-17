-- Каталог Workspace зеркалится ежечасно, а какие ящики брать в работу —
-- решает человек галочками.
--
-- Из-за этого «выключен» и «не прошёл проверку» больше не могут жить в одной
-- колонке status: при синхронизации каталога портал будет сам заводить сотни
-- ящиков, и они обязаны появляться выключенными, не теряя при этом состояния
-- проверки. Поэтому выбор человека переезжает в отдельный флаг:
--   enabled     — берём ли ящик в рассылку (галочка на экране);
--   status      — только жизненный цикл проверки входа (pending/verified/failed);
--   google_state — что про ящик думает сам Google (active/suspended/missing).
alter table public.sender_mailboxes
  add column if not exists enabled boolean not null default true;

alter table public.sender_mailboxes
  add column if not exists google_state text;

alter table public.sender_mailboxes
  add column if not exists directory_synced_at timestamptz;

alter table public.sender_mailboxes
  drop constraint if exists sender_mailboxes_google_state_check;

alter table public.sender_mailboxes
  add constraint sender_mailboxes_google_state_check
  check (google_state is null or google_state in ('active', 'suspended', 'missing'));

-- Перенос уже выключенных ящиков: они становятся невыбранными, а их состояние
-- проверки возвращается в «ожидает» — прежнее значение status у них потеряно
-- не было, потому что «disabled» и означало «выключен руками».
update public.sender_mailboxes
   set enabled = false,
       status = 'pending'
 where status = 'disabled';

-- Отбор воркерами: проверяем и опрашиваем только выбранные ящики, поэтому
-- индексы теперь по паре.
create index if not exists idx_sender_mailboxes_enabled_status
  on public.sender_mailboxes (enabled, status);

comment on column public.sender_mailboxes.enabled is
  'Галочка «берём в рассылку». Ящики, приехавшие синхронизацией каталога Google, появляются выключенными.';
comment on column public.sender_mailboxes.google_state is
  'Состояние ящика в самом Workspace на момент последней синхронизации: active, suspended или missing (пропал из каталога).';
