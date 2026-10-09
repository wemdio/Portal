-- Автоподъём ENG-базы, легшей на ВРЕМЕННОМ отказе провайдера.
--
-- Ретрай на уровне ДЖОБЫ у V1 уже есть (MAX_ATTEMPTS=3, волна 3 добавила паузу
-- по Retry-After и типизированные классы отказов). Чего нет — возврата САМОЙ
-- БАЗЫ в работу после ФИНАЛЬНОГО фейла: моргнул Serper — и he_bases лежит в
-- 'failed' до того, как клиент сам нажмёт «Collect base» ещё раз. Кабинет при
-- этом честно пишет ему «Start the step again in a few minutes»
-- (clientErrors.ts, код 'provider') — этот проход делает ровно то, что там
-- написано, но сам.
--
-- ПРОХОД ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ. Ночной крон (app/worker/heAutoPipelineCron.ts →
-- lib/hypothesisEngine/baseAutoResume.ts) зовёт эту функцию ТОЛЬКО при
-- HE_AUTO_RESUME_TRANSIENT=1 (а также true/on/yes) в окружении воркера; флаг по
-- умолчанию не выставлен, и без него не поднимается ни одна база — упавшая
-- остаётся 'failed', пока клиент сам не нажмёт «Collect base». Сама миграция
-- только создаёт колонки и функции и ничего не вызывает.
--
-- Все условия и счётчик живут ЗДЕСЬ, в SQL (образец — V2,
-- 20260921_0001_ve_auto_resume_transient.sql): проход зовётся из ночного крона
-- одним RPC, и гонка крона с воркером не должна поднять базу дважды.
--
-- ─── Чего этот проход НЕ поднимает (каждый пункт — способ сделать вред) ───
--
--  1. ОТМЕНУ КЛИЕНТОМ. ENG-роут отмены пишет базе английское
--     'Cancelled by user' (api/client/eng/projects/[id]/cancel/route.ts),
--     staff-роут — русский текст, и regexp по сообщению из V2 («Отменено
--     пользователем») воскресил бы отменённые клиентом базы. Решает ДОЛГОВЕЧНЫЙ
--     ФАКТ, а не текст: оба роута переводят джобы базы в he_jobs.status =
--     'cancelled', и наличие такой джобы исключает базу навсегда.
--     Этого факта мало для базы, которая упала ДО отмены: её джоба к нажатию
--     кнопки уже 'failed', роут её не трогает (он переводит только
--     pending/running), и текст отмены база не получает (роут валит только
--     'collecting'/'analyzing'). Отмена же — кнопка ПРОЕКТА: оба роута
--     переводят в 'cancelled' ВСЕ активные джобы проекта и ставят им
--     finished_at = момент отмены. Если активная джоба была, долговечный факт
--     «клиент остановил проект после того, как база упала» лежит в БД:
--     отменённая джоба ТОГО ЖЕ ПРОЕКТА с finished_at не раньше
--     he_bases.updated_at (момента, когда базу свалили). Такая база тоже не
--     поднимается — условие стоит и в выборке кандидатов, и в CAS апдейта.
--     ДЫРА (с 08.10.2026): клиентский роут отмены больше не отвечает 409 при
--     нуле активных джоб — он отменяет и тогда (снимает автопилот, ставит
--     паузу ночного добора). Такая отмена НЕ оставляет отменённой джобы, и
--     база, упавшая на временном отказе ДО неё, ЭТОЙ версией функции
--     поднялась бы. Закрыта в 20261009_0002_he_project_cancel_marker.sql:
--     долговечная отметка he_projects.cancelled_at (её пишут роуты отмены) и
--     пересозданная функция с условием «база упала не позже отметки — не
--     поднимается». HE_AUTO_RESUME_TRANSIENT включать только вместе с ОБЕИМИ
--     миграциями; без 20261009_0002 проход не идёт — baseAutoResume.ts
--     проверяет колонку и бросает, не вызвав функцию.
--     Отмена, случившаяся ДО падения базы (клиент остановил проект, потом
--     запустил сборку заново, и она упала), подъёму не мешает: остановленная
--     работа к этой базе не относится.
--  2. РЕШЕНИЯ САМОГО ДВИЖКА. «Сегмент исчерпан», «Авто-сборка не дала строк»,
--     отказ пробы среза («не покрывается каталогом»), таймаут конструктора —
--     это не сбои, а остановки с причиной. Их повтор — это повтор уже
--     полученного ответа за новые деньги.
--  3. ПЕРМАНЕНТНЫЙ отказ провайдера (волна 3): 402/401/403, «Serper billing:»,
--     «Serper configuration:», имя env-переменной ключа. Баланс за ночь сам не
--     пополняется, ключ сам не починится.
--  4. REFILL-базы ночного долива: у долива свой терминал
--     (stages/baseCollectRefill.ts), и его 'failed'-база выпадает из
--     кросс-базового исключения — подъём заставил бы крон платить за те же
--     компании заново.
--  5. БАЗЫ РЫНКА 'ru'. Это staff-инструмент /tools/hypothesis-engine, которым
--     работают каждый день: подъём отменял бы РУЧНОЕ решение специалиста.
--     Гейт he_projects.market = 'us' стоит ДВАЖДЫ — в выборке кандидатов и в
--     WHERE самого апдейта, — и параметра «рынок» у функции нет вовсе, поэтому
--     промахнуться им нельзя ни вызовом, ни конфигом.
--  6. БАЗЫ, У КОТОРЫХ СБОР ДОШЁЛ ДО КОНЦА. row_count = 0 плюс «по базе нет ни
--     одной джобы, кроме base_collect»: собранная база с упавшим АНАЛИЗОМ
--     нуждается в base_analyze, а не во второй сборке.
--  7. БАЗЫ, КОТОРЫЕ КЛИЕНТ УЖЕ ЗАМЕНИЛ САМ. Кабинет на временном отказе пишет
--     «Start the step again in a few minutes», клиент жмёт «Collect base», и
--     enqueueHeBaseCollect делает НОВУЮ базу (упавшая конфликтом не считается).
--     Поднять после этого старую — заплатить за сборку вертикали, которая уже
--     собрана или собирается. Поэтому вертикаль, у которой есть auto-база в
--     'collecting' / 'analyzing' / 'analyzed', отказывает подъёму с причиной
--     'vertical_<статус>', а база, у которой есть БОЛЕЕ МОЛОДАЯ не-refill сестра
--     той же вертикали, — с причиной 'superseded'. Тот же предикат «вертикали
--     нужна ОДНА база» стоит в клиентском роуте запуска
--     (api/client/eng/projects/[id]/autopilot): там он запрещает даже
--     БЕСПЛАТНЫЙ ремонт осиротевшей базы, а здесь речь о полной платной сборке.
--
-- ─── Что это стоит ───
-- Подъём вставляет НОВУЮ he_jobs base_collect (attempts = 0) и возвращает базу
-- в 'collecting': start-guard стадии требует ровно этот статус
-- (stages/baseCollect.ts), а оживлять старую строку джобы нельзя — её attempts
-- уже исчерпаны. Новая джоба = ещё до MAX_ATTEMPTS прогонов стадии. Оплаченное
-- при этом НЕ переплачивается: стадия продолжает с чекпойнтов в
-- he_bases.collect_info (plan, harvest каждой задачи, relevance_gate.ran =
-- доказательство оплаты гейта, construct.bc_job_id = уже поставленная джоба
-- конструктора). Потолок подъёмов — he_bases.auto_resumes, пожизненный (НЕ
-- оконный, как в V2: там подготовка копит контакты между подъёмами, здесь
-- подъём может заново оплатить построение плана).

