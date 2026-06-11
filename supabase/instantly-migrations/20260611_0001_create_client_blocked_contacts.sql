-- Чёрный список контактов клиента.
--
-- Зачем: в ответах бывает негатив («не пишите нам»), а клиент ничего не мог
-- с этим сделать — при следующем запуске кампании контакт снова попадал в
-- рассылку. Теперь клиент блокирует email (из «Ответов» или вручную на
-- странице «Чёрный список»), и все будущие запуски/догрузки лидов через
-- портал фильтруют таких получателей ДО загрузки в Instantly.
--
-- Почему НЕ блоклист Instantly: блоклист там действует на весь workspace,
-- а клиенты могут делить один Instantly-аккаунт — блок одного клиента
-- зацепил бы рассылки остальных. Поэтому список живёт у нас, скоуп — клиент.
--
-- email хранится УЖЕ нормализованным (trim + lowercase) — нормализует
-- приложение (normalizeBlockedEmail). Уникальность по (client_user_id, email)
-- поэтому обычная, без выражений — PostgREST upsert с onConflict работает.
--
-- Лежит в Instantly DB (supabaseInstantly), как и остальные client_* таблицы.

create table if not exists public.client_blocked_contacts (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,
  email text not null,
  reason text,
  source text not null default 'manual'
    check (source in ('manual', 'reply')),
  created_at timestamptz not null default now(),
  unique (client_user_id, email)
);

-- Выборка всего списка клиента (страница + фильтр при запуске) идёт по
-- client_user_id; уникальный составной индекс выше покрывает её по
-- leading-колонке, отдельный индекс не нужен.

alter table public.client_blocked_contacts enable row level security;

drop policy if exists "Service role full access on client_blocked_contacts"
  on public.client_blocked_contacts;
create policy "Service role full access on client_blocked_contacts"
  on public.client_blocked_contacts for all
  using (true) with check (true);
