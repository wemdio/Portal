# Vertical Engine v2 — Handoff для продолжения работы

> Для следующего агента (Codex и т.п.), который продолжит ветку `Sergey`.
> Перед началом обязательно прочитать: `AGENTS.md`, `docs/vertical-engine-changelog.md`,
> `docs/design/2026-08-20-vertical-engine-v2-isolation.md`,
> `docs/design/2026-08-26-vertical-engine-v2-cutover.md`,
> `docs/design/2026-08-28-vertical-engine-v2-seasonal-launch-portfolio.md`,
> `docs/design/2026-09-02-vertical-engine-v2-contact-delivery-pacing.md`,
> `docs/design/2026-09-03-vertical-engine-v2-continuous-supply.md`,
> `docs/integrations/instantly-api.md`.

## 1. Где мы и что это

- **Ветка**: `Sergey` (owner — Sergey). Работать только в task-worktree этой ветки; грязный
  корневой checkout другой ветки не использовать и не менять.
- **Vertical Engine v2** — изолированный новый движок рядом с v1/ENG:
  `verticalEngineV2` (код), `ve_*` (таблицы/очередь), `VE_MODEL_*` (конфиг),
  `worker-vertical-engine-v2` (воркер).
- **Граница (критично)**: `hypothesisEngine` / `he_*` / `HE_MODEL_*` — это прод-бэкенд
  `/client/eng`. Их **не трогать**. v1 (`/tools/hypothesis-engine`) — легаси-клиент того
  же бэкенда.
- Дата контекста: **2026-09-03**. Звонок с технической командой по средам уже был.

## 2. Что уже сделано

**Новое: превью и непрерывное пополнение — реализовано в коде.** Новый сбор готовит
до 1 000 проверенных, релевантных контактов на каждую выбранную гипотезу, с добором
после потерь и отдельным отображением защитного лимита/исчерпания/ошибки. Специалист
согласует превью и условия; после ручного допуска к запуску воркер пополняет резерв
тех же кампаний небольшими проверенными партиями. Дневной runner сохраняет расчёт
под обязательство, дедупликацию и защиту неоднозначных provider-попыток.
В UI доступны выбор базы гипотезы, согласование, пауза **добора**, точный запас и
расчёт рабочих дней при текущем темпе. Неизвестный остаток рынка не выдаётся за ноль.
Подробности, ограничения прогноза, recovery и выпуск:
[continuous supply](design/2026-09-03-vertical-engine-v2-continuous-supply.md), пункт 22
changelog. Миграция `20260903_0001_vertical_engine_v2_contact_supply.sql` и её
зависимости должны выпускаться штатно; в этой задаче production не изменялся.

**Новое: исправлен ложный ноль прогресса из кейса Ксюши.** Шаг 4 выбирает текущую
сборку из всех баз проекта, отдельно показывает очередь (включая другие вертикали),
не подменяет неизвестный промежуточный результат финальным `row_count=0` и не делит
число кандидатов на лимит ради процента. Источники, кандидаты после дедупа и готовые
получатели имеют разные подписи. Процент доступен только для текущего этапа конструктора.
Backend сохраняет `collect_info.waiting_for_base_id`, промежуточный `stats.rows_total`
без `finished_at` и наблюдаемый `construct.progress`; управляющий `construct.status`
не становится `done` до финальной записи результата. Это важно для повторов после сбоя.
В списке UI только 30 последних jobs, поэтому отсутствие job не доказывает остановку.
Нужен выпуск приложения **и** VE2-воркера; новой миграции для фикса нет. Production
не менялся. Подробности: пункт 21 в changelog.

**Новое: дозированная загрузка под обязательство.** Шаг 5 закрепляет точный Portal-проект,
активный период и числовую цель; кампании готовятся с письмами, база сохраняется в Portal.
Дневной sweep в VE-воркере работает только с допущенными к запуску гипотезами, исключает
выходные, учитывает уже загруженный остаток и не считает upload фактом выполнения.
Старый refill не должен обходить этот план. Новая миграция
`20260902_0001_vertical_engine_v2_contact_delivery.sql` **не применялась**, deploy не выполнялся.
Полный контракт, формулы и recovery: [contact delivery pacing](design/2026-09-02-vertical-engine-v2-contact-delivery-pacing.md).

Пункты 1–5 были закоммичены и запушены в `Sergey` ранее. Реализации #8 и сезонного
launch portfolio существуют только в коде ветки `Sergey`: их миграции не применялись,
приложение и воркер не развёртывались.

