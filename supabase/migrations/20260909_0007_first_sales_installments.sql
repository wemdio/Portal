-- Деньги первички: рассрочка перестаёт считаться продлением, а весь приход
-- банка становится видимым на экране.
--
-- ─── Что было не так ─────────────────────────────────────────────────────
--
-- Правило было такое: первый приход от ИНН — первичка, любой следующий —
-- кандидат в продление, который ждёт разметки человеком. Оно верно для
-- абонентки и неверно для рассрочки: договор на 229 000 ₽, оплаченный тремя
-- траншами, давал одну продажу и два «кандидата в продления», которых никто
-- не разбирает.
--
-- Сверка за август 2026 (весь приход-выручка 2 910 244 ₽):
--   1 889 500  показано в «Деньги»
--     468 600  «ждут разбора» — из них 290 500 оказались траншами по уже
--              посчитанным сделкам: 217 500 = 72 500 × 3, 159 000 =
--              80 000 + 79 000 (дважды), 229 000 = 115 000 + 54 000 + 60 000
--     468 300  ИНН нашёлся в воронке продлений, а не первички
--       4 844  эквайринг («Аванпост», реестр платежей физлиц)
--      79 000  размечено человеком как продление
--
-- ─── Что делаем ──────────────────────────────────────────────────────────
--
-- 1. Транш. Если накопленная сумма приходов от ИНН не превысила сумму самой
--    сделки — это тот же договор, а не новая продажа клиенту. Такой платёж
--    получает состояние 'installment' и идёт в деньги первички, минуя очередь
--    ручной разметки. Как только сумма договора выбрана до конца, следующий
--    приход снова становится кандидатом в продления — ровно так и отличается
--    абонентка: «Облачные решения» платят с августа 2025 на 1 039 740 ₽ при
--    сделке в 149 000 ₽, и остаются в очереди.
--
--    Порог строгий (`<=`, без допуска). Переплата на копейку отправит платёж
--    в очередь к человеку — это честнее, чем зачесть в первичку продление,
--    случайно совпавшее по сумме.
--
--    Сумма сделки берётся только при однозначной связке (deal_matches = 1):
--    при нескольких сделках на один ИНН неизвестно, какой договор оплачивают,
--    и выдумывать ответ нельзя.
--
-- 2. Сходимость. Функция теперь отдаёт ВСЕ приходы-выручку окна, а не только
--    те, чей ИНН нашёлся в первичке. У платежа появился второй счётчик —
--    `renewal_deal_matches` (сколько сделок воронки продлений делят этот ИНН).
--    Благодаря ему карточка денег показывает, куда ушла разница с банком:
--    «в продления» и «не связано» вместо молчания. Раньше эти строки
--    существовали только в переписке.
--
-- Классификацию по-прежнему делает TypeScript (lib/firstSales/money.ts) —
-- здесь только факты: сколько сделок делят ИНН, какая сумма у сделки, каким
-- по счёту пришёл платёж.

-- Сигнатура меняется (добавился p_renewals_pipeline_id), поэтому старую
-- версию именно удаляем: `create or replace` создал бы вторую перегрузку, и
-- какая из них вызовется — зависело бы от того, как PostgREST разберёт
-- параметры. Двух правд об одних деньгах быть не должно.
drop function if exists public.first_sales_payments(bigint, timestamptz, timestamptz);

create or replace function public.first_sales_payments(
  p_pipeline_id          bigint,
  p_renewals_pipeline_id bigint,
  p_from                 timestamptz,
  p_to                   timestamptz
)
returns table (
  transaction_id        bigint,
  occurred_at           timestamptz,
  amount                numeric,
  payer_inn             text,
  payer_name            text,
  amo_deal_id           bigint,
  deal_matches          integer,
  renewal_deal_matches  integer,
  renewal_state         text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with deal_inn as (
    select l.amo_id as amo_deal_id,
           l.amount as deal_amount,
           public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) as inn
    from public.amo_leads l
    where l.pipeline_id = p_pipeline_id
      and public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) is not null
  ),
  renewal_inn as (
    select l.amo_id as amo_deal_id,
           public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) as inn
    from public.amo_leads l
    where l.pipeline_id = p_renewals_pipeline_id
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
           ) as rn,
           -- Накопленная сумма приходов от этого ИНН включительно по текущий.
           -- Считается по ВСЕЙ истории, как и ранг: внутри окна первый транш
           -- мог остаться в прошлом месяце, и без истории договор на 229 000
           -- выглядел бы оплаченным на 60 000.
           sum(bt.amount) over (
             partition by public.norm_inn(bt.payer_inn)
             order by bt.occurred_at asc, bt.id asc
             rows between unbounded preceding and current row
           ) as paid_running
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
           min(d.amo_deal_id)            as amo_deal_id,
           min(d.deal_amount)            as deal_amount
    from pay p
    left join deal_inn d on d.inn = p.inn
    group by p.id
  ),
  matched_renewal as (
    select p.id, count(r.amo_deal_id)::integer as renewal_deal_matches
    from pay p
    left join renewal_inn r on r.inn = p.inn
    group by p.id
  )
  select p.id,
         p.occurred_at,
         p.amount,
         p.payer_inn,
         p.payer_name,
         m.amo_deal_id,
         m.deal_matches,
         mr.renewal_deal_matches,
         case
           when p.rn = 1                       then 'first'
           when m.deal_matches = 1
                and m.deal_amount is not null
                and m.deal_amount > 0
                and p.paid_running <= m.deal_amount then 'installment'
           when rm.id is null                  then 'pending'
           when rm.is_renewal                  then 'renewal'
           else                                     'not_renewal'
         end as renewal_state
  from pay p
  join matched m on m.id = p.id
  join matched_renewal mr on mr.id = p.id
  left join public.renewal_marks rm on rm.transaction_id = p.id
  where p.occurred_at >= p_from
    and p.occurred_at <= p_to
$$;

revoke all on function public.first_sales_payments(bigint, bigint, timestamptz, timestamptz) from public;
grant execute on function public.first_sales_payments(bigint, bigint, timestamptz, timestamptz)
  to service_role, postgres;

comment on function public.first_sales_payments(bigint, bigint, timestamptz, timestamptz) is
  'Все приходы-выручка за окно, по одной строке на платёж. deal_matches — сколько сделок первичной воронки делят ИНН плательщика (0 — не наш клиент в этой воронке, >1 — спорный). renewal_deal_matches — то же по воронке продлений: нужен, чтобы карточка денег показывала, куда ушла разница с выпиской. renewal_state: first — первый приход от ИНН за всю историю; installment — очередной транш, укладывающийся в сумму той же сделки; not_renewal — человек отметил «не продление»; renewal — продление; pending — кандидат в продления, которого ещё не разобрали.';
