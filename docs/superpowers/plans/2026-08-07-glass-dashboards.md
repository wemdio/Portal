# Стеклянные дашборды — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать трём дашбордам (`/analytics/first-sales`, `/analytics/renewals`, `/analytics/projects`) монохромную подложку и стеклянные поверхности, работающие в светлой и тёмной теме.

**Architecture:** В `globals.css` добавляется отдельная секция: класс сцены `.glass-stage` (фон + набор CSS-переменных) и три материала `.glass-tile` / `.glass-panel` / `.glass-frame`, которые читают эти переменные. Материалы названы так, чтобы существующий слой принудительных переопределений тёмной темы (он ловит `.bg-white` и подобные утилиты Tailwind) их не видел. В компонентах утилиты фона/рамки заменяются на классы материалов. Отдельная правка в `charts/theme.ts` не даёт тултипам ECharts стать полупрозрачными.

**Tech Stack:** Next.js 15, Tailwind CSS 4 (`@import "tailwindcss"`), ECharts, Jest + jsdom.

**Спека:** [`docs/superpowers/specs/2026-08-07-glass-dashboards-design.md`](../specs/2026-08-07-glass-dashboards-design.md)

---

## Ориентировка для исполнителя

Несколько вещей, которые неочевидны и стоят потерянного часа:

1. **Тёмная тема — это слой `!important`.** В `app/src/app/globals.css`, начиная примерно со строки 2540, идут правила вида `html[data-portal-theme='dark'] .portal-shell .bg-white { background-color: var(--pd-surface) !important }`. Любая полупрозрачная карточка, собранная на утилите `bg-white/60`, в тёмной теме будет залита непрозрачным цветом. Поэтому **нельзя** делать стекло через Tailwind-утилиты прозрачности. Только через классы материалов из этого плана.

2. **Новая секция дописывается в конец `globals.css`.** Правила материалов и правила тёмной темы для них живут рядом, в одном блоке, а не внутри существующего слоя переопределений.

3. **`backdrop-filter` работает только если под элементом что-то есть.** Родитель со своим фоном — это `.glass-stage`. Материал без сцены-предка выглядит просто как полупрозрачный прямоугольник.

4. **Вложенное размытие запрещено.** `.glass-frame` не содержит `.glass-tile` и наоборот. Именно вложенность (blur внутри blur) роняет плавность прокрутки, а не сам эффект.

5. **Холст ECharts трогать не надо.** Ни один компонент не задаёт `backgroundColor` в опциях графика, а по умолчанию у ECharts он прозрачный — проверено грепом. Работа с графиками сводится к Задаче 1.

6. **Тесты.** `npm test` из каталога `app/`. jsdom отдаёт кастомные CSS-свойства через `getComputedStyle`, но **не наследует** их от предков — поэтому в тесте переменная ставится прямо на элемент.

---

## Структура файлов

| Файл | Ответственность |
| --- | --- |
| `app/src/app/globals.css` (дописать в конец) | Сцена, три материала, тонированные модификаторы, тёмная тема для них, ветка `prefers-reduced-transparency` |
| `app/src/components/charts/theme.ts` (правка) | Приоритет `--chart-surface` над замером фона по дереву |
| `app/tests/components/charts/chartSurface.test.ts` (создать) | Тест приоритета и фолбэка |
| `app/src/components/first-sales/*` (правка) | Сцена и материалы на дашборде первички |
| `app/src/components/renewals/*` (правка) | Сцена и материалы на дашборде продлений |
| `app/src/app/analytics/projects/page.tsx` (правка) | Сцена, тонированные плитки, блоки-таблицы |

---

## Задача 1: Тултипы графиков не должны просвечивать

Сейчас `resolveSurface()` поднимается по дереву до первого «непрозрачного» предка. Её проверка отсеивает только `transparent` и `rgba(0, 0, 0, 0…)`, поэтому полупрозрачный белый вроде `rgba(255, 255, 255, 0.55)` она примет за валидный фон. Значение уходит в фон тултипа (`tooltipSkin`, `theme.ts:204`), и на стеклянной карточке тултип станет просвечивать насквозь.

Правка: если на элементе (или унаследована от сцены) объявлена переменная `--chart-surface`, берём её; замер по дереву остаётся фолбэком для всех остальных страниц портала.