1. **Cutover v1→v2** (`8f7eaf857`, `e6cb0f084`, `9de1d2b9d`):
   - v2 видим в реестре инструментов (`toolsRegistry.ts`) — карточка на `/tools`.
   - v1: баннер «перейдите в v2» + блок новых прогонов (UI + `POST
     /api/tools/hypothesis-engine/projects` → `409 MIGRATED_TO_V2`). ENG-роут
     `/api/client/eng/projects` НЕ тронут.
   - v2: предупреждение о дублях по домену при создании проекта
     (`legacyDuplicateCheck.ts`) — сверка с внутренними `he_projects`.
2. **Retry LLM на 5xx/429** (`79869a6c5`) — `rawCall` в `verticalEngineV2/llm.ts`
   ретраит 408/425/429/5xx и сеть с бэкоффом 2/4/8с; постоянные 4xx — сразу.
3. **Автоповтор упавшей стадии** (`64f9da191`) — `jobRetry.ts` + `failJob` в
   `worker/verticalEngineV2.ts`: транзиентные ошибки до 5 попыток с бэкоффом
   30/60/120/120с; постоянные — 3 быстрых. «Повторить» (полный перезапуск с
   `site_profile`) больше не нужен для транзиентных 502.
4. **Структурный редизайн интерфейса v2** (`9e9e57ae1`) — компоненты engine.
5. **Тесты обновлены/добавлены**: isolation, v1 projects, `llmRetry`, `jobRetry`.
6. **#8 Предзапускный аудит сегментации — закрыт в коде**:
   - новый persisted snapshot `ve_segmentation_audits` и отдельная асинхронная стадия
     `ve_jobs.stage='segmentation_audit'`; POST ставит проверку в очередь, GET используется
     для polling и возвращает сводку без построчных assignments;
   - на шаге 5 до формы запуска обязателен inline review: все segment conditions, включая
     нулевые, отдельный default, до трёх примеров на группу, итоговая аудитория и исключения
     (низкая релевантность, плохой verification-статус, невалидный email, дубль email);
   - запуск требует `segmentation_audit_id` и явный `confirm_segmentation=true`.
     Отсутствующий, неподтверждённый, stale или incomplete audit закрывает gate с `409` до
     любых внешних мутаций;
   - launch повторно не классифицирует строки: использует сохранённые assignments, а
     SHA-256 по шаблону, базе, условиям, точной аудитории и назначениям защищает от stale;
   - missing/unknown/failed назначения не становятся default. Шаблон без segment variants
     получает `not_required`, 0 LLM batches и явные default-назначения для всей готовой
     аудитории; inline review/confirmation всё равно обязателен;
   - exact launch cap проверяется до LLM-задачи; enqueue audit+job и cancel audit+job имеют
     транзакционные DB-границы, включая ready-save/cancel race;
   - launch защищён exact reservation + heartbeat. Запись `launch_info` и terminal audit
     атомарны; stale-процесс не может перезаписать ручную сверку. Неоднозначный результат
     остаётся `uncertain`: UI требует проверить Instantly, сохраняет полный union известных и
     введённых campaign ID и не разрешает «кампании нет», если Portal уже знает кампанию;
   - в рамках #8 доведён до UI фикс #7: вычисляемый preview уже выбирал segment body,
     но видимая tokenized-версия повторно брала default. Теперь видимый body использует
     выбранный сегмент; это закреплено component-тестом.
7. **Verified RU seasonality + launch portfolio — закрыто в коде**:
   - старый пункт #5 был только prompt hint в `base_analyze`/template. Теперь evidence-stage
     сохраняет на гипотезе структурированную оценку `seasonal | neutral | unknown` с
     confidence, rationale и проверенными URL+цитатами; неподтверждённый вывод становится
     `unknown`, а не эвристикой по названию ниши;
   - положительные окна — `peak` с `lead_days`, отрицательные — `avoid`. По календарю
     `Europe/Moscow` вычисляются `launch_now`, `prepare_now`, `neutral`, `unknown`, `wait`
     и `avoid`; сезонность и потенциал остаются отдельными измерениями. RU queue GET и
     activation preflight каждый раз пересчитывают date-derived timing из immutable snapshot,
     проверяют stable hash и атомарно повышают plan version только при реальном изменении;
   - успешная подготовка создаёт PAUSED-кампании и атомарно фиксирует один immutable bundle
     со всеми child campaign ID, Instantly workspace и mailbox snapshot. N сегментных
     кампаний одного шаблона = один слот; подготовленных PAUSED bundle может быть сколько
     угодно;
   - `ve_launch_portfolio_settings`, `ve_launch_queue_items` и
     `ve_launch_queue_campaigns` хранят очередь/ёмкость. Для одного workspace и
     пересекающихся mailbox-наборов лимит RU по умолчанию — один активный bundle; разные
     workspace и непересекающиеся mailbox-наборы могут идти параллельно;
   - запуск остаётся ручным действием специалиста в Portal после QA. Reservation,
     idempotency key, plan version и CAS проверяются до внешних вызовов; Portal активирует
     все child campaigns, а частичный/неоднозначный результат оставляет bundle `uncertain`.
     Полный paginated preflight сверяет точный campaign set, ID, workspace и mailbox snapshot;
     UI показывает кампании/сегменты/объём/ссылки до QA-confirm;
   - `activating`, `active`, `uncertain` держат слот без preemption. Очередь: ручной порядок
     → сезонный дедлайн/запас → confidence → potential → возраст ожидания → stable ID.
     Ручной override требует reason/actor и не снимает занятый слот; explicit `wait`
     исключает bundle из authoritative head;
   - live reconciliation отслеживает статусы известных кампаний, в том числе активированных
     напрямую в Instantly и реактивированных после manual release. `active` требует exact
     допустимого статуса каждого child; partial bundle остаётся `uncertain`. Автоосвобождение —
      только когда все child campaigns свежо подтверждены как `Completed`; такой exact set,
      включая recovery, автоматически становится `released` без manual actor. Иной fresh exact
      non-sending set не доказывает completion, но после settling fence допускает audited manual
      release только `active | uncertain` bundle с mailbox snapshot, reason и actor. Cascade
      guard сохраняет любой ledger с tracked remote campaign независимо от cached status.
