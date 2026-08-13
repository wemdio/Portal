# Дашборд первички: источники вместо каналов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать с дашборда первички слой «канал» и группировать сделки прямо по значению поля «Источник» из AMO, которое ведут продажи.

**Architecture:** Справочник `lead_source_channels` и свёртка «источник → канал» удаляются целиком. Новый модуль `lib/firstSales/sources.ts` достаёт из сделки ключ группировки (`enum_id` значения AMO) и название. `metrics.ts` агрегирует по этому ключу и отдаёт список доступных источников, посчитанный **до** применения фильтра. Фильтр в UI — выпадающий список с галочками вместо чипов-каналов.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase-js, Jest, Tailwind. Тесты — `cd app && npm test`.

**Спека:** `docs/superpowers/specs/2026-08-12-first-sales-sources-instead-of-channels-design.md`

---

## Порядок и состояние сборки

Задачи идут строго по номерам. Важно про промежуточное состояние:

- После **Task 2** `npx tsc --noEmit` покажет ошибки в трёх компонентах (`FiltersBar.tsx`, `SourceTable.tsx`, `KpiRow.tsx`, `FirstSalesView.tsx`) — они ещё обращаются к удалённым полям. **Это ожидаемо.** Jest при этом зелёный.
- Типы сходятся обратно после **Task 4**. Не пытайтесь «починить» компоненты раньше срока — Task 3 и 4 переписывают их целиком.

## Карта файлов

| Файл | Ответственность после правки |
|---|---|
| `app/src/lib/firstSales/sources.ts` | **создаётся**: из сырой сделки AMO → ключ группировки и название источника |
| `app/src/lib/firstSales/sourceChannels.ts` | **удаляется** |
| `app/src/lib/firstSales/metrics.ts` | агрегация по ключу источника, список доступных источников |
| `app/src/lib/firstSales/params.ts` | разбор query: `source[]` вместо `channel[]` |
| `app/src/app/api/analytics/first-sales/summary/route.ts` | сводка, без загрузки справочника |
| `app/src/app/api/analytics/first-sales/leads/route.ts` | drill-down по одному ключу источника |
| `app/src/app/api/analytics/first-sales/source-map/route.ts` | **удаляется** |
| `app/src/components/first-sales/FiltersBar.tsx` | выпадающий список источников с галочками и поиском |
| `app/src/components/first-sales/SourceTable.tsx` | таблица без колонки «Канал» |
| `app/src/components/first-sales/KpiRow.tsx` | плашка «Без источника», кликабельная |
| `app/src/components/first-sales/FirstSalesView.tsx` | проводка, без справочника |
| `app/src/components/first-sales/SourceMapEditor.tsx` | **удаляется** |
| `supabase/migrations/20260812_0001_drop_lead_source_channels.sql` | **создаётся**: `drop table` |

---

### Task 1: Модуль извлечения источника

Чистая функция без зависимостей — начинаем с неё, потому что на ней стоит всё остальное. Ничего существующего эта задача не ломает.

**Files:**
- Create: `app/src/lib/firstSales/sources.ts`
- Test: `app/tests/lib/firstSales/sources.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/firstSales/sources.test.ts`:

```ts
import { NO_SOURCE_KEY, NO_SOURCE_LABEL, resolveSource } from '@/lib/firstSales/sources';

/** Сырая сделка AMO с одним полем «Источник». */
const raw = (value: unknown, enumId?: unknown) => ({
  custom_fields_values: [
    {
      field_name: 'Источник',
      field_type: 'select',
      values: [enumId === undefined ? { value } : { value, enum_id: enumId }],
    },
  ],
});

describe('resolveSource', () => {
  it('ключ — enum_id, название — как в AMO', () => {
    const res = resolveSource(raw('Email Outreach', 11382049));
    expect(res.key).toBe('11382049');
    expect(res.label).toBe('Email Outreach');
  });

  it('регистр названия не трогается: ключ стабилен, показываем как завели', () => {
    const res = resolveSource(raw('портал (outreachOS)', 11383675));
    expect(res.key).toBe('11383675');
    expect(res.label).toBe('портал (outreachOS)');
  });

  it('enum_id строкой из JSON тоже принимается', () => {
    expect(resolveSource(raw('SEO', '11382055')).key).toBe('11382055');
  });

  it('значение без enum_id уходит в текстовый ключ, ё схлопывается', () => {
    const res = resolveSource(raw('Партнёр'));
    expect(res.key).toBe('text:партнер');
    expect(res.label).toBe('Партнёр');
  });

  it('нечисловой enum_id считается отсутствующим', () => {
    expect(resolveSource(raw('PR', 'abc')).key).toBe('text:pr');
  });

  it('пустое значение — «без источника»', () => {
    for (const empty of [null, '', '   ']) {
      const res = resolveSource(raw(empty, 123));
      expect(res.key).toBe(NO_SOURCE_KEY);
      expect(res.label).toBe(NO_SOURCE_LABEL);
    }
  });

  it('поля «Источник» нет вовсе — «без источника»', () => {
    const res = resolveSource({
      custom_fields_values: [{ field_name: 'Контур', values: [{ value: 'Маркетинг' }] }],
    });
    expect(res.key).toBe(NO_SOURCE_KEY);
  });

  it('битые входные данные не роняют расчёт', () => {
    for (const bad of [null, undefined, 42, 'строка', {}, { custom_fields_values: 'нет' }]) {
      expect(resolveSource(bad).key).toBe(NO_SOURCE_KEY);
    }
  });

  it('поле есть, но values пустой', () => {
    expect(resolveSource({ custom_fields_values: [{ field_name: 'Источник', values: [] }] }).key)
      .toBe(NO_SOURCE_KEY);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd app && npx jest tests/lib/firstSales/sources.test.ts
```

