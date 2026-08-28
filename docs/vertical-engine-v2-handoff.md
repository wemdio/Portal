# Vertical Engine v2 — Handoff для продолжения работы

> Для следующего агента (Codex и т.п.), который продолжит ветку `Sergey`.
> Перед началом обязательно прочитать: `AGENTS.md`, `docs/vertical-engine-changelog.md`,
> `docs/design/2026-08-20-vertical-engine-v2-isolation.md`,
> `docs/design/2026-08-26-vertical-engine-v2-cutover.md`,
> `docs/design/2026-08-28-vertical-engine-v2-seasonal-launch-portfolio.md`.

## 1. Где мы и что это

- **Ветка**: `Sergey` (owner — Sergey). Работать только в task-worktree этой ветки; грязный
  корневой checkout другой ветки не использовать и не менять.
- **Vertical Engine v2** — изолированный новый движок рядом с v1/ENG:
  `verticalEngineV2` (код), `ve_*` (таблицы/очередь), `VE_MODEL_*` (конфиг),
  `worker-vertical-engine-v2` (воркер).
- **Граница (критично)**: `hypothesisEngine` / `he_*` / `HE_MODEL_*` — это прод-бэкенд
  `/client/eng`. Их **не трогать**. v1 (`/tools/hypothesis-engine`) — легаси-клиент того
  же бэкенда.
- Дата контекста: **2026-08-28**. Звонок с технической командой по средам уже был.

## 2. Что уже сделано

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
  `20260828_0003_vertical_engine_v2_launch_portfolio.sql` — отдельный будущий release-шаг.
  Миграции `0002`/`0003` здесь точно не применялись; deployment не выполнялся.
- **Live VBI-тест в v2 после деплоя**: 2 гипотезы → 2 базы; verified сезонность с
  peak/avoid/unknown и московским состоянием; человеческие названия (#9); видимый tokenized
  segment preview (#7); async audit (#8) с complete, stale/incomplete и `not_required`;
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
