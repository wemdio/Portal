# Смена сайта ENG-клиента по просьбе клиента

Для Support и дежурного. Клиент англоязычного кабинета (`/client/eng`) пишет в чат Support, что хочет работать с другим сайтом.

> **ВНИМАНИЕ: удаление проекта — запись в production-БД.**
> Действуют правила [`AGENTS.md`](../../AGENTS.md), раздел «Release and production boundary (critical)»:
> - production меняется только с явного разрешения владельца, полученного непосредственно перед действием;
> - разрешение даётся на конкретный `id` проекта;
> - чтение (шаги 1–3) можно делать без разрешения;
> - SSH-доступ к серверу сам по себе не даёт права на запись ([`docs/ssh-access.md`](../ssh-access.md)).
>
> Удаление необратимо: отдельной копии строки нет, вернуть можно только из общего бэкапа БД.

## Почему только так

Решение владельца 10.10.2026: один аккаунт — один сайт.

- **Создание проекта.** Кабинет отказывает, если у аккаунта есть хоть одна строка `he_projects` с `created_by = клиент`. Статус и рынок не важны: упавший или остановленный проект тоже считается. Правило проверяется дважды: `requireEngPaidAccess` (`app/src/lib/hypothesisEngine/engPaidAccess.ts`) и под замком в `he_eng_create_project` (миграция `20261010_0002`).
- **Смена сайта.** PATCH проекта `website_url` не меняет.
- **Удаление.** У клиента удаления нет. Staff-инструмент `/tools/hypothesis-engine` проект тоже не удаляет: у `api/tools/hypothesis-engine/projects/[id]` есть только GET и PATCH.

Поэтому единственный путь такой: удалить старый проект в БД, после чего клиент сам создаёт новый на новый сайт. Кнопки в staff-инструменте для этого нет, только SQL ниже.

## Как подключаться

- **Чтение (шаги 1–3)** — любым read-only способом:
  - portal-db MCP: роль `readonly`, только SELECT, [`docs/portal-db-mcp-guide.md`](../portal-db-mcp-guide.md);
  - или psql в транзакции `begin read only;`.
  - Не выбирай `collect_info`, `data` и `launch_info` целиком: это мегабайты на строку. Запросы ниже достают из них только нужные поля.
- **Запись (шаг 5)** — только через SSH на prod-хост ([`docs/ssh-access.md`](../ssh-access.md)), затем:

  ```bash
  docker exec -i main-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1
  ```

  MCP с ролью `readonly` DELETE не выполнит.

В psql задай переменные один раз. Запросы ниже ссылаются на них как `:'email'`, `:'uid'` и `:'pid'`.

```sql
\set email 'client@example.com'
-- после шага 1.1:
\set uid  '00000000-0000-0000-0000-000000000000'
\set pid  '00000000-0000-0000-0000-000000000000'
```

Чтение оборачивай так:

```sql
begin read only;
set local statement_timeout = '20s';
-- запросы
rollback;
```

## 1. Проверки только на чтение

### 1.1 Клиент и его проекты

```sql
select id as user_id, email, role, market
  from public.profiles
 where lower(email) = lower(:'email');

select id, name, website_url, market, status, autopilot, created_at, updated_at
  from public.he_projects
 where created_by = :'uid'
 order by created_at;
```

- Ожидается ровно одна строка проекта.
- Если строк больше (аккаунт создал несколько проектов до правила), новый проект клиент сможет создать, только когда не останется ни одной. Шаги 1.3–5 тогда проходятся для каждого проекта.
- Владельцу пиши про все проекты сразу.

### 1.2 Каскад на проде совпадает с репозиторием

Схема prod может отставать от миграций репозитория, поэтому каскад проверяется по каталогу:

```sql
select conrelid::regclass as child, conname, confrelid::regclass as parent, confdeltype
  from pg_constraint
 where contype = 'f'
   and confrelid::regclass::text ~ '^(public\.)?he_'
 order by 3, 1;
```

Коды `confdeltype`: `c` — cascade, `n` — set null, `a` — no action, `r` — restrict.