Ожидаемо: FAIL, `Cannot find module '@/lib/firstSales/sources'`.

- [ ] **Step 3: Реализовать модуль**

Создать `app/src/lib/firstSales/sources.ts`:

```ts
/**
 * Источник сделки AMO для дашборда первички.
 *
 * Раньше здесь (в `sourceChannels.ts`) жила свёртка источника в «канал» через
 * справочник `lead_source_channels`. Справочник удалён: таксономию источников
 * ведут продажи в самом AMO — поле «Источник» там `select` с фиксированным
 * списком значений (`field_id = 1314379`), — а портал только группирует по
 * ней и второго списка у себя не заводит. Спека:
 * docs/superpowers/specs/2026-08-12-first-sales-sources-instead-of-channels-design.md
 */

/** Ключ сделки без заполненного «Источник». Числовым `enum_id` не бывает. */
export const NO_SOURCE_KEY = 'none';
export const NO_SOURCE_LABEL = 'Без источника';

export type ResolvedSource = {
  /**
   * Ключ группировки, он же значение параметра `source` в API:
   * `<enum_id>` — обычный источник;
   * `text:<нормализованное значение>` — защитный случай для значения без
   * `enum_id` (поле `select`, такого быть не должно, но потерять сделку хуже,
   * чем держать лишнюю ветку);
   * `none` — поле не заполнено.
   */
  key: string;
  /** Название ровно как заведено в AMO. Для незаполненного — NO_SOURCE_LABEL. */
  label: string;
};

const NONE: ResolvedSource = { key: NO_SOURCE_KEY, label: NO_SOURCE_LABEL };

/** Только для текстового ключа: два написания одного значения не должны дать
 *  две строки в разбивке. Название при этом остаётся исходным. */
function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function resolveSource(raw: unknown): ResolvedSource {
  if (!raw || typeof raw !== 'object') return NONE;

  const fields = (raw as { custom_fields_values?: unknown }).custom_fields_values;
  if (!Array.isArray(fields)) return NONE;

  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    if ((field as { field_name?: unknown }).field_name !== 'Источник') continue;

    const values = (field as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0) return NONE;

    const first = values[0];
    if (!first || typeof first !== 'object') return NONE;

    const rawValue = (first as { value?: unknown }).value;
    const label = rawValue == null ? '' : String(rawValue).trim();
    if (label === '') return NONE;

    const enumId = (first as { enum_id?: unknown }).enum_id;
    if (typeof enumId === 'number' && Number.isInteger(enumId)) {
      return { key: String(enumId), label };
    }
    if (typeof enumId === 'string' && /^\d+$/.test(enumId)) {
      return { key: enumId, label };
    }
    return { key: `text:${normalizeText(label)}`, label };
  }

  return NONE;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
cd app && npx jest tests/lib/firstSales/sources.test.ts
```

Ожидаемо: PASS, 9 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/firstSales/sources.ts app/tests/lib/firstSales/sources.test.ts
git commit -m "feat(first-sales): извлечение источника сделки по enum_id AMO"
```

---

### Task 2: Агрегация и API по источникам

Серверная часть целиком, одной задачей: `metrics.ts`, `params.ts` и обе ручки завязаны друг на друга типами, разносить их по задачам — значит держать красный `tsc` дольше.

**Files:**
- Modify: `app/src/lib/firstSales/metrics.ts`
- Modify: `app/src/lib/firstSales/params.ts`
- Modify: `app/src/app/api/analytics/first-sales/summary/route.ts`
- Modify: `app/src/app/api/analytics/first-sales/leads/route.ts`
- Delete: `app/src/lib/firstSales/sourceChannels.ts`, `app/tests/lib/firstSales/sourceChannels.test.ts`
- Test: `app/tests/lib/firstSales/metrics.test.ts`

- [ ] **Step 1: Переписать тесты метрик под новую модель**

В `app/tests/lib/firstSales/metrics.test.ts` заменить шапку файла (строки 1–12) на:

```ts
import {
  CONTRACT_RULE_SINCE,
  computeFirstSalesSeries,
  type FirstSalesLeadRow,
} from '@/lib/firstSales/metrics';
import { MEETINGS_RELIABLE_SINCE, type MeetingLinkRow } from '@/lib/firstSales/meetings';
```

Константа `map` больше не нужна — удалить её. Дальше по файлу: у всех вызовов `computeFirstSalesSeries` убрать аргумент `map` (он стоял третьим, между `meetingLinks` и `from`). Было `[], map, from, to, 'day', null` — станет `[], from, to, 'day', null`.

Заменить блок про неизвестный источник (около строки 138) на:

```ts
    const unknown = res.bySource.find((s) => s.source === 'Нейровыдача');
    expect(unknown?.leads).toBe(1);
    expect(res.totals.noSourceLeads).toBe(0);
