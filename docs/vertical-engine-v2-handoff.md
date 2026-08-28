# Vertical Engine v2 — Handoff для продолжения работы

> Для следующего агента (Codex и т.п.), который продолжит ветку `Sergey`.
> Перед началом обязательно прочитать: `AGENTS.md`, `docs/vertical-engine-changelog.md`,
> `docs/design/2026-08-20-vertical-engine-v2-isolation.md`,
> `docs/design/2026-08-26-vertical-engine-v2-cutover.md`.

## 1. Где мы и что это

- **Ветка**: `Sergey` (owner — Sergey). **Worktree**: `codex-worktrees/vertical-engine-v2`.
- **Vertical Engine v2** — изолированный новый движок рядом с v1/ENG:
  `verticalEngineV2` (код), `ve_*` (таблицы/очередь), `VE_MODEL_*` (конфиг),
  `worker-vertical-engine-v2` (воркер).
- **Граница (критично)**: `hypothesisEngine` / `he_*` / `HE_MODEL_*` — это прод-бэкенд
  `/client/eng`. Их **не трогать**. v1 (`/tools/hypothesis-engine`) — легаси-клиент того
  же бэкенда.
- Дата контекста: **2026-08-28**. Звонок с технической командой по средам уже был.

## 2. Что уже сделано

Пункты 1–5 были закоммичены и запушены в `Sergey` ранее. Реализация #8 существует
только в коде ветки `Sergey`: её миграция не применялась, приложение и воркер не
развёртывались.

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

## 4. Pending / TODO

- **Следующий незакрытый пункт — #9, человеческие названия вертикалей**. Prompt-level
  запрет жаргона B2B/B2C/ОКВЭД уже есть, но end-to-end пункт не закрыт без live VBI-прогона:
  проверить конкретные названия в vertical → chain → template и при необходимости усилить
  нормализацию.
- **Деплой миграций** `#6` (base-per-hypothesis), `#12` (unique index fix) и
  `20260828_0001_vertical_engine_v2_segmentation_audits.sql` (#8) — отдельный будущий
  release-шаг. В этом handoff их применение не подтверждается.
- **Live VBI-тест в v2** после деплоя: 2 гипотезы → 2 базы; сезонность; человеческие
  названия (#9); видимый tokenized segment preview (#7); async audit (#8) с complete,
  stale/incomplete и `not_required`; подтверждённый запуск из сохранённых assignments.
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
- **Старые тесты**: isolation ожидает v2 В реестре (а не скрытым); v1 `POST projects`
  ожидает `409`. `mockSupabase` поддерживает `.ilike()`/`.select()`/`.single()`.
- **`worker/verticalEngineV2.ts`** — в eslint-ignore (worker линтится только esbuild-сборкой).
- **Полный `jest` на этом Windows-host**: 693 suites / 8116 assertions прошли; два suite не
  загрузились (`sqliteReader`, `sessionUtils`), потому что общий `node_modules/sqlite3` не
  содержит native `node_sqlite3.node` для Node 22.23.2/Windows x64. Assertion-регрессий #8 нет.
- **Не путать наличие кода с релизом**: #8 и миграция находятся только в ветке `Sergey`.
  Состояние commit/push проверять через Git при фактической передаче; migration/deploy —
  отдельная явно подтверждаемая фаза.

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
