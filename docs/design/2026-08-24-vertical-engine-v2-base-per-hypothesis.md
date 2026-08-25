# Vertical Engine v2: база на гипотезу (base-per-hypothesis)

**Статус**: дизайн (на согласование перед кодом)
**Дата**: 2026-08-24
**Скоуп**: только `verticalEngineV2` / `ve_*` (изоляция от `he_*` / ENG — см.
`2026-08-20-vertical-engine-v2-isolation.md`).

## 1. Проблема

Сейчас база собирается **одна на вертикаль**: `ve_bases.vertical_id NOT NULL` +
уникальный индекс `ve_bases_one_collecting_per_vertical`. Выбранные в UI гипотезы
(`hypothesis_ids`) лишь фильтруют план сборки (`base_collect` → `buildPlan`), а
результат складывается в **одну** `ve_bases.data`.

Следствие (фидбек Ани, прогон VBI): в одной выгрузке лежат разные отрасли
(образование + медицина), потому что широкая вертикаль «Платные B2C-сервисы»
раскидана по нескольким гипотезам, но файл один.

**Цель**: собирать **отдельную базу (файл) под каждую выбранную гипотезу**, чтобы
выгрузка для оценки была чистой по сегменту.

## 2. Текущая модель (что есть)

- `ve_bases`: `vertical_id NOT NULL REFERENCES ve_verticals ON DELETE CASCADE`,
  `data jsonb`, `collect_info jsonb`, частичный уникальный индекс
  `ve_bases_one_collecting_per_vertical (vertical_id) WHERE source='auto' AND status='collecting'`.
- `ve_hypotheses`: `vertical_id NULL` (FK `ON DELETE SET NULL`), нет связи с base.
- `ve_templates`: `base_id NOT NULL REFERENCES ve_bases`, `vertical_id NOT NULL`.
- Downstream по `vertical_id`: `template` (читает гипотезы по `vertical_id`),
  `chain`/`dossier`/`vocab` (по `vertical_id`), запуск рассылки (`launchTemplate`
  по `template.base_id`), UI `Step4Base` группирует базы по `vertical_id`.

## 3. Целевая модель

### 3.1 Схема

- `ve_bases` + `hypothesis_id uuid NULL` (FK `ON DELETE SET NULL`): база может
  принадлежать ровно одной гипотезе; `NULL` = **только** ручная загрузка
  (`source='upload'`) и легаси-базы до миграции. Автосборка `source='auto'`
  ВСЕГДА проставляет `hypothesis_id` — даже когда гипотеза одна (авто-вывод
  единственной неотклонённой гипотезы вертикали).
- Порядок создания: `ve_bases.vertical_id` остаётся `NOT NULL` (база всегда в
  контексте вертикали), `hypothesis_id` добавляется опционально.
- Уникальный индекс антигонки переехал с `(vertical_id)` на `(hypothesis_id)`
  там, где гипотеза задана: два параллельных запуска одной гипотезы ловятся.
  Для базы без гипотезы (легаси-сборка по вертикали, `hypothesis_id IS NULL`)
  остаётся старый unique на `vertical_id`.

```sql
-- пример целевых DDL (полностью — в отдельной миграции)
alter table public.ve_bases
  add column if not exists hypothesis_id uuid,
  add constraint ve_bases_hypothesis_id_fkey
    foreign key (hypothesis_id) references public.ve_hypotheses(id) on delete set null;

create index if not exists idx_ve_bases_hypothesis on public.ve_bases(hypothesis_id);

-- антигонка: одна collecting-база на гипотезу (когда гипотеза задана),
-- иначе — на вертикаль
create unique index if not exists ve_bases_one_collecting_per_hypothesis
  on public.ve_bases (hypothesis_id)
  where source = 'auto' and status = 'collecting' and hypothesis_id is not null;
-- (ve_bases_one_collecting_per_vertical остаётся для hypothesis_id IS NULL)
```

### 3.2 base_collect

- `enqueueVeBaseCollect` при `hypothesis_ids.length >= 1` создаёт **N баз** (по
  одной на гипотезу), каждая со своей джобой `base_collect` и `payload.hypothesis_id`,
  `collect_info.hypothesis_id`.
- `buildPlan` в стадии строит план **по одной гипотезе** (передаваемой в payload),
  а не по пересечению всех принятых вертикали.
- Дедуп/гонка переведены на `hypothesis_id` (см. 3.1).
- Ручная загрузка (`source='upload'`) — `hypothesis_id NULL`, как раньше.

### 3.3 template/chain/launch

- `template` привязывается к **конкретной базе** и её `hypothesis_id`; гипотезы
  для промпта берёт не по `vertical_id`, а по `base.hypothesis_id` (для
  `hypothesis_id NULL` — фолбэк на вертикаль, как сейчас, чтобы не сломать легаси).
- `chain`/`dossier`/`vocab` остаются на `vertical_id` (они про вертикаль, а не
  про базу) — не трогаем.
- `launchTemplate` остаётся на `template.base_id` (уже верно: один шаблон на базу).

### 3.4 UI (Step4Base)

- Список баз группируется по `hypothesis_id`/гипотезе внутри вертикали; каждая
  база — свой файл выгрузки и своя кнопка «собрать шаблон».

## 4. Обратная совместимость

- `hypothesis_id` **nullable** — существующие базы (в т.ч. смешанные VBI) не
  переделываем, они остаются `NULL` и работают по старому пути.
- `ve_templates.vertical_id` остаётся `NOT NULL` (не трогаем).
- Новый путь включается только когда `hypothesis_id` задан → старый путь для
  `NULL`-баз остаётся нетронутым.

## 5. Граница ENG / изоляция

- Правки строго в `verticalEngineV2` и `ve_*`. `he_*` и `hypothesisEngine` не
  трогаем (у `he_bases` остаётся своя логика «база на вертикаль»).
- Миграция не меняет `he_*`, не добавляет FK в их сторону.

## 6. Фазовый план

1. **Миграция схемы** (`ve_bases.hypothesis_id` + индексы) — отдельный
   `supabase/migrations/20xxxxxxxx_vertical_engine_v2_base_per_hypothesis.sql`.
2. **types** — `VeBase.hypothesis_id: string | null`.
3. **base_collect** — `buildPlan` по одной гипотезе; `enqueueVeBaseCollect`
   создаёт N баз.
4. **template** — чтение гипотез по `base.hypothesis_id` (фолбэк на vertical).
5. **UI Step4Base** — группировка баз по гипотезе.
6. **Верификация** — `tsc --noEmit`, eslint, ручной прогон на v2-проекте с 2
   гипотезами → 2 базы, регрессия легаси (`hypothesis_id NULL`).

## 7. Роллбэк

- Миграция только добавляет nullable-колонку и новый индекс → обратно совместима,
  безопасный `git revert` без потери данных. Удаление колонки при необходимости —
  отдельная миграция.

## 8. Решения (согласовано)

- Название колонки: `hypothesis_id` ✅
- `hypothesis_id = NULL` — только ручная загрузка + легаси; автосборка всегда
  проставляет гипотезу (даже единственную — авто-вывод). ✅
- Реализация строго фазами (схема → collect → template+UI), с коммитом и
  проверкой после каждой фазы. ✅