```

- [ ] **Step 2: Дописать новые тесты в конец `describe('computeFirstSalesSeries', ...)`**

```ts
  it('сделки с одним enum_id сливаются в строку, имя берётся от свежей', () => {
    const withEnum = (value: string, over: Partial<FirstSalesLeadRow>) =>
      lead({
        ...over,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value, enum_id: 11382029 }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [
        withEnum('Партнер', { amo_id: 1, created_at: '2026-07-10T09:00:00.000Z' }),
        withEnum('Партнёрка', { amo_id: 2, created_at: '2026-07-20T09:00:00.000Z' }),
      ],
      [], from, to, 'day', null,
    );

    expect(res.bySource).toHaveLength(1);
    expect(res.bySource[0]!.key).toBe('11382029');
    expect(res.bySource[0]!.source).toBe('Партнёрка');
    expect(res.bySource[0]!.leads).toBe(2);
  });

  it('сделка без источника попадает в отдельную строку и в noSourceLeads', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, raw: { custom_fields_values: [] } })],
      [], from, to, 'day', null,
    );
    expect(res.totals.noSourceLeads).toBe(1);
    expect(res.bySource.find((s) => s.key === 'none')?.leads).toBe(1);
  });

  it('«Контур = Маркетинг» больше ни на что не влияет', () => {
    const res = computeFirstSalesSeries(
      [lead({
        amo_id: 1,
        raw: { custom_fields_values: [{ field_name: 'Контур', values: [{ value: 'Маркетинг' }] }] },
      })],
      [], from, to, 'day', null,
    );
    expect(res.totals.noSourceLeads).toBe(1);
  });

  it('фильтр по источнику сужает итоги', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2)], [], from, to, 'day', ['111'],
    );
    expect(res.totals.leads).toBe(1);
    expect(res.bySource).toHaveLength(1);
  });

  it('availableSources считается ДО фильтра — иначе фильтр съедает сам себя', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2)], [], from, to, 'day', ['111'],
    );
    expect(res.availableSources.map((s) => s.key).sort()).toEqual(['111', '222']);
  });

  it('availableSources отсортирован по числу лидов', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2), withEnum(222, 3)], [], from, to, 'day', null,
    );
    expect(res.availableSources[0]!.key).toBe('222');
    expect(res.availableSources[0]!.leads).toBe(2);
  });