8. **Честная воронка сегмента и базы — закрыта в коде**:
   - старое досье показывало сырые строки широкого ОКВЭД-среза как «компании», хотя это
     не уникальные юрлица, не фильтры гипотезы и не готовые контакты. Новый v2-only RPC
     `ve_directory_segment_stats` возвращает raw rows, уникальные компании по ИНН и две
     разные contact-семантики: `companies_with_*` ищет известный канал на любой строке
     qualifying ИНН, а `matched_companies_with_*` — только на строках, прошедших точные
     фильтры среза. Строки без ИНН не склеиваются. Malformed/partial core-счётчики RPC не
     превращаются в ложный ноль: статистика становится недоступной с явной причиной;
   - `20260830_0001_vertical_engine_v2_directory_stats.sql` не меняет shared directory RPC
     и поддерживает опциональные region/revenue/employees/require-email фильтры. Миграция
     добавлена в код, но **не применялась и не деплоилась**;
   - досье различает raw/unique/contact-channel, предупреждает, что email не валидированы и
     это не прогноз базы. Legacy-досье помечается старым расчётом до ручной пересборки;
   - `base_collect` сохраняет estimate точного плана до cap; для contact-ступени estimate
     использует matched-row, а не known-any-INN счётчики. После обработки сохраняются
     collected/processed/low-relevance; `launchable_rows` записывается только после полной
     построчной validation;
   - порядок конструктора: optional `find_emails` → optional `enrich_descriptions` один раз
     на строку компании → `split_emails` → дедуп → validation → cap. Терминальный legacy-
     constructor job без `split_emails` не импортируется и один раз re-dispatch'ится по
     новому контракту;
   - relevance оценивается по title+description закреплённой гипотезы. Если контекст
     привязанной гипотезы недоступен, её строки fail-closed считаются непроверенными;
     vertical-only fallback разрешён только legacy-базе без `hypothesis_id`. После split
     одна компания (ИНН, fallback `company+website`) уходит в LLM один раз, затем
     verdict fan-out'ится на все её email-строки. Хвост лимита и сбойные/malformed батчи
     получают отдельный `_relevance_unchecked` и fail-closed исключаются из launch/refill;
   - Step 4 различает estimate/cap/collected/processed/проверенный итог. Последняя ступень
     называется «Прошли проверки», показывает checked/total company coverage и число строк
     без relevance-verdict; они в итог не входят. При >2 000 есть warning о лимите одного
     запуска, а failed-база не получает выдуманный processed count из `row_count`;
   - raw CSV теперь явно диагностический и остаётся на Step 4 как «Исходный CSV». Для
     `mode=launch-ready` Step 5 требует выбранный client preset и точную актуальную связку
     template + complete segmentation audit. Экспорт берёт сохранённую audited-аудиторию,
     добавляет `_ve_segment`, заново валидирует snapshot и исключает blocklist владельца
     выбранного preset; без любого из этих контекстов ответ fail-closed;
   - client blocklist читается одним транзакционным RPC: count и email берутся из одного
     MVCC-snapshot, а malformed/oversize/error останавливает экспорт и launch;
   - `base_collect` исключает другие базы проекта по email тоже, включая все адреса из
     multi-email ячейки. Занятый адрес вырезается отдельно, а свежие адреса строки остаются;
     Google Maps сохраняет весь список, дубли компании объединяют email. Upload-базы с
     `E-mail`/`Компания`/`ИНН` также формируют exclusion keys. После конструктора keys
     перечитываются заново, чтобы параллельная база не сохранила тот же контакт вторым
     запуском. Старый JS-slice чужого `data` до `MAX_ROWS_LIMIT` убран;
   - очередь collecting больше не ждёт старый orphan без живой job бесконечно: живую
     старшую сборку ждём, свежему base→job оставляем короткий grace, повторный enqueue
     восстанавливает потерянную job только из snapshot самой базы. Режим текущего normal/refill-
     вызова в repair не протекает; DB unique guard не допускает две активные job на один base,
     а ошибка job INSERT переводит новую базу в `failed`. При multi-hypothesis повторе
     существующая первая база не отменяет постановку остальных;
   - refill сохраняет в `ve_bases.data` только строки, для которых реально начался provider
     POST в Instantly. Отрезанные тарифом/cap/blocklist или pre-provider ошибкой строки можно
     собрать позднее. Дневной cap резервируется атомарно в основной БД по project+UTC-day до
     provider POST. Первый claim фиксирует server-side cap дня (config или DB-default), его
     изменение вступает в силу со следующего UTC-дня; параллельные workers не делят один и тот
     же остаток. Timeout расходует неоднозначно отправленный chunk консервативно, crash до
     финализации оставляет полную бронь до конца дня, повторная финализация не может увеличить
     расход, а удаление базы не стирает ledger. `ve_auto_pipeline_runs` — только best-effort
     аудит, не authority cap;
   - live VBI-пример до этого safety-fix был диагностическим снимком:
     **8 410 под фильтры → cap 2 000 → 1 514 после конструктора → 651 строка прошла тогдашние
     проверки**. Старые VBI/transport базы, собранные до fail-closed email gate, launch-ready
     export и межбазового email-дедупа, нужно пересобрать после деплоя.
