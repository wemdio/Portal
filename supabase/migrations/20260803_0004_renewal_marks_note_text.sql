-- Третий, приоритетный сигнал автоподтверждения продлений: комментарий AMO
-- вида «Продление N - сумма» у сделки клиента с тем же ИНН.
--
-- Контекст (детали — в 20260803_0003_amo_notes.sql). Договорённость команды
-- от 2026-08-03: сделка переходит в статус «Продление» → менеджер пишет
-- ОТДЕЛЬНЫЙ комментарий на каждое продление («Продление 1 - 159к», через
-- месяц новый комментарий «Продление 2 - 300к»). У комментария есть
-- собственная created_at — это и есть дата продления, а не дата платежа:
-- комментарий и есть событие. Это сильнее сигнала 1 (текст задачи), потому
-- что задача — производная сущность с приблизительной датой (см. комментарий
-- к updated_at_amo в 20260803_0001_amo_tasks.sql), а комментарий пишется
-- ИМЕННО в момент, который команда считает моментом продления.
--
-- ─── Риск №1: старые комментарии (см. отчёт по задаче, обязателен к разбору) ─
--
-- В базе 5189 common-комментариев за два года, слово «продление» встретилось
-- в 17, и почти все — намерения и отказы: «решили не продляться», «пинг по
-- продлению», «потом поговорим о продлении», «Скорее всего это продлится до
-- конца года». Наивный регэксп ~* 'продл' поймал бы их все и приписал бы
-- продления там, где их не было. Защита — ДВЕ независимые меры, не одна:
--
--   1. Отсечка по дате: created_at_amo >= '2026-08-03' (день самой
--      договорённости). Это единственная и достаточная защита от ВСЕХ 17
--      исторических упоминаний разом — ни одно из них не могло быть написано
--      после этой даты просто потому, что процесса ещё не существовало.
--      Дата — константа в этой функции (не параметр, не настройка), потому
--      что это дата решения команды, а не что-то, что должно меняться.
--
--   2. Анкеринг к началу текста: текст обязан НАЧИНАТЬСЯ со слова
--      «продление» (после пробелов), а не просто содержать его где-то в
--      середине. Ни один из 17 примеров выше не начинается с этого слова —
--      «решили», «пинг», «потом», «скорее всего» стоят первыми. Это защита
--      НЕ от истории (с ней справляется отсечка по дате), а от будущего шума
--      того же рода уже ПОСЛЕ 2026-08-03: менеджер может упомянуть слово
--      «продление» в комментарии о звонке или в обсуждении, не имея в виду
--      факт оплаты по новому формату. Строгий формат — «Продление N - сумма»
--      — единственное, что мы ожидаем видеть в начале строки по протоколу.
--
--   Сознательно НЕ выбрано (см. отчёт): требовать наличие суммы в тексте —
--   отклонено, потому что «Продление 2» без числа — валидная запись по
--   договорённости (см. следующий блок про сумму), обязательное требование
--   суммы отбросило бы законные случаи, а не только шум.
--
-- ─── Риск №2: сумма может отсутствовать в тексте ────────────────────────────
--
-- «Продление 2» без числа — валидная запись (номер это часть протокола,
-- сумма — нет). Сумма НЕ обязательна для распознавания: если она есть и
-- совпала с суммой платежа — сильное дополнительное подтверждение (by_sum),
-- если её нет или она не совпала — используется дата рядом (±14 дней,
-- by_date), тот же принцип, что у сигнала 1 (текст задачи). Сама сумма
-- продления как метрика (сколько ₽) в любом случае берётся из
-- bank_transactions.amount через transaction_id, а не из текста комментария
-- — renewal_marks не хранит отдельную колонку суммы ни для одного метода,
-- текст используется только для СВЕРКИ, а не как источник истины о деньгах.
--
-- Форматы суммы, которые нужно поддержать («159к», «300к», «159 000») —
-- шире, чем в задачах (только «к»/«тыс», см. renewal_amounts_thousands в
-- 20260803_0002_renewal_marks.sql). Полный формат без сокращения — «159 000»
-- — там не требовался (в примерах задач всегда было «к»), а тут явно нужен,
-- поэтому ниже отдельная функция, а не переиспользование старой: смешивать
-- в одной функции формат для задач и формат для комментариев значило бы
-- рисковать сигналом 1 ради сигнала 3.
--
-- ─── Риск №3: порядковый номер («Продление N») ──────────────────────────────
--
-- Номер пишет человек, но порядок можно посчитать по датам самостоятельно —
-- значит написанный номер это не источник истины, а декларация человека,
-- которую МОЖНО было бы сверить с фактическим счётом продлений по датам и
-- показать расхождение («написано «Продление 3», а у нас закреплено только
-- два» — сигнал, что одно потерялось). Решение здесь: извлекать номер и
-- класть его в note (свободный текст, читаемый человеком на экране разбора),
-- но НЕ заводить для него отдельную колонку и НЕ строить сверку в этой
-- миграции. Причина — задача просит распознавание, а полноценная сверка
-- («ожидаемый номер = COUNT предыдущих подтверждённых продлений этого ИНН +
-- 1, с обработкой ручных решений, пропущенных номеров, начального номера у
-- разных клиентов и т.д.») это отдельная фича со своим объёмом решений, и
-- сейчас достаточных данных (после 2026-08-03 их пока считанные единицы),
-- чтобы спроектировать её осмысленно, ещё нет. Извлечённый номер в note не
-- теряется — если сверку решат делать позже, данные для неё уже накоплены.
create or replace function public.renewal_note_amounts(v text)
returns numeric[] language sql immutable as $$
  select coalesce(array_agg(distinct amt), array[]::numeric[])
  from (
    -- «159к», «на 149к.», «300 тыс» — тот же приём, что renewal_amounts_thousands.
    select (replace(m[1], ',', '.'))::numeric * 1000 as amt
    from regexp_matches(coalesce(v, ''), '(\d+(?:[.,]\d+)?)\s*(?:к\.?|тыс\.?)', 'gi') as m
    union all
    -- «159000» / «159 000» / «1 200 000» — целая сумма без сокращения.
    -- Группы по три цифры через обычный пробел (минимум 4 цифры итого) ИЛИ
    -- голая строка от 4 цифр подряд. Порядковый номер («Продление 2»,
    -- «Продление 10»), ОТДЕЛЁННЫЙ ОТ СУММЫ дефисом/тире по протоколу
    -- команды («Продление N - сумма»), никогда не даёт ложного совпадения:
    -- дефис прерывает попытку регэкспа продолжить «номер + пробел + тройка
    -- цифр» в одно число.
    --
    -- ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (проверено вручную regex-трассировкой, не
    -- автотестом на живой БД): если человек отступит от протокола и
    -- напишет номер и полную сумму БЕЗ дефиса через один пробел —
    -- «Продление 2 159000» — регэксп группы по тройкам жадно склеит «2» и
    -- первые три цифры суммы в «2 159», дав неверное число 2159 вместо
    -- 159000. Формат «к»/«тыс» (первая ветка выше) этой проблеме не
    -- подвержен. Осознанно не закрыто отдельной защитой: попытка вырезать
    -- номер перед поиском суммы (regexp_replace по префиксу) на проверке
    -- оказалась ХУЖЕ — при отсутствии номера она откусывает начало самой
    -- суммы. Практическое следствие ошибки некритично: неверная сумма
    -- почти никогда не совпадёт с реальным платежом (by_sum остаётся
    -- false), автоматчер просто падает на более слабый признак — дату
    -- рядом (by_date), — а не путает продление с другим платежом. Если
    -- протокол «N - сумма» соблюдается (как в обоих примерах команды),
    -- ограничение не проявляется вовсе.
    select replace(m[1], ' ', '')::numeric as amt
    from regexp_matches(
           coalesce(v, ''),
           '(\d{1,3}(?: \d{3})+|\d{4,})',
           'g'
         ) as m
  ) amounts