- Ожидаются только `c` и `n`, кроме одной связи: `he_sending_pool` → `he_projects` (`he_sending_pool_project_id_fkey`) — `r` (restrict) намеренно (миграция `20261011_0001`). Проект с ящиками пула не удаляется, пока ящики не вернули в пул (шаг 5.0).
- Если есть другие `a` или `r`, удаление упадёт на этой связи. Остановись и напиши владельцу, ничего не трогая.

### 1.3 Запуска нет (обязательное условие)

Шаблон считается запущенным по тому же правилу, что в коде (`heTemplateLaunchMarked`, `app/src/lib/hypothesisEngine/launchTemplate.ts`):

- в `launch_info.campaign_id` непустая строка — кампания у рассыльщика создана;
- или `launch_info.running_until` позже текущего момента — идёт попытка запуска, её аренда живёт 15 минут и продлевается на каждой записи.

```sql
select t.id,
       t.status,
       t.launch_info->>'campaign_id' as campaign_id,
       case when jsonb_typeof(t.launch_info->'campaigns') = 'array'
            then jsonb_array_length(t.launch_info->'campaigns') end as campaigns,
       t.launch_info->>'running_until' as running_until,
       case when t.launch_info->>'running_until' ~ '^\d{4}-\d{2}-\d{2}'
            then (t.launch_info->>'running_until')::timestamptz > now() end as lease_live
  from public.he_templates t
 where (t.vertical_id in (select id from public.he_verticals where project_id = :'pid')
     or t.base_id in (select id from public.he_bases where project_id = :'pid'))
   and (coalesce(t.launch_info->>'campaign_id', '') <> ''
     or coalesce(t.launch_info->>'running_until', '') <> '');
```

**Стоп и вопрос владельцу**, если есть хоть одна строка, где:
- `campaign_id` не пуст;
- или `lease_live = true`;
- или `running_until` не похоже на дату (тогда `lease_live` пуст, и разобрать её надо руками).

Почему стоп:
- кампании продолжают жить у рассыльщика, удаление проекта их не останавливает;
- вместе с шаблоном каскадом уходит запись о том, кто попал в эти кампании (`launch_info`);
- уходят ночной долив и защита от повторной отправки тем же людям.

Строки, где есть только `running_until` в прошлом, — это законченные попытки без кампании, они удалению не мешают.

У первого запуска есть слепое окно: классификатор сегментов работает до того, как запуск пишет `launch_info`. Это окно видно только по журналу расхода:

```sql
select max(created_at) as last_launch_spend
  from public.application_logs
 where source = 'he_provider_usage'
   and request_id = :'pid'
   and context->>'stage' = 'launch'
   and created_at > now() - interval '30 minutes';
```

Если `last_launch_spend` не пуст, подожди 30 минут и повтори всю проверку 1.3.

### 1.4 Работа не идёт (обязательное условие)

```sql
-- активные джобы движка: должно быть пусто
select stage, status, count(*)
  from public.he_jobs
 where project_id = :'pid'
   and status in ('pending', 'running')
 group by 1, 2;

-- базы в работе: должно быть пусто
select id, status, source
  from public.he_bases
 where project_id = :'pid'
   and status in ('collecting', 'analyzing');

-- конструктор баз этого проекта: должно быть пусто
select bc.id, bc.status
  from public.he_bases b
  join public.base_constructor_jobs bc
    on bc.id::text = b.collect_info->'construct'->>'bc_job_id'
 where b.project_id = :'pid'
   and bc.status in ('pending', 'processing');

-- парсер карт этого проекта: должно быть пусто
select g.id, g.status
  from public.he_bases b
 cross join lateral jsonb_array_elements(
         case when jsonb_typeof(b.collect_info->'tasks') = 'array'
              then b.collect_info->'tasks' else '[]'::jsonb end) as task
  join public.google_maps_jobs g on g.id::text = task->>'child_job_id'
 where b.project_id = :'pid'
   and task->>'source' = 'google_maps'
   and g.status in ('queued', 'running', 'paused');
```