```

- [ ] **Step 3: Убедиться, что тесты падают**

```bash
cd app && npx jest tests/lib/firstSales/metrics.test.ts
```

Ожидаемо: FAIL — `computeFirstSalesSeries` ждёт 7 аргументов, `noSourceLeads`/`availableSources`/`key` не существуют.

- [ ] **Step 4: Переписать `metrics.ts`**

В `app/src/lib/firstSales/metrics.ts` заменить импорт справочника:

```ts
import {
  NO_SOURCE_KEY,
  NO_SOURCE_LABEL,
  resolveSource,
  type ResolvedSource,
} from '@/lib/firstSales/sources';
```

(строки, импортирующие `buildSourceIndex`, `resolveChannel`, `FirstSalesChannel`, `ResolvedChannel`, `SourceChannelRow` — удалить целиком).

Заменить тип разбивки:

```ts
export type SourceBreakdown = {
  /** Ключ группировки, он же значение `source` в API drill-down. */
  key: string;
  /** Название источника как заведено в AMO. */
  source: string;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

/** Пункт выпадашки фильтра. Считается ДО применения фильтра — см. комментарий
 *  в computeFirstSalesSeries. */
export type AvailableSource = { key: string; label: string; leads: number };
```

В `FirstSalesTotals` переименовать поле `unassignedLeads: number` в `noSourceLeads: number`.

В `FirstSalesSeries` добавить поле:

```ts
export type FirstSalesSeries = {
  series: SeriesBucket[];
  bySource: SourceBreakdown[];
  availableSources: AvailableSource[];
  totals: FirstSalesTotals;
};
```

Сигнатуру функции заменить на:

```ts
export function computeFirstSalesSeries(
  leads: FirstSalesLeadRow[],
  meetingLinks: MeetingLinkRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  sourceFilter: string[] | null,
): FirstSalesSeries {
  const allowed = sourceFilter && sourceFilter.length > 0 ? new Set(sourceFilter) : null;
```

(строку `const index = buildSourceIndex(sourceMap);` удалить.)

Инициализацию `totals` поправить: `unassignedLeads: 0` → `noSourceLeads: 0`.

Заменить объявление карты каналов на карту источников и добавить две служебные карты:

```ts
  // Источник СДЕЛКИ, не записи разговора — иначе фильтр не работал бы для
  // встреч. Заполняется в основном цикле ДО фильтра, чтобы в карте остались
  // все сделки независимо от текущего выбора.
  const dealSourceMap = new Map<number, ResolvedSource>();

  // Название источника берём у сделки с наибольшим created_at (при равенстве —
  // с наибольшим amo_id, чтобы результат не зависел от порядка строк выборки).
  // Если продажи переименуют пункт в AMO, у старых, давно не синхронизированных
  // сделок в raw останется прежнее написание — показываем свежее.
  const labelPick = new Map<string, { label: string; createdAt: number; amoId: number }>();

  // Список для выпадашки фильтра. Считается ДО отсева по источнику: иначе,
  // выбрав один источник, пользователь получил бы список из одного пункта и
  // добавить второй стало бы нечем — фильтр съел бы сам себя.
  const availableLeads = new Map<string, number>();
```

Начало цикла `for (const lead of leads)` заменить на:

```ts
  for (const lead of leads) {
    const resolved = resolveSource(lead.raw);
    dealSourceMap.set(lead.amo_id, resolved);

    const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : Number.NEGATIVE_INFINITY;
    const bestLabel = labelPick.get(resolved.key);
    if (
      !bestLabel
      || createdAt > bestLabel.createdAt
      || (createdAt === bestLabel.createdAt && lead.amo_id > bestLabel.amoId)
    ) {
      labelPick.set(resolved.key, { label: resolved.label, createdAt, amoId: lead.amo_id });
    }
    if (!availableLeads.has(resolved.key)) availableLeads.set(resolved.key, 0);
    if (inWindow(lead.created_at, from, to)) {
      availableLeads.set(resolved.key, (availableLeads.get(resolved.key) as number) + 1);
    }

    if (allowed && !allowed.has(resolved.key)) continue;

    let breakdown = bySource.get(resolved.key);
    if (!breakdown) {
      breakdown = { key: resolved.key, source: resolved.label, leads: 0, qualified: 0, meetings: 0, contracts: 0 };
      bySource.set(resolved.key, breakdown);
    }
```

(весь прежний блок с `const sourceKey = ...` и длинным примечанием про `channel/known` от первой сделки — удалить: имя строки теперь берётся из `labelPick` на выходе, а не от первой попавшейся сделки, так что и оговорка не нужна.)

Внутри `if (inWindow(lead.created_at, from, to))` строку `if (resolved.channel === 'unassigned') totals.unassignedLeads += 1;` заменить на:

```ts
      if (resolved.key === NO_SOURCE_KEY) totals.noSourceLeads += 1;
```

В блоке встреч заменить резолв канала:

```ts
    const resolved = dealSourceMap.get(link.amo_deal_id);
    const key = resolved?.key ?? NO_SOURCE_KEY;
    if (allowed && !allowed.has(key)) continue;

    totals.meetings += 1;
    bump(bucketKey(meetingDate, groupBy), 'meetings');

    let breakdown = bySource.get(key);
    if (!breakdown) {
      breakdown = {
        key,
        source: resolved?.label ?? NO_SOURCE_LABEL,
        leads: 0, qualified: 0, meetings: 0, contracts: 0,
      };
      bySource.set(key, breakdown);
    }
    breakdown.meetings += 1;
```

и дописать `NO_SOURCE_LABEL` в импорт из `sources.ts`.

Блок `return` заменить на:

```ts
  return {
    series: keys.map((k) => series.get(k) as SeriesBucket),
    // Пустые строки отбрасываем: выборка тянет сделки с любой активностью в
    // окне, поэтому источник может попасть в разбивку из-за оплаты старой
    // сделки и дать строку из одних нулей.
    bySource: [...bySource.values()]
      .filter((s) => s.leads + s.qualified + s.meetings + s.contracts > 0)
      .map((s) => ({ ...s, source: labelPick.get(s.key)?.label ?? s.source }))
      .sort((a, b) => b.leads - a.leads),
    availableSources: [...availableLeads.entries()]
      .map(([key, leads]) => ({ key, label: labelPick.get(key)?.label ?? key, leads }))
      .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label, 'ru-RU')),
    totals,
  };
```

Удалить функцию `fetchSourceMap` целиком (последние 8 строк файла).

- [ ] **Step 5: Переписать `params.ts`**

В `app/src/lib/firstSales/params.ts` удалить импорт `FIRST_SALES_CHANNELS`/`FirstSalesChannel` и строку `const CHANNELS: readonly FirstSalesChannel[] = FIRST_SALES_CHANNELS;`. Единственный оставшийся импорт — `GroupBy` из `buckets`.

В типе `FirstSalesParams` заменить `channels: FirstSalesChannel[] | null;` на `sources: string[] | null;`.

Блок разбора каналов заменить на:

```ts
  // Список значений не проверяем: источники ведут продажи в AMO, портал не
  // держит их перечня и не вправе объявить чужое значение недопустимым.
  // Ограничиваем только количество — защита от бесконечной строки запроса.
  const sourceRaw = url.searchParams.getAll('source');
  if (sourceRaw.length > MAX_SOURCES) {
    return { value: null, error: `Слишком много источников в фильтре: максимум ${MAX_SOURCES}` };
  }
```

и вернуть `sources: sourceRaw.length > 0 ? sourceRaw : null` вместо `channels`.

Рядом с `MAX_RANGE_DAYS` добавить `const MAX_SOURCES = 100;`.

- [ ] **Step 6: Поправить ручку сводки**

В `app/src/app/api/analytics/first-sales/summary/route.ts`:

- из импорта `@/lib/firstSales/metrics` убрать `fetchSourceMap`;
- `const { from, to, groupBy, channels } = parsed.value;` → `const { from, to, groupBy, sources } = parsed.value;`;
- из `Promise.all` убрать элемент `fetchSourceMap(db),` и соответствующую переменную `sourceMap` из деструктуризации (станет `const [current, previous, lastRunRes] = await Promise.all([...])`);
- оба вызова расчёта:

```ts
    const result = computeFirstSalesSeries(
      current.leads, current.meetingLinks, from, to, groupBy, sources,
    );
    const prevResult = computeFirstSalesSeries(
      previous.leads, previous.meetingLinks, prev.from, prev.to, groupBy, sources,
    );
```

- [ ] **Step 7: Поправить ручку drill-down**

В `app/src/app/api/analytics/first-sales/leads/route.ts` заменить импорты справочника на `import { resolveSource } from '@/lib/firstSales/sources';`, а тело фильтрации — на:

```ts
    const leads = await fetchFirstSalesLeads(gate.supabaseAdmin, PIPELINE_ID, from, to, meetingDealIds);

    const rows = leads
      .filter((lead) => resolveSource(lead.raw).key === source)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, MAX_ROWS)
