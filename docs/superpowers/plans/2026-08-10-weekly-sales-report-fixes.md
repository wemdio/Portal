# Правки еженедельного отчёта продаж — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Считать метрики отчёта по максимально достигнутому этапу сделки вместо текущего, отсечь тестовые заявки своих сотрудников и дубли лид-магнита.

**Architecture:** Чистая функция `computeMetricsFromRows` получает историю переходов `amo_events` четвёртым параметром и для каждой сделки считает `peak` — максимальный `sort` среди этапа создания и всех достигнутых этапов, исключая «Успешно», «Закрыто» и «Перенос». Фильтры имён и дедуп лид-магнита выносятся в отдельный модуль `leadFilters.ts` — `metrics.ts` уже держит пороги, окно и запрос в БД, добавлять туда ещё и текстовые правила нельзя.

**Tech Stack:** TypeScript, Next.js, Supabase JS client, Jest (`next/jest`), Postgres.

**Спека:** `docs/superpowers/specs/2026-08-10-weekly-sales-report-fixes-design.md`

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `app/src/lib/leadsReport/channels.ts` (изменить) | Раскладка сделки по каналам + явный список исключённых источников |
| `app/src/lib/leadsReport/leadFilters.ts` (создать) | Чёрный список имён и дедупликация лид-магнита. Чистые функции, без БД и без типов AMO |
| `app/src/lib/leadsReport/metrics.ts` (изменить) | Пороги этапов, расчёт `peak`, метрики, выборка из БД |
| `app/tests/lib/leadsReport/channels.test.ts` (изменить) | Тест на исключённый источник |
| `app/tests/lib/leadsReport/leadFilters.test.ts` (создать) | Тесты чёрного списка и дедупа |
| `app/tests/lib/leadsReport/metrics.test.ts` (изменить) | Тесты `peak` и связки фильтров |

Все команды запускаются из каталога `app/`.

Базовое состояние перед началом: `npx jest tests/lib/leadsReport` → 9 suites, 61 test, все PASS. В рабочей копии уже лежат невыкаченные правки по «Закрыто и не реализовано» и лид-магниту — они часть этой же ветки, коммитить их отдельно не нужно.

---

### Task 1: Автоаутрич явно вне отчёта

**Files:**
- Modify: `app/src/lib/leadsReport/channels.ts`
- Test: `app/tests/lib/leadsReport/channels.test.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в `app/tests/lib/leadsReport/channels.test.ts` внутрь существующего верхнеуровневого `describe`:

```ts
  it('источник «портал (outreachos)» сознательно вне отчёта', () => {
    const raw = {
      custom_fields_values: [
        { field_name: 'Источник', values: [{ value: 'портал (outreachos)' }] },
      ],
    };
    expect(detectSummaryChannel(raw)).toBeNull();
  });

  it('исключённый источник сильнее пометки «Контур»=«Маркетинг»', () => {
    const raw = {
      custom_fields_values: [
        { field_name: 'Контур', values: [{ value: 'Маркетинг' }] },
        { field_name: 'Источник', values: [{ value: 'Портал (OutreachOS)' }] },
      ],
    };
    expect(detectSummaryChannel(raw)).toBeNull();
  });
```

- [ ] **Step 2: Запустить тест и убедиться, что второй падает**

Run: `npx jest tests/lib/leadsReport/channels.test.ts -t "Контур"`
Expected: FAIL — `expected null, received "marketing"`. Первый тест пройдёт и без правки (источник и так неизвестен) — это нормально, он закрепляет поведение.

- [ ] **Step 3: Внести правку**

В `app/src/lib/leadsReport/channels.ts` после блока `SUMMARY_CHANNELS` и функции `normalize` добавить:

```ts
/**
 * Источники, которые сознательно НЕ считаются в отчёт продаж.
 *
 * `портал (outreachos)` — автоаутрич с портала. За неделю 31.07–07.08 это была
 * 21 сделка, треть всего недельного потока, и одна из них дошла до проведённой
 * встречи. Решение Дмитрия от 10.08.2026 — не считать: отчёт сравнивают с
 * ручным, где автоаутрича нет.
 *
 * Список нужен именно явный: без него источник просто не подходит ни под одно
 * правило и молча выпадает, что неотличимо от пробела в классификации — на
 * разбор этого «пробела» уже ушло два расследования (03.08 и 10.08).
 */
export const EXCLUDED_SOURCES = new Set(['портал (outreachos)']);
```

Внутри `detectSummaryChannel` перенести извлечение `source` наверх и добавить проверку до всех правил:

```ts
export function detectSummaryChannel(raw: unknown): SummaryChannelName | null {
  const source = normalize(extractCustomField(raw, 'Источник'));
  // Проверка идёт до «Контура»: решение «не считать» не должно обходиться
  // пометкой контура, поставленной вручную.
  if (EXCLUDED_SOURCES.has(source)) return null;

  const kontur = normalize(extractCustomField(raw, 'Контур'));
  if (kontur === 'маркетинг') return 'marketing';

  const utmMedium = normalize(extractCustomField(raw, 'utm_medium'));

  if (source === 'telegram outreach') return 'tg_outreach';
  if (['партнер', 'партнерка'].includes(source)) return 'partners';
  if (['email outreach', 'аутрич'].includes(source)) return 'outreach';
  // SMM: явное «SMM»/utm_medium=smm либо контент-канал «Личный бренд (инст/ютуб)»
  // (согласовано с Никитой 2026-07-24).
  if (
    ['smm', 'смм'].includes(source)
    || utmMedium === 'smm'
    || source === 'личный бренд (инст /ютуб)'
  ) return 'smm';

  return null;
}
```

Обновить и docstring функции: пункт 1 приоритета теперь «явно исключённые источники», далее «Контур», далее «Источник».

- [ ] **Step 4: Запустить тесты**

Run: `npx jest tests/lib/leadsReport/channels.test.ts`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/channels.ts app/tests/lib/leadsReport/channels.test.ts
git commit -m "feat(leads-report): автоаутрич явно вне отчёта, а не молча"
```