9. **Безопасный выбор Instantly preset/workspace — закрыт в коде**:
   - шаг 5 не выбирает первый клиентский пресет автоматически. Непривязанный legacy-проект
     требует явного выбора; после него UI показывает workspace, общий тег пула и количество
     ящиков без адресов отправителей;
   - custom tags и account mappings читаются live и отдельно для каждого workspace. Exact tag
     означает полное совпадение account-set с preset-пулом, shared покрывает весь пул и может
     включать дополнительные ящики; частичные теги не угадываются и показываются как mixed;
   - `20260831_0001_vertical_engine_v2_launch_preset_binding.sql` хранит на `ve_projects`
     immutable preset/workspace binding, автора и время. Первый выбор закрепляется CAS-
     операцией; другая пара либо перенос live preset в другой workspace блокируются до
     launch reservation и внешних мутаций;
   - точные `email_account_ids` остаются server-side authority для Instantly campaign payload
     и launch snapshot. Tag — только display identity и не расширяет фактический sender pool;
   - общий Instantly adapter и read-routes tags/mappings поддерживают account-scoped reads.
     Миграция не применялась и приложение не деплоилось.
10. **Self-service onboarding клиента специалистом — закрыт в коде**:
   - только `technician | admin` видит inline-форму шага 5 и может передать email, пароль и
     пару Instantly workspace+tag. Backend берёт display name из текущего VE2-проекта,
     принудительно создаёт роль `client` и игнорирует любые присланные role/full_name;
   - список для формы безопасен: workspace, tag и опциональный count без sender addresses.
     Он строится по всем настроенным workspace; tags и mappings деградируют независимо, сбой
     одного workspace не скрывает здоровые, а неизвестный count не блокирует создание. Для
     записи preset backend не доверяет mapping-счётчику, а заново пагинирует live
     `/accounts?tag_ids=<id>` в выбранном workspace, валидирует, нормализует и дедуплицирует
     точный sender snapshot. У всех VE2 pagination loops есть page/repeated-cursor guards;
   - новый клиент без отдельного тарифа ограничен 16 ящиками. Preset получает канонические
     default schedule/limits/tracking. После успеха он появляется и выбирается в текущей
     форме, но immutable binding проекта устанавливается только фактическим launch;
   - cross-DB операция использует best-effort компенсацию: при profile/preset failure код
     пытается удалить только что созданные сущности, а отдельный сбой cleanup логируется и
     не маскируется обещанием обязательного удаления. Duplicate email возвращает `409` без
     preset и delete. Неоднозначный Auth-response сверяется по заранее заданному UUID попытки,
     а не поиском/удалением по email. Пароль и sender addresses не попадают в response/logs;
   - tag не является подпиской: будущие изменения его состава не обновляют сохранённый
     preset. Правка live campaign в Instantly действует на неё; следующий запуск опять берёт
     настройки из preset. Миграций и deploy для этого пункта нет.

## 3. Ключевые решения и их мотивы (этого нет в коде — важно не потерять)

- **Внутренний vs ENG** разграничивается по роли создателя:
  `he_projects.created_by → profiles.role`. `role='client'` = ENG (не дубль, не трогаем);
  остальные роли и `created_by IS NULL` (легаси) = внутренние. **НЕ** по `market`/`autopilot`
  (AGENTS.md запрещает). Хелперы: `isInternalRole()` / `isClient()` в `app/src/lib/roles.ts`.