**Files:**
- Modify: `app/src/components/charts/theme.ts`
- Test: `app/tests/components/charts/chartSurface.test.ts`

- [ ] **Шаг 1: Написать падающий тест**

Создать `app/tests/components/charts/chartSurface.test.ts`:

```ts
import { resolveSurface } from '@/components/charts/theme';

describe('resolveSurface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('берёт --chart-surface, если она объявлена', () => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'rgba(255, 255, 255, 0.55)';
    el.style.setProperty('--chart-surface', '#f4f6fa');
    document.body.appendChild(el);

    expect(resolveSurface(el)).toBe('#f4f6fa');
  });

  it('без переменной поднимается до первого непрозрачного предка', () => {
    const parent = document.createElement('div');
    parent.style.backgroundColor = 'rgb(255, 255, 255)';
    const child = document.createElement('div');
    parent.appendChild(child);
    document.body.appendChild(parent);

    expect(resolveSurface(child)).toBe('rgb(255, 255, 255)');
  });

  it('на голом дереве отдаёт белый', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    expect(resolveSurface(el)).toBe('#ffffff');
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/components/charts/chartSurface.test.ts
```

Ожидание: FAIL — `resolveSurface` не экспортируется из `@/components/charts/theme`.

- [ ] **Шаг 3: Внести правку**

В `app/src/components/charts/theme.ts` заменить объявление `resolveSurface` (сейчас начинается на строке 77, сразу после комментария `/** Фон берём не из переменной… */`).

Было:

```ts
function resolveSurface(from: HTMLElement): string {
  let node: HTMLElement | null = from;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0')) return bg;
    node = node.parentElement;
  }
  return '#ffffff';
}
```

Стало (заодно заменить комментарий над функцией — он объясняет ровно то, что меняется):

```ts
/**
 * Фон карточки под графиком: сначала объявленная переменная, потом замер.
 *
 * Обычные карточки портала покрашены утилитами Tailwind (`bg-white`), а тёмная
 * тема переопределяет их отдельным правилом в `globals.css`. Переменной, из
 * которой можно прочитать «текущую поверхность», для них нет — поэтому фон
 * замеряется у ближайшего непрозрачного предка.
 *
 * Стеклянные дашборды ломают этот замер: у них фон карточки полупрозрачный, и
 * проверка ниже примет `rgba(255, 255, 255, 0.55)` за валидную поверхность —
 * тултип станет просвечивать насквозь. Такие поверхности объявляют
 * `--chart-surface` с плотным цветом, и он имеет приоритет над замером.
 */
export function resolveSurface(from: HTMLElement): string {
  const declared = getComputedStyle(from).getPropertyValue('--chart-surface').trim();
  if (declared) return declared;

  let node: HTMLElement | null = from;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0')) return bg;
    node = node.parentElement;
  }
  return '#ffffff';
}
```

- [ ] **Шаг 4: Запустить тест и убедиться, что он проходит**

```bash
cd app && npx jest tests/components/charts/chartSurface.test.ts
```

Ожидание: PASS, 3 теста.

- [ ] **Шаг 5: Коммит**

```bash
git add app/src/components/charts/theme.ts app/tests/components/charts/chartSurface.test.ts
git commit -m "fix(charts): --chart-surface имеет приоритет над замером фона"
```

---

## Задача 2: Сцена и материалы в globals.css

**Files:**
- Modify: `app/src/app/globals.css` (дописать в конец файла)

- [ ] **Шаг 1: Дописать секцию в конец `globals.css`**

