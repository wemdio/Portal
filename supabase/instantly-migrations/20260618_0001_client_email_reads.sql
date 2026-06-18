-- Персональная прочитанность ответов в клиентском портале.
--
-- Зачем: «непрочитано» в портале раньше бралось напрямую из флага Instantly
-- (email.is_unread), а он ОБЩИЙ и нестабильный: открытие одной переписки
-- вызывало markThreadAsRead и гасило «непрочитано» по ВСЕМУ треду (всем
-- письмам лида), а отправка ответа гасит его в Instantly сама. Клиент жаловался,
-- что письма «сами прочитались» — он открывал/отвечал по лиду, а помечались
-- read и соседние фоллоапы, которые он не открывал (аудит 18.06: 173 входящих в
-- 101 треде, 37 многораздельных, до 13 писем в треде).
--
-- Теперь прочитанность ведём САМИ, ПОШТУЧНО и для КОНКРЕТНОГО клиента: запись
-- появляется, только когда клиент реально открыл это письмо в портале (или
-- пометил «лид»/прочитанным). «Непрочитано» в /replies = письма, которых тут
-- нет. Портал больше НЕ дёргает markThreadAsRead — флаг Instantly не трогаем.
-- Кнопка «пометить непрочитанным» удаляет запись.
--
-- Лежит в Instantly DB (supabaseInstantly), как и остальные client_* таблицы.
-- email_id — id письма Instantly (текст). PK по (client_user_id, email_id) →
-- PostgREST upsert c onConflict работает.

create table if not exists public.client_email_reads (
  client_user_id uuid not null,
  email_id text not null,
  read_at timestamptz not null default now(),
  primary key (client_user_id, email_id)
);

alter table public.client_email_reads enable row level security;

drop policy if exists "Service role full access on client_email_reads"
  on public.client_email_reads;
create policy "Service role full access on client_email_reads"
  on public.client_email_reads for all
  using (true) with check (true);
