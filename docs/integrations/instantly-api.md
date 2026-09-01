# Instantly API в Portal — канонический контракт интеграции

- **Последняя сверка:** 2026-08-31
- **API:** Instantly API v2 (`https://api.instantly.ai/api/v2`)
- **Область:** общий серверный адаптер Portal и его использование Vertical Engine v2

Этот документ фиксирует, как Portal работает с Instantly. Он является внутренним источником
истины для реализации. Upstream starter kit и OpenAPI используются для проверки контракта,
но не заменяют правила безопасности и orchestration Portal.

## 1. Официальные источники

Сверка выполнена с официальным репозиторием Instantly на commit
[`7649e6e4f820ad18cc563d5075f34b1a8daceb36`](https://github.com/Instantly-ai/instantly-starter-kit/tree/7649e6e4f820ad18cc563d5075f34b1a8daceb36):

- [README и статус SDK](https://github.com/Instantly-ai/instantly-starter-kit/blob/7649e6e4f820ad18cc563d5075f34b1a8daceb36/README.md);
- [общие API-конвенции](https://github.com/Instantly-ai/instantly-starter-kit/blob/7649e6e4f820ad18cc563d5075f34b1a8daceb36/docs/conventions.md);
- [кампании](https://github.com/Instantly-ai/instantly-starter-kit/blob/7649e6e4f820ad18cc563d5075f34b1a8daceb36/docs/api/campaigns.md);
- [лиды и bulk import](https://github.com/Instantly-ai/instantly-starter-kit/blob/7649e6e4f820ad18cc563d5075f34b1a8daceb36/docs/api/leads.md);
- [официальный List accounts и фильтр `tag_ids`](https://developer.instantly.ai/api-reference/account/list-account);
- [OpenAPI 3.1](https://github.com/Instantly-ai/instantly-starter-kit/blob/7649e6e4f820ad18cc563d5075f34b1a8daceb36/spec/openapi.yaml).

Starter kit опубликован под MIT License и содержит сгенерированные JavaScript/Python SDK,
примеры, service templates и OpenAPI. На дату сверки это **repo-based pre-publish**:
пакетов `@instantly-ai/sdk` и `instantly-sdk` ещё нет в npm/PyPI. Поэтому в Portal нельзя
добавлять вымышленную registry-зависимость или тянуть неприкреплённый `main` во время build.

## 2. Решение по SDK

Сейчас starter kit используется как дополнительная официальная документация и эталон
payload/response-контрактов. Существующий адаптер Portal не заменяем SDK целиком.

Причины:

- `app/src/lib/instantly/client.ts` уже покрывает нужные Portal endpoints;
- `accounts.ts` добавляет несколько Instantly workspace и server-only ключи;
- общий rate limiter умеет учитывать workspace-wide бюджет (сейчас он feature-flagged,
  выключен по умолчанию и работает fail-open);
- в адаптере зафиксированы проверенные особенности API, cursor pagination, timeouts,
  чанкинг лидов и нормализация bulk counters;
- Vertical Engine v2 поверх него реализует собственную fenced saga для неоднозначных
  внешних мутаций.

SDK можно рассматривать позже только за текущим интерфейсом `app/src/lib/instantly`, с
закреплённой upstream-версией, сохранением Portal-specific поведения и contract tests.
Прямые импорты SDK в UI, VE2 stages или route handlers запрещены: provider должен оставаться
заменяемой деталью адаптера.

## 3. Текущий адаптер Portal

| Зона | Источник истины |
|---|---|
| HTTP-вызовы и endpoints | `app/src/lib/instantly/client.ts` |
| API-типы | `app/src/lib/instantly/types.ts` |
| workspace и server-only credentials | `app/src/lib/instantly/accounts.ts` |
| общий rate limiter | `app/src/lib/instantly/rateLimiter.ts` |
| VE2 orchestration запуска | `app/src/lib/verticalEngineV2/launchTemplate.ts` |
| преобразование писем и базы | `app/src/lib/verticalEngineV2/launchHandoff.ts` |
| ручная активация bundle | `app/src/app/api/tools/vertical-engine-v2/launch-portfolio/[id]/activate/route.ts` |

Канонический ключ основного workspace — `INSTANTLY_API_KEY`. Старое имя
`INSTANTLY_PORTAL_API_KEY` поддерживается только как fallback. Дополнительные workspace
задаются через `INSTANTLY_ACCOUNTS_JSON`; ключи никогда не должны попадать в клиентский код,
логи, документацию или git.

## 4. Контракт запуска Vertical Engine v2

Запрошенная интеграция уже реализована в коде ветки `Sergey`:

1. Если у проекта ещё нет клиентского пресета, специалист с ролью `technician` или `admin`
   создаёт его прямо на шаге запуска: вводит только email клиента, пароль и выбирает пару
   Instantly workspace + tag. Имя клиента backend берёт из текущего VE2-проекта, а роль
   жёстко задаёт как `client` — браузер не может подменить ни имя, ни права.
2. Backend заново проверяет выбранный tag в указанном workspace и получает его актуальный
   состав через `GET /accounts?tag_ids=<tagId>` со всей cursor-pagination. Адреса
   нормализуются, дедуплицируются и сохраняются только как точный snapshot
   `client_campaign_presets.email_account_ids`; в UI и ответе API их нет. Для нового клиента
   без отдельного тарифа действует стандартный лимит 16 ящиков.
3. Специалист завершает сбор базы и обязательный предзапускный аудит сегментации.
4. Backend повторно проверяет exact audience, persisted assignments и freshness hash до
   первого внешнего вызова.
5. Специалист явно выбирает `client_campaign_presets`; созданный inline-пресет выбирается в
   форме автоматически, но сам факт создания клиента ещё не привязывает проект. Первый
   подтверждённый запуск атомарно
   закрепляет за VE2-проектом preset ID и текущий Instantly workspace. Следующие запуски
   принимают только эту пару. Сам пресет определяет точные mailbox IDs, расписание, лимиты и
   tracking-настройки.
6. Для default-группы и каждого непустого сегмента создаётся отдельная кампания.
7. `ve_templates.letters` превращаются в `sequences[0].steps`: тема, body, A/B-варианты и
   интервалы. Если create-response не вернул сохранённую sequence, Portal досылает её PATCH.
8. Проверенные строки `ve_bases` превращаются в `email + custom_variables` и загружаются
   напрямую в соответствующую кампанию через bulk import, последовательно по 1000 записей.
9. Все remote campaign IDs и количество принятых лидов сохраняются в `launch_info` и
   `ve_launch_queue_*` как один bundle.
10. Подготовка **не активирует** кампании. После QA специалист отдельно активирует весь bundle
   из launch portfolio; capacity reservation происходит до внешнего вызова.

### Draft и Paused — разные статусы

Официальный `createCampaign` создаёт `Draft` (`status = 0`), который ничего не отправляет.
`Paused` (`status = 2`) — отдельный статус уже приостановленной кампании. В старых внутренних
текстах слово `PAUSED` иногда использовалось как общее название «подготовлена и не отправляет».
Для API-проверок всегда надо использовать фактический status, а не это бытовое обозначение.

### Что именно переносится

- основное письмо и A/B-варианты;
- follow-up-письма и интервалы;
- отдельные тексты для сегментов через отдельные child campaigns;
- email каждой launchable-строки;
- остальные колонки и operator mapping как `custom_variables`;
- mailbox scope, schedule, daily limits и tracking из выбранного пресета.

Сейчас VE2 не раскладывает произвольные колонки базы по стандартным полям Instantly
`first_name`, `last_name`, `company_name`: кроме email они уходят как custom variables. Это не
мешает подстановкам в письмах, но остаётся известным улучшением импорта.

## 5. Правила безопасности

1. **Create не равен launch.** Активация всегда отдельная и явная, после preflight/QA.
2. **У Instantly нет общего idempotency-key для write endpoints.** Timeout или оборванный
   ответ после POST не доказывает, что мутация не произошла. Слепой повтор запрещён.
3. **Неоднозначный результат остаётся `uncertain`.** Reservation и известные campaign IDs
   сохраняются; повтор возможен только после live reconciliation.
4. **Bulk import — максимум 1000 лидов на запрос.** Большая база режется последовательно;
   частичный импорт не должен выглядеть полным успехом.
5. **Пагинация cursor-based.** Полные сверки читают все страницы и fail closed при повторе
   cursor, неполном exact set или изменении count во время чтения.
6. **Rate limit workspace-wide.** Portal имеет общий limiter и ограниченный retry только для
   явного `429`; timeout внешнего write не ретраится. Перед live-запуском limiter надо явно
   включить и проверить: его текущий default — off, а отказ хранилища пропускает запрос.
7. **Verification расходует Instantly Credits.** Автоматический verify-on-import не включать
   без отдельного продуктового решения; VE2 использует собственный сохранённый validation
   status базы.
8. **Webhook не считается подписанным по умолчанию.** Если он используется для критического
   состояния, receiver должен проверять настроенный нами секретный custom header и затем
   сверять живое состояние API.
9. **Preset и workspace закреплены за VE2-проектом.** Первый выбор записывается compare-and-set
   операцией. Другой preset или перенос того же preset в другой workspace блокирует запуск до
   reservation и любых Instantly write. Миграция намеренно не угадывает привязку старых
   проектов и не ставит `main` по умолчанию.
10. **Создание клиента — компенсируемая saga.** Portal Auth/profile и operational Instantly DB
    не имеют общей транзакции. Если profile или preset не сохранился после создания auth-user,
    backend удаляет только что созданного пользователя. Дубликат email возвращает `409`, не
    создаёт preset и никогда не удаляет существующего пользователя. Для неоднозначного ответа
    Auth backend заранее задаёт UUID создаваемого пользователя и сверяет именно его: потерянный
    success-response можно безопасно продолжить, не разыскивая и не удаляя пользователя по
    одному только email. Пароль не возвращается и не попадает в application logs/traces.

### Как показывается пул отправителей

- Точные `email_account_ids` остаются server-side источником истины для campaign payload и
  immutable launch snapshot; тег не подменяет фактический список отправителей.
- UI получает только имя клиента, workspace, число уникальных ящиков и display-safe теги —
  адреса отправителей в ответ селектора не возвращаются и в DOM не показываются.
- Custom tags и mappings читаются live отдельно для каждого workspace. Один bulk-read на
  workspace исключает N+1 и смешение тегов разных аккаунтов.
- Для создания нового пресета mapping используется только для безопасной подсказки-счётчика
  в селекторе. Если mapping пуст, устарел или временно недоступен, UI показывает, что состав
  будет проверен при создании, и не блокирует действие. Перед записью backend обязательно
  делает отдельный authoritative read `/accounts?tag_ids=...`; поэтому stale mapping не может
  назначить чужие или уже удалённые ящики.
- Cursor-pagination tags, mappings и filtered accounts в VE2 имеет защиту от повторяющегося
  cursor, лимит числа страниц и runtime-проверку ответа. Сбой display-read одного workspace
  деградирует только его; malformed authoritative response блокирует запись fail-closed.
- Сначала ищется тег, чей account-set точно совпадает со всем preset-пулом. Если такого нет,
  допустим общий более широкий тег, покрывающий весь пул. Несколько полных совпадений
  показываются все; частичные разные теги не превращаются в выдуманный «главный» тег.
- При частичном совпадении UI пишет «Теги пула различаются», при отсутствии mapping — «Тег не
  назначен», при недоступности live-read — «Теги временно не загрузились». Эти состояния не
  меняют exact sender list; пустой sender pool по-прежнему блокирует запуск.

## 6. Что нужно для рабочего окружения

Код интеграции сам по себе не означает, что контур уже настроен или развёрнут. Нужны:

- API key каждого Instantly workspace с минимально необходимыми scopes;
- корректная server-only конфигурация workspace;
- подключение Instantly operational DB для `client_campaign_presets`;
- пресеты с точными `instantly_account_id`, mailbox IDs, schedule и лимитами;
- применённые VE2 migrations аудита/seasonality/launch portfolio;
- развёрнутые версии app и `worker-vertical-engine-v2`;
- live smoke-test в тестовом workspace без активации отправки.

UX показывает клиентский пресет, человекочитаемый workspace, теги пула и количество ящиков,
но не сами адреса. Непривязанный legacy-проект требует явного выбора и не выбирает первый
пресет автоматически. После первого подтверждения selector закреплён за проектом; backend
повторяет ту же проверку независимо от состояния браузера. Для этого должна быть применена
миграция `20260831_0001_vertical_engine_v2_launch_preset_binding.sql`; наличие кода в ветке не
означает, что она уже применена.

Tag при onboarding — одноразовый источник snapshot, а не подписка. Если позже добавить или
убрать ящики в Instantly tag, существующий preset сам не изменится. Ручные правки уже созданной
кампании в Instantly действуют на эту кампанию; следующий VE2-запуск снова возьмёт defaults и
точный sender snapshot из preset. Чтобы изменить будущие запуски, нужно отдельно обновить сам
preset, а не только live campaign.

Другие известные live-readiness gaps:

- подготовка кампаний и всех lead chunks выполняется синхронно внутри HTTP request с
  `maxDuration = 60`; большой сегментированный bundle может не успеть завершиться;
- initial bulk import не имеет durable ledger по каждому 1000-row chunk: при частичном сбое
  весь запуск правильно становится `uncertain`, но автоматической точной сверки чанков нет;
- до create/activate нет отдельного preflight по warmup/vitals выбранных mailboxes;
- нужно явно решить, применяем ли Portal client blocklist и должны ли созданные кампании
  сразу попадать в client access и общий campaign catalog.

## 7. Чек-лист обновления upstream

При следующей сверке starter kit:

1. закрепить новый commit/tag и дату в этом документе;
2. проверить breaking changes в campaign create/update/activate и leads bulk import;
3. сравнить OpenAPI с `types.ts` и contract tests адаптера;
4. проверить limits, pagination, retry и async background jobs;
5. не менять provider или write-retry политику без теста неоднозначного результата;
6. только после contract suite обновить pinned reference или принять SDK dependency.