- **Матчинг дублей** — по нормализованному домену: lowercase, снять `www.`, снять
  trailing dot (`normalizeDomain` в `legacyDuplicateCheck.ts`).
- **Cutover phased**: Phase A — деплой миграций `#6`/`#12` → VBI-smoke → v2 видим;
  Phase B — v1 banner+block, v2 dup-warning, v1 read-only. Сейчас кодовая часть Phase B
  выполнена; миграции ждут деплоя.
- **Иерархия ретраев**: HTTP-retry внутри `rawCall` (2/4/8с) → автоповтор стадии воркером
  (30–120с, до 5 попыток) → кнопка «Повторить» (полный перезапуск research).
- **Аудит — снимок, а не подсказка**: специалист подтверждает конкретный persisted audit,
  а launch обязан использовать его assignments без второго LLM-вызова. Изменение шаблона,
  базы, launch-аудитории или назначений меняет hash и требует нового review.
- **External launch — fenced saga**: каждый запуск привязан к точному reservation ID,
  обновляет heartbeat перед/после внешних вызовов и завершает `launch_info` + audit одной
  транзакцией. Истёкший heartbeat переводится не в retry, а в `uncertain`; снять блокировку
  можно только явной сверкой той же попытки. Отмена проекта переводит уже зарезервированный
  launch в `uncertain`; heartbeat/finalize требуют audit со статусом `ready`, поэтому поздний
  процесс не продолжит следующую кампанию и не зафиксирует отменённый запуск как успешный.
- **Рынок ≠ база ≠ launch-аудитория**: raw rows директории нужны только для диагностики,
  unique companies считаются по ИНН, наличие email/телефона означает лишь заполненный канал
  в справочнике. Для qualifying ИНН досье может учитывать канал из любой известной строки
  компании (`companies_with_*`), но estimate точного плана использует только channel-поля
  matched-строк (`matched_companies_with_*`). Оценка идёт до cap; processed и проверенный
  итог — фактические последующие ступени. Эти числа нельзя заменять одним headline и нельзя
  складывать для пересекающихся source slices.
- **Relevance принадлежит гипотезе**: для `base.hypothesis_id` gate обязан учитывать
  конкретные title+description. Широкая vertical-only проверка допустима только как legacy-
  fallback для базы без `hypothesis_id`; недоступный контекст привязанной гипотезы должен
  fail-closed оставить строки непроверенными. Иначе смежный подтип вертикали ошибочно проходит
  в базу выбранной гипотезы.
  После split релевантность всё равно классифицируется один раз на компанию, а verdict
  распространяется на все её строки: стоимость и решение не зависят от числа email. Лимит
  проверки и временный сбой LLM не являются положительным verdict: непроверенные company-группы
  маркируются отдельно и не допускаются ни в основной запуск, ни в refill.
- **Один email — одна строка до validation**: описание компании обогащается до split, затем
  multi-email ячейка разделяется раньше дедупликации и проверки. Иначе row-level «лучший»
  status может относиться не к тому адресу, который импортёр сохранит, а enrich повторит один
  и тот же HTTP-запрос для каждого адреса. Legacy-job без split нельзя импортировать — только
  re-dispatch по текущим шагам.
- **«Прошли проверки» ≠ «можно запустить всё одним кликом»**: count появляется только после
  полной построчной validation и того же email/relevance/dedup-контракта, что использует #8.
  Строки без relevance-verdict из-за лимита/сбоя считаются отдельным excluded-классом, а UI
  показывает покрытие компаний. Текущий cap одного запуска — 2 000; превышение показывается
  отдельно. Failed `row_count` не считается доказательством, что строки дошли до обработки.
- **Raw CSV не равен launch-ready**: исходная выгрузка нужна для диагностики и разбора
  источников. Launch-ready можно сформировать только на Step 5 с выбранным клиентским
  preset и complete/current segmentation audit; это именно сохранённая audited-аудитория
  после blocklist выбранного клиента, а не повторная безымянная фильтрация raw-базы. Строка
  без `_email_status='ok'` не может попасть ни в launch, ни в refill.
- **Дедуп между базами — контактный**: компания/ИНН остаются важными, но email сильнее для
  запуска. Уже сохранённый email удаляется из multi-email строки новой базы даже при другом
  названии компании/ИНН; вся строка исчезает только когда заняты все её email либо совпало
  юрлицо. Параллельные collecting-базы одного проекта идут по очереди только при живой job,
  а после конструктора исключения перечитываются свежо.
