-- «Рассылка» → «Статистика» → «Коды отказов»: какими кодами отвечают серверы
-- получателей. Источники и фильтры — как у bounce_events в
-- sender_stats_dashboard (20261002_0020), чтобы цифры блоков сходились.

-- Текст отбойника или ошибки SMTP → код. Сначала поле Status: отчёта о
-- недоставке, затем любой расширенный код (5.1.1, 5.7.193), затем базовый
-- 4xx/5xx в начале строки или после пробела. Нет кода — null.
create or replace function public.sender_bounce_code(p_text text)
returns text
language sql
immutable
as $$
  select coalesce(
    substring(s.t from '(?i)status:\s*([245]\.\d{1,3}\.\d{1,3})'),
    substring(s.t from '\m([245]\.\d{1,3}\.\d{1,3})\M'),
    substring(s.t from '(?:^|\s)([45]\d\d)[ -]')
  )
  from (select left(p_text, 20000) as t) s
$$;

comment on function public.sender_bounce_code(text) is
  'Bounce / SMTP error text → status code: DSN Status, else any enhanced code, else basic 4xx/5xx; null when none.';

-- Все отказы периода с кодом и подробностями; общая основа счётчиков и списка.
create or replace function public.sender_bounce_code_rows(
  p_since timestamptz default null,
  p_campaign_id uuid default null
)
returns table (
  code text,
  at timestamptz,
  source text,
  to_email text,
  mailbox_email text,
  campaign_name text,
  detail text
)
language sql
stable
as $$
  select public.sender_bounce_code(p.body),
         coalesce(p.received_at, p.created_at),
         'bounce',
         coalesce(r.email, lower(substring(p.body from '(?i)final-recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)'))),
         mb.email,
         c.name,
         left(coalesce(
           substring(p.body from '(?i)diagnostic-code:\s*smtp;\s*([^\r\n]+)'),
           p.body
         ), 4000)
    from public.sender_replies p
    left join public.sender_recipients r on r.id = p.recipient_id
    left join public.sender_campaigns c on c.id = r.campaign_id
    left join public.sender_mailboxes mb on mb.id = p.mailbox_id
   where p.kind = 'bounce'
     and (p_since is null or coalesce(p.received_at, p.created_at) >= p_since)
     and (p_campaign_id is null or r.campaign_id = p_campaign_id)
  union all
  select public.sender_bounce_code(m.error),
         coalesce(m.sent_at, m.created_at),
         'send',
         m.to_email,
         mb.email,
         c.name,
         left(m.error, 4000)
    from public.sender_messages m
    left join public.sender_campaigns c on c.id = m.campaign_id
    left join public.sender_mailboxes mb on mb.id = m.mailbox_id
   where m.status = 'failed'
     and m.error is not null
     and m.mailbox_id is not null
     and (p_campaign_id is null or m.campaign_id = p_campaign_id)
     and (p_since is null or coalesce(m.sent_at, m.created_at) >= p_since)
$$;

-- Счётчики по кодам: [{code, n}], code null — код не найден.
create or replace function public.sender_bounce_codes(
  p_since timestamptz default null,
  p_campaign_id uuid default null
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'n', x.n) order by x.n desc, x.code), '[]'::jsonb)
    from (
      select code, count(*) as n
        from public.sender_bounce_code_rows(p_since, p_campaign_id)
       group by code
    ) x
$$;

-- Последние письма с одним кодом; p_code null — отказы без кода.
create or replace function public.sender_bounce_code_events(
  p_code text,
  p_since timestamptz default null,
  p_campaign_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'code' order by x.at desc), '[]'::jsonb)
    from (
      select *
        from public.sender_bounce_code_rows(p_since, p_campaign_id) e
       where e.code is not distinct from p_code
       order by e.at desc
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x
$$;

grant execute on function public.sender_bounce_code(text) to service_role;
grant execute on function public.sender_bounce_code_rows(timestamptz, uuid) to service_role;
grant execute on function public.sender_bounce_codes(timestamptz, uuid) to service_role;
grant execute on function public.sender_bounce_code_events(text, timestamptz, uuid, integer) to service_role;