```css
/* ═══════════════════════════════════════════════════════════════════════════
   СТЕКЛЯННЫЕ ДАШБОРДЫ
   Спека: docs/superpowers/specs/2026-08-07-glass-dashboards-design.md

   Материалы намеренно названы собственными классами, а не собраны из утилит
   Tailwind. Слой тёмной темы выше по файлу перекрашивает `.bg-white` и
   родственные утилиты через `!important`; карточка, собранная на них, в тёмной
   теме потеряла бы прозрачность. Свои имена этот слой не ловит, и совместимость
   держится по построению, а не отладкой.

   Секция стоит в конце файла: правила материалов должны выигрывать у утилит
   Tailwind при равной специфичности (один класс против одного класса — решает
   порядок в стилевом файле).
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─── Сцена ───
   Надевается на корневой блок экрана. Даёт фон, под которым размытие вообще
   имеет смысл, и объявляет переменные, которые читают материалы.

   Пятна заданы в процентах от размеров элемента, а не в пикселях: на странице
   с таблицей на несколько сотен строк пиксельные пятна остались бы вверху, и
   низ страницы стал бы плоско-серым — стекло там перестало бы читаться. */
.glass-stage {
  --glass-fill: rgba(255, 255, 255, 0.55);
  --glass-fill-soft: rgba(255, 255, 255, 0.4);
  --glass-edge: rgba(255, 255, 255, 0.85);
  --glass-shadow: 0 8px 24px -12px rgba(23, 31, 51, 0.28);
  --glass-rows: rgba(255, 255, 255, 0.92);
  /* Плотный аналог поверхности — для тултипов ECharts, см. resolveSurface(). */
  --chart-surface: #f4f6fa;

  padding: 1rem;
  border-radius: 1rem;
  background-color: #f0f2f6;
  background-image:
    radial-gradient(58% 26% at 16% 4%, #dbe1ea 0%, rgba(219, 225, 234, 0) 100%),
    radial-gradient(52% 22% at 86% 30%, #e5e8ee 0%, rgba(229, 232, 238, 0) 100%),
    radial-gradient(66% 28% at 42% 72%, #e0e5ee 0%, rgba(224, 229, 238, 0) 100%),
    radial-gradient(58% 24% at 78% 96%, #dfe4ec 0%, rgba(223, 228, 236, 0) 100%);
  background-repeat: no-repeat;
}

html[data-portal-theme='dark'] .glass-stage {
  /* В тёмной теме стекло — это светлый слой поверх тёмного, а не белый с
     прозрачностью: прямое переиспользование светлых значений даёт мутный
     серый блок. */
  --glass-fill: rgba(255, 255, 255, 0.07);
  --glass-fill-soft: rgba(255, 255, 255, 0.05);
  --glass-edge: rgba(255, 255, 255, 0.14);
  --glass-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.55);
  --glass-rows: rgba(22, 23, 27, 0.82);
  --chart-surface: #16171b;

  background-color: #131519;
  background-image:
    radial-gradient(58% 26% at 16% 4%, #262b36 0%, rgba(38, 43, 54, 0) 100%),
    radial-gradient(52% 22% at 86% 30%, #1e222b 0%, rgba(30, 34, 43, 0) 100%),
    radial-gradient(66% 28% at 42% 72%, #232833 0%, rgba(35, 40, 51, 0) 100%),
    radial-gradient(58% 24% at 78% 96%, #1d212a 0%, rgba(29, 33, 42, 0) 100%);
}

/* ─── Материалы ───
   Общая формула одна, различаются заливка и скругление. Скругление плитки
   совпадает с прежним `rounded-xl` (0.75rem), чтобы геометрия экранов не
   поехала при замене классов. */
.glass-tile,
.glass-panel,
.glass-frame {
  background-color: var(--glass-fill);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid var(--glass-edge);
  box-shadow: var(--glass-shadow);
}

.glass-tile {
  border-radius: 0.75rem;
}

/* Служебный слой: фильтры и заголовки. Прозрачнее и с меньшим скруглением,
   чтобы не конкурировать с плитками данных. */
.glass-panel {
  background-color: var(--glass-fill-soft);
  border-radius: 0.625rem;
}

/* Рамка таблицы. Скругление и клиппинг — на самом элементе; `overflow` здесь
   НЕ задаётся: на этих блоках уже висит `overflow-x-auto`, и перебивать его
   значило бы отрезать горизонтальную прокрутку широких таблиц. */
.glass-frame {
  border-radius: 0.75rem;
}

/* Строки данных лежат на плотной подложке: под стеклом плотная таблица
   начинает просвечивать соседними строками и перестаёт читаться. Размытия
   здесь нет намеренно — blur внутри blur роняет прокрутку. */
.glass-frame tbody {
  background-color: var(--glass-rows);
}

.glass-frame thead {
  background-color: var(--glass-fill-soft);
}

/* ─── Тонированные плитки ───
   Для дашборда проектов и «жёлтых» плиток продлений: цвет там несёт смысл
   (норма / внимание / просрочено), монохромное стекло его бы стёрло. */
.glass-tile.glass-tint-blue {
  background-color: rgba(59, 130, 246, 0.14);
  border-color: rgba(59, 130, 246, 0.32);
}
.glass-tile.glass-tint-emerald {
  background-color: rgba(16, 185, 129, 0.14);
  border-color: rgba(16, 185, 129, 0.32);
}
.glass-tile.glass-tint-amber {
  background-color: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.34);
}
.glass-tile.glass-tint-red {
  background-color: rgba(220, 38, 38, 0.14);
  border-color: rgba(220, 38, 38, 0.32);
}

html[data-portal-theme='dark'] .glass-tile.glass-tint-blue {
  background-color: rgba(96, 165, 250, 0.16);
  border-color: rgba(96, 165, 250, 0.3);
}
html[data-portal-theme='dark'] .glass-tile.glass-tint-emerald {
  background-color: rgba(52, 211, 153, 0.14);
  border-color: rgba(52, 211, 153, 0.28);
}
html[data-portal-theme='dark'] .glass-tile.glass-tint-amber {
  background-color: rgba(251, 191, 36, 0.16);
  border-color: rgba(251, 191, 36, 0.3);
}
html[data-portal-theme='dark'] .glass-tile.glass-tint-red {
  background-color: rgba(248, 113, 113, 0.16);
  border-color: rgba(248, 113, 113, 0.3);
}

/* ─── Системная настройка «уменьшить прозрачность» ───
   Windows и macOS умеют её выставлять. Отдаём непрозрачные варианты тех же
   материалов: экран остаётся полностью рабочим, теряется только эффект.
   Firefox медиа-запрос не поддерживает — там останется стеклянный вариант,
   это осознанно принято. */
@media (prefers-reduced-transparency: reduce) {
  .glass-stage {
    background-image: none;
    background-color: var(--app-bg);
    --chart-surface: #ffffff;
  }
  .glass-tile,
  .glass-panel,
  .glass-frame {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: #ffffff;
    border-color: #e2e4e9;
    box-shadow: none;
  }
  .glass-frame tbody,
  .glass-frame thead {
    background-color: #ffffff;
  }

  html[data-portal-theme='dark'] .glass-stage {
    background-image: none;
    background-color: var(--pd-bg);
    --chart-surface: #16171b;
  }
  html[data-portal-theme='dark'] .glass-tile,
  html[data-portal-theme='dark'] .glass-panel,
  html[data-portal-theme='dark'] .glass-frame,
  html[data-portal-theme='dark'] .glass-frame tbody,
  html[data-portal-theme='dark'] .glass-frame thead {
    background-color: var(--pd-surface);
    border-color: var(--pd-divider-strong);
  }
}
```