---

### Task 2: Чёрный список имён

**Files:**
- Create: `app/src/lib/leadsReport/leadFilters.ts`
- Test: `app/tests/lib/leadsReport/leadFilters.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/leadsReport/leadFilters.test.ts`:

```ts
import { isExcludedLeadName } from '@/lib/leadsReport/leadFilters';

describe('isExcludedLeadName', () => {
  it('ловит сотрудников, тестирующих бота, в любом написании', () => {
    expect(isExcludedLeadName('Бот: Юлия Миронова')).toBe(true);
    expect(isExcludedLeadName('бот: юлия миронова')).toBe(true);
    expect(isExcludedLeadName('Егор Каныгин')).toBe(true);
    expect(isExcludedLeadName('Бот: Саша')).toBe(true);
  });

  it('ловит тестовые заявки', () => {
    expect(isExcludedLeadName('Бот: ТЕСТ атрибуции 2026-07-23')).toBe(true);
    expect(isExcludedLeadName('Заявка: test-direct-site.polzaagency.ru')).toBe(true);
    expect(isExcludedLeadName('Заявка: test.ru')).toBe(true);
  });

  it('не ловит живых людей и компании по подстроке', () => {
    // «Саша» не должна поймать фамилию, «тест» — причастие.
    expect(isExcludedLeadName('Бот: Сашанина Ольга')).toBe(false);
    expect(isExcludedLeadName('Заявка: протестирован.рф')).toBe(false);
    expect(isExcludedLeadName('Бот: Александр')).toBe(false);
    expect(isExcludedLeadName('Дмитрий')).toBe(false);
    expect(isExcludedLeadName(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest tests/lib/leadsReport/leadFilters.test.ts`
Expected: FAIL — `Cannot find module '@/lib/leadsReport/leadFilters'`.

- [ ] **Step 3: Написать модуль**

Создать `app/src/lib/leadsReport/leadFilters.ts`:

```ts
/**
 * Текстовые фильтры сделок для отчёта продаж: чёрный список имён и
 * дедупликация лид-магнита.
 *
 * Живут отдельно от `metrics.ts` намеренно — тот уже отвечает за пороги
 * этапов, отчётное окно и запрос в БД. Здесь только чистые функции над
 * именами, без типов AMO и без Supabase.
 */

const normalizeName = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

/**
 * Имена, которые никогда не считаются в отчёт — ни в «Пришло», ни в «Лидов»,
 * ни во встречи, ни в одном канале.
 *
 * Это свои люди, тестирующие бота и форму заявки, плюс явные тестовые прогоны.
 * За неделю 31.07–07.08 «Бот: Юлия Миронова» дал две сделки в SMM, обе
 * засчитались лидами. Список согласован с Дмитрием 10.08.2026 и действует во
 * всех каналах: заявка сотрудника может прилететь и через лид-магнит в
 * Маркетинг, не только через SMM.
 *
 * «Егор Каныгин» в базе за три месяца не встречается ни разу. Строка оставлена
 * по просьбе продаж; если его заявки приходят под другим телеграм-именем,
 * нужно добавить именно то имя.
 */
export const EXCLUDED_LEAD_NAMES = [
  'Юлия Миронова',
  'Егор Каныгин',
  'Саша',
  'тест',
  'test',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Совпадение — по отдельному слову, а не по подстроке: иначе «Саша» поймала бы
 * «Сашанину», а «тест» — «протестирован». Границей считается всё, что не буква
 * и не цифра, поэтому `test.ru` и `test-direct-site` тоже ловятся.
 */
const EXCLUDED_NAME_PATTERN = new RegExp(
  `(^|[^\\p{L}\\p{N}])(${EXCLUDED_LEAD_NAMES.map(normalizeName)
    .map(escapeRegExp)
    .join('|')})([^\\p{L}\\p{N}]|$)`,
  'u',
);

export function isExcludedLeadName(name: string | null): boolean {
  return EXCLUDED_NAME_PATTERN.test(normalizeName(name));
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx jest tests/lib/leadsReport/leadFilters.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/leadFilters.ts app/tests/lib/leadsReport/leadFilters.test.ts
git commit -m "feat(leads-report): чёрный список имён сотрудников и тестовых заявок"
```

---

### Task 3: Дедупликация лид-магнита

**Files:**
- Modify: `app/src/lib/leadsReport/leadFilters.ts`
- Test: `app/tests/lib/leadsReport/leadFilters.test.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в `app/tests/lib/leadsReport/leadFilters.test.ts`:

```ts
import {
  dedupeLeadMagnets,
  isExcludedLeadName,
  isLeadMagnet,
} from '@/lib/leadsReport/leadFilters';

// ...существующий describe('isExcludedLeadName') остаётся выше...

