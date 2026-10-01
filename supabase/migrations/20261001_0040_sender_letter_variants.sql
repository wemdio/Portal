-- А/Б-тест писем внутри кампании «Рассылки» (01.10.2026, просьба Дмитрия К.).
--
-- У шага цепочки может быть несколько вариантов письма: база делится между
-- ними поровну, и через неделю видно, на какой текст больше ответов. Вариант
-- выбирается от id получателя (lib/sender/variants.ts), поэтому один и тот же
-- лид всегда попадает в один и тот же вариант, сколько бы раз планировщик ни
-- пересчитывал шаг.
--
-- Отдельной таблицы под варианты нет: вариант — это тот же шаг, только с
-- другим текстом. Поэтому уникальность шага расширяется номером варианта, а
-- отправленное письмо запоминает, какой вариант в нём уехал: без этого
-- сравнивать ответы не с чем (у получателя остаётся только номер шага).

alter table public.sender_campaign_steps
  add column if not exists variant_no int not null default 1 check (variant_no >= 1);

alter table public.sender_campaign_steps
  drop constraint if exists sender_campaign_steps_campaign_id_step_no_key;

create unique index if not exists sender_campaign_steps_campaign_step_variant_key
  on public.sender_campaign_steps (campaign_id, step_no, variant_no);

alter table public.sender_messages
  add column if not exists variant_no int not null default 1 check (variant_no >= 1);

comment on column public.sender_campaign_steps.variant_no is
  'A/B variant of this chain step: the base is split evenly between variants of the same step_no.';
comment on column public.sender_messages.variant_no is
  'Which A/B variant of the step was actually sent — the only way to compare replies afterwards.';

-- ── Результаты А/Б по кампании ───────────────────────────────────────────────
-- «Ответил» считается так же, как в разбивке по шагам: лид в статусе replied,
-- у которого отправлено ровно столько писем, сколько номер шага, — то есть он
-- ответил после этого письма.
create or replace function public.sender_campaign_variant_stats(p_campaign_id uuid)
returns table (step_no int, variant_no int, sent bigint, replied bigint)
language sql
stable
as $$
  select m.step_no,
         m.variant_no,
         count(*) filter (where m.status = 'sent') as sent,
         count(*) filter (
           where m.status = 'sent'
             and r.status = 'replied'
             and r.last_step_sent = m.step_no
         ) as replied
    from public.sender_messages m
    join public.sender_recipients r on r.id = m.recipient_id
   where m.campaign_id = p_campaign_id
   group by m.step_no, m.variant_no
   order by m.step_no, m.variant_no
$$;

revoke all on function public.sender_campaign_variant_stats(uuid) from public;
grant execute on function public.sender_campaign_variant_stats(uuid) to service_role;

comment on function public.sender_campaign_variant_stats is
  'A/B results of a sender campaign: sent and replied counts per (step_no, variant_no).';