```

`fetchSourceMap` и `Promise.all` вокруг него убрать, `buildSourceIndex`/`allowed`/`channels` — тоже: строка, в которую пользователь проваливается, уже прошла фильтр, второй раз применять его незачем. Комментарий над чтением `source` заменить на:

```ts
  // Сделки без заполненного «Источник» приходят сюда под ключом `none` —
  // именно его кладёт в разбивку metrics.ts. Проверяем на null, а не на
  // пустоту: отсутствие параметра — ошибка вызова, а не «источник без имени».
```

Из `parsed.value` брать только `{ from, to }`.

- [ ] **Step 8: Удалить справочник из кода**

```bash
git rm app/src/lib/firstSales/sourceChannels.ts app/tests/lib/firstSales/sourceChannels.test.ts
```

- [ ] **Step 9: Прогнать тесты**

```bash
cd app && npx jest tests/lib/firstSales
```

Ожидаемо: PASS. `npx tsc --noEmit` на этом шаге ещё красный на четырёх компонентах — так и задумано, Task 3 и 4 их закрывают.

- [ ] **Step 10: Коммит**

```bash
git add -A app/src/lib/firstSales app/src/app/api/analytics/first-sales app/tests/lib/firstSales
git commit -m "feat(first-sales): агрегация и API по источникам AMO вместо каналов"
```

---

### Task 3: Фильтр — выпадающий список источников

**Files:**
- Modify: `app/src/components/first-sales/FiltersBar.tsx`

- [ ] **Step 1: Заменить шапку файла**

В `app/src/components/first-sales/FiltersBar.tsx` заменить импорты (строки 1–4) на:

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AvailableSource } from '@/lib/firstSales/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';
```

В `FiltersState` заменить `channels: FirstSalesChannel[];` на `sources: string[];`, а в `getDefaultFilters()` — `channels: []` на `sources: []`.

- [ ] **Step 2: Заменить сигнатуру компонента и обработчик**

Заменить блок от `export default function FiltersBar({` до закрывающей скобки `toggleChannel` включительно (строки 75–93 исходного файла) на код ниже. `applyPreset` в нём переехал вниз — он был выше `toggleChannel` и целиком попадает в заменяемый кусок:

```tsx
export default function FiltersBar({
  value,
  sources,
  onChange,
}: {
  value: FiltersState;
  /** Доступные источники за период. Приходят из сводки и считаются ДО фильтра. */
  sources: AvailableSource[];
  onChange: (value: FiltersState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Закрытие по клику мимо и по Escape. Панель не модальная — фокус не
  // забираем, чтобы не мешать работе с датами рядом.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru-RU');
    if (!q) return sources;
    return sources.filter((s) => s.label.toLocaleLowerCase('ru-RU').includes(q));
  }, [sources, query]);

  const toggleSource = (key: string) => {
    const has = value.sources.includes(key);
    onChange({
      ...value,
      sources: has ? value.sources.filter((s) => s !== key) : [...value.sources, key],
    });
  };

  // Подпись кнопки: пусто = «все», один = его имя, дальше — счёт. Имя
  // единственного выбранного полезнее числа «1».
  const selectedLabel =
    value.sources.length === 0
      ? 'все'
      : value.sources.length === 1
        ? (sources.find((s) => s.key === value.sources[0])?.label ?? '1')
        : `выбрано ${value.sources.length}`;

  const applyPreset = (preset: Preset) => {
    const now = mskNow();
    onChange({ ...value, from: toDateInputValue(preset.from(now)), to: toDateInputValue(now) });
  };
```

- [ ] **Step 3: Заменить блок чипов на выпадашку**

Блок `{/* каналы */}` (строки 144–173 в исходном файле) заменить на:

