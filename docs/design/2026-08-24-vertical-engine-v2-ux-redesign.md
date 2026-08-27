# Vertical Engine v2 — UX/UI редизайн (бриф задачи)

Дата: 2026-08-24. Владелец: Sergey.

## Цель

Переработать UX/UI **только** движка v2 с применением принципов Apple Design
(скилл `apple-design`). Редизайн не должен менять логику, поведение или схему
данных — только интерфейс и взаимодействие.

## Scope (строго)

- Работать **только** над Vertical Engine v2:
  - логика: `app/src/lib/verticalEngineV2`
  - UI: `app/src/components/vertical-engine-v2` (шаги движка Step1–Step5, карточки, модалки и пр.)
  - данные/очередь/воркер: таблицы `ve_*`, воркер `worker-vertical-engine-v2`, настройки `VE_MODEL_*`
- Дизайн менять **только внутри v2**, НЕ глобально по сайту, НЕ трогать другие страницы/компоненты.

## Изоляция (критично — не нарушать)

- v1 (`app/src/lib/hypothesisEngine`, таблицы `he_*`, настройки `HE_MODEL_*`) =
  production-бэкенд `/client/eng`. **НЕ трогать, НЕ редизайнить, НЕ прятать.**
- Полный регламент: `docs/design/2026-08-20-vertical-engine-v2-isolation.md`
  и `AGENTS.md` (раздел «Vertical Engine v2 / ENG boundary»).
- Новые запуски v2 никогда не пишут в `he_*`.

## Скилл

- Использовать `apple-design`. Установлен локально:
  `C:\Users\wemd1\Desktop\Portal\.claude\skills\apple-design\SKILL.md`

## Рабочая точка

- Worktree: `C:\Users\wemd1\Desktop\Portal\codex-worktrees\vertical-engine-v2`
- Ветка: `origin/Sergey`. Перед push обязательно `git fetch origin` + `git rebase origin/Sergey`
  (ветку двигают внешние коммиты).
- Стоп-точка: коммит + push в `Sergey`. Дальше merge/деплой делает пользователь (не делать самому).

## Текущее состояние v2 (что уже сделано)

Полный журнал: `docs/vertical-engine-changelog.md` (пункты #1–#9). Кратко:

- #5 сезонность (сентябрь/образование) — реализовано.
- #6 база на гипотезу (base-per-hypothesis) — реализовано.
- #7 сегментно-осознанное превью — реализовано.
- #8 предзапускный аудит сегментации — ещё НЕ реализован (план к звонку).
- #9 человеческие названия вертикалей (запрет жаргона B2B/B2C/ОКВЭД) — реализовано (prompt).

## Правила проверки после правок

- `node node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` (из каталога `app`)
- `node node_modules\eslint\bin\eslint.js <файлы>` (из каталога `app`)
- Если трогаешь подстановку сегментов в превью/запуске: матч `when→text` должен
  оставаться байт-в-байт одинаковым между `renderPreview.ts` и `buildLaunchSequence`
  (`(v.when ?? '').trim().toLowerCase() === segmentKey`).

## Что предстоит (дизайн)

1. Аудит текущих компонентов v2 (Step1–Step5 + карточки/модалки/состояния).
2. Применить принципы `apple-design`: response (мгновенный отклик), direct manipulation,
   interruptibility, материалы/глубина, типографика, reduced-motion.
3. НЕ менять логику/поведение/схему данных и не ломать изоляцию v1/v2.