Если хоть что-то идёт, попроси клиента нажать «Cancel all jobs» на странице проекта. Эта кнопка:
- отменяет джобы;
- выключает автопилот;
- ставит на паузу ночной добор;
- останавливает конструктор и парсер карт у отменённых баз.

После этого повтори проверки 1.3 и 1.4.

Кнопка отмены в staff-инструменте слабее. Она отменяет джобы и базы и переводит `researching` в `draft`, но:
- не выключает автопилот;
- не ставит паузу ночного добора;
- не трогает конструктор и парсер карт.

Поэтому сначала используй кнопку клиента.

### 1.5 Включён ли потолок расхода клиента

Потолки задаются переменными окружения приложения. Пусто — потолок выключен, это значение по умолчанию.

```bash
docker exec portal printenv HE_US_CLIENT_SPEND_CAP_USD HE_US_CLIENT_DAY_SPEND_CAP_USD
```

Если хоть одна из переменных задана, **без решения владельца не удаляй**:
- сумма «за всё время» (`he_client_provider_spend_sum`, миграция `20261010_0001`) складывает расход только по проектам, которые есть сейчас. Удалённый проект уходит из неё навсегда, и клиент получает потраченное обратно в лимит (`app/src/lib/hypothesisEngine/engClientSpend.ts`, раздел «СУММА»);
- суточный порог недосчитывает этот расход 24 часа после удаления;
- журнал расхода (`application_logs`, `source = 'he_provider_usage'`, `request_id = id проекта`) не удаляется, но к клиенту его больше ничто не привязывает.

Сколько клиент потратил (если миграция `20261010_0001` применена):

```sql
select * from public.he_client_provider_spend_sum(:'uid'::uuid, null, null);
```

### 1.6 Сколько исследований клиент запустил сегодня

Удаление сбрасывает и дневной лимит исследований (`HE_US_MAX_RESEARCH_PER_DAY`, по умолчанию 5):
- старты `site_profile` удалённого проекта уходят из счёта вместе с его джобами;
- создание нового проекта лимит исследований не проверяет.

Поэтому новый проект сразу запускает платное исследование, сколько бы клиент ни потратил сегодня. Число нужно для сообщения владельцу:

```sql
select count(*) as research_starts_today
  from public.he_jobs j
  join public.he_projects p on p.id = j.project_id
 where p.created_by = :'uid'
   and p.market = 'us'
   and j.stage = 'site_profile'
   and j.created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
```

### 1.6a Ящики пула у проекта

Проект ENG получает ящики отправки из нашего пула при первом запуске (миграция `20261011_0001`). Если таблицы ещё нет на проде, запрос ответит `relation "public.he_sending_pool" does not exist` — тогда ящиков у проекта нет, шаг 5.0 пропускается.

```sql
select email, instantly_account_id, status, assigned_at
  from public.he_sending_pool
 where project_id = :'pid'
 order by email;
```

- Пусто — шаг 5.0 не нужен.
- Есть строки `assigned` — их возвращают в пул на шаге 5.0, до удаления. Без этого DELETE упадёт на связи restrict (шаг 1.2).

### 1.7 Что удалится

```sql
select (select count(*) from public.he_verticals where project_id = :'pid') as verticals,
       (select count(*) from public.he_hypotheses where project_id = :'pid') as hypotheses,
       (select count(*) from public.he_bases where project_id = :'pid') as bases,
       (select coalesce(sum(row_count), 0) from public.he_bases where project_id = :'pid') as base_rows,
       (select count(*) from public.he_templates t
         where t.vertical_id in (select id from public.he_verticals where project_id = :'pid')) as templates,
       (select count(*) from public.he_chains c
         where c.vertical_id in (select id from public.he_verticals where project_id = :'pid')) as letter_sequences,
       (select count(*) from public.he_jobs where project_id = :'pid') as jobs;
```

## 2. Согласование с владельцем

