-- Реальные деньги на дашборде первички: банковский приход, связанный со
-- сделкой воронки по ИНН плательщика.
--
-- Почему ИНН, а не сумма/имя: имя плательщика в выписке — это «ООО "РОМАШКА"»
-- против «Ромашка» в AMO, сумма совпадает у половины платежей месяца. ИНН —
-- единственный ключ, который есть по обе стороны и не допускает толкований:
-- на 12.08.2026 он заполнен у 30 из 30 приходов-выручки за последний месяц
-- (банк отдаёт его сам) и у 283 сделок AMO (кастомное поле «ИНН», менеджеры
-- заполняют руками).
--
-- Второй ключ здесь не изобретается: `apply_renewal_marks()` (20260803_0002)
-- уже сопоставляет платежи со сделками ровно так же — через
-- `amo_custom_field_value(raw, 'ИНН')`. Разойтись эти два расчёта не должны,
-- поэтому и дальше используется та же функция.
--
-- ВАЖНО про покрытие: ИНН заполнен примерно у 5% сделок. Цифра денег на
-- дашборде поэтому заведомо НЕ полная, и UI обязан показывать рядом, у
-- скольких договоров окна ИНН вообще есть, — иначе «пришло 400к» прочитается
-- как «мы заработали 400к», а не как «мы смогли связать 400к». Считает это
-- покрытие TypeScript (`firstSales/money.ts`), здесь — только связка.

-- ─── Нормализация ИНН ────────────────────────────────────────────────────
-- В AMO ИНН вводят руками: «7709492845», «ИНН 7709492845», «7709 492 845».
-- В выписке он приходит машинно и всегда чистый. Без нормализации ровно те
-- сделки, где менеджер добавил префикс или пробел, тихо не сматчатся — и это
-- будет выглядеть как «клиент не платил», а не как «мы не смогли сравнить».
--
-- Длина проверяется намеренно: 10 цифр — юрлицо, 12 — ИП/физлицо. Всё
-- остальное (обрывок, телефон, «—») — не ИНН, и лучше явный NULL, чем
-- совпадение по мусору. Контрольная сумма НЕ проверяется: опечатка в
-- контрольном разряде даст NULL и потеряет реальный платёж, а вреда от
-- невалидного ИНН нет — он просто ни с чем не сойдётся.
create or replace function public.norm_inn(v text)
returns text language sql immutable as $$
  select case
    when regexp_replace(coalesce(v, ''), '\D', '', 'g') ~ '^(\d{10}|\d{12})$'
    then regexp_replace(v, '\D', '', 'g')
  end
$$;

revoke all on function public.norm_inn(text) from public;
grant execute on function public.norm_inn(text) to service_role, postgres;

comment on function public.norm_inn(text) is
  'ИНН, очищенный от всего кроме цифр, если получилось 10 или 12 цифр; иначе NULL. Нужен, чтобы «ИНН 7709492845» из AMO сходился с «7709492845» из банковской выписки. Контрольная сумма не проверяется — опечатка в ней потеряла бы реальный платёж, а невалидный ИНН и так ни с чем не сойдётся.';

-- Поиск сделки по ИНН идёт по каждому платежу окна. Без индекса это
-- последовательный скан amo_leads с разбором jsonb на каждой строке (5.2к
-- сделок × разбор raw) на каждый запрос дашборда.
create index if not exists idx_amo_leads_inn
  on public.amo_leads (public.norm_inn(public.amo_custom_field_value(raw, 'ИНН')))
  where public.norm_inn(public.amo_custom_field_value(raw, 'ИНН')) is not null;

-- ─── Платежи окна со связкой на сделку ───────────────────────────────────
--
-- Функция, а не view, по двум причинам: воронка задаётся из приложения
-- (`FIRST_SALES_PIPELINE_ID`), зашивать её в SQL нельзя; и `deal_matches`
-- обязан считаться ВНУТРИ воронки — иначе одна и та же сделка клиента в
-- «Первичке» и в «Работе с текущими» дала бы «две сделки на платёж» и платёж
-- уехал бы в спорные на ровном месте.
--
-- Одна строка на платёж, а не на пару (платёж, сделка): пара размножила бы
-- сумму, и любой join выше по стеку считал бы деньги дважды. Спорность
-- отдаётся числом `deal_matches`, решение по ней принимает вызывающий код.
--
-- `renewal_state` — продление это или первичка. Правило не изобретается
-- заново, а берётся из `apply_renewal_marks()`: первый приход от ИНН всегда
-- первичка (продлевать ещё нечего), последующие — кандидаты, которые либо
-- размечены (renewal_marks), либо ждут человека. Ранг считается по ВСЕЙ
-- истории платежей ИНН, а не внутри окна: иначе первый платёж любого окна
-- назывался бы первичкой, и августовское продление годовалого клиента
-- посчиталось бы новой продажей.
create or replace function public.first_sales_payments(
  p_pipeline_id bigint,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  transaction_id bigint,
  occurred_at    timestamptz,
  amount         numeric,
  payer_inn      text,
  payer_name     text,
  amo_deal_id    bigint,
  deal_matches   integer,
  renewal_state  text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with deal_inn as (
    select l.amo_id as amo_deal_id,
           public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) as inn
    from public.amo_leads l
    where l.pipeline_id = p_pipeline_id
      and public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) is not null
  ),
  pay as (
    select bt.id,
           bt.occurred_at,
           bt.amount,
           bt.payer_inn,
           bt.payer_name,
           public.norm_inn(bt.payer_inn) as inn,
           row_number() over (
             partition by public.norm_inn(bt.payer_inn)
             order by bt.occurred_at asc, bt.id asc
           ) as rn
    from public.bank_transactions bt
    where bt.direction = 'credit'
      and bt.is_revenue
      and public.norm_inn(bt.payer_inn) is not null
  ),
  matched as (
    select p.id,
           count(d.amo_deal_id)::integer as deal_matches,
           -- min() валиден только при deal_matches = 1; при большем числе
           -- совпадений вызывающий код обязан не смотреть на этот столбец
           -- (и не смотрит — см. `attributablePayment` в money.ts).
           min(d.amo_deal_id)            as amo_deal_id
    from pay p
    left join deal_inn d on d.inn = p.inn
    group by p.id
  )
  select p.id,
         p.occurred_at,
         p.amount,
         p.payer_inn,
         p.payer_name,
         m.amo_deal_id,
         m.deal_matches,
         case
           when p.rn = 1                  then 'first'
           when rm.id is null             then 'pending'
           when rm.is_renewal             then 'renewal'
           else                                'not_renewal'
         end as renewal_state
  from pay p
  join matched m on m.id = p.id
  left join public.renewal_marks rm on rm.transaction_id = p.id
  where m.deal_matches > 0
    and p.occurred_at >= p_from
    and p.occurred_at <= p_to
$$;

revoke all on function public.first_sales_payments(bigint, timestamptz, timestamptz) from public;
grant execute on function public.first_sales_payments(bigint, timestamptz, timestamptz)
  to service_role, postgres;

comment on function public.first_sales_payments(bigint, timestamptz, timestamptz) is
  'Приходы-выручка за окно, ИНН плательщика которых совпал со сделкой указанной воронки. Одна строка на платёж. deal_matches — сколько сделок воронки делят этот ИНН (>1 = спорный, сумму нельзя отнести к менеджеру/каналу). renewal_state: first — первый приход от ИНН за всю историю (первичка), not_renewal — человек отметил «не продление», renewal — продление, pending — кандидат в продления, которого ещё не разобрали.';