- [ ] **Шаг 2: Проверить, что стили собираются**

```bash
cd app && npx next build --no-lint
```

Ожидание: сборка проходит. Если падает на CSS — искать опечатку в добавленном блоке, ничего другого не менялось.

- [ ] **Шаг 3: Коммит**

```bash
git add app/src/app/globals.css
git commit -m "feat(ui): сцена и стеклянные материалы для дашбордов"
```

---

## Задача 3: Дашборд первички

**Files:**
- Modify: `app/src/components/first-sales/FirstSalesView.tsx:198`
- Modify: `app/src/components/first-sales/KpiRow.tsx:47-49`
- Modify: `app/src/components/first-sales/FiltersBar.tsx:96`
- Modify: `app/src/components/first-sales/SourceTable.tsx:149,272`
- Modify: `app/src/components/first-sales/FunnelChart.tsx:148`
- Modify: `app/src/components/first-sales/TimeSeriesChart.tsx:227`

- [ ] **Шаг 1: Надеть сцену на корневой блок**

`FirstSalesView.tsx`, строка 198. Было:

```tsx
    <div className="space-y-4">
```

Стало:

```tsx
    <div className="glass-stage space-y-4">
```

- [ ] **Шаг 2: Плитки KPI**

`KpiRow.tsx`, строки 47-49. Было:

```tsx
    <div
      className={`rounded-xl border px-4 py-3 ${
        amber ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white'
      }`}
    >
```