describe('isLeadMagnet', () => {
  it('лид-магнит — это заявка бота по префиксу имени', () => {
    expect(isLeadMagnet('Бот: Third Child')).toBe(true);
    expect(isLeadMagnet('  Бот: Third Child')).toBe(true);
    expect(isLeadMagnet('Заявка: onelabgames.ru')).toBe(false);
    expect(isLeadMagnet(null)).toBe(false);
  });
});

describe('dedupeLeadMagnets', () => {
  const candidate = (
    amoId: number,
    name: string,
    peak: number,
    channel = 'smm',
    createdAt = '2026-08-03T10:00:00.000Z',
  ) => ({ amoId, name, peak, channel, createdAt });

  it('из двух заявок бота с одним именем оставляет дошедшую дальше', () => {
    const result = dedupeLeadMagnets([
      candidate(34518579, 'Бот: Aleksei Brazhnikov', 30),
      candidate(34518593, 'Бот: Aleksei Brazhnikov', 70),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([34518593]);
  });

  it('при равном этапе оставляет самую раннюю заявку', () => {
    const result = dedupeLeadMagnets([
      candidate(34550051, 'Бот: Михаил Маркетолог', 20, 'marketing', '2026-08-05T08:38:39.000Z'),
      candidate(34549993, 'Бот: Михаил Маркетолог', 20, 'marketing', '2026-08-05T08:35:06.000Z'),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([34549993]);
  });

  it('не трогает не-лид-магниты: два разных «Дмитрия» остаются двумя', () => {
    const result = dedupeLeadMagnets([
      candidate(34510495, 'Дмитрий', 30, 'outreach'),
      candidate(34512057, 'Дмитрий', 80, 'outreach'),
    ]);

    expect(result).toHaveLength(2);
  });

  it('дедуп идёт внутри канала: одно имя в разных каналах — разные заявки', () => {
    const result = dedupeLeadMagnets([
      candidate(1, 'Бот: Евгения', 30, 'marketing'),
      candidate(2, 'Бот: Евгения', 30, 'smm'),
    ]);

    expect(result).toHaveLength(2);
  });

  it('сохраняет исходный порядок оставшихся заявок', () => {
    const result = dedupeLeadMagnets([
      candidate(10, 'Бот: Первый', 30),
      candidate(20, 'Бот: Дубль', 30),
      candidate(30, 'Бот: Дубль', 30),
      candidate(40, 'Бот: Третий', 30),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([10, 20, 40]);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest tests/lib/leadsReport/leadFilters.test.ts`
Expected: FAIL — `dedupeLeadMagnets is not a function`.

- [ ] **Step 3: Дописать модуль**

Добавить в конец `app/src/lib/leadsReport/leadFilters.ts`:

```ts
/**
 * Признак «лид-магнит»: сделка автоматически создана TG-ботом «Polza Site
 * Feedback» — имя всегда с префиксом «Бот:» (см. Telegram-канал заявок).
 */
export const LEAD_MAGNET_NAME_PREFIX = 'Бот:';

export function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith(LEAD_MAGNET_NAME_PREFIX);
}

export type DedupCandidate = {
  amoId: number;
  name: string | null;
  /** Максимальный достигнутый этап — считается в `metrics.ts`. */
  peak: number;
  channel: string;
  createdAt: string | null;
};

/**
 * Схлопывает повторные заявки лид-магнита: одно имя внутри одного канала за
 * отчётное окно — одна сделка.
 *
 * Только лид-магнит. У заявок бота имя — это телеграм-аккаунт, совпадение
 * означает того же человека, ткнувшего бота дважды (за неделю 24.07 таких было
 * 11). У остальных сделок имя не гарантирует ничего: в Аутриче за неделю
 * 31.07–07.08 было два разных «Дмитрия», а под именем «Заявка с сайта» за
 * неделю 19.06 сидели 27 разных компаний. Дедуп по всем именам съел бы живые
 * лиды.
 *
 * Из группы остаётся сделка с наибольшим `peak`; при равенстве — самая ранняя
 * по `createdAt`; при равенстве — с меньшим `amoId`. Последнее нужно, чтобы
 * результат не зависел от порядка строк, в котором их отдала БД.
 */
export function dedupeLeadMagnets<T extends DedupCandidate>(candidates: T[]): T[] {
  const winnerByKey = new Map<string, T>();

  for (const candidate of candidates) {
    if (!isLeadMagnet(candidate.name)) continue;
    const key = `${candidate.channel} ${normalizeName(candidate.name)}`;
    const current = winnerByKey.get(key);
    if (!current || isBetterCandidate(candidate, current)) {
      winnerByKey.set(key, candidate);
    }
  }

  const winners = new Set(winnerByKey.values());
  return candidates.filter(
    (candidate) => !isLeadMagnet(candidate.name) || winners.has(candidate),
  );
}

function isBetterCandidate(candidate: DedupCandidate, current: DedupCandidate): boolean {
  if (candidate.peak !== current.peak) return candidate.peak > current.peak;

  const candidateTime = Date.parse(candidate.createdAt ?? '');
  const currentTime = Date.parse(current.createdAt ?? '');
  const candidateValid = Number.isFinite(candidateTime);
  const currentValid = Number.isFinite(currentTime);
  if (candidateValid && currentValid && candidateTime !== currentTime) {
    return candidateTime < currentTime;
  }
  if (candidateValid !== currentValid) return candidateValid;

  return candidate.amoId < current.amoId;
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx jest tests/lib/leadsReport/leadFilters.test.ts`
Expected: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/leadFilters.ts app/tests/lib/leadsReport/leadFilters.test.ts
git commit -m "feat(leads-report): дедуп повторных заявок лид-магнита"
```

---

### Task 4: Метрики по максимально достигнутому этапу

Самая крупная задача: меняется сигнатура `computeMetricsFromRows`, поэтому все существующие тесты файла правятся в одном шаге.

**Files:**
- Modify: `app/src/lib/leadsReport/metrics.ts`
- Test: `app/tests/lib/leadsReport/metrics.test.ts`

- [ ] **Step 1: Обновить фикстуры существующих тестов под новую сигнатуру**

В `app/tests/lib/leadsReport/metrics.test.ts` заменить импорт, массив `statuses` и хелпер `lead` на:

```ts
import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import {
  computeMetricsFromRows,
  type AmoLeadMetricRow,
  type AmoStatusEventRow,
  type AmoStatusMetricRow,
} from '@/lib/leadsReport/metrics';

const statuses: AmoStatusMetricRow[] = [
  { pipeline_id: 1, status_id: 10, status_name: 'Новый лид', sort: 10 },
  {
    pipeline_id: 1,
    status_id: 20,
    status_name: 'Квалифицированный лид',
    sort: 30,
  },
  {
    pipeline_id: 1,
    status_id: 30,
    status_name: 'Назначена встреча',
    sort: 40,
  },
  { pipeline_id: 1, status_id: 35, status_name: 'Не вышел на звонок', sort: 50 },
  {
    pipeline_id: 1,
    status_id: 40,
    status_name: 'Встреча проведена + КП отправлено',
    sort: 60,
  },
  { pipeline_id: 1, status_id: 50, status_name: 'Перенос', sort: 70 },
  { pipeline_id: 1, status_id: 142, status_name: 'Успешно', sort: 10000 },
  { pipeline_id: 1, status_id: 143, status_name: 'Закрыто', sort: 11000 },
];

let nextAmoId = 1;

function lead(
  fields: Record<string, string>,
  statusId: number,
  statusName: string,
  opts: { name?: string | null; amoId?: number; createdAt?: string } = {},
): AmoLeadMetricRow {
  return {
    amo_id: opts.amoId ?? nextAmoId++,
    pipeline_id: 1,
    status_id: statusId,
    status_name: statusName,
    name: opts.name ?? 'Сделка',
    created_at: opts.createdAt ?? '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    raw: {
      custom_fields_values: Object.entries(fields).map(
        ([field_name, value]) => ({
          field_name,
          values: [{ value }],
        }),
      ),
    },
  };
}

/** Переход этапа: `to` — куда перешли, `from` — откуда. */
function move(
  amoId: number,
  from: number,
  to: number,
  changedAt: string,
): AmoStatusEventRow {
  return {
    amo_deal_id: amoId,
    changed_at: changedAt,
    from_value: String(from),
    to_value: String(to),
  };
}

const WINDOW_START = new Date('2026-07-19T21:00:00.000Z');
const WINDOW_END = new Date('2026-07-24T15:00:00.000Z');
```

Затем в каждом из четырёх существующих вызовов `computeMetricsFromRows` добавить четвёртым аргументом пустой массив событий `[]`, а границы окна заменить на константы. Например первый вызов становится:

```ts
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Маркетинг — только по явному маркеру «Контур»=«Маркетинг».
        lead({ Контур: 'Маркетинг' }, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Сайт', utm_medium: 'smm' }, 30, 'Назначена встреча'),
        lead({ Источник: 'Аутрич' }, 40, 'Встреча проведена + КП отправлено'),
        lead({ Источник: 'Партнер' }, 142, 'Успешно'),
        lead({ Источник: 'Telegram Outreach' }, 143, 'Закрыто'),
      ],
      [],
      WINDOW_START,
      WINDOW_END,
    );
```

Ожидаемые значения в этих четырёх тестах менять НЕ нужно: без событий `peak` равен `sort` этапа создания, что для них совпадает с прежним поведением по текущему этапу.

- [ ] **Step 2: Написать падающие тесты на новое правило**

Дописать в конец `describe('computeMetricsFromRows')`:

```ts
  it('«Перенос» после встречи встречу сохраняет', () => {
    const deal = lead({ Источник: 'Аутрич' }, 50, 'Перенос', { amoId: 900 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(900, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(900, 30, 40, '2026-07-22T09:00:00.000Z'),
        move(900, 40, 50, '2026-07-23T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 1,
      meetingsHeld: 1,
      meetingsScheduled: 0,
    });
  });

  it('«Перенос» без встречи встречу не придумывает', () => {
    // Реальный кейс недели 31.07–07.08: «Бот: Aleksei Brazhnikov», путь
    // «Новый лид → Первый контакт → Перенос». Старое правило считало
    // проведённой встречей, потому что «Перенос» лежит ниже по воронке.
    const deal = lead({ Источник: 'Аутрич' }, 50, 'Перенос', { amoId: 901 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [move(901, 10, 50, '2026-07-22T09:00:00.000Z')],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 0,
      meetingsHeld: 0,
      meetingsScheduled: 0,
    });
  });

  it('назначенная и потом закрытая встреча не пропадает', () => {
    // Кейс «@chapurina_volna»: назначили встречу, откатили, закрыли.
    const deal = lead({ Источник: 'Telegram Outreach' }, 143, 'Закрыто', { amoId: 902 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(902, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(902, 30, 10, '2026-07-21T14:00:00.000Z'),
        move(902, 10, 143, '2026-07-22T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'tg_outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 1,
      meetingsHeld: 0,
      meetingsScheduled: 1,
    });
  });

  it('«Не вышел на звонок» считается запланированной встречей', () => {
    const deal = lead({ Источник: 'Партнер' }, 35, 'Не вышел на звонок', { amoId: 903 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(903, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(903, 30, 35, '2026-07-22T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'partners')).toMatchObject({
      qualifiedLeads: 1,
      meetingsHeld: 0,
      meetingsScheduled: 1,
    });
  });

  it('карточка, созданная сразу на «Встреча проведена», встречу сохраняет', () => {
    // Менеджер завёл карточку уже после встречи, переходов нет вовсе.
    const deal = lead({ Источник: 'Аутрич' }, 40, 'Встреча проведена + КП отправлено', {
      amoId: 904,
    });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      qualifiedLeads: 1,
      meetingsHeld: 1,
    });
  });

  it('переход после конца окна в расчёт не входит', () => {
    // Кейс «@igorhappy»: «Назначена встреча» через три дня после отчёта.
    const deal = lead({ Источник: 'Telegram Outreach' }, 30, 'Назначена встреча', {
      amoId: 905,
    });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(905, 10, 20, '2026-07-21T09:00:00.000Z'),
        move(905, 20, 30, '2026-07-27T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'tg_outreach')).toMatchObject({
      qualifiedLeads: 1,
      meetingsScheduled: 0,
      meetingsHeld: 0,
    });
  });
```

- [ ] **Step 3: Запустить и убедиться, что новые тесты падают**

Run: `npx jest tests/lib/leadsReport/metrics.test.ts`
Expected: FAIL. Первым делом упадёт компиляция типа — `AmoStatusEventRow` не экспортируется и `computeMetricsFromRows` принимает 5 аргументов, а не 6.

- [ ] **Step 4: Переписать расчёт в `metrics.ts`**

В `app/src/lib/leadsReport/metrics.ts`:

Заменить блок констант и импортов в начале файла на:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import {
  detectSummaryChannel,
  type ChannelSummaryConfig,
} from '@/lib/leadsReport/channels';
import {
  dedupeLeadMagnets,
  isExcludedLeadName,
  isLeadMagnet,
  type DedupCandidate,
} from '@/lib/leadsReport/leadFilters';

const DEFAULT_PIPELINE_NAME = 'Воронка - новые лиды';
const QUALIFIED_STATUS = 'Квалифицированный лид';
const MEETING_SCHEDULED_STATUS = 'Назначена встреча';
const MEETING_HELD_STATUS = 'Встреча проведена + КП отправлено';
const PARKING_STATUS = 'Перенос';
const WON_STATUS_ID = 142;
const LOST_STATUS_ID = 143;

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
```

Локальные `LEAD_MAGNET_NAME_PREFIX` и `isLeadMagnet` из файла удалить — они переехали в `leadFilters.ts`. Константу `WON_LOST` тоже удалить, она больше не нужна.

Обновить типы:

```ts
export type AmoStatusMetricRow = {
  pipeline_id: number;
  status_id: number;
  status_name: string;
  sort: number;
};

export type AmoLeadMetricRow = {
  amo_id: number;
  pipeline_id: number | null;
  status_id: number | null;
  status_name: string | null;
  name: string | null;
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
};

/** Переход этапа из `amo_events` (`event_type = 'lead_status_changed'`). */
export type AmoStatusEventRow = {
  amo_deal_id: number;
  changed_at: string;
  from_value: string | null;
  to_value: string | null;
};
```

Расширить `Thresholds` и `buildThresholds`:

```ts
type Thresholds = {
  pipelineId: number;
  qualifiedSort: number;
  meetingScheduledSort: number;
  meetingHeldSort: number;
  sortByStatusId: Map<number, number>;
  /**
   * Статусы, которые НЕ считаются достигнутым этапом воронки.
   *
   * «Успешно» и «Закрыто» — потому что их sort (10000/11000) это признак
   * закрытия, а не позиция. «Перенос» — потому что это парковка: карточку
   * кладут туда с любого этапа, а лежит она в воронке выше «Встречи
   * проведённой». Без этого исключения правило «максимум за неделю» само себя
   * ломает и все придуманные встречи возвращаются.
   */
  ignoredForPeak: Set<number>;
};

function findStatus(
  statuses: AmoStatusMetricRow[],
  name: string,
): AmoStatusMetricRow {
  const found = statuses.find(
    (status) => normalize(status.status_name) === normalize(name),
  );
  if (!found) throw new Error(`AMO status not found: ${name}`);
  return found;
}

function buildThresholds(statuses: AmoStatusMetricRow[]): Thresholds {
  const qualified = findStatus(statuses, QUALIFIED_STATUS);
  const meetingScheduled = findStatus(statuses, MEETING_SCHEDULED_STATUS);
  const meetingHeld = findStatus(statuses, MEETING_HELD_STATUS);
  const parking = findStatus(statuses, PARKING_STATUS);

  const pipelineIds = new Set(
    [qualified, meetingScheduled, meetingHeld, parking].map(
      (status) => status.pipeline_id,
    ),
  );
  if (pipelineIds.size > 1) {
    throw new Error('AMO report statuses belong to different pipelines');
  }

  return {
    pipelineId: qualified.pipeline_id,
    qualifiedSort: qualified.sort,
    meetingScheduledSort: meetingScheduled.sort,
    meetingHeldSort: meetingHeld.sort,
    sortByStatusId: new Map(
      statuses
        .filter((status) => status.pipeline_id === qualified.pipeline_id)
        .map((status) => [status.status_id, status.sort]),
    ),
    ignoredForPeak: new Set([WON_STATUS_ID, LOST_STATUS_ID, parking.status_id]),
  };
}
```

Добавить расчёт `peak` перед `computeMetricsFromRows`:

```ts
/**
 * Самый дальний этап воронки, до которого сделка реально дошла к концу окна.
 *
 * Считается из двух источников:
 *   1. этап, на котором карточку создали — `from_value` самого раннего перехода,
 *      а если переходов нет вовсе, значит карточку с тех пор не двигали и это
 *      её текущий этап;
 *   2. все `to_value` переходов, случившихся ДО конца окна.
 *
 * Переходы после конца окна игнорируются: отчёт должен показывать состояние на
 * момент отправки, а не на момент пересчёта. Иначе сделка, у которой встречу
 * назначили через три дня после отчёта, задним числом попадала бы в него.
 */
function computePeak(
  lead: AmoLeadMetricRow,
  events: AmoStatusEventRow[],
  thresholds: Thresholds,
  end: Date,
): number {
  const sortOf = (statusId: number | null): number => {
    if (statusId === null || thresholds.ignoredForPeak.has(statusId)) return 0;
    return thresholds.sortByStatusId.get(statusId) ?? 0;
  };

  const sorted = [...events].sort(
    (a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at),
  );
  const creationStatusId = sorted.length > 0
    ? toStatusId(sorted[0].from_value)
    : lead.status_id;

  let peak = sortOf(creationStatusId);
  for (const event of sorted) {
    const changedAt = Date.parse(event.changed_at);
    if (!Number.isFinite(changedAt) || changedAt >= end.getTime()) continue;
    peak = Math.max(peak, sortOf(toStatusId(event.to_value)));
  }
  return peak;
}

function toStatusId(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
```

Заменить тело `computeMetricsFromRows` целиком на:

```ts
/** Чистая часть расчёта — используется тестами и DB-оркестратором. */
export function computeMetricsFromRows(
  channels: ChannelSummaryConfig[],
  statuses: AmoStatusMetricRow[],
  leads: AmoLeadMetricRow[],
  statusEvents: AmoStatusEventRow[],
  start: Date,
  end: Date,
): ChannelMetrics[] {
  const thresholds = buildThresholds(statuses);
  const metrics = new Map(
    channels.map((channel) => [
      channel.name,
      {
        channel,
        arrived: 0,
        qualifiedLeads: 0,
        meetingsScheduled: 0,
        meetingsHeld: 0,
      },
    ]),
  );

  const eventsByDeal = new Map<number, AmoStatusEventRow[]>();
  for (const event of statusEvents) {
    const bucket = eventsByDeal.get(event.amo_deal_id);
    if (bucket) bucket.push(event);
    else eventsByDeal.set(event.amo_deal_id, [event]);
  }

  type PreparedLead = DedupCandidate & {
    statusId: number | null;
  };

  // `identity` — кастомное поле AMO «Telegram Chat ID», точный признак «тот
  // же человек» для заявок бота. Заполнено примерно у половины из них; где
  // пусто, `dedupeLeadMagnets` откатывается на имя. Без него под именем
  // «Бот: Георгий» схлопнулись бы три разных телеграм-аккаунта.
  const TELEGRAM_CHAT_ID_FIELD = 'Telegram Chat ID';

  const prepared: PreparedLead[] = [];
  for (const lead of leads) {
    if (lead.pipeline_id !== thresholds.pipelineId) continue;
    const channel = detectSummaryChannel(lead.raw);
    if (!channel || !metrics.has(channel)) continue;

    // Все метрики считаются ТОЛЬКО по сделкам, ПРИШЕДШИМ на этой неделе
    // (created_at в окне). Старые backlog-сделки с активностью на этой неделе
    // не считаются: иначе массовые обновления полей раздуют цифры и они станут
    // несопоставимы с прошлыми отчётами продаж (Егор, 2026-07-24; подтверждено
    // Дмитрием 10.08.2026).
    if (!isInWindow(lead.created_at, start, end)) continue;

    // Свои люди, тестирующие бота и форму, не считаются нигде и ни в одном
    // канале — см. EXCLUDED_LEAD_NAMES.
    if (isExcludedLeadName(lead.name)) continue;

    prepared.push({
      amoId: lead.amo_id,
      name: lead.name,
      identity: extractCustomField(lead.raw, TELEGRAM_CHAT_ID_FIELD),
      channel,
      createdAt: lead.created_at,
      statusId: lead.status_id,
      peak: computePeak(
        lead,
        eventsByDeal.get(lead.amo_id) ?? [],
        thresholds,
        end,
      ),
    });
  }

  for (const item of dedupeLeadMagnets(prepared)) {
    const bucket = metrics.get(item.channel as ChannelSummaryConfig['name']);
    if (!bucket) continue;

    // Лидом считается сделка, дошедшая до «Квалифицированный лид» или дальше.
    // Успешно закрытая — лид всегда: до «Успешно» иначе не доходят.
    const qualified =
      item.peak >= thresholds.qualifiedSort || item.statusId === WON_STATUS_ID;

    // Лид-магниты («Бот:...») попадают в «Пришло» только когда прошли
    // квалификацию — иначе они раздувают воронку, ведь бот создаёт много
    // слабых заявок «через магнит» (см. Егор, 2026-07-24).
    if (!isLeadMagnet(item.name) || qualified) {
      bucket.arrived += 1;
    }

    if (qualified) {
      bucket.qualifiedLeads += 1;
    }

    if (item.peak >= thresholds.meetingHeldSort) {
      bucket.meetingsHeld += 1;
    } else if (item.peak >= thresholds.meetingScheduledSort) {
      // Встреча запланирована — дошли до «Назначена встреча», но не до
      // проведённой. Сюда же попадает «Не вышел на звонок»: встречу назначали,
      // клиент не пришёл.
      bucket.meetingsScheduled += 1;
    }
  }

  return channels.map((channel) => {
    const value = metrics.get(channel.name);
    if (!value) throw new Error(`Metrics bucket missing: ${channel.name}`);
    return value;
  });
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npx jest tests/lib/leadsReport/metrics.test.ts`
Expected: PASS, 10 тестов (4 прежних + 6 новых).

- [ ] **Step 6: Коммит**

```bash
git add app/src/lib/leadsReport/metrics.ts app/tests/lib/leadsReport/metrics.test.ts
git commit -m "feat(leads-report): метрики по максимально достигнутому этапу, а не по текущему"
```

---

### Task 5: Догрузка истории переходов из БД

`computeAllChannelMetrics` пока не передаёт события — после Task 4 он не компилируется.

**Files:**
- Modify: `app/src/lib/leadsReport/metrics.ts:186-227` (функция `computeAllChannelMetrics`)
- Test: `app/tests/lib/leadsReport/metrics.test.ts`

- [ ] **Step 1: Написать падающий тест**

Сначала добавить `computeAllChannelMetrics` в существующий импорт из
`@/lib/leadsReport/metrics` в начале файла — отдельным `import` дублировать
модуль не нужно:

```ts
import {
  computeAllChannelMetrics,
  computeMetricsFromRows,
  type AmoLeadMetricRow,
  type AmoStatusEventRow,
  type AmoStatusMetricRow,
} from '@/lib/leadsReport/metrics';
```

Затем дописать в `app/tests/lib/leadsReport/metrics.test.ts` новый
верхнеуровневый `describe` (после существующего):

```ts
describe('computeAllChannelMetrics', () => {
  function fakeDb(calls: Array<{ table: string; filters: Record<string, unknown> }>) {
    return {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        calls.push({ table, filters });
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters[`eq:${column}`] = value;
            return builder;
          },
          gte: (column: string, value: unknown) => {
            filters[`gte:${column}`] = value;
            return builder;
          },
          lt: (column: string, value: unknown) => {
            filters[`lt:${column}`] = value;
            return builder;
          },
          in: (column: string, value: unknown) => {
            filters[`in:${column}`] = value;
            return builder;
          },
          then: (resolve: (result: unknown) => unknown) =>
            resolve({ data: dataFor(table), error: null }),
        };
        return builder;
      },
    };
  }

  function dataFor(table: string) {
    if (table === 'amo_statuses') return statuses;
    if (table === 'amo_leads') {
      return [
        lead({ Источник: 'Аутрич' }, 50, 'Перенос', {
          amoId: 700,
          createdAt: '2026-07-21T10:00:00.000Z',
        }),
      ];
    }
    return [move(700, 10, 50, '2026-07-22T09:00:00.000Z')];
  }

  it('тянет историю переходов и считает по ней, а не по текущему этапу', async () => {
    const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const result = await computeAllChannelMetrics(
      fakeDb(calls) as never,
      SUMMARY_CHANNELS,
      WINDOW_START,
      WINDOW_END,
    );

    expect(calls.map((call) => call.table)).toEqual([
      'amo_statuses',
      'amo_leads',
      'amo_events',
    ]);
    const eventsCall = calls[2];
    expect(eventsCall.filters['eq:event_type']).toBe('lead_status_changed');
    expect(eventsCall.filters['in:amo_deal_id']).toEqual([700]);
    // Окно по времени режет `computePeak`, а не запрос. Фильтр `.lt` здесь был
    // бы багом: у сделки, созданной в пятницу вечером и сдвинутой в
    // понедельник, ВСЯ история лежит после конца окна. Запрос вернул бы ноль
    // строк, `computePeak` откатился бы на текущий этап карточки — и понедельничная
    // встреча попала бы в пятничный отчёт задним числом.
    expect(eventsCall.filters['lt:changed_at']).toBeUndefined();

    // Сделка в «Переносе», встречи не было — «Было» должно остаться нулём.
    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      meetingsHeld: 0,
    });
  });
});
```

Заглушка намеренно игнорирует фильтры и отдаёт данные по имени таблицы:
проверяем не SQL, а что события вообще запрашиваются с правильными условиями и
доезжают до расчёта. Переменную `LEADS_REPORT_PIPELINE_NAME` трогать не нужно —
заглушка отдаёт фикстуру `statuses` независимо от имени воронки, а глобальный
`process.env` в тестах лучше не мутировать.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `npx jest tests/lib/leadsReport/metrics.test.ts -t "тянет историю"`
Expected: FAIL — в `computeAllChannelMetrics` таблица `amo_events` не запрашивается, массив `calls` содержит только два элемента.

- [ ] **Step 3: Дописать выборку событий**

Заменить `computeAllChannelMetrics` в `app/src/lib/leadsReport/metrics.ts` на:

```ts
export async function computeAllChannelMetrics(
  db: SupabaseClient,
  channels: ChannelSummaryConfig[],
  start: Date,
  end: Date,
): Promise<ChannelMetrics[]> {
  const pipelineName =
    process.env.LEADS_REPORT_PIPELINE_NAME ?? DEFAULT_PIPELINE_NAME;

  const { data: statusesData, error: statusesError } = await db
    .from('amo_statuses')
    .select('pipeline_id, status_id, status_name, sort')
    .eq('pipeline_name', pipelineName);
  if (statusesError) throw statusesError;

  const statuses = (statusesData ?? []) as AmoStatusMetricRow[];
  const thresholds = buildThresholds(statuses);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const { data: leadsData, error: leadsError } = await db
    .from('amo_leads')
    .select(
      'amo_id, pipeline_id, status_id, status_name, name, created_at, updated_at, raw',
    )
    .eq('pipeline_id', thresholds.pipelineId)
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (leadsError) throw leadsError;

  const leads = (leadsData ?? []) as AmoLeadMetricRow[];

  // История переходов нужна, чтобы считать метрики по максимально достигнутому
  // этапу, а не по текущему этапу карточки. Тянем чанками по `IN_CHUNK_SIZE` —
  // тот же приём, что в `firstSales/meetings.ts`: у PostgREST есть предел длины
  // URL. Сделок в окне порядка семидесяти, так что чанк обычно один.
  //
  // Фильтра по `changed_at` здесь намеренно НЕТ, и это не забывчивость. Окно
  // режет `computePeak`, потому что этап создания берётся из `from_value`
  // самого раннего перехода — а у заявки, созданной в пятницу вечером и
  // впервые сдвинутой в понедельник, ВСЯ история лежит после конца окна.
  // Запрос с фильтром вернул бы ноль строк, `computePeak` откатился бы на
  // текущий этап карточки, и понедельничная встреча попала бы в пятничный
  // отчёт задним числом.
  const dealIds = [...new Set(leads.map((lead) => lead.amo_id))];
  const eventChunks = await Promise.all(
    chunkArray(dealIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data, error } = await db
        .from('amo_events')
        .select('amo_deal_id, changed_at, from_value, to_value')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (error) throw error;
      return (data ?? []) as AmoStatusEventRow[];
    }),
  );

  return computeMetricsFromRows(
    channels,
    statuses,
    leads,
    eventChunks.flat(),
    start,
    end,
  );
}
```

- [ ] **Step 4: Запустить весь набор тестов отчёта**

Run: `npx jest tests/lib/leadsReport`
Expected: PASS. 10 suites (добавился `leadFilters.test.ts`), 71+ тестов.

- [ ] **Step 5: Проверить типы и линт**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

Run: `npm run lint`
Expected: без новых ошибок в изменённых файлах.

- [ ] **Step 6: Проверить, что воркер собирается**

Сигнатура `computeMetricsFromRows` изменилась, а `leadsReportSummaryCron.ts` зовёт `computeAllChannelMetrics` — его правки не требуют, но сборку проверить нужно.

Run: `npm run build:workers 2>&1 | tail -5`
Expected: без ошибок, в выводе есть `dist/workers/leadsReportSummaryCron.js`.

- [ ] **Step 7: Коммит**

```bash
git add app/src/lib/leadsReport/metrics.ts app/tests/lib/leadsReport/metrics.test.ts
git commit -m "feat(leads-report): догрузка истории переходов amo_events для расчёта метрик"
```

---

### Task 6: Сверка с боевыми данными

Тесты проверяют правила, но не то, что правила дают ожидаемые цифры на реальной неделе. Спека предсказывает конкретный результат — его надо подтвердить.

**Files:** ничего не меняется, только проверка.

- [ ] **Step 1: Пересчитать неделю 31.07–07.08 на боевых данных**

Через read-only доступ к прод-БД (`portal-db` MCP) выполнить расчёт по новым правилам за окно `2026-07-31 14:01:00+00` → `2026-08-07 14:01:00+00` и сверить с таблицей из спеки:

| Канал | Ожидается (Пришло / Лидов / Было / Запланировано) |
|---|---|
| Маркетинг | 4 / 3 / 1 / 0 |
| SMM | 2 / 1 / 1 / 0 |
| Аутрич | 9 / 4 / 3 / 1 |
| Партнёрка | 2 / 2 / 1 / 1 |
| TG Outreach | 6 / 1 / 0 / 1 |

- [ ] **Step 2: Если цифры разошлись — разобраться до коммита**

Расхождение означает либо баг в реализации, либо неточность в спеке. Найти конкретную сделку, из-за которой разошлось, и объяснить. Молча подгонять ожидания под результат нельзя.

- [ ] **Step 3: Отчитаться пользователю**

Сообщить ветку, SHA коммитов, результат прогона тестов и таблицу сверки. Мержем и выкатом занимается пользователь — см. `AGENTS.md`, раздел про границы релиза.

---

## Что осталось за рамками плана

* Матчер записей встреч к сделкам (не читает `#номер` из подписи, теряет треть записей) — отдельная задача, дашборд первички. Детали в разделе «Вне scope» спеки.
* Непокрытые источники `холодная база`, `сарафан`, `тг-канал`, `seo` без пометки «Контур» — решение по ним не принималось.