-- ─── 1. Счётчик подъёмов на строке базы ──────────────────────────────────
-- Пожизненный и монотонный: его никто не уменьшает, поэтому цикл «упал →
-- подняли → упал» обязан кончиться. Ручной повторный запуск сборки счётчик не
-- трогает — он создаёт НОВУЮ базу.

alter table public.he_bases
  add column if not exists auto_resumes integer not null default 0;
alter table public.he_bases
  add column if not exists auto_resumed_at timestamptz;

comment on column public.he_bases.auto_resumes is
  'Сколько раз базу возвращал в сборку автоподъём после временного отказа провайдера (he_auto_resume_transient_bases). Ручная кнопка «Collect base» счётчик не трогает: она создаёт новую базу.';
comment on column public.he_bases.auto_resumed_at is
  'Когда автоподъём последний раз вернул эту базу в сборку (остывание между подъёмами).';

-- ─── 2. Предикат «это временный отказ провайдера» ────────────────────────
-- Зеркало ОДНОГО кода кабинета — 'provider' из
-- lib/hypothesisEngine/clientErrors.ts (classifyHeClientError), но НЕ зеркало
-- порядка его правил, и разница сознательная. Классификатор проверяет биллинг и
-- конфигурацию, затем СРАЗУ белый список провайдера (429/5xx, «Serper
-- transient:») и только потом решения движка. Здесь решения движка отсекаются
-- ДО белого списка: текст вида «Авто-сборка не дала строк: google_maps —
-- Serper transient: …» кабинет называет 'provider', а эта функция — нет. Это
-- строже кабинета в безопасную сторону: решение движка с вложенным 5xx — всё
-- равно решение, его повтор покупает тот же ответ, и платить за него ночью без
-- человека нельзя. Клиенту такой текст обещает только РУЧНОЙ повтор («Start
-- the step again»), а ручной повтор этой функцией не ограничен.
--
-- Почему именно 'provider', а не «всё, что похоже на транзиент»: этим кодом
-- кабинет ОБЕЩАЕТ клиенту «Start the step again in a few minutes». Всё
-- остальное он классифицирует иначе и повтора не обещает — в том числе
-- 'timeout' (таймаут конструктора и сторож простоя) и 'internal'
-- («Requesty transport: …»), которые сознательно НЕ поднимаются: первый —
-- решение движка, второй может означать оплаченный, но не разобранный ответ.
--
-- Регистронезависимость (~*) нужна только латинице; кириллические образцы
-- написаны в том же регистре, в котором их печатает код, поэтому правило не
-- зависит от того, умеет ли локаль складывать регистр кириллицы.
create or replace function public.he_transient_collect_error(p_error text)
returns boolean language sql immutable set search_path = '' as $$
  select p_error is not null
    and btrim(p_error) <> ''
    -- (1) Баланс провайдера — перманентно.
    and p_error !~* '(requesty|serper|openrouter)[[:space:]]*(http[[:space:]]*)?[:(]?[[:space:]]*402\y'
    and p_error !~* 'serper billing:'
    and not (
      p_error ~* '\y(requesty|serper|openrouter)\y'
      and p_error ~* '(not enough credits|insufficient[ _-]+(funds|balance|credits|search credits)|payment[ _-]+required|credit balance (is )?too low)'
    )
    -- (2) Ключ/конфигурация провайдера — перманентно.
    and p_error !~* 'serper configuration:'
    and p_error !~* '(requesty|serper|openrouter)[[:space:]]*(http[[:space:]]*)?[:(]?[[:space:]]*(401|403)\y'
    and p_error !~* '\y(openrouter|requesty|serper)[a-z0-9_]*_api_key\y'
    and not (
      p_error ~* '\y(requesty|serper|openrouter)\y'
      and p_error ~* '((missing|invalid|absent|rejected)[ _-]+(api[ _-]+)?key|api[ _-]+key.{0,30}(missing|invalid|absent|rejected))'
    )
    -- (3) Решения самого движка: остановка с причиной, а не сбой.
    and p_error !~* '(не покрывается каталогом|Сегмент исчерпан|не осталось новых|Авто-сборка не дала строк|план пуст)'
    and p_error !~* '(Конструктор баз не завершился|конструктор завершился со статусом|конструктор вернул пустые данные)'
    and p_error !~* '(разноса адресов по строкам|вердикты валидации в такой сетке)'
    -- Отмену решает СТАТУС джобы (he_auto_resume_transient_bases), не текст:
    -- эти две строки — вторая сетка, а не решение.
    and p_error !~* '(Cancelled by user|Отменено пользователем)'
    -- (4) Белый список: ровно то, что кабинет называет 'provider'.
    and (
      p_error ~* '(requesty|serper|openrouter)[[:space:]]*(http[[:space:]]*)?[:(]?[[:space:]]*(429|5[0-9][0-9])\y'
      or p_error ~* 'serper transient:'
    );
