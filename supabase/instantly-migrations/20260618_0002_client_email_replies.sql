-- Персональная отметка «отвечено» для ответов в клиентском портале.
--
-- Зачем: список «Ответы» тянет только ВХОДЯЩИЕ письма (email_type='received') и
-- показывает один статус из трёх — Лид / Непрочитано / Ответ. Понять, на какое
-- письмо клиент УЖЕ ответил, из списка нельзя — приходится открывать каждую
-- строку (жалоба клиента 18.06). Факт отправки ответа мы нигде не сохраняли
-- (роут /reply писал только audit-лог).
--
-- Теперь при отправке ответа фиксируем (client_user_id, email_id) здесь, а
-- список помечает строку «Отвечено», если письмо тут есть. Аналог
-- client_email_reads (персональная прочитанность). Лежит в Instantly DB.

create table if not exists public.client_email_replies (
  client_user_id uuid not null,
  email_id text not null,
  replied_at timestamptz not null default now(),
  primary key (client_user_id, email_id)
);

alter table public.client_email_replies enable row level security;

drop policy if exists "Service role full access on client_email_replies"
  on public.client_email_replies;
create policy "Service role full access on client_email_replies"
  on public.client_email_replies for all
  using (true) with check (true);