- **Сезонность — verified input, не «знание LLM»**: `neutral` допустим только с проверенным
  источником и цитатой; у `seasonal` каждое отдельное `peak/avoid` имеет собственный
  URL+quote evidence. Mixed-ответ теряет неподтверждённые окна, а полное отсутствие поддержки
  нормализуется в `unknown`. Оценка делается на evidence-stage для каждой RU-гипотезы и
  сохраняется в `ve_hypotheses`.
- **`lead_days` смотрит назад от пика**: дата запуска outreach = начало `peak` минус
  `lead_days`; `prepare_now` — отдельный 14-дневный буфер перед этой датой. `avoid` имеет
  приоритет при пересечении окон. Все календарные решения считаются по Москве и поддерживают
  окна через Новый год. Название `launch_now` означает «можно предложить ручную активацию»,
  а не фоновый автозапуск.
- **Deadline учитывает длительность отправки**: сезонный дедлайн — первый день после конца
  inclusive peak; latest activation = этот дедлайн минус `ceil(estimated_run_days)`. Поэтому
  длинный bundle с меньшим запасом поднимается выше короткого, даже если его peak позже.
  Длительность считается по сумме лидов всех child campaigns общего mailbox pool.
- **Подготовка ≠ активная мощность**: кампании создаются PAUSED заранее без расходования
  слота. Слот появляется только у bundle в `activating | active | uncertain`; один bundle
  включает все сегментные кампании одного template launch.
- **Ёмкость mailbox-scoped**: конфликт есть только внутри одного Instantly workspace при
  пересечении mailbox-наборов. При RU capacity=1 Portal не активирует второй конфликтующий
  bundle, не останавливает и не вытесняет первый. Непересекающиеся пулы независимы.
- **Очередь объяснима**: manual order/pin → seasonal deadline/slack → confidence →
  potential → starvation age → stable ID. Нет единого «магического» score. Ручной override
  аудируется и не обходит capacity/no-preemption; explicit `wait` исключает bundle из
  authoritative head даже при исходном automatic eligibility.
- **Reconciliation fail-closed**: только свежий exact set, где каждый child `Completed`, даёт
  автоматический `released`; это не manual release и `released_by` не требуется. `active`
  выставляется только для exact child set, где каждый child имеет допустимый active/completed
  статус; partial active+paused/error остаётся `uncertain`. Completed recovery сразу становится
  `released`, повторно не активируется. Иной fresh exact non-sending set (например,
  Paused/unhealthy) не доказывает completion, но позволяет audited manual release только для
  `active | uncertain`: он запрещён в `activating`, для fresh `uncertain` действует 10-минутный
  settling fence, обязательны reason/actor. Missing, stale, unknown и sending proof слот сохраняют.
  Прямой клик в Instantly остаётся операционным bypass, пока доступ там не ограничен; для
  уже известных кампаний reconcile обнаруживает активность и блокирует следующий Portal-launch.
- **`released` в Portal ≠ remote-terminal/delete-proof**: manual release `active | uncertain`
  bundle после fresh non-sending proof может освободить capacity, но ledger остаётся доступен
  reconciliation и при внешней реактивации возвращается в `active | uncertain`. Source cascade
  разрешён только для childless `released | skipped | cancelled`; любой tracked child блокирует
  delete при любом status, включая cached `Completed`. Полноценный cleanup с двухфазным remote
  DELETE остаётся отдельной будущей операцией, её нельзя заменять сменой статуса.

## 4. Pending / TODO

- **#9, человеческие названия вертикалей, остаётся отдельной live VBI-проверкой**.
  Prompt-level запрет жаргона B2B/B2C/ОКВЭД уже есть, но end-to-end пункт не закрыт без
  реального прогона: проверить конкретные названия в vertical → chain → template и при
  необходимости усилить нормализацию. Это не следующий этап реализации launch portfolio.