Стало (скругление и рамка приходят из материала, поэтому `rounded-xl` и `border-*` убираются):

```tsx
    <div className={`glass-tile px-4 py-3 ${amber ? 'glass-tint-amber' : ''}`}>
```

- [ ] **Шаг 3: Панель фильтров**

`FiltersBar.tsx`, строка 96. Было:

```tsx
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
```

Стало:

```tsx
    <div className="glass-panel space-y-2 px-3 py-2.5">
```

- [ ] **Шаг 4: Две таблицы источников**

`SourceTable.tsx`, строка 149. Было:

```tsx
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
```

Стало:

```tsx
        <div className="glass-frame overflow-x-auto">
```

`SourceTable.tsx`, строка 272. Было:

```tsx
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
```

Стало:

```tsx
    <div className="glass-frame overflow-x-auto">
```

- [ ] **Шаг 5: Две карточки графиков**

`FunnelChart.tsx`, строка 148. Было:

```tsx
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
```

Стало:

```tsx
    <div ref={rootRef} className="glass-tile p-3">
```

`TimeSeriesChart.tsx`, строка 227. Было:

```tsx
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
```

Стало:

```tsx
    <div ref={rootRef} className="glass-tile p-3">
```

- [ ] **Шаг 6: Проверить сборку и линтер**

```bash
cd app && npx tsc --noEmit && npx eslint src/components/first-sales
```

Ожидание: обе команды без ошибок.

- [ ] **Шаг 7: Коммит**

```bash
git add app/src/components/first-sales
git commit -m "feat(first-sales): стеклянное оформление дашборда первички"
```

---

## Задача 4: Дашборд продлений

**Files:**
- Modify: `app/src/components/renewals/RenewalsView.tsx:98`
- Modify: `app/src/components/renewals/KpiRow.tsx:22-24`
- Modify: `app/src/components/renewals/FiltersBar.tsx:123`
- Modify: `app/src/components/renewals/RenewalsTable.tsx:24`
- Modify: `app/src/components/renewals/RenewalsUndatedSection.tsx:30,48`
- Modify: `app/src/components/renewals/RenewalsChart.tsx:274`
- Modify: `app/src/components/renewals/RenewalsFunnel.tsx:148`

- [ ] **Шаг 1: Надеть сцену на корневой блок**

`RenewalsView.tsx`, строка 98. Было:

```tsx
    <div className="space-y-4">
```

Стало:

```tsx
    <div className="glass-stage space-y-4">
```

- [ ] **Шаг 2: Плитки KPI**

`KpiRow.tsx`, строки 22-24. Было:

```tsx
      className={`rounded-xl border px-4 py-3 ${
        amber ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white'
      }`}
```

Стало:

```tsx
      className={`glass-tile px-4 py-3 ${amber ? 'glass-tint-amber' : ''}`}
```

- [ ] **Шаг 3: Панель фильтров**

`FiltersBar.tsx`, строка 123. Было:

```tsx
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
```

Стало:

```tsx
    <div className="glass-panel space-y-2 px-3 py-2.5">
```

- [ ] **Шаг 4: Таблица продлений**

`RenewalsTable.tsx`, строка 24. Было:

```tsx
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
```

Стало:

```tsx
    <div className="glass-frame overflow-x-auto">
```

- [ ] **Шаг 5: Блок продлений без даты**

`RenewalsUndatedSection.tsx`, строка 30. Было:

```tsx
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/40">
```

Стало (жёлтый смысл сохраняем тонированным стеклом; `overflow-hidden` остаётся — здесь нет горизонтальной прокрутки на самом блоке):

```tsx
    <div className="glass-tile glass-tint-amber overflow-hidden">
```

`RenewalsUndatedSection.tsx`, строка 48. Было:

```tsx
        <div className="overflow-x-auto border-t border-amber-200 bg-white">
```

Стало (вложенное стекло запрещено — внутренняя часть остаётся плотной подложкой строк):

```tsx
        <div className="overflow-x-auto border-t border-amber-200 bg-[var(--glass-rows)]">
```

- [ ] **Шаг 6: Две карточки графиков**

`RenewalsChart.tsx`, строка 274. Было:

```tsx
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
```

Стало:

```tsx
    <div ref={rootRef} className="glass-tile p-3">
```

`RenewalsFunnel.tsx`, строка 148. Было:

```tsx
    <div ref={rootRef} className="rounded-xl border border-zinc-200 bg-white p-3">
```

Стало:

```tsx
    <div ref={rootRef} className="glass-tile p-3">
```

- [ ] **Шаг 7: Проверить сборку, линтер и существующие тесты продлений**

```bash
cd app && npx tsc --noEmit && npx eslint src/components/renewals && npx jest tests/components/renewals
```

Ожидание: три команды без ошибок. Если тест продлений падает на проверке классов — значит он завязан на `bg-white`; обновить ожидание на `glass-tile` / `glass-frame`, а не откатывать правку.

- [ ] **Шаг 8: Коммит**

```bash
git add app/src/components/renewals app/tests/components/renewals
git commit -m "feat(renewals): стеклянное оформление дашборда продлений"
```

---

## Задача 5: Дашборд проектов

Здесь четыре верхние карточки уже несут цветовую семантику — им ставятся тонированные плитки, а не монохромные.

**Files:**
- Modify: `app/src/app/analytics/projects/page.tsx:334,344-358,363,382,403,441`

- [ ] **Шаг 1: Надеть сцену на корневой блок**

Строка 334. Было:

```tsx
    <div className="space-y-8">
```

Стало:

```tsx
    <div className="glass-stage space-y-8">
```

- [ ] **Шаг 2: Четыре тонированные плитки**

Строки 344-358. Было:

```tsx
        <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5 shadow-sm">
          <p className="text-sm text-blue-700">Всего проектов</p>
          <p className="text-2xl font-semibold text-blue-900">{projects.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm">
          <p className="text-sm text-emerald-700">Активных</p>
          <p className="text-2xl font-semibold text-emerald-900">{activeProjects.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
          <p className="text-sm text-amber-700">Продления (30 дней)</p>
          <p className="text-2xl font-semibold text-amber-900">{renewals.length}</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-5 shadow-sm">
          <p className="text-sm text-red-700">Просроченных</p>
          <p className="text-2xl font-semibold text-red-900">{overdueProjects.length}</p>
        </div>
```

Стало:

```tsx
        <div className="glass-tile glass-tint-blue p-5">
          <p className="text-sm text-blue-700">Всего проектов</p>
          <p className="text-2xl font-semibold text-blue-900">{projects.length}</p>
        </div>
        <div className="glass-tile glass-tint-emerald p-5">
          <p className="text-sm text-emerald-700">Активных</p>
          <p className="text-2xl font-semibold text-emerald-900">{activeProjects.length}</p>
        </div>
        <div className="glass-tile glass-tint-amber p-5">
          <p className="text-sm text-amber-700">Продления (30 дней)</p>
          <p className="text-2xl font-semibold text-amber-900">{renewals.length}</p>
        </div>
        <div className="glass-tile glass-tint-red p-5">
          <p className="text-sm text-red-700">Просроченных</p>
          <p className="text-2xl font-semibold text-red-900">{overdueProjects.length}</p>
        </div>
```

- [ ] **Шаг 3: Четыре блока-списка**

Это четыре одинаковых обёртки на строках 363, 382, 403 и 441. Каждая выглядит так:

```tsx
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
```

Заменить каждую на:

```tsx
        <div className="glass-frame">
```

Внимание: отступ у этих четырёх строк разный (первая и последняя — на два пробела меньше). Менять содержимое класса, отступ сохранять.

- [ ] **Шаг 4: Шапки блоков**

Внутри тех же четырёх блоков идут шапки на сером фоне. Три из них выглядят так:

```tsx
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
```

Заменить каждую на:

```tsx
          <div className="border-b border-gray-200 bg-[var(--glass-fill-soft)] px-6 py-4">
```

Четвёртая (блок «Просроченные проекты», строка ~404) — красная, её оставить как есть:

```tsx
          <div className="border-b border-red-200 bg-red-100/80 px-6 py-4">
```

- [ ] **Шаг 5: Проверить сборку и линтер**

```bash
cd app && npx tsc --noEmit && npx eslint src/app/analytics/projects
```

Ожидание: обе команды без ошибок.