$$;

revoke all on function public.renewal_note_amounts(text) from public;
grant execute on function public.renewal_note_amounts(text) to service_role, postgres;

comment on function public.renewal_note_amounts(text) is
  'Суммы в рублях из текста комментария AMO: «159к»/«300 тыс» (как renewal_amounts_thousands) ПЛЮС целые числа без сокращения — «159000»/«159 000»/«1 200 000». Отдельная от renewal_amounts_thousands функция: формат комментариев шире формата задач (там всегда «к»/«тыс»), смешивать в одной функции значило бы рисковать существующим сигналом 1 ради нового сигнала 3. Короткие числа (1-3 цифры без разделителя разрядов) никогда не совпадают — порядковый номер «Продление 2» не может быть принят за сумму.';

-- ─── Автоматчер: третий сигнал + защита от дублей строк на один платёж ──────
--
-- ВНИМАНИЕ при чтении/правке: источники подтверждения объединяются через
-- union all в CTE resolved, и на этом уже спотыкались бы (см. отчёт по
-- задаче) — если один transaction_id попадёт больше чем в одну из
-- note_confirmed/task_confirmed/project_confirmed, insert ... on conflict do
-- update упадёт с «cannot affect row a second time» при первом же
-- пересекающемся транзакшене. Приоритет комментарий → задача → тип проекта
-- обеспечен НЕ порядком в union all (union all сам по себе от дублей не
-- защищает), а явными not exists: task_confirmed исключает всё, что уже
-- подтвердил note_confirmed; project_confirmed исключает всё, что подтвердил
-- любой из двух предыдущих. Раньше (20260803_0002) здесь было только одно
-- исключение (project_confirmed vs task_confirmed) — при добавлении нового
-- сигнала пришлось расширить оба места, а не одно.
create or replace function public.apply_renewal_marks()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  with candidates as (
    -- Кандидаты: приходы (is_revenue, credit) с непустым ИНН плательщика,
    -- КРОМЕ первого платежа от этого ИНН — не изменилось с 20260803_0002.
    select ranked.id as transaction_id, ranked.payer_inn, ranked.payer_name,
           ranked.amount, ranked.occurred_at
    from (
      select bt.id, bt.payer_inn, bt.payer_name, bt.amount, bt.occurred_at,
             row_number() over (
               partition by bt.payer_inn
               order by bt.occurred_at asc, bt.id asc
             ) as rn
      from public.bank_transactions bt
      where bt.direction = 'credit'
        and bt.is_revenue
        and coalesce(btrim(bt.payer_inn), '') <> ''
    ) ranked
    where ranked.rn > 1
  ),

  -- Сделки AMO по ИНН плательщика — не изменилось с 20260803_0002.
  deal_inn as (
    select distinct l.amo_id as amo_deal_id, cf.inn
    from public.amo_leads l
    cross join lateral (select public.amo_custom_field_value(l.raw, 'ИНН') as inn) cf
    where cf.inn is not null
      and cf.inn in (select c.payer_inn from candidates c)
  ),

  -- ── Сигнал 1 (новый, самый приоритетный): комментарий сделки этого ИНН
  -- вида «Продление N - сумма», написанный НАЧИНАЯ с даты договорённости
  -- команды и НАЧИНАЮЩИЙСЯ с этого слова (обе меры — см. заголовок файла,
  -- «Риск №1»). by_sum — сумма из текста совпала с суммой платежа (сильное
  -- основание, дата не важна). by_date — created_at_amo самого комментария
  -- (НЕ платежа — комментарий и есть событие) в пределах ±14 дней от даты
  -- платежа: тот же допуск, что у сигнала 2 (текст задачи), нужен ровно
  -- затем, чтобы найти КОНКРЕТНЫЙ платёж, который комментарий подтверждает —
  -- банк и AMO не связаны напрямую, банковское зачисление может отстать от
  -- комментария на несколько дней.
  note_hits as (
    select
      c.transaction_id,
      di.amo_deal_id,
      nt.id as note_id,
      nt.text,
      nt.created_at_amo,
      (regexp_match(nt.text, '^\s*продлени[ея]\D{0,5}?(\d+)', 'i'))[1] as ordinal_num,
      (c.amount = any (amt.arr)) as by_sum
    from candidates c
    join deal_inn di on di.inn = c.payer_inn
    join public.amo_notes nt
      on nt.amo_deal_id = di.amo_deal_id
     and nt.note_type = 'common'
     and nt.created_at_amo is not null
     and (nt.created_at_amo at time zone 'Europe/Moscow')::date >= date '2026-08-03'
     and nt.text ~* '^\s*продление'
    cross join lateral (select public.renewal_note_amounts(nt.text) as arr) amt
    where (c.amount = any (amt.arr))
       or abs(
            (nt.created_at_amo at time zone 'Europe/Moscow')::date
            - (c.occurred_at    at time zone 'Europe/Moscow')::date
          ) <= 14
  ),
  note_ranked as (
    select transaction_id, amo_deal_id, note_id, text, created_at_amo, ordinal_num, by_sum,
           count(*) over (partition by transaction_id) as n
    from note_hits
  ),
  note_confirmed as (
    -- n=1: ровно один комментарий-кандидат под платёж. n>1 (несколько
    -- комментариев и/или несколько сделок ИНН подошли одновременно) —
    -- неоднозначность, не выбираем за человека, кандидат остаётся
    -- неразмеченным (тот же принцип, что у task_confirmed ниже).
    select transaction_id, amo_deal_id,
           'по комментарию сделки ' || amo_deal_id || ' от '
             || to_char(created_at_amo at time zone 'Europe/Moscow', 'DD.MM.YYYY')
             || case when ordinal_num is not null then ' (номер ' || ordinal_num || ')' else '' end
             || ': «' || left(coalesce(text, ''), 200) || '»'
             || case when by_sum then ' — сумма совпала'
                     else ' — дата рядом (±14 дней)' end as note
    from note_ranked
    where n = 1
  ),

  -- ── Сигнал 2 (текст задачи) — не изменилось с 20260803_0002, кроме
  -- добавленного исключения того, что уже подтвердил сигнал 1.
  task_hits as (
    select
      c.transaction_id,
      di.amo_deal_id,
      t.id as task_id,
      t.result_text,
      (c.amount = any (amt.arr)) as by_sum
    from candidates c
    join deal_inn di on di.inn = c.payer_inn
    join public.amo_tasks t
      on t.amo_deal_id = di.amo_deal_id
     and t.is_completed
     and t.result_text ~* 'продл|пролонг'
     and t.updated_at_amo is not null
    cross join lateral (select public.renewal_amounts_thousands(t.result_text) as arr) amt
    where (c.amount = any (amt.arr))
       or abs(
            (t.updated_at_amo at time zone 'Europe/Moscow')::date
            - (c.occurred_at   at time zone 'Europe/Moscow')::date
          ) <= 14
  ),
  task_ranked as (
    select transaction_id, amo_deal_id, task_id, result_text, by_sum,
           count(*) over (partition by transaction_id) as n
    from task_hits
  ),
  task_confirmed as (
    select transaction_id, amo_deal_id,
           'по тексту задачи (сделка ' || amo_deal_id || '): «'
             || left(coalesce(result_text, ''), 200) || '»'
             || case when by_sum then ' — сумма совпала'
                     else ' — дата рядом (±14 дней)' end as note
    from task_ranked tr
    where n = 1
      -- Сигнал 1 (комментарий) приоритетнее и сильнее: если платёж уже
      -- подтверждён комментарием, задача не конкурирует за строку. Без
      -- этого исключения один и тот же transaction_id мог бы попасть и в
      -- note_confirmed, и в task_confirmed — resolved ниже дал бы для него
      -- ДВЕ строки, и insert ... on conflict упал бы с «cannot affect row a
      -- second time» на первом же пересечении.
      and not exists (
        select 1 from note_confirmed nc where nc.transaction_id = tr.transaction_id
      )
  ),

  -- ── Сигнал 3 (project_type) — не изменилось с 20260803_0002, кроме
  -- добавленного исключения того, что подтвердил сигнал 1.
  project_hits as (
    select c.transaction_id, p.id as project_id, p.name as project_name
    from candidates c
    join public.bank_transactions bt on bt.id = c.transaction_id
    join public.projects p
      on p.project_type = 'Продление'
     and abs(
           (case when p.payment_date ~ '^\d{4}-\d{2}-\d{2}$'
                 then p.payment_date::date end)
           - (c.occurred_at at time zone 'Europe/Moscow')::date
         ) <= 14
     and coalesce(btrim(bt.payer_name), '') <> ''
     and coalesce(btrim(p.client), '') <> ''
     and length(btrim(p.client)) > 3
     and (
       position(lower(btrim(p.client)) in lower(btrim(bt.payer_name))) > 0
       or position(lower(btrim(bt.payer_name)) in lower(btrim(p.client))) > 0
     )
  ),
  project_ranked as (
    select transaction_id, project_id, project_name,
           count(*) over (partition by transaction_id) as n
    from project_hits
  ),
  project_confirmed as (
    select pr.transaction_id,
           'по проекту «' || pr.project_name
             || '» (project_type=Продление), дата оплаты рядом (±14 дней)' as note
    from project_ranked pr
    where pr.n = 1
      -- Приоритет: комментарий → задача → тип проекта. Оба сильных сигнала
      -- исключаются здесь — не только задача, как было в 20260803_0002.
      and not exists (
        select 1 from task_confirmed tc where tc.transaction_id = pr.transaction_id
      )
      and not exists (
        select 1 from note_confirmed nc where nc.transaction_id = pr.transaction_id
      )
  ),

  resolved as (
    select transaction_id, amo_deal_id, 'note_text'::text as method, note
    from note_confirmed
    union all
    select transaction_id, amo_deal_id, 'task_text'::text as method, note
    from task_confirmed
    union all
    select transaction_id, null::bigint as amo_deal_id, 'project_type'::text as method, note
    from project_confirmed
  )

  insert into public.renewal_marks (transaction_id, is_renewal, method, amo_deal_id, note, matched_at)
  select transaction_id, true, method, amo_deal_id, note, now()
  from resolved
  on conflict (transaction_id) do update
     set is_renewal  = excluded.is_renewal,
         method      = excluded.method,
         amo_deal_id = excluded.amo_deal_id,
         note        = excluded.note,
         matched_at  = now()
   -- Ключевая строка не изменилась с 20260803_0002: ручное решение
   -- неприкосновенно, и 'manual', и 'not_renewal' — оба обязаны быть здесь.
   where public.renewal_marks.method not in ('manual', 'not_renewal');

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.apply_renewal_marks() from public;
grant execute on function public.apply_renewal_marks() to service_role, postgres;