Напиши владельцу одним сообщением:
- почту аккаунта;
- `id`, имя, старый `website_url` и статус проекта, а также новый сайт со слов клиента;
- итоги проверок 1.3 и 1.4 (пусто или что найдено);
- сколько ящиков пула у проекта (1.6a) — они вернутся в пул и достанутся следующему новому проекту;
- включён ли потолок расхода (1.5) и сколько исследований клиент запустил сегодня (1.6);
- счётчики «что удалится» (1.7);
- точное действие: «удалить `he_projects` id … (created_by …) одной транзакцией по шагу 5 этого runbook».

Дальше — только после явного «да» на этот `id`. Разрешение на один проект не переносится на другой.

## 3. Снимок перед удалением

Ответы клиента из старого проекта на новый не переносятся. Форма создания спрашивает описание бизнеса и целевую аудиторию заново. Сохрани их, чтобы отдать клиенту по просьбе:

```sql
select id, created_by, name, website_url, market, status, created_at,
       brief->>'business_override' as business_description,
       brief->'icp' as target_audience
  from public.he_projects
 where id = :'pid';
```

Результат храни во внутренней заметке тикета Support. В общие каналы его не выкладывай: это данные клиента.

## 4. Последняя проверка перед записью

Повтори шаги 1.3 и 1.4 прямо перед шагом 5. Между согласованием и удалением клиент мог что-то запустить.

Шаг 5 повторяет эти условия ещё раз внутри самого DELETE, так что строка удалится, только если они верны в момент записи. Шаг 4 нужен, чтобы увидеть *что именно* мешает, а не только «удалено 0 строк».

## 5. Удаление (production write, только после «да» владельца)

### 5.0 Вернуть ящики пула (если 1.6a не пуст)

Тоже запись в production — только после того же «да» владельца.

Основной путь — кнопка staff-инструмента: `/tools/hypothesis-engine` → «Пул ящиков ENG» → «Открыть» → блок «Проекты с ящиками пула» → строка проекта → «Вернуть ящики в пул». Кнопка делает две вещи:
- возвращает все ящики проекта в свободные (`he_sending_pool_release`, под замком пула);
- убирает их адреса из пресета отправки владельца проекта (`client_campaign_presets` в БД рассыльщика). Иначе устаревший пресет держал бы ящик, который пул отдаст другому клиенту, и запуск того клиента отказал бы.

Ответы кнопки:
- «возвращено N» и «Адреса убраны из пресета владельца» или «В пресете владельца этих адресов не было» — переходи к 5.1;
- «Пресет владельца НЕ очищен» — ящики в пул вернулись, но адреса остались в пресете. Убери их на `/admin/clients/<uid>/preset` (сними галочки у этих адресов и сохрани), затем 5.1;
- «У проекта есть запуск…» — ничего не возвращено: после проверки 1.3 у проекта появилась кампания или идущая попытка запуска. Повтори шаги 1.3–4;
- «У проекта нет ящиков пула» — переходи к 5.1.

Запасной путь (кнопка недоступна) — psql в `main-postgres`, отдельной транзакцией до 5.1:

```sql
select public.he_sending_pool_release(:'pid'::uuid);
```

Ответ `{"outcome": "released", ...}` — ящики вернулись; `launched` — ничего не возвращено (см. выше); `nothing_assigned` — возвращать нечего. Адреса из пресета владельца этот путь НЕ убирает: сделай это на `/admin/clients/<uid>/preset`.

Функция возвращает ящики только у проекта без запуска (то же правило, что условия DELETE в 5.1). Если после 5.0 клиент успел снова нажать Launch, запуск выдаст проекту ящики заново, и DELETE в 5.1 упадёт на связи restrict (5.2).

**Удаление проекта (5.1–5.3).** Запускай в psql внутри `main-postgres` (раздел «Как подключаться»). Шаг состоит из трёх частей. Вставляй их **по одной** и читай ответ psql после каждой.

### 5.1 Открыть транзакцию и удалить с условиями