$$;

comment on function public.he_transient_collect_error(text) is
  'Временный отказ провайдера (код кабинета provider): 429/5xx Requesty|Serper|OpenRouter и «Serper transient:». Баланс, ключ, отмена и решения движка — false.';

-- ─── 3. Один проход автоподъёма ──────────────────────────────────────────
-- Возвращает ПО СТРОКЕ НА КАНДИДАТА — крон логирует и поднятые, и отказы с
-- причиной. Пишет ТОЛЬКО по строкам с outcome='resumed'.
--
-- Разделение «жёсткое условие → фильтр, граница → причина отказа» сделано
-- намеренно. Отмена, рынок, refill, транзиентность и «сбор дошёл до конца»
-- стоят в WHERE: до ветки записи такая база не доезжает в принципе, и никакая
-- ошибка в порядке if'ов ниже не может её поднять. Причинами отказа объясняются
-- только границы (потолок подъёмов, остывание, занятая или уже подготовленная
-- вертикаль, база, которую клиент заменил новее, проигранная гонка) — их видно в
-- ночном логе, и их немного, потому что окно кандидатов ограничено
-- p_max_age_hours. Границы «вертикаль занята/подготовлена» и «базу заменили»
-- продублированы внутри WHERE апдейта: там они превращаются в 'raced', зато не
-- зависят от порядка if'ов.
create or replace function public.he_auto_resume_transient_bases(
  p_limit integer default 5,
  p_max_resumes integer default 2,
  p_min_age_minutes integer default 10,
  p_max_age_hours integer default 72,
  p_now timestamptz default now()
) returns table (
  base_id     uuid,
  project_id  uuid,
  vertical_id uuid,
  outcome     text,
  reason      text,
  resumes     integer,
  job_id      uuid
) language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
-- Директива — первой строкой тела (так её показывает документация plpgsql).
-- Зачем: имена трёх выходных колонок совпадают с колонками he_bases/he_jobs.
-- Все ссылки на колонки ниже квалифицированы префиксом таблицы, а директива
-- страхует от промаха — неквалифицированное имя внутри запроса значит КОЛОНКУ,
-- ровно как в обычном SQL.
declare
  v_limit    constant integer  := greatest(1, least(coalesce(p_limit, 5), 20));
  v_max      constant integer  := greatest(1, least(coalesce(p_max_resumes, 2), 5));
  v_cooldown constant interval := make_interval(mins => greatest(1, least(coalesce(p_min_age_minutes, 10), 24 * 60)));
  v_window   constant interval := make_interval(hours => greatest(1, least(coalesce(p_max_age_hours, 72), 14 * 24)));
  item    record;
  v_done    integer := 0;
  v_outcome text;
  v_reason  text;
  v_job_id  uuid;
  -- Статус базы вертикали, из-за которой подъём не нужен ('collecting' —
  -- собирается прямо сейчас, 'analyzing'/'analyzed' — сборка УЖЕ удалась).
  v_busy_status text;