```tsx
      {/* источники */}
      <div className="flex flex-wrap items-center gap-2">
        <div ref={boxRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="listbox"
            className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            Источники: <span className="font-medium text-zinc-900">{selectedLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {open && (
            <div
              role="listbox"
              className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-lg"
            >
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск источника"
                className="mb-1 w-full rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
              />
              <div className="max-h-64 overflow-y-auto">
                {visible.map((s) => {
                  const active = value.sources.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => toggleSource(s.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50"
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300'
                        }`}
                      >
                        {active && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <span className="truncate">{s.label}</span>
                      <span className="ml-auto tabular-nums text-zinc-400">{s.leads}</span>
                    </button>
                  );
                })}
                {visible.length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-zinc-400">Ничего не найдено.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {value.sources.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...value, sources: [] })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>
```

- [ ] **Step 4: Проверить сборку компонента**

```bash
cd app && npx tsc --noEmit 2>&1 | grep -E "FiltersBar" || echo "FiltersBar чист"
```

Ожидаемо: `FiltersBar чист`. Ошибки в `SourceTable`/`KpiRow`/`FirstSalesView` остаются — их закрывает Task 4.

- [ ] **Step 5: Коммит**

```bash
git add app/src/components/first-sales/FiltersBar.tsx
git commit -m "feat(first-sales): фильтр источников выпадающим списком с галочками"
```

---

### Task 4: Таблица, плашка и проводка

**Files:**
- Modify: `app/src/components/first-sales/SourceTable.tsx`
- Modify: `app/src/components/first-sales/KpiRow.tsx`
- Modify: `app/src/components/first-sales/FirstSalesView.tsx`

- [ ] **Step 1: Таблица — убрать колонку «Канал»**

В `app/src/components/first-sales/SourceTable.tsx`:

- удалить импорт `CHANNEL_LABELS`;
- в `drillKey` заменить `filters.channels.join(',')` на `filters.sources.join(',')`;
- в `DrillDownRows` убрать цикл `for (const channel of filters.channels) qs.append('channel', channel);` и заменить зависимость эффекта `filters.channels.join(',')` на `filters.sources.join(',')` (и упоминание каналов в комментарии-дисклеймере над `eslint-disable` — на источники);
- в `sourceSortColumns` удалить строку `channel: { ... }`;
- заменить сигнатуру `DrillDownRows` на `{ sourceKey, filters }: { sourceKey: string; filters: FiltersState }` и внутри — `new URLSearchParams({ from: filters.from, to: filters.to, source: sourceKey })`, зависимость эффекта `source` → `sourceKey`, `logError(..., { source: sourceKey })`;
- заменить `colSpan={7}` на `colSpan={6}` во всех четырёх местах;
- удалить `<SortableTh label="Канал" ... />` из шапки и `<td ...>{CHANNEL_LABELS[row.channel]}</td>` из строки;
- удалить блок с меткой «нет в справочнике» (`{!row.known && (...)}`);
- в теле таблицы заменить ключ раскрытия на `row.key`:

```tsx
          {sortedRows.map((row) => {
            const isOpen = expanded === row.key;
            return (
              <Fragment key={row.key}>
                <tr
                  onClick={() => toggle(row.key)}
```

и раскрытие строки — на `{isOpen && <DrillDownRows sourceKey={row.key} filters={filters} />}` (`filters` здесь — проп самого `SourceTable`; сужение периода по выбранной корзине делает `FirstSalesView` выше уровнем, до передачи в этот проп);

- в ячейке названия оставить `{row.source}` без фолбэка `|| '(не указан)'` — пустым `source` уже не бывает, `resolveSource` всегда даёт название.

- [ ] **Step 2: Плашка «Без источника»**

В `app/src/components/first-sales/KpiRow.tsx` добавить проп и заменить плашку:

```tsx
export default function KpiRow({
  totals,
  previousTotals,
  syncedAt,
  onNoSourceClick,
}: {
  totals: FirstSalesTotals;
  previousTotals: FirstSalesTotals;
  syncedAt: string | null;
  /** Клик по плашке — поставить фильтр на «Без источника». */
  onNoSourceClick: () => void;
}) {
```

Плашку `label="Без канала"` заменить на:

```tsx
      <button
        type="button"
        onClick={onNoSourceClick}
        disabled={totals.noSourceLeads === 0}
        title="Показать только сделки без заполненного «Источник» — со ссылками в AMO"
        className="text-left enabled:cursor-pointer disabled:cursor-default"
      >
        <Tile
          label="Без источника"
          value={fmt(totals.noSourceLeads)}
          amber={totals.noSourceLeads > 0}
        />
      </button>
```

- [ ] **Step 3: Проводка**

В `app/src/components/first-sales/FirstSalesView.tsx`:

- удалить импорт `SourceMapEditor`, состояние `showSourceMap` и кнопку «Справочник источников» вместе с блоком `{showSourceMap && (...)}`;
- в обоих фетчах заменить `for (const channel of filters.channels) qs.append('channel', channel);` на `for (const source of filters.sources) qs.append('source', source);`;
- `const channelKey = filters.channels.join(',');` → `const sourceKey = filters.sources.join(',');`, и в зависимостях эффекта корзины `channelKey` → `sourceKey` (комментарий у `eslint-disable` — про источники);
- передать источники в фильтр и обработчик в плашки:

```tsx
      <FiltersBar
        value={filters}
        sources={data?.availableSources ?? []}
        onChange={(next) => {
          setFilters(next);
          setSelectedBucket(null);
        }}
      />
```

```tsx
          <KpiRow
            totals={data.totals}
            previousTotals={data.previousTotals}
            syncedAt={data.syncedAt}
            onNoSourceClick={() => {
              setFilters((f) => ({ ...f, sources: ['none'] }));
              setSelectedBucket(null);
            }}
          />
```

`reloadKey` остаётся: его по-прежнему инкрементирует `MeetingLinksEditor`.

- [ ] **Step 4: Типы должны сойтись**

```bash
cd app && npx tsc --noEmit
```

Ожидаемо: без ошибок.

- [ ] **Step 5: Линт и тесты**

```bash
cd app && npm run lint && npm test
```

Ожидаемо: PASS.

- [ ] **Step 6: Коммит**

```bash
git add app/src/components/first-sales
git commit -m "feat(first-sales): таблица и плашки по источникам, справочник снят с экрана"
```

---

### Task 5: Удалить справочник из базы и из кода

**Files:**
- Delete: `app/src/components/first-sales/SourceMapEditor.tsx`, `app/src/app/api/analytics/first-sales/source-map/route.ts`
- Create: `supabase/migrations/20260812_0001_drop_lead_source_channels.sql`
- Create: `app/tests/migrations/dropLeadSourceChannels.test.ts`
- Modify: `app/tests/migrations/firstSalesDashboard.test.ts`

- [ ] **Step 1: Удалить экран и ручку**

```bash
git rm app/src/components/first-sales/SourceMapEditor.tsx app/src/app/api/analytics/first-sales/source-map/route.ts
```

- [ ] **Step 2: Написать падающий тест миграции**

Создать `app/tests/migrations/dropLeadSourceChannels.test.ts`:

```ts
import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260812_0001_drop_lead_source_channels.sql'),
  'utf8',
);

describe('миграция удаления справочника источников', () => {
  it('удаляет таблицу идемпотентно', () => {
    expect(SQL).toMatch(/drop table if exists public\.lead_source_channels/);
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

```bash
cd app && npx jest tests/migrations/dropLeadSourceChannels.test.ts
```

Ожидаемо: FAIL, `ENOENT` — файла миграции нет.

- [ ] **Step 4: Написать миграцию**

Создать `supabase/migrations/20260812_0001_drop_lead_source_channels.sql`:

```sql
-- Слой «канал» убран с дашборда первички. Таксономию источников ведут продажи
-- в AMO (поле «Источник» — select, field_id 1314379), портал группирует сделки
-- по ней и второго списка у себя не держит.
--
-- Справочник был заведён в 20260730_0001 и с 31.07.2026 не редактировался ни
-- разу: 16 источников так и остались в канале unassigned, из-за чего плашка
-- «Без канала» показывала 240 из 380 лидов при 10 реально неразмеченных.
-- Спека: docs/superpowers/specs/2026-08-12-first-sales-sources-instead-of-channels-design.md

drop table if exists public.lead_source_channels;
```

- [ ] **Step 5: Убедиться, что тест проходит**

```bash
cd app && npx jest tests/migrations/dropLeadSourceChannels.test.ts
```

Ожидаемо: PASS.

- [ ] **Step 6: Снять сторожа со старой миграции**

В `app/tests/migrations/firstSalesDashboard.test.ts` удалить четыре теста, охраняющих форму удалённой таблицы: `'создаёт справочник источников'`, `'ограничивает канал списком значений'`, `'выдаёт гранты service_role на новую таблицу'`, `'включает RLS без select-политики для authenticated'`.

Тесты про `amo_lead_stage_dates_v`, индекс на `amo_events` и верхнюю границу порогов этапов **оставить** — они охраняют живую логику.

- [ ] **Step 7: Полный прогон**

```bash
cd app && npx tsc --noEmit && npm run lint && npm test
```

Ожидаемо: всё зелёное, ни одной ссылки на `lead_source_channels` в `app/src`.

```bash
cd G:/PycharmProjects/Portal && grep -rn "lead_source_channels\|sourceChannels\|SourceMapEditor\|source-map" app/src app/tests || echo "ссылок не осталось"
```

- [ ] **Step 8: Коммит**

```bash
git add -A app supabase/migrations/20260812_0001_drop_lead_source_channels.sql
git commit -m "refactor(first-sales): удалить справочник источник-канал из кода и базы"
```

---

### Task 6: Сверка с боевыми данными

Расчёт переписан целиком — цифры обязаны сойтись с тем, что дашборд показывал до правки. Проверяем через `portal-db` MCP (только чтение).

**Files:** нет правок, только проверка.

- [ ] **Step 1: Эталон по базе**

Выполнить через MCP `portal-db` (read-only):

```sql
with base as (
  select v.amo_deal_id, v.created_at, l.raw
  from amo_lead_stage_dates_v v
  join amo_leads l on l.amo_id = v.amo_deal_id
  where v.pipeline_id = 7670334
    and v.created_at >= '2026-07-14T00:00:00+03'
    and v.created_at <= '2026-08-12T23:59:59+03'
), s as (
  select (select f->'values'->0->>'enum_id'
            from jsonb_array_elements(
              case when jsonb_typeof(b.raw->'custom_fields_values')='array'
                   then b.raw->'custom_fields_values' else '[]'::jsonb end) f
           where f->>'field_name'='Источник' limit 1) as enum_id
  from base b
)
select count(*) as leads_vsego,
       count(*) filter (where enum_id is null) as bez_istochnika,
       count(distinct enum_id) as istochnikov
from s;
```

Ожидаемо: `leads_vsego = 380`, `bez_istochnika = 10`, `istochnikov = 15`.

- [ ] **Step 2: Поднять дашборд и сверить**

```bash
cd app && npm run dev:next
```

Открыть `/analytics/first-sales`, выставить период 14.07.2026 — 12.08.2026 и сверить: «Лиды» = 380, «Без источника» = 10, в выпадашке источников 15 пунктов плюс «Без источника», сумма колонки «Лиды» в таблице = 380.

- [ ] **Step 3: Проверить, что фильтр не съедает сам себя**

В выпадашке выбрать один источник — убедиться, что остальные пункты в списке остались и можно добавить второй. Выбрать шесть телеграмных (TG-посев, Телеграм, Telegram Outreach, ТГ-канал, ТГ Бот, ТГ-АДС) — плашки и воронка должны показать их сумму.

- [ ] **Step 4: Проверить плашку**

Кликнуть «Без источника» — фильтр встаёт на неё, в таблице одна строка «Без источника» на 10 сделок; раскрыть строку — сделки со ссылками в AMO, ссылки открываются.

- [ ] **Step 5: Финальный коммит и пуш**

```bash
cd G:/PycharmProjects/Portal && git status --short
git push origin dmitriy_kuladmed
```

Остановиться здесь и доложить пользователю: ветка, SHA, результаты сверки. Мерж в `main` и деплой — не наша зона (см. `AGENTS.md`).

---

## Что не входит в план

- Отчёт продаж (`app/src/lib/salesReport/`) и его понятие канала — не трогаем.
- `app/src/lib/cisLeads/channelResolver.ts` — другой «канал» (соцсети лида), не связан.
- Схлопывание шести телеграм-источников в один: делается в самом AMO силами продаж.
- Этапы 2 и 3 дашборда (оборот, стоимость лида).
