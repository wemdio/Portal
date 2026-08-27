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
- Дата контекста: **2026-08-26**. Звонок с технической командой по средам уже был.

## 2. Что уже сделано (закоммичено и запушено в `Sergey`)

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

## 4. Pending / TODO

- **#8 Предзапускный аудит сегментации** (фидбек Ани) — НЕ реализован. Нужно до создания
  кампаний: распределение всех строк по сегментам + примеры строк + сколько ушло в дефолт.
- **Деплой миграций** `#6` (base-per-hypothesis) и `#12` (unique index fix) — применятся
  при деплое, идемпотентны. На проде старый индекс `ve_bases_one_collecting_per_vertical`
  ещё живой, пока не деплой.
- **Live VBI-тест в v2** после деплоя: 2 гипотезы → 2 базы; сезонность; сегментное превью
  (байт-в-байт `when→text` между `renderPreview.ts` и `buildLaunchSequence`).
- **(Опционально)** «умный Повторить» — resume с упавшей стадии вместо полного перезапуска.
- Открытые вопросы: точные границы v1 read-only (сейчас — только блок новых прогонов).

## 5. Ловушки и проверенные факты

- **Requesty 502** = транзиентный отказ провайдера. Модель research = `anthropic/claude-opus-5`
  (env `VE_MODEL_RESEARCH`). Ошибка уже ретраится двумя уровнями (см. §2).
- **`ve_bases_one_collecting_per_vertical`** — legacy unique index без условия на
  `hypothesis_id`; чинится миграцией `20260826_0001_...` (drop + пересоздание). Применится
  при деплое.
- **Тесты**: isolation-тест теперь ожидает v2 В реестре (а не скрытым); v1 `POST projects`
  ожидает `409`. `mockSupabase` поддерживает `.ilike()`/`.select()`/`.single()`.
- **`worker/verticalEngineV2.ts`** — в eslint-ignore (worker линтится только esbuild-сборкой).
- **Полный `jest`** содержит flaky jsdom-таймаут-тесты (`Team*`, `TwoGisParserView`,
  `PaymentsPageView`, `telegram/tdataArchive`) — при параллельном прогоне таймаутят,
  изолированно проходят. Не считать их регрессией.
- **Остался незакоммиченным?** Нет — на момент handoff дерево чистое, HEAD = origin/Sergey.

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