begin
  for item in
    select b.id as base_id,
           b.project_id as base_project_id,
           b.vertical_id as base_vertical_id,
           -- Точка отсчёта «сестра моложе меня» (граница 'superseded').
           b.created_at as base_created_at,
           b.auto_resumes as resumes_before,
           b.auto_resumed_at as resumed_at,
           last_job.payload as job_payload
      from public.he_bases b
      -- Гейт рынка №1. RU-проект не попадает в кандидаты вообще.
      join public.he_projects p on p.id = b.project_id and p.market = 'us'
      -- ПОСЛЕДНЯЯ джоба сборки этой базы: судим по ней, а не по любой из
      -- прошлых. После подъёма последней становится новая (pending) — и база
      -- перестаёт быть кандидатом до её собственного финала.
      join lateral (
        select j.status, j.error, j.payload
          from public.he_jobs j
         where j.project_id = b.project_id
           and j.stage = 'base_collect'
           and j.payload->>'base_id' = b.id::text
         -- id как тайбрейк: две джобы с одинаковым created_at иначе дали бы
         -- неустойчивый выбор «последней».
         order by j.created_at desc, j.id desc
         limit 1
      ) last_job on true
     where b.source = 'auto'
       and b.status = 'failed'
       -- Сбор не доходил до финальной записи: строк у базы нет. Собранная
       -- база с упавшим анализом лечится анализом, а не второй сборкой.
       and b.row_count = 0
       -- Окно: вчерашний блип поднимаем, недельный труп — нет. Это же окно
       -- держит ночной лог коротким.
       and b.updated_at > p_now - v_window
       -- Refill ночного долива — тремя независимыми признаками.
       and coalesce(b.filename, '') not like 'auto-refill%'
       and (b.collect_info -> 'refill') is distinct from 'true'::jsonb
       and (last_job.payload -> 'refill') is distinct from 'true'::jsonb
       -- Финальный фейл именно сборки, и причина — временный отказ провайдера.
       -- Спрашиваем ОБА текста: he_jobs.error (что сказал провайдер) и
       -- he_bases.error (что записали базе). При штатном пути они совпадают, а
       -- расхождение значит, что базу свалил кто-то другой, — тогда не лезем.
       and last_job.status = 'failed'
       and public.he_transient_collect_error(last_job.error)
       and public.he_transient_collect_error(b.error)
       and not exists (
         select 1
           from public.he_jobs a
          where a.project_id = b.project_id
            and a.payload->>'base_id' = b.id::text
            and (
              -- Под базой уже идёт работа.
              a.status in ('pending', 'running')
              -- ОТМЕНА: долговечный факт оба роута отмены пишут именно так.
              or a.status = 'cancelled'
              -- База прошла сборку и жила дальше (анализ, шаблон).
              or a.stage <> 'base_collect'
            )
       )
       -- ОТМЕНА ПРОЕКТА ПОСЛЕ ПАДЕНИЯ БАЗЫ (пункт 1 шапки): её собственных джоб
       -- роут не тронул, но остановлен весь проект.
       and not exists (
         select 1
           from public.he_jobs c
          where c.project_id = b.project_id
            and c.status = 'cancelled'
            and coalesce(c.finished_at, c.updated_at) >= b.updated_at
       )
     -- Сначала те, кого ещё не поднимали: бюджет ночи не должен уходить на
     -- обход тех, кто уже упёрся в потолок.
     order by b.auto_resumes, b.updated_at
     limit 200
  loop
    exit when v_done >= v_limit;
    v_outcome := 'refused';
    v_reason := null;
    v_job_id := null;
    v_busy_status := null;

    -- ВЕРТИКАЛЬ УЖЕ ЗАНЯТА ИЛИ УЖЕ ПОДГОТОВЛЕНА — три статуса одним запросом,
    -- потому что все три значат одно: платить за ещё одну сборку этой вертикали
    -- не нужно.
    --  * 'collecting' — partial unique index he_bases_one_collecting_per_vertical
    --    дал бы 23505; спрашиваем ДО записи, чтобы отказ был НАЗВАН.
    --  * 'analyzing'/'analyzed' — сборка вертикали УЖЕ УДАЛАСЬ другой базой.
    --    Это главный путь, а не экзотика: кабинет на временном отказе просит
    --    клиента «start the step again», клиент жмёт «Collect base», и
    --    enqueueHeBaseCollect делает НОВУЮ базу — упавшая ему не конфликт.
    --    Старая при этом остаётся кандидатом все 72 часа окна, и подъём заплатил
    --    бы полную сборку той вертикали, которую клиент уже собрал заново.
    -- Набор статусов и source='auto' — те же, которыми «подготовленность
    -- вертикали» считают автопилот (lib/hypothesisEngine/autopilotNext:
    -- afterChainDone) и клиентский роут запуска. Одно отличие сознательное: те
    -- два вычитают из набора refill-базы долива («auto-refill: …», успешный
    -- долив тоже кончает 'analyzed'), потому что решают, НАЧИНАТЬ ли работу, а
    -- здесь решается, ПЛАТИТЬ ли второй раз. Вертикаль, у которой идут доливы,
    -- давно запущена и основную базу имеет, так что лишний отказ тут бесплатен,
    -- а лишний подъём — нет.
    -- Причина отказа — с ИМЕНЕМ СТАТУСА ('vertical_collecting' как раньше,
    -- 'vertical_analyzing', 'vertical_analyzed'), чтобы ночной лог показывал, ПО
    -- КАКОЙ причине база не поднята, а не только то, что не поднята.
    select o.status into v_busy_status
      from public.he_bases o
     where o.vertical_id = item.base_vertical_id
       and o.source = 'auto'
       and o.status in ('collecting', 'analyzing', 'analyzed')
     order by array_position(array['collecting', 'analyzing', 'analyzed'], o.status)
     limit 1;

    if item.resumes_before >= v_max then
      v_reason := 'resume_cap';
    elsif item.resumed_at is not null and item.resumed_at > p_now - v_cooldown then
      v_reason := 'cooldown';
    elsif v_busy_status is not null then
      v_reason := 'vertical_' || v_busy_status;
    elsif exists (
      -- «Клиент уже перезапустил этот шаг» в самом точном виде: у вертикали есть
      -- БОЛЕЕ МОЛОДАЯ база. Она ловит и то, чего не ловит статус выше: сестра
      -- могла сама упасть ('failed') или ждать анализа ('uploaded'), и поднимать
      -- нужно самую свежую попытку, а не всю их череду.
      -- Refill ночного долива сестрой НЕ считается: долив создаёт базу той же
      -- вертикали каждую ночь (lib/hypothesisEngine/autoPipeline: filename
      -- «auto-refill: …»), и без этой оговорки один долив запретил бы подъёмы
      -- навсегда. Долив — не решение клиента, а добор в уже запущенную кампанию.
      -- Сравнение парой (created_at, id): у двух баз, созданных в одну
      -- микросекунду, иначе не было бы «младшей» вовсе, и обе стали бы
      -- кандидатами.
      select 1 from public.he_bases o
       where o.vertical_id = item.base_vertical_id
         and (o.created_at, o.id) > (item.base_created_at, item.base_id)
         and coalesce(o.filename, '') not like 'auto-refill%'
         and (o.collect_info -> 'refill') is distinct from 'true'::jsonb
    ) then
      v_reason := 'superseded';
    else
      -- Апдейт базы и вставка джобы — в одном блоке с обработчиком: исключение
      -- откатывает ОБА, и осиротевшей 'collecting'-базы без джобы не остаётся.
      begin
        update public.he_bases b
           set status = 'collecting',
               error = null,
               auto_resumes = b.auto_resumes + 1,
               auto_resumed_at = p_now,
               updated_at = p_now
         where b.id = item.base_id
           -- CAS: статус и счётчик те же, что мы читали.
           and b.status = 'failed'
           and b.source = 'auto'
           and b.auto_resumes = item.resumes_before
           -- Гейт рынка №2. Даже ошибка в выборке выше не даст записать
           -- ни одной RU-базы.
           and exists (
             select 1 from public.he_projects p2
              where p2.id = b.project_id and p2.market = 'us'
           )
           -- Отмена проекта после падения базы — второй сеткой в самой записи:
           -- клиент мог нажать отмену между выборкой и этим апдейтом.
           and not exists (
             select 1 from public.he_jobs c
              where c.project_id = b.project_id
                and c.status = 'cancelled'
                and coalesce(c.finished_at, c.updated_at) >= b.updated_at
           )
           -- Те же две границы, что назвали причину выше, — второй сеткой в
           -- самой записи: вертикаль занята/подготовлена…
           and not exists (
             select 1 from public.he_bases o
              where o.vertical_id = b.vertical_id
                and o.source = 'auto'
                and o.status in ('collecting', 'analyzing', 'analyzed')
           )
           -- …и базу уже заменили более молодой (не-refill) сестрой. Гонка между
           -- предпроверкой и записью здесь означает, что клиент нажал «Collect
           -- base» в эти миллисекунды, — и тогда подъём не состоится ('raced').
           and not exists (
             select 1 from public.he_bases o
              where o.vertical_id = b.vertical_id
                and (o.created_at, o.id) > (b.created_at, b.id)
                and coalesce(o.filename, '') not like 'auto-refill%'
                and (o.collect_info -> 'refill') is distinct from 'true'::jsonb
           );
        if not found then
          v_reason := 'raced';
        else
          -- Новая строка джобы, attempts = 0: start-guard стадии требует
          -- 'collecting', а у старой строки попытки уже сожжены. payload
          -- переносим как есть (base_id, лимит, выбранные гипотезы), сняв
          -- счётчик прерываний волны 3 — серия оборвана этим подъёмом.
          insert into public.he_jobs (project_id, stage, status, attempts, payload)
          values (item.base_project_id, 'base_collect', 'pending', 0, item.job_payload - 'interruptions')
          returning id into v_job_id;
          v_outcome := 'resumed';
          v_done := v_done + 1;
        end if;
      exception when others then
        -- Откатилось всё: и счётчик, и статус базы, и джоба. Ночь просто
        -- называет причину — платной работы не начиналось.
        v_outcome := 'refused';
        v_job_id := null;
        v_reason := 'sql_' || sqlstate;
      end;
    end if;

    return query
      select item.base_id,
             item.base_project_id,
             item.base_vertical_id,
             v_outcome,
             v_reason,
             item.resumes_before + (case when v_outcome = 'resumed' then 1 else 0 end),
             v_job_id;
  end loop;
end $$;

comment on function public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz) is
  'Один проход автоподъёма ENG-баз (market=us), легших на временном отказе провайдера: строка на кандидата, resumed/refused с причиной. Отмена (джоб базы или проекта после падения базы), refill, решения движка, рынок ru, уже собранная (collecting/analyzing/analyzed) вертикаль и база, заменённая более молодой, не поднимаются. Крон зовёт её только при HE_AUTO_RESUME_TRANSIENT=1 (по умолчанию выключено).';

-- ─── Права ───────────────────────────────────────────────────────────────
-- Движковые функции через PostgREST RPC не вызывают: только воркер/крон под
-- service_role. ALTER DEFAULT PRIVILEGES выдаёт execute роли PUBLIC, поэтому
-- отзываем ПОИМЁННО (20260920_0001_he_rls_lockdown.sql, линт
-- app/tests/migrations/grants.test.ts). Новых таблиц тут нет — только колонки,
-- а они наследуют права he_bases.

revoke all privileges on function public.he_transient_collect_error(text),
  public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz)
  from public, anon, authenticated;

grant execute on function public.he_transient_collect_error(text),
  public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz)
  to service_role, postgres;