- **Деплой миграций** `#6` (base-per-hypothesis), `#12` (unique index fix) и
  `20260828_0001_vertical_engine_v2_segmentation_audits.sql` (#8),
  `20260828_0002_vertical_engine_v2_ru_seasonality.sql` и
  `20260828_0003_vertical_engine_v2_launch_portfolio.sql`, а также
  `20260830_0001_vertical_engine_v2_directory_stats.sql`,
  `20260831_0001_vertical_engine_v2_launch_preset_binding.sql`,
  `20260901_0004_vertical_engine_v2_base_collect_job_guard.sql`,
  `20260901_0005_vertical_engine_v2_refill_budget.sql` (основная БД) и
  `20260901_0001_client_blocklist_snapshot.sql` (Instantly DB) — отдельный будущий
  release-шаг. Миграции `20260830_0001`, `20260831_0001` и все `20260901_*` здесь точно не
  применялись; deployment не выполнялся. Перед `20260901_0004` нужен read-only preflight на
  дубли active `base_collect` по `payload.base_id`: миграция намеренно остановится и потребует
  ручного разбора, если такие job уже существуют.
- **Live VBI-тест в v2 после деплоя**: 2 гипотезы → 2 базы; verified сезонность с
  peak/avoid/unknown и московским состоянием; человеческие названия (#9); видимый tokenized
  segment preview (#7); async audit (#8) с complete, stale/incomplete и `not_required`;
  для одной базы сверить estimate до cap → collected → processed → «Прошли проверки»,
  split multi-email, complete-validation gate, межбазовый email-дедуп и company-level
  hypothesis-aware relevance;
  пересобрать досье и сверить raw/unique/known-any-INN/matched-row channels;
  technician создаёт тестового client по email/password и workspace+tag → сверить exact
  snapshot, отсутствие sender addresses в UI и отсутствие project binding до launch;
  PAUSED preparation → очередь → ручная активация первого bundle → reconcile → release →
  активация следующего.
- **Операционная граница Instantly**: решить отдельно, ограничиваем ли специалистам прямую
  активацию кампаний. Текущий код умеет обнаружить bypass для отслеживаемых campaign ID, но
  не может физически запретить внешний клик.
- **(Опционально)** «умный Повторить» — resume с упавшей стадии вместо полного перезапуска.
- Открытые вопросы: точные границы v1 read-only (сейчас — только блок новых прогонов).

## 5. Ловушки и проверенные факты

- **Requesty 502** = транзиентный отказ провайдера. Модель research = `anthropic/claude-opus-5`
  (env `VE_MODEL_RESEARCH`). Ошибка уже ретраится двумя уровнями (см. §2).
- **`ve_bases_one_collecting_per_vertical`** — legacy unique index без условия на
  `hypothesis_id`; чинится миграцией `20260826_0001_...` (drop + пересоздание). Применится
  при деплое.
- **Live VBI-воронка диагностики 2026-08-30**: 8 410 кандидатов под точные фильтры
  гипотезы → выбранный cap 2 000 → 1 514 строк после конструктора → 651 уникальный email,
  прошедший полную validation и pre-launch фильтры. Старые `~31 528` были широкими raw rows
  досье и не являлись прогнозом контактов этой гипотезы.
- **Тесты честной воронки**: `verticalEngineV2DirectoryStats.test.ts`,
  `dossierData.test.ts`, `VerticalEngineV2Dossier.test.tsx`,
  `baseCollectConstruct.test.ts`, `baseCollectHypothesisRelevance.test.ts`,
  `relevanceGate.test.ts`, `VerticalEngineV2Step4Base.test.tsx`,
  `segmentationAudit.test.ts`, `segmentationAuditStage.test.ts` и
  `baseCollectRefillRelevance.test.ts` фиксируют v2-only RPC,
  дедуп по ИНН, known-any-INN vs matched-row contact counters, malformed-RPC fail-safe,
  legacy UI, estimate/stats, re-dispatch старого constructor job, enrich-before-split,
  company-level relevance fan-out, fail-closed unchecked coverage, обычный launch/refill,
  complete-validation gate и truthful Step 4. Фактический локальный прогон этих десяти
  файлов: **10 suites / 46 tests passed**; отдельный прогон
  `noTransactionMigrations.test.ts` + `grants.test.ts`: **2 suites / 5 tests passed**;
  полный VE2 regression: **45 suites / 349 tests passed**.
- **Тесты #8**: `segmentClassify.test.ts`, `segmentationAudit.test.ts`,
  `launchReservation.test.ts`, `segmentationAuditStage.test.ts`,
  `jobFailureTransition.test.ts`, `templateSegmentationAudit.test.ts`, `projectCancel.test.ts`,
  `templateLaunchSegmentationAudit.test.ts`, `renderPreview.test.ts` и
  `VerticalEngineV2Step5Template.test.tsx`. Они фиксируют reconciliation/counts/examples,
  hash и assignments, async persistence/cancel, `not_required`, fail-closed gate,
  reservation/heartbeat/recovery, отсутствие второго LLM-вызова и фактически видимый segment
  body. На 2026-08-28 целевой набор вместе с migration/isolation: **12 suites / 70 tests passed**.
- **Тесты seasonality/portfolio**: `ruSeasonality.test.ts`,
  `evidenceSeasonality.test.ts`, `launchPortfolio.test.ts`, `launchPortfolioTiming.test.ts`,
  `verticalEngineV2RuSeasonality.test.ts`, `verticalEngineV2LaunchPortfolio.test.ts`,
  `launchPortfolioQueue.test.ts`, `launchPortfolioActivation.test.ts`,
  `templateLaunchPortfolioRead.test.ts`, `templateLaunchSegmentationAudit.test.ts`,
  `VerticalEngineV2Seasonality.test.tsx`, `VerticalEngineV2LaunchPortfolio.test.tsx` и
  `VerticalEngineV2Step5Template.test.tsx`. Итоговый прогон: весь Vertical Engine v2 —
  **37 suites / 316 tests passed**; целевой seasonality/portfolio-набор —
  **13 suites / 162 tests passed**; strict TypeScript — green.
- **Актуальный полный VE2 regression после preset/workspace binding**: все
  `tests/lib/vertical-engine-v2`, `tests/api/vertical-engine-v2`, компоненты
  `VerticalEngineV2*`, v2 migrations/isolation, workspace-scoped custom-tag reads и общие
  migration guards — **57 suites / 404 tests passed**; strict TypeScript и targeted ESLint —
  green; production Next build завершён успешно.
- **Self-service client onboarding (2026-09-01)**: targeted API/UI/auth/admin contract —
  **5 suites / 16 tests passed**; exact полный CI-командный прогон —
  **188 suites / 2025 tests passed**. Он включает `verticalEngineV2Isolation`; strict
  TypeScript, targeted ESLint, `git diff --check` и production Next build — green. В build
  остаются только прежние repository-wide warnings Next/Turbopack, не связанные с VE2.
- **Старые тесты**: isolation ожидает v2 В реестре (а не скрытым); v1 `POST projects`
  ожидает `409`. `mockSupabase` поддерживает `.ilike()`/`.select()`/`.single()`.
- **`worker/verticalEngineV2.ts`** — в eslint-ignore (worker линтится только esbuild-сборкой).
- **Не путать наличие кода с релизом**: #8, seasonality/portfolio и их миграции находятся
  только в ветке `Sergey`. Состояние commit/push проверять через Git при фактической передаче;
  migration/deploy — отдельная явно подтверждаемая фаза.

## 6. Границы (обязательно соблюдать)

- Push в `Sergey` — **стоп-точка**. Не мержить в `test`/`main`, не деплоить, не трогать прод.
- ENG (`/client/eng`, `requireClientAuth`, `he_*`) — не менять.
- Правки только в `verticalEngineV2`/`ve_*`/`VE_MODEL_*`/`worker-vertical-engine-v2`.

## 7. Как верифицировать

```bash
cd app
npm run typecheck:strict   # next typegen + route-validator + tsc
npm run lint               # eslint (0 errors ожидаемо)
npm test -- --watchAll=false
```

Минимальный regression-набор #7/#8 перед push:

```bash
npm test -- --runInBand --watchAll=false \
  --testMatch '**/tests/{lib/vertical-engine-v2/{segmentClassify,segmentationAudit,segmentationAuditStage,renderPreview,launchReservation},api/vertical-engine-v2/{templateSegmentationAudit,templateLaunchSegmentationAudit,projectCancel},components/VerticalEngineV2Step5Template,migrations/verticalEngineV2SegmentationAudits,architecture/verticalEngineV2Isolation}.test.ts?(x)'
```

Дополнительно для seasonality/launch portfolio:

```bash
npm test -- --runInBand --watchAll=false \
  --testMatch '**/tests/{lib/vertical-engine-v2/{ruSeasonality,evidenceSeasonality,launchPortfolio,launchPortfolioTiming},api/vertical-engine-v2/{launchPortfolioQueue,launchPortfolioActivation,templateLaunchPortfolioRead,templateLaunchSegmentationAudit},components/{VerticalEngineV2Seasonality,VerticalEngineV2LaunchPortfolio,VerticalEngineV2Step5Template},migrations/{verticalEngineV2RuSeasonality,verticalEngineV2LaunchPortfolio}}.test.ts?(x)'
```

Дополнительно для честной воронки досье/базы:

```bash
npm test -- --runInBand --watchAll=false \
  tests/migrations/verticalEngineV2DirectoryStats.test.ts \
  tests/lib/vertical-engine-v2/dossierData.test.ts \
  tests/components/VerticalEngineV2Dossier.test.tsx \
  tests/lib/vertical-engine-v2/baseCollectConstruct.test.ts \
  tests/lib/vertical-engine-v2/baseCollectHypothesisRelevance.test.ts \
  tests/lib/vertical-engine-v2/relevanceGate.test.ts \
  tests/components/VerticalEngineV2Step4Base.test.tsx \
  tests/lib/vertical-engine-v2/segmentationAudit.test.ts \
  tests/lib/vertical-engine-v2/segmentationAuditStage.test.ts \
  tests/lib/vertical-engine-v2/baseCollectRefillRelevance.test.ts
```

Фактический локальный результат этого точного набора на 2026-08-30:
**10 suites / 46 tests passed**.

Guards новой миграции:

```bash
npm test -- --runInBand --watchAll=false \
  tests/migrations/noTransactionMigrations.test.ts \
  tests/migrations/grants.test.ts
```

Фактический локальный результат: **2 suites / 5 tests passed**.