- [ ] **Шаг 6: Коммит**

```bash
git add app/src/app/analytics/projects/page.tsx
git commit -m "feat(projects): стеклянное оформление аналитики проектов"
```

---

## Задача 6: Визуальная проверка в браузере

Сборка и типы ничего не говорят о том, как это выглядит. Здесь проверяется каждый критерий приёмки из спеки.

**Files:** правок нет, только проверка. Если что-то не сходится — вернуться в задачи 2-5.

- [ ] **Шаг 1: Поднять дев-сервер**

Через `preview_start` с конфигом из `.claude/launch.json` (не через Bash — дев-серверы запускаются только так). Если конфига нет, создать запись с `runtimeExecutable: "npm"`, `runtimeArgs: ["run", "dev:next"]`, `port: 3000`.

- [ ] **Шаг 2: Пройти три экрана в светлой теме**

Открыть по очереди `/analytics/first-sales`, `/analytics/renewals`, `/analytics/projects`.

Проверить на каждом:
- подложка видна, пятна доходят до низа страницы (проскроллить до конца таблицы);
- плитки KPI, карточки графиков и рамки таблиц читаются как стекло, у них виден светлый край;
- строки таблиц не просвечивают друг через друга;
- навести курсор на график — фон всплывающей подсказки непрозрачный.

- [ ] **Шаг 3: Пройти те же три экрана в тёмной теме**

Переключить тему кнопкой в шапке портала. Проверить те же четыре пункта плюс:
- нет карточек, оставшихся белыми или непрозрачно-серыми;
- на дашборде проектов сохранилась цветовая семантика четырёх верхних карточек (синяя / зелёная / жёлтая / красная).

- [ ] **Шаг 4: Проверить консоль и контраст**

Через `read_console_messages` — ошибок быть не должно.

Через `javascript_tool` замерить фактический контраст основной цифры KPI к подложке под ней на обеих темах:

```js
(() => {
  const tile = document.querySelector('.glass-tile');
  const num = tile.querySelector('p:nth-of-type(2), p + p');
  return {
    text: getComputedStyle(num).color,
    tile: getComputedStyle(tile).backgroundColor,
    stage: getComputedStyle(document.querySelector('.glass-stage')).backgroundColor,
  };
})()
```

Цифры KPI — крупный текст, порог AA для него 3:1. Если не проходит, поднять непрозрачность `--glass-fill` в `globals.css`, а не менять цвет текста.

- [ ] **Шаг 5: Проверить ветку «уменьшить прозрачность»**

Эмулировать настройку через DevTools-протокол недоступно из этих инструментов, поэтому проверяется временной правкой: заменить в `globals.css` строку `@media (prefers-reduced-transparency: reduce) {` на `@media all {`, перезагрузить экран, убедиться, что размытие пропало и всё читаемо на обеих темах, затем вернуть строку обратно.

- [ ] **Шаг 6: Убедиться, что вне охвата ничего не поехало**

Открыть `/analytics/mailbox-load` и любую страницу вне аналитики. Подложки и стекла быть не должно, вид прежний.

- [ ] **Шаг 7: Прогнать весь набор тестов**

```bash
cd app && npm test
```

Ожидание: PASS. Падений, связанных с правками этого плана, быть не должно.

- [ ] **Шаг 8: Снять скриншоты и показать результат**

Через `computer` с `action: "screenshot"` — по одному кадру на экран в каждой теме, шесть штук. Приложить к отчёту.

---

## Критерии приёмки (из спеки)

1. Три дашборда показывают подложку и стеклянные поверхности в светлой и тёмной теме — Задача 6, шаги 2-3.
2. Переключение темы не оставляет непрозрачных или мутно-серых карточек — Задача 6, шаг 3.
3. Всплывающие подсказки графиков непрозрачны на обеих темах — Задача 1 + Задача 6, шаги 2-3.
4. При включённой системной настройке «уменьшить прозрачность» экраны читаемы и без размытия — Задача 2 + Задача 6, шаг 5.
5. На странице проектов сохранена цветовая семантика четырёх верхних карточек — Задача 5, шаг 2 + Задача 6, шаг 3.
6. Загрузка ящиков, боковое меню и остальные страницы визуально не изменились — Задача 6, шаг 6.
