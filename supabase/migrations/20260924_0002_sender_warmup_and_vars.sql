-- Рассылка: прогрев чужих сетей не считаем ответами; переменные письма — по
-- всей базе, а не по последней тысяче получателей.

-- ── Прогрев чужих сетей ──────────────────────────────────────────────────────
-- Ящики стоят на прогреве Instantly, и он переписывается в основном с ящиками
-- других участников сети. Их адресов у нас нет, поэтому фильтр «письма своих
-- ящиков» их пропускал: на старте прода было 453 «ответа» при 7 письмах.
--
-- Признак, на который опираемся: письмо не ответ на наше письмо, и мы никогда
-- не писали ни на этот адрес, ни в эту компанию. Коллега лида с того же
-- корпоративного домена остаётся живым ответом — ради него и заведён домен.

alter table public.sender_recipients
  add column if not exists email_domain text
  generated always as (lower(split_part(email, '@', 2))) stored;

create index if not exists idx_sender_recipients_email
  on public.sender_recipients (email);

create index if not exists idx_sender_recipients_email_domain
  on public.sender_recipients (email_domain);

-- Уже накопленное: непривязанные «ответы» от тех, кому мы не писали, — прогрев.
-- Публичные почтовые домены совпадением домена не считаются: с gmail.com пишут
-- все подряд, там нужен точный адрес.
update public.sender_replies r
   set kind = 'warmup'
 where r.kind in ('human', 'auto_reply', 'unknown')
   and r.recipient_id is null
   and r.from_email is not null
   and not exists (
     select 1 from public.sender_recipients s where s.email = lower(r.from_email)
   )
   and (
     lower(split_part(r.from_email, '@', 2)) in (
       'gmail.com', 'googlemail.com', 'yandex.ru', 'yandex.com', 'ya.ru', 'mail.ru', 'bk.ru',
       'inbox.ru', 'list.ru', 'internet.ru', 'rambler.ru', 'outlook.com', 'hotmail.com',
       'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com',
       'gmx.com', 'aol.com'
     )
     or not exists (
       select 1 from public.sender_recipients s
        where s.email_domain = lower(split_part(r.from_email, '@', 2))
     )
   );

-- ── Переменные письма по всей базе ───────────────────────────────────────────
-- Форма кампании собирала переменные по последней 1000 получателей. Колонка,
-- которой нет в этой выборке, считалась «неизвестной», и кампанию нельзя было
-- сохранить. Ключи и заполненность считаем здесь, по всем строкам.
create or replace function public.sender_campaign_var_stats(p_campaign_id uuid)
returns table (key text, filled bigint)
language sql
stable
as $$
  select kv.key,
         count(*) filter (where nullif(btrim(kv.value), '') is not null) as filled
    from public.sender_recipients r
    cross join lateral jsonb_each_text(r.vars) as kv
   where r.campaign_id = p_campaign_id
   group by kv.key
$$;

revoke all on function public.sender_campaign_var_stats(uuid) from public;
grant execute on function public.sender_campaign_var_stats(uuid) to service_role;

comment on function public.sender_campaign_var_stats is
  'Variable keys of a sender campaign base with the number of recipients where each is non-empty — over the whole base, not a sample.';