comment on function public.apply_renewal_marks() is
  'Автоподтверждение продлений, приоритет сверху вниз: (1) комментарий AMO вида «Продление N - сумма» у сделки того же ИНН, начиная с 2026-08-03, начинающийся с этого слова — сильнейший сигнал, дата события = created_at_amo комментария; (2) текст выполненной задачи со словом «продл»/«пролонг» — как раньше; (3) project_type=Продление у проекта того же клиента — как раньше, только сейчас. Каждый следующий сигнал применяется лишь к тому, что не подтвердил предыдущий (not exists), поэтому один transaction_id даёт ровно одну строку. Неоднозначные (несколько подходящих комментариев/задач/проектов) остаются неразмеченными. Ручные решения (method=manual|not_renewal) не перезаписываются никогда.';

-- ─── 'note_text' в CHECK renewal_marks.method ───────────────────────────────
-- Column-level CHECK без явного имени в 20260803_0002_renewal_marks.sql —
-- Postgres назвал его по умолчанию <table>_<column>_check (тот же приём
-- рефакторинга, что в 20260731_0002_meeting_deal_links_not_a_meeting.sql для
-- meeting_deal_links_method_check).
alter table public.renewal_marks
  drop constraint if exists renewal_marks_method_check;
alter table public.renewal_marks
  add constraint renewal_marks_method_check
  check (method in ('note_text','task_text','project_type','manual','not_renewal'));

comment on column public.renewal_marks.method is
  'note_text — подтверждено комментарием AMO «Продление N - сумма» (сильнейший сигнал, дата события — created_at_amo комментария). task_text — подтверждено текстом задачи AMO. project_type — подтверждено вторым по силе сигналом: у клиента есть проект project_type=Продление с датой оплаты рядом. manual — человек нажал «продление». not_renewal — человек нажал «транш той же оплаты» или «другая услуга»; is_renewal при этом всегда false.';
comment on column public.renewal_marks.amo_deal_id is
  'Сделка AMO, чей комментарий (method=note_text) или задача (method=task_text) подтвердили продление. NULL у method=project_type — второй сигнал идёт через совпадение имени клиента с projects.client, а не через сделку. Всегда NULL у not_renewal.';
