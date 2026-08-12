-- Ручная передача лида и партнёра.
--
-- Автоматическая пересылка срабатывает по триггерной фразе в ответе модели.
-- Но решение «это лид» часто принимает человек, глядя на переписку, — и до сих
-- пор ему нечем было её отправить: оставалось пересылать руками из своего
-- Telegram, теряя и единый вид сообщения, и след о том, кто передал.
--
-- Исходов у переписки два, и уходят они разным людям: клиент, которому интересна
-- услуга, и человек, который хочет стать партнёром программы. Поэтому у задачи
-- есть вид (`kind`), от него зависят и заголовок сообщения, и чат-получатель.
--
-- Отправляет тот же аккаунт кампании, что вёл переписку, — как и в
-- автоматическом режиме. Живое соединение с Telegram есть только у воркера,
-- поэтому кнопка в интерфейсе не отправляет, а ставит задачу: воркер выполнит
-- её, когда дойдёт до этого аккаунта в круге.
--
-- Текст сообщения складываем в строку задачи, а не собираем при отправке:
-- оператор подтверждает конкретный текст в предпросмотре, и уйти должен ровно
-- он. Иначе правка шаблона между постановкой и отправкой молча меняла бы то,
-- что человек уже согласовал.

create table if not exists public.tg_outreach_lead_forwards (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  dialog_id         uuid not null references public.tg_outreach_dialogs(id) on delete cascade,
  account_id        uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  -- Что передаём: 'lead' — заинтересованный клиент, 'partner' — кандидат в
  -- партнёры программы. Разные получатели и разный заголовок сообщения.
  kind              text not null default 'lead'
    check (kind in ('lead', 'partner')),
  -- Куда отправлять. Снимок настройки на момент постановки: смена «чата для
  -- пересылки» в кампании не должна переадресовать уже согласованного лида.
  target_chat       text not null,
  message_text      text not null,
  status            text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  requested_by      uuid references auth.users(id) on delete set null,
  -- Имя дублируем строкой: в сообщении менеджеру стоит «передал такой-то», и
  -- оно должно оставаться читаемым, даже если учётку потом удалят.
  requested_by_name text not null default '',
  requested_at      timestamptz not null default now(),
  sent_at           timestamptz,
  error_message     text
);

create index if not exists tg_outreach_lead_forwards_pending_idx
  on public.tg_outreach_lead_forwards (account_id, requested_at)
  where status = 'pending';

create index if not exists tg_outreach_lead_forwards_dialog_idx
  on public.tg_outreach_lead_forwards (dialog_id, requested_at desc);

-- Одна задача в очереди на диалог и вид. Двойной клик по кнопке не должен слать
-- два одинаковых сообщения; повторить передачу можно после того, как первая
-- ушла или упала. Вид в ключе: один и тот же человек может быть и клиентом, и
-- кандидатом в партнёры, и уходят эти сообщения разным людям.
create unique index if not exists tg_outreach_lead_forwards_one_pending_idx
  on public.tg_outreach_lead_forwards (dialog_id, kind)
  where status = 'pending';

comment on table public.tg_outreach_lead_forwards is
  'Очередь ручной передачи лида или кандидата в партнёры. Выполняет воркер аккаунтом кампании.';

alter table public.tg_outreach_lead_forwards enable row level security;

-- Политики _all, как у остального tg-outreach: инструмент командный, лида
-- заводит один специалист, а разбирает другой.
create policy tg_outreach_lead_forwards_select_all on public.tg_outreach_lead_forwards
  for select to authenticated using (true);
create policy tg_outreach_lead_forwards_insert_all on public.tg_outreach_lead_forwards
  for insert to authenticated with check (true);
create policy tg_outreach_lead_forwards_update_all on public.tg_outreach_lead_forwards
  for update to authenticated using (true) with check (true);
create policy tg_outreach_lead_forwards_delete_all on public.tg_outreach_lead_forwards
  for delete to authenticated using (true);

grant all on public.tg_outreach_lead_forwards to service_role;
grant select, insert, update, delete on public.tg_outreach_lead_forwards to authenticated;