```sql
\set pid '…'
\set uid '…'

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

delete from public.he_projects p
 where p.id = :'pid'
   and p.created_by = :'uid'
   -- нет активных джоб движка
   and not exists (
         select 1 from public.he_jobs j
          where j.project_id = p.id
            and j.status in ('pending', 'running'))
   -- нет баз в работе
   and not exists (
         select 1 from public.he_bases b
          where b.project_id = p.id
            and b.status in ('collecting', 'analyzing'))
   -- нет шаблона с кампанией или с живой арендой запуска
   and not exists (
         select 1 from public.he_templates t
          where (t.vertical_id in (select v.id from public.he_verticals v where v.project_id = p.id)
              or t.base_id in (select b2.id from public.he_bases b2 where b2.project_id = p.id))
            and (coalesce(t.launch_info->>'campaign_id', '') <> ''
              or case when t.launch_info->>'running_until' ~ '^\d{4}-\d{2}-\d{2}'
                      then (t.launch_info->>'running_until')::timestamptz > now()
                      else coalesce(t.launch_info->>'running_until', '') <> ''
                 end))
   -- нет недавнего расхода на запуск (окно классификатора, см. ниже)
   and not exists (
         select 1 from public.application_logs l
          where l.source = 'he_provider_usage'
            and l.request_id = p.id::text
            and l.context->>'stage' = 'launch'
            and l.created_at > now() - interval '30 minutes')
returning p.id, p.name, p.website_url;
```

Что здесь важно:
- **Условия — внутри DELETE.** Если после шага 4 что-то запустилось, DELETE вернёт `DELETE 0` и ничего не удалит. Выводить проверки отдельными SELECT и потом удалять «вслепую» нельзя.
- **`running_until`, не похожее на дату, тоже блокирует.** Разбор строки идёт через `case`, а не через `and`: Postgres не обещает порядок проверок в `and`, и приведение мусора к `timestamptz` уронило бы весь запрос. Мусорную аренду разбери руками и согласуй с владельцем.
- **Блокировка строки проекта не останавливает запуск шаблона.** DELETE берёт блокировку строки `he_projects`. Это задерживает только вставку новых строк, которые ссылаются на проект (джобы, базы). Запуск шаблона пишет только в `he_templates`, поэтому он может начаться параллельно.
- **Слепое окно запуска.** Классификатор сегментов работает до того, как запуск запишет `launch_info`. Это окно запрос видит только по журналу расхода на запуск за последние 30 минут, и только у шаблонов, где классификатор вызывается. Запуск без классификатора, начатый в ту же секунду, не виден ничем. Поэтому перед шагом 5 попроси клиента ничего не запускать (или нажать «Cancel all jobs», раздел 1.4).
- **`lock_timeout`.** Если он сработал, строки проекта сейчас пишет воркер. Выполни `rollback;`, подожди и начни с шага 4.

### 5.2 Прочитать ответ

- **`DELETE 1`** и одна строка в `returning`, совпадающая с согласованным проектом: переходи к 5.3.
- **`DELETE 0`**: одно из условий не выполнено или `id`/`created_by` не те. Выполни `rollback;` и повтори шаг 4, чтобы увидеть причину.
- **`ERROR: update or delete on table "he_projects" violates foreign key constraint "he_sending_pool_project_id_fkey"`**: у проекта есть ящики пула (не сделан 5.0, или клиент снова запустил после него). Выполни `rollback;`, повтори 1.3, 1.6a и 5.0.
- **Ошибка или что-то другое**: выполни `rollback;` и действуй по разделу 7.

### 5.3 Зафиксировать — отдельной командой, только после `DELETE 1`

```sql
commit;
```

До `commit;` удаление видно только этой сессии и отменяется `rollback;`. Не держи транзакцию открытой надолго: пока она открыта, строка проекта заблокирована.

### Что удаляет каскад

Одна строка `he_projects` уносит за собой:

| От чего | Что удаляется |
|---|---|
| проекта (`project_id … on delete cascade`) | `he_jobs`, `he_hypotheses`, `he_verticals`, `he_bases`, `he_vertical_dossiers`, `he_cases`, `he_auto_pipeline_configs` (конфиг ночного добора — добор по проекту прекращается), `he_refill_daily_budgets`, `he_refill_daily_reservations`, `he_refill_carryover` |
| вертикалей | `he_chains` (письма), `he_vocab`, `he_templates`, `he_catalog_cursors` (закладки каталога); `he_hypotheses.vertical_id` у оставшихся строк обнуляется (`set null`), но эти гипотезы и так уходят по `project_id` |
| баз | `he_templates` (по `base_id`), `he_refill_carryover` |
| шаблонов | `he_launch_schedule` |
| конфига добора | `he_auto_pipeline_runs` с этим `config_id` |

Источники в репозитории: `20260724_0001_create_hypothesis_engine.sql`, `20260728_0001`, `20260804_0005`, `20260926_0002`, `20260930_0002`, `20260930_0004`, `20261004_0001`. Фактический набор на проде — по запросу 1.2.

Ящики пула (`he_sending_pool`, `20261011_0001`) каскадом не удаляются и не обнуляются: связь restrict, их возвращает шаг 5.0. Строки пула остаются и после удаления проекта — свободными, их получит следующий новый проект.

### Что остаётся (ссылки без FK, не удаляются)

- **`application_logs`.** Журнал расхода (`source = 'he_provider_usage'`, `request_id = id проекта`), аудит и трассы (`trace_spans`). Расход в нём остаётся, но к клиенту больше не привязан (см. 1.5).
- **`he_auto_pipeline_runs`.** Строки прогонов добора, записанные с пустым `config_id`.
- **Внешние джобы.** Строки `base_constructor_jobs` и `google_maps_jobs` этого проекта (законченные, раз проверка 1.4 пуста).
- **Журнал контактов клиентских кампаний** (`client_campaign_contact_ledger`, `client_campaign_append_batches`). Записи есть только если были запуски, а проверка 1.3 их исключает.
- **`ve_legacy_project_links`.** Связи v2 со старым проектом, если были.
- **Кампании у рассыльщика.** Их нет, раз проверка 1.3 пуста. Если удалили проект с кампаниями, они продолжают жить у рассыльщика, а запись о них потеряна.
- **Аккаунт клиента целиком.** Профиль, подтверждённая почта (`he_eng_email_verifications` привязана к профилю, а не к проекту) и подключённые ящики (`/client/eng/mailboxes`).
- **Пресет отправки клиента** (`client_campaign_presets`, БД рассыльщика) — один на аккаунт. После 5.0 в нём нет адресов пула; новый проект при первом запуске получит из пула свои ящики, и пресет заполнится ими.

## 6. Что видит клиент после удаления

- **`/client/eng`.** Список проектов пуст, поэтому показывается форма «Your project»:
  - поля «Website», «Project name (optional)», «Describe your business (optional)», «Who do you sell to? (optional)»;
  - кнопка «Create & start research».
  - Старые ответы в форме не подставляются.
- **Command Center.** Показывает «No project yet» и «Create your project».
- **Старая ссылка на проект.** Отвечает «Project not found». Открытая вкладка увидит это на следующем опросе.
- **Почта и ящики.** Почта остаётся подтверждённой, ящики остаются подключёнными.
- **Создание нового проекта.** Сразу запускает платное исследование. Дневной лимит исследований считает только существующие проекты (см. 1.6).

Ответ клиенту, по-английски, без слова «manager»:

> Your previous project has been removed. Open the cabinet and create a project for your new website — the research starts as soon as you create it.

## 7. Если что-то пошло не так

Пока не выполнен `commit;`, любую неожиданность (DELETE вернул не `DELETE 1`, в `returning` не тот проект, ошибка) снимает `rollback;` — шаг 5.2.

Если неожиданность обнаружилась уже после `commit;` (удалён не тот проект, ошибка на `commit`):
1. Остановись.
2. Ничего не чини сам.
3. Сообщи владельцу точно, что выполнено и что вернула БД (`AGENTS.md`, последний пункт раздела «Release and production boundary»).
