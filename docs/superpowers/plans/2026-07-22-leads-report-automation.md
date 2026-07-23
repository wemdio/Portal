# Leads Report Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Phase 1** — автозаполнение двух Google-таблиц (маркетинг + аутрич) новыми лидами из `amo_leads` раз в сутки. Максим и Нина выведены из процесса.
- **Phase 2** — пятничный TG-саммари по 5 каналам продаж в личку админам и подписчикам. Егор выведен из процесса.

**Architecture:**
- **Phase 1:** один Node-скрипт-крон (`leadsReportCron.ts`), запускаемый ежедневно в 05:30 UTC (8:30 МСК) через хостовый crontab. Читает `amo_leads` через Supabase JS client после ежедневного AMO-синка в 8:00 МСК. По двум конфигам (marketing + outreach) фильтрует сделки, собирает строки, дедуплицирует по `amo_id` и делает `append` через Google Sheets API.
- **Phase 2:** резидентный TG-бот-воркер (`leadsReportBot.ts`, long polling `getUpdates`) для команд `/start`/`/add`/`/remove`/`/list`/`/whoami` + пятничный крон (`leadsReportSummaryCron.ts`, 15:00 UTC = 18:00 МСК) — считает метрики по 5 каналам и шлёт форматированное сообщение всем админам + подписчикам.

Всё пишет статистику в `external_sync_runs`.

**Tech Stack:** TypeScript (strict), Node 20, `googleapis@^144`, `@supabase/supabase-js` (через существующий `requireSupabaseAdmin`), Jest 29, Postgres/Supabase, Telegram Bot API через `fetch` (без внешних либ). CI/CD — Semaphore, деплой контейнерами в существующий стек Portal.

**Спека:** `docs/superpowers/specs/2026-07-21-marketing-leads-report-automation-design.md`

**Порядок выполнения:** Tasks 1-12 (Phase 1) → выкатили, убедились что таблицы наполняются → Tasks 13-19 (Phase 2).

---

## Файловая структура

**Новые файлы:**
- `app/src/lib/googleSheets/auth.ts` — JWT-клиент из env
- `app/src/lib/googleSheets/writer.ts` — append/read по имени листа
- `app/src/lib/leadsReport/config.ts` — типы конфигов + два объекта (marketing, outreach)
- `app/src/lib/leadsReport/extractUtm.ts` — извлекатель UTM из `amo_leads.raw`
- `app/src/lib/leadsReport/platformMapper.ts` — правила «UTM → Площадка → Категория»
- `app/src/lib/leadsReport/rowBuilder.ts` — сборка строки по конфигу
- `app/src/lib/leadsReport/report.ts` — оркестратор (БД → строки → Sheet)
- `app/worker/leadsReportCron.ts` — one-shot cron entrypoint
- `app/tests/lib/leadsReport/extractUtm.test.ts`
- `app/tests/lib/leadsReport/platformMapper.test.ts`
- `app/tests/lib/leadsReport/rowBuilder.test.ts`
- `supabase/migrations/20260723_0001_leads_report_source.sql` — расширение check-constraint

**Правки:**
- `app/package.json` — добавить cron entry в скрипт `build:workers`
- `Dockerfile.worker` — добавить cron entry в esbuild list
- `docker-compose.prod.yml` — новый сервис `worker-leads-report`
- `.semaphore/select-deploy-targets.sh` — добавить в `ALL_WORKER_SERVICES`
- `.env` (на dev и prod) — новые переменные:
  - `LEADS_REPORT_MARKETING_SHEET_ID=1kKDO-vqpjqOIC9OQogwQrhxs1s1-eC_IBzrZqU9ZvUs`
  - `LEADS_REPORT_OUTREACH_SHEET_ID=14Kg75x91STU3RFLbVGf5WeNxpQUoBUth-Gm0fEVDRCU`
  - `AMO_BASE_URL_HOST=polzaagency.amocrm.ru` (для построения ссылок на сделку в AMO)
- Prod crontab на 139.60.162.12 — новая строка (шаг ручной, описан в Task 10)

---

## Задачи

### Task 1: Миграция — расширить check-constraint `external_sync_runs.source`

Логи прогонов пишем в существующую таблицу `external_sync_runs`. Её column `source` имеет check-constraint со списком разрешённых значений. Надо добавить два новых.

**Files:**
- Create: `supabase/migrations/20260723_0001_leads_report_source.sql`

- [ ] **Step 1: Создать миграцию**

Создать файл `supabase/migrations/20260723_0001_leads_report_source.sql` с содержимым:

```sql
-- Расширение check-constraint external_sync_runs.source двумя новыми источниками
-- для нового воркера leadsReportCron (см. docs/superpowers/plans/2026-07-22-leads-report-automation.md).
--
-- До: metrika, amo_leads, amo_events, bank_tochka, bank_tbank, attribution, amo_enrich.
-- После: + leads_report_marketing, leads_report_outreach.

alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika',
    'amo_leads',
    'amo_events',
    'bank_tochka',
    'bank_tbank',
    'attribution',
    'amo_enrich',
    'leads_report_marketing',
    'leads_report_outreach'
  ));
```

- [ ] **Step 2: Применить миграцию локально**

Run:
```bash
psql "$LOCAL_SUPABASE_DB_URL" -f supabase/migrations/20260723_0001_leads_report_source.sql
```
Expected: `ALTER TABLE` × 2, exit code 0.

- [ ] **Step 3: Проверить, что constraint обновился**

Run:
```bash
psql "$LOCAL_SUPABASE_DB_URL" -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'external_sync_runs_source_check';"
```
Expected: вывод содержит `leads_report_marketing` и `leads_report_outreach`.

- [ ] **Step 4: Коммит**

```bash
git add supabase/migrations/20260723_0001_leads_report_source.sql
git commit -m "feat(db): allow leads_report_marketing/outreach in external_sync_runs.source"
```

---

### Task 2: Google Sheets Auth helper

Достанем в отдельный модуль JWT-клиент от service account. Сейчас код inline в `app/src/app/api/reglament/import-google-doc/route.ts:62-88`, мы его вынесем и добавим scope для Sheets.

**Files:**
- Create: `app/src/lib/googleSheets/auth.ts`

- [ ] **Step 1: Создать модуль**

Создать файл `app/src/lib/googleSheets/auth.ts`:

```typescript
import { google, type sheets_v4 } from 'googleapis';

/**
 * JWT-клиент от Google service account. Env-переменные:
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL — email, кому шарим таблицы Editor-доступом.
 * - GOOGLE_PRIVATE_KEY — приватный ключ с "\n" вместо реальных переносов строк.
 * Scopes: readonly Drive + read/write Sheets.
 */
export function getSheetsClient(): sheets_v4.Sheets {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set',
    );
  }

  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });

  return google.sheets({ version: 'v4', auth });
}
```

- [ ] **Step 2: Убедиться, что сборка проходит**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0, никаких ошибок про новый файл.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/googleSheets/auth.ts
git commit -m "feat(sheets): extract Google Sheets JWT auth helper"
```

---

### Task 3: Google Sheets Writer — append + read + createTab

**Files:**
- Create: `app/src/lib/googleSheets/writer.ts`

- [ ] **Step 1: Реализовать writer**

Создать файл `app/src/lib/googleSheets/writer.ts`:

```typescript
import { getSheetsClient } from '@/lib/googleSheets/auth';

/** Читает значения одной колонки листа (A1-нотация без диапазона). */
export async function readColumn(
  spreadsheetId: string,
  sheetName: string,
  column: string, // 'A', 'B', ...
): Promise<string[]> {
  const sheets = getSheetsClient();
  const range = `${sheetName}!${column}:${column}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values ?? [];
  return rows.map((r) => (r[0] ?? '').toString());
}

/** Дописывает строки в конец листа. Каждая row — массив ячеек. */
export async function appendRows(
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows as (string | number | null)[][] },
  });
}

/** Возвращает true, если лист с таким именем уже существует. */
export async function sheetExists(
  spreadsheetId: string,
  sheetName: string,
): Promise<boolean> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === sheetName,
  );
}
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/googleSheets/writer.ts
git commit -m "feat(sheets): add appendRows/readColumn/sheetExists writer"
```

---

### Task 4: UTM Extractor + тесты (TDD)

Извлекаем UTM из `amo_leads.raw` — сначала из custom-полей, потом из текста примечания как fallback.

**Files:**
- Create: `app/src/lib/leadsReport/extractUtm.ts`
- Test: `app/tests/lib/leadsReport/extractUtm.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать файл `app/tests/lib/leadsReport/extractUtm.test.ts`:

```typescript
import { extractUtm } from '@/lib/leadsReport/extractUtm';

describe('extractUtm', () => {
  it('извлекает из custom_fields_values по field_name', () => {
    const raw = {
      custom_fields_values: [
        { field_name: 'utm_source', values: [{ value: 'yandex' }] },
        { field_name: 'utm_medium', values: [{ value: 'cpc' }] },
        { field_name: 'utm_campaign', values: [{ value: '119782678' }] },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'yandex',
      medium: 'cpc',
      campaign: '119782678',
      content: null,
      term: null,
    });
  });

  it('извлекает из текста комментария (fallback)', () => {
    const raw = {
      custom_fields_values: [
        {
          field_name: 'Комментарий',
          values: [
            {
              value:
                'Лид из бота\nutm_source: inst\nutm_medium: social\nutm_content: link_in_bio',
            },
          ],
        },
      ],
    };
    expect(extractUtm(raw)).toEqual({
      source: 'inst',
      medium: 'social',
      campaign: null,
      content: 'link_in_bio',
      term: null,
    });
  });

  it('возвращает all-null если UTM нигде нет', () => {
    expect(extractUtm({ custom_fields_values: [] })).toEqual({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      term: null,
    });
  });

  it('устойчив к null/undefined raw', () => {
    expect(extractUtm(null)).toEqual({
      source: null,
      medium: null,
      campaign: null,
      content: null,
      term: null,
    });
  });
});
```

- [ ] **Step 2: Прогнать тест — должен упасть**

Run: `cd app && npx jest tests/lib/leadsReport/extractUtm.test.ts`
Expected: FAIL — `Cannot find module '@/lib/leadsReport/extractUtm'`.

- [ ] **Step 3: Реализовать extractUtm**

Создать файл `app/src/lib/leadsReport/extractUtm.ts`:

```typescript
export type Utm = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
};

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
type UtmKey = (typeof UTM_KEYS)[number];

const empty = (): Utm => ({
  source: null,
  medium: null,
  campaign: null,
  content: null,
  term: null,
});

/** Извлекает UTM из raw jsonb сделки AMO.
 *  Порядок источников: custom-поля по имени → regex по тексту комментария/примечания.
 *  Все ключи lower-case, префикс "utm_" ищется опционально.
 */
export function extractUtm(raw: unknown): Utm {
  if (!raw || typeof raw !== 'object') return empty();
  const cf = (raw as { custom_fields_values?: unknown[] })
    .custom_fields_values;
  if (!Array.isArray(cf)) return empty();

  const result = empty();

  // Проход 1: custom-поля по имени
  for (const field of cf) {
    if (!field || typeof field !== 'object') continue;
    const name = String(
      (field as { field_name?: unknown }).field_name ?? '',
    ).toLowerCase();
    const values = (field as { values?: unknown[] }).values;
    const rawValue = Array.isArray(values)
      ? (values[0] as { value?: unknown } | undefined)?.value
      : undefined;
    const value = rawValue == null ? null : String(rawValue);
    if (!value) continue;

    for (const key of UTM_KEYS) {
      if (
        (name === `utm_${key}` || name === key) &&
        result[key] === null
      ) {
        result[key] = value;
      }
    }
  }

  // Проход 2: fallback regex по тексту комментариев
  if (UTM_KEYS.every((k) => result[k] === null)) {
    for (const field of cf) {
      const values = (field as { values?: unknown[] }).values;
      const text = Array.isArray(values)
        ? String(
            (values[0] as { value?: unknown } | undefined)?.value ?? '',
          )
        : '';
      if (!text) continue;
      for (const key of UTM_KEYS) {
        if (result[key] !== null) continue;
        const m = new RegExp(`utm_${key}\\s*[:=]\\s*(\\S+)`, 'i').exec(text);
        if (m) result[key] = m[1];
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Прогнать тест — должен пройти**

Run: `cd app && npx jest tests/lib/leadsReport/extractUtm.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/extractUtm.ts app/tests/lib/leadsReport/extractUtm.test.ts
git commit -m "feat(leadsReport): add UTM extractor with custom-field and text fallback"
```

---

### Task 5: Platform Mapper + тесты (TDD)

**Files:**
- Create: `app/src/lib/leadsReport/platformMapper.ts`
- Test: `app/tests/lib/leadsReport/platformMapper.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать файл `app/tests/lib/leadsReport/platformMapper.test.ts`:

```typescript
import {
  mapPlatform,
  mapCategory,
} from '@/lib/leadsReport/platformMapper';

describe('mapPlatform', () => {
  it('yandex + cpc → Я.Директ', () => {
    expect(
      mapPlatform({
        source: 'yandex',
        medium: 'cpc',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Я.Директ');
  });

  it('polzaagency / hh → HH', () => {
    expect(
      mapPlatform({
        source: 'polzaagency',
        medium: 'outreach',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('HH');
    expect(
      mapPlatform({
        source: 'hh',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('HH');
  });

  it('inst → Инстаграм', () => {
    expect(
      mapPlatform({
        source: 'inst',
        medium: 'social',
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Инстаграм');
  });

  it('vs / campaign contains vs → VS', () => {
    expect(
      mapPlatform({
        source: 'vs',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('VS');
    expect(
      mapPlatform({
        source: 'x',
        medium: null,
        campaign: 'summer_vs_2026',
        content: null,
        term: null,
      }),
    ).toBe('VS');
  });

  it('пустой source → Органика', () => {
    expect(
      mapPlatform({
        source: null,
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Органика');
  });

  it('неизвестный source → Другое (source)', () => {
    expect(
      mapPlatform({
        source: 'reddit',
        medium: null,
        campaign: null,
        content: null,
        term: null,
      }),
    ).toBe('Другое (reddit)');
  });
});

describe('mapCategory', () => {
  it.each([
    ['Я.Директ', 'Лиды Директ'],
    ['Инстаграм', 'Лиды Директ'],
    ['VK', 'Лиды Директ'],
    ['HH', 'Лиды копирайт'],
    ['Органика', 'Заявки органика'],
    ['VS', 'Лиды Директ'],
    ['Другое (reddit)', 'Заявки органика'],
  ])('%s → %s', (platform, expected) => {
    expect(mapCategory(platform)).toBe(expected);
  });
});
```

- [ ] **Step 2: Прогнать тест — должен упасть**

Run: `cd app && npx jest tests/lib/leadsReport/platformMapper.test.ts`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Реализовать mapper**

Создать файл `app/src/lib/leadsReport/platformMapper.ts`:

```typescript
import type { Utm } from '@/lib/leadsReport/extractUtm';

/** Классифицирует UTM в платформу для колонки D таблицы маркетинга. */
export function mapPlatform(utm: Utm): string {
  const source = (utm.source ?? '').toLowerCase();
  const medium = (utm.medium ?? '').toLowerCase();
  const campaign = (utm.campaign ?? '').toLowerCase();

  if (source === 'yandex' && medium === 'cpc') return 'Я.Директ';
  if (source === 'polzaagency' || source === 'hh') return 'HH';
  if (source === 'inst') return 'Инстаграм';
  if (source === 'vs' || campaign.includes('vs')) return 'VS';
  if (!source || source === 'organic') return 'Органика';
  return `Другое (${source})`;
}

/** Классифицирует площадку в категорию для колонки «источник для…». */
export function mapCategory(platform: string): string {
  if (['Я.Директ', 'Инстаграм', 'VK', 'VS'].includes(platform)) {
    return 'Лиды Директ';
  }
  if (platform === 'HH') return 'Лиды копирайт';
  if (platform === 'Органика') return 'Заявки органика';
  return 'Заявки органика';
}
```

- [ ] **Step 4: Прогнать тест — должен пройти**

Run: `cd app && npx jest tests/lib/leadsReport/platformMapper.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/platformMapper.ts app/tests/lib/leadsReport/platformMapper.test.ts
git commit -m "feat(leadsReport): add platform mapper (UTM → Площадка + Категория)"
```

---

### Task 6: Конфиг двух отчётов

**Files:**
- Create: `app/src/lib/leadsReport/config.ts`

- [ ] **Step 1: Написать конфиг**

Создать файл `app/src/lib/leadsReport/config.ts`:

```typescript
/** Спецификация одной колонки таблицы отчёта. */
export type ColumnSpec = {
  /** Заголовок колонки (для документации/логов, в Sheet не пишется). */
  header: string;
  /** Ключ данных из AmoLead (см. report.ts) — как извлечь значение. */
  key: string;
};

export type LeadsReportConfig = {
  name: 'marketing' | 'outreach';
  spreadsheetId: string;
  /** Имя вкладки, куда пишем поток лидов. */
  sheetName: string;
  /** Источник, который засчитывается как этот отчёт. Инвертирующий флаг — для маркетинга. */
  amoSourceFilter:
    | { equals: string }
    | { notEquals: string };
  /** Список колонок в порядке слева-направо. Последняя всегда `amo_id` (служебная, для дедупа). */
  columns: ColumnSpec[];
  /** Логический источник для external_sync_runs. */
  syncSource: 'leads_report_marketing' | 'leads_report_outreach';
};

const AMO_ID_COLUMN: ColumnSpec = { header: 'AMO id', key: 'amo_id_raw' };

export const marketingConfig: LeadsReportConfig = {
  name: 'marketing',
  spreadsheetId: process.env.LEADS_REPORT_MARKETING_SHEET_ID ?? '',
  sheetName: 'Лиды',
  amoSourceFilter: { notEquals: 'Email Outreach' },
  syncSource: 'leads_report_marketing',
  columns: [
    { header: 'Ссылка на лид в амо', key: 'amo_url' },
    { header: 'UTM', key: 'utm_block' },
    { header: 'Площадка', key: 'platform' },
    { header: 'Дата', key: 'created_at_short' },
    { header: 'Телефон', key: 'phone' },
    { header: 'email', key: 'email' },
    { header: 'Имя', key: 'name' },
    { header: 'Кто обрабатывает лид', key: 'responsible_name' },
    { header: 'источник для...', key: 'category' },
    AMO_ID_COLUMN,
  ],
};

export const outreachConfig: LeadsReportConfig = {
  name: 'outreach',
  spreadsheetId: process.env.LEADS_REPORT_OUTREACH_SHEET_ID ?? '',
  sheetName: 'Лиды',
  amoSourceFilter: { equals: 'Email Outreach' },
  syncSource: 'leads_report_outreach',
  columns: [
    { header: 'Имя', key: 'name' },
    { header: 'Контакт', key: 'phone' },
    { header: 'Email', key: 'email' },
    { header: 'Организация', key: 'company_name' },
    { header: 'Сайт', key: 'company_website' },
    { header: 'Дата передачи лида', key: 'created_at_short' },
    { header: 'Статус', key: 'status_name' },
    AMO_ID_COLUMN,
  ],
};

export const ALL_CONFIGS: LeadsReportConfig[] = [
  marketingConfig,
  outreachConfig,
];
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/leadsReport/config.ts
git commit -m "feat(leadsReport): add marketing+outreach configs with column specs"
```

---

### Task 7: Row Builder + тесты (TDD)

Строит массив ячеек по конфигу колонок из объекта `AmoLead`.

**Files:**
- Create: `app/src/lib/leadsReport/rowBuilder.ts`
- Test: `app/tests/lib/leadsReport/rowBuilder.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать файл `app/tests/lib/leadsReport/rowBuilder.test.ts`:

```typescript
import { buildRow, type AmoLead } from '@/lib/leadsReport/rowBuilder';
import { marketingConfig, outreachConfig } from '@/lib/leadsReport/config';

const baseLead: AmoLead = {
  amo_id: 12345,
  name: 'Иванов Иван',
  status_name: 'Первый контакт',
  contact_phone: '79001234567',
  contact_email: 'ivan@example.com',
  company_name: 'ООО Ромашка',
  company_website: 'romashka.ru',
  responsible_name: 'Софья',
  created_at: '2026-07-01T10:15:00Z',
  raw: {
    custom_fields_values: [
      { field_name: 'utm_source', values: [{ value: 'yandex' }] },
      { field_name: 'utm_medium', values: [{ value: 'cpc' }] },
    ],
  },
};

describe('buildRow', () => {
  it('маркетинг: заполняет все ожидаемые колонки', () => {
    const row = buildRow(baseLead, marketingConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      'https://polzaagency.amocrm.ru/leads/detail/12345',
      'UTM source: yandex\nUTM medium: cpc',
      'Я.Директ',
      '2026-07-01',
      '79001234567',
      'ivan@example.com',
      'Иванов Иван',
      'Софья',
      'Лиды Директ',
      '12345',
    ]);
  });

  it('аутрич: заполняет только свой набор колонок', () => {
    const outreachLead: AmoLead = { ...baseLead, status_name: 'Назначена встреча' };
    const row = buildRow(outreachLead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      'Иванов Иван',
      '79001234567',
      'ivan@example.com',
      'ООО Ромашка',
      'romashka.ru',
      '2026-07-01',
      'Назначена встреча',
      '12345',
    ]);
  });

  it('пустые поля пишет как пустая строка, не null', () => {
    const lead: AmoLead = { ...baseLead, contact_phone: null, contact_email: null };
    const row = buildRow(lead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row[1]).toBe('');
    expect(row[2]).toBe('');
  });
});
```

- [ ] **Step 2: Прогнать тест — должен упасть**

Run: `cd app && npx jest tests/lib/leadsReport/rowBuilder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализовать rowBuilder**

Создать файл `app/src/lib/leadsReport/rowBuilder.ts`:

```typescript
import { extractUtm } from '@/lib/leadsReport/extractUtm';
import {
  mapPlatform,
  mapCategory,
} from '@/lib/leadsReport/platformMapper';
import type { LeadsReportConfig } from '@/lib/leadsReport/config';

export type AmoLead = {
  amo_id: number;
  name: string | null;
  status_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  company_name: string | null;
  company_website: string | null;
  responsible_name: string | null;
  created_at: string | null; // ISO
  raw: unknown;
};

/** Форматирует UTM в многострочный текстовый блок (как у Максима сейчас). */
function formatUtmBlock(raw: unknown): string {
  const utm = extractUtm(raw);
  const lines: string[] = [];
  if (utm.source) lines.push(`UTM source: ${utm.source}`);
  if (utm.medium) lines.push(`UTM medium: ${utm.medium}`);
  if (utm.campaign) lines.push(`UTM campaign: ${utm.campaign}`);
  if (utm.content) lines.push(`UTM content: ${utm.content}`);
  if (utm.term) lines.push(`UTM term: ${utm.term}`);
  return lines.join('\n');
}

/** Собирает строку для листа по конфигу — массив ячеек в порядке колонок. */
export function buildRow(
  lead: AmoLead,
  config: LeadsReportConfig,
  amoHost: string,
): string[] {
  const utm = extractUtm(lead.raw);
  const platform = mapPlatform(utm);

  const values: Record<string, string> = {
    amo_url: `https://${amoHost}/leads/detail/${lead.amo_id}`,
    amo_id_raw: String(lead.amo_id),
    utm_block: formatUtmBlock(lead.raw),
    platform,
    category: mapCategory(platform),
    created_at_short: lead.created_at ? lead.created_at.slice(0, 10) : '',
    phone: lead.contact_phone ?? '',
    email: lead.contact_email ?? '',
    name: lead.name ?? '',
    responsible_name: lead.responsible_name ?? '',
    company_name: lead.company_name ?? '',
    company_website: lead.company_website ?? '',
    status_name: lead.status_name ?? '',
  };

  return config.columns.map((col) => values[col.key] ?? '');
}
```

- [ ] **Step 4: Прогнать тест — должен пройти**

Run: `cd app && npx jest tests/lib/leadsReport/rowBuilder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/leadsReport/rowBuilder.ts app/tests/lib/leadsReport/rowBuilder.test.ts
git commit -m "feat(leadsReport): add rowBuilder — cell array by config"
```

---

### Task 8: Report Orchestrator

Читает БД → фильтрует по конфигу → строит строки → пишет в Sheet, дедуплицирует по служебной колонке AMO id.

**Files:**
- Create: `app/src/lib/leadsReport/report.ts`

- [ ] **Step 1: Реализовать оркестратор**

Создать файл `app/src/lib/leadsReport/report.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { appendRows, readColumn } from '@/lib/googleSheets/writer';
import type { LeadsReportConfig } from '@/lib/leadsReport/config';
import { buildRow, type AmoLead } from '@/lib/leadsReport/rowBuilder';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

const SOURCE_FIELD_NAME = 'Источник';

export type ReportRunResult = {
  fetchedFromDb: number;
  matchedFilter: number;
  skippedDedup: number;
  appended: number;
};

/** Определяет колонку служебного `amo_id` (последняя колонка в конфиге). */
function amoIdColumnLetter(config: LeadsReportConfig): string {
  const index = config.columns.length - 1; // 0-based
  // Простое конвертирование 0→'A', 25→'Z'; больше 26 колонок нам не нужно.
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Проверяет соответствие сделки фильтру конфига по custom-полю «Источник». */
function matchesFilter(lead: AmoLead, config: LeadsReportConfig): boolean {
  const source = extractCustomField(lead.raw, SOURCE_FIELD_NAME) ?? '';
  const filter = config.amoSourceFilter;
  if ('equals' in filter) return source === filter.equals;
  return source !== filter.notEquals;
}

/**
 * Выполнить один прогон отчёта: читает свежие лиды из БД, фильтрует,
 * дедуплицирует по amo_id уже присутствующим в Sheet, аппендит новые.
 */
export async function runReport(
  db: SupabaseClient,
  config: LeadsReportConfig,
  opts: { sinceDays: number; amoHost: string },
): Promise<ReportRunResult> {
  if (!config.spreadsheetId) {
    throw new Error(`spreadsheetId is empty for config ${config.name}`);
  }

  // 1. Читаем сделки за последние N дней (окно синка + запас на back-fill правок)
  const since = new Date();
  since.setDate(since.getDate() - opts.sinceDays);

  const { data, error } = await db
    .from('amo_leads')
    .select(
      'amo_id, name, status_name, contact_phone, contact_email, company_name, company_website, responsible_name, created_at, raw',
    )
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;
  const leads = (data ?? []) as AmoLead[];

  // 2. Фильтр по «Источник»
  const matching = leads.filter((lead) => matchesFilter(lead, config));

  // 3. Дедуп по колонке AMO id в Sheet
  const existing = new Set(
    (await readColumn(config.spreadsheetId, config.sheetName, amoIdColumnLetter(config)))
      .map((v) => v.trim())
      .filter((v) => v && v !== 'AMO id'),
  );

  const fresh = matching.filter(
    (lead) => !existing.has(String(lead.amo_id)),
  );

  // 4. Собираем строки и аппендим
  const rows = fresh.map((lead) => buildRow(lead, config, opts.amoHost));
  await appendRows(config.spreadsheetId, config.sheetName, rows);

  return {
    fetchedFromDb: leads.length,
    matchedFilter: matching.length,
    skippedDedup: matching.length - fresh.length,
    appended: rows.length,
  };
}
```

- [ ] **Step 2: Создать вспомогательный `extractCustomField`**

Создать файл `app/src/lib/leadsReport/extractCustomField.ts`:

```typescript
/** Возвращает первое значение custom-поля AMO по имени. */
export function extractCustomField(
  raw: unknown,
  fieldName: string,
): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const cf = (raw as { custom_fields_values?: unknown[] })
    .custom_fields_values;
  if (!Array.isArray(cf)) return null;

  for (const field of cf) {
    if (!field || typeof field !== 'object') continue;
    if ((field as { field_name?: unknown }).field_name !== fieldName) continue;
    const values = (field as { values?: unknown[] }).values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const v = (values[0] as { value?: unknown }).value;
    return v == null ? null : String(v);
  }
  return null;
}
```

- [ ] **Step 3: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 4: Коммит**

```bash
git add app/src/lib/leadsReport/report.ts app/src/lib/leadsReport/extractCustomField.ts
git commit -m "feat(leadsReport): add report orchestrator + custom-field helper"
```

---

### Task 9: Cron Worker Entry Point

**Files:**
- Create: `app/worker/leadsReportCron.ts`

- [ ] **Step 1: Реализовать cron entry**

Создать файл `app/worker/leadsReportCron.ts`:

```typescript
/**
 * Ежедневный запуск (один прогон, потом exit) — заполняет две Google-таблицы
 * (маркетинг + аутрич) новыми лидами из amo_leads.
 *
 * Расписание задаётся в хостовом crontab на 139.60.162.12:
 *   30 5 * * * docker exec portal-worker-leads-report node dist/workers/leadsReportCron.js
 *
 * Спецификация: docs/superpowers/specs/2026-07-21-marketing-leads-report-automation-design.md
 * План: docs/superpowers/plans/2026-07-22-leads-report-automation.md
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { ALL_CONFIGS } from '@/lib/leadsReport/config';
import { runReport } from '@/lib/leadsReport/report';

const WORKER_ID = 'leads-report-cron';
const SINCE_DAYS = Number(process.env.LEADS_REPORT_SINCE_DAYS) || 30;
const AMO_HOST =
  process.env.AMO_BASE_URL_HOST ?? 'polzaagency.amocrm.ru';

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const db = requireSupabaseAdmin(log);
  log.info('starting', { since_days: SINCE_DAYS, amo_host: AMO_HOST });

  for (const config of ALL_CONFIGS) {
    const startedAt = new Date().toISOString();
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | null = null;
    let result: Awaited<ReturnType<typeof runReport>> | null = null;

    try {
      result = await runReport(db, config, {
        sinceDays: SINCE_DAYS,
        amoHost: AMO_HOST,
      });
      log.info('report done', { config: config.name, ...result });
    } catch (err) {
      status = 'error';
      errorMessage =
        err instanceof Error ? err.message : String(err);
      log.error('report failed', { config: config.name, error: errorMessage });
    }

    const { error: insertError } = await db.from('external_sync_runs').insert({
      source: config.syncSource,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      records_upserted: result?.appended ?? 0,
      error: errorMessage,
      meta: result
        ? {
            fetched_from_db: result.fetchedFromDb,
            matched_filter: result.matchedFilter,
            skipped_dedup: result.skippedDedup,
            spreadsheet_id: config.spreadsheetId,
          }
        : { spreadsheet_id: config.spreadsheetId },
    });
    if (insertError) {
      log.error('external_sync_runs insert failed', {
        message: insertError.message,
      });
    }
  }

  log.info('done');
}

main().catch((err) => {
  console.error('[leadsReportCron] fatal', err);
  process.exit(1);
});
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Локальный dry-run (только если в .env есть тестовые SHEET_ID + service account шареный)**

Run:
```bash
cd app && npx tsx worker/leadsReportCron.ts
```
Expected: логи `starting`, `report done` × 2, `done`. В обеих тестовых таблицах — новые строки. В таблице `external_sync_runs` — две записи `status='success'`.

Если service account ещё не расшарен — увидишь `report failed` с 403; это ожидаемо, тогда пропусти этот шаг до Task 10.

- [ ] **Step 4: Коммит**

```bash
git add app/worker/leadsReportCron.ts
git commit -m "feat(leadsReport): add cron entry point (one-shot)"
```

---

### Task 10: Сборка и деплой конфигурации

**Files:**
- Modify: `app/package.json` — расширить `build:workers`
- Modify: `Dockerfile.worker` — добавить cron entry в esbuild list
- Modify: `docker-compose.prod.yml` — новый сервис
- Modify: `.semaphore/select-deploy-targets.sh` — добавить в `ALL_WORKER_SERVICES`

- [ ] **Step 1: Расширить `build:workers` в package.json**

Открыть `app/package.json`, найти скрипт `build:workers` (строка 17). В список `esbuild worker/*.ts` (или явный перечень) добавить `worker/leadsReportCron.ts` — по образцу существующих. Если это единая команда с шаблоном — пропустить (шаблон уже подхватит новый файл).

Проверка:
```bash
cd app && npm run build:workers
ls dist/workers/leadsReportCron.js
```
Expected: файл существует.

- [ ] **Step 2: Добавить в Dockerfile.worker**

Открыть `Dockerfile.worker`, найти строку с `esbuild` (~строка 43), добавить `worker/leadsReportCron.ts` в список input-файлов, если он там явный. Если файлы указаны шаблоном — пропустить.

Проверка (локальная сборка образа):
```bash
docker build -f Dockerfile.worker -t portal-worker:test .
docker run --rm portal-worker:test ls dist/workers/leadsReportCron.js
```
Expected: файл найден.

- [ ] **Step 3: Новый сервис в docker-compose.prod.yml**

Открыть `docker-compose.prod.yml`, найти блок `worker-sales-ai-analysis` (~строки 466-491). Скопировать его как `worker-leads-report`, изменив:
- `container_name: portal-worker-leads-report`
- `command: ["true"]` или `sleep infinity` — задача одноразовая, контейнер должен просто ждать (запускается через `docker exec`).
- Добавить env-переменные:
  ```yaml
  LEADS_REPORT_MARKETING_SHEET_ID: ${LEADS_REPORT_MARKETING_SHEET_ID}
  LEADS_REPORT_OUTREACH_SHEET_ID: ${LEADS_REPORT_OUTREACH_SHEET_ID}
  LEADS_REPORT_SINCE_DAYS: ${LEADS_REPORT_SINCE_DAYS:-30}
  AMO_BASE_URL_HOST: ${AMO_BASE_URL_HOST:-polzaagency.amocrm.ru}
  GOOGLE_SERVICE_ACCOUNT_EMAIL: ${GOOGLE_SERVICE_ACCOUNT_EMAIL}
  GOOGLE_PRIVATE_KEY: ${GOOGLE_PRIVATE_KEY}
  ```
- Оставить `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` как у `worker-sales-ai-analysis`.

Валидация:
```bash
docker compose -f docker-compose.prod.yml config | grep -A 5 worker-leads-report
```
Expected: сервис виден, env-блок правильный.

- [ ] **Step 4: Semaphore `select-deploy-targets.sh`**

Открыть `.semaphore/select-deploy-targets.sh`, найти переменную `ALL_WORKER_SERVICES` (строка 6). Добавить `worker-leads-report` в список.

- [ ] **Step 5: Коммит правок сборки/деплоя**

```bash
git add app/package.json Dockerfile.worker docker-compose.prod.yml .semaphore/select-deploy-targets.sh
git commit -m "chore(leadsReport): wire cron worker into build, compose, and semaphore"
```

---

### Task 11: Env + доступ + prod crontab (ручные шаги)

Технической автоматизации у этих шагов нет — они выполняются людьми (пользователем и владельцами таблиц). План описывает что именно сделать.

**Files:** нет (внешние действия)

- [ ] **Step 1: Расшарить обе тестовые таблицы на service account**

Владелец таблиц открывает в Google Sheets:
- https://docs.google.com/spreadsheets/d/1kKDO-vqpjqOIC9OQogwQrhxs1s1-eC_IBzrZqU9ZvUs/
- https://docs.google.com/spreadsheets/d/14Kg75x91STU3RFLbVGf5WeNxpQUoBUth-Gm0fEVDRCU/

В каждой: «Настройки доступа» → добавить email из `GOOGLE_SERVICE_ACCOUNT_EMAIL` с ролью **Editor**. Снять галку «Уведомить».

Проверка (после Task 9 dry-run): в env-переменной `LEADS_REPORT_MARKETING_SHEET_ID` = ID первой, `LEADS_REPORT_OUTREACH_SHEET_ID` = ID второй. Запустить `npx tsx app/worker/leadsReportCron.ts` — не должно быть 403.

- [ ] **Step 2: Прописать env на prod**

На сервере 139.60.162.12 в файле `.env` рядом с `docker-compose.prod.yml` добавить:
```
LEADS_REPORT_MARKETING_SHEET_ID=1kKDO-vqpjqOIC9OQogwQrhxs1s1-eC_IBzrZqU9ZvUs
LEADS_REPORT_OUTREACH_SHEET_ID=14Kg75x91STU3RFLbVGf5WeNxpQUoBUth-Gm0fEVDRCU
LEADS_REPORT_SINCE_DAYS=30
AMO_BASE_URL_HOST=polzaagency.amocrm.ru
```

- [ ] **Step 3: Крон на prod**

На сервере 139.60.162.12 добавить в root crontab (`crontab -e`):
```
30 5 * * * docker exec portal-worker-leads-report node dist/workers/leadsReportCron.js >> /var/log/leads-report-cron.log 2>&1
```
Это 05:30 UTC = 08:30 МСК, через 30 минут после ежедневного AMO-синка (08:00 МСК).

- [ ] **Step 4: Первый ручной прогон на prod**

После деплоя, до первого cron-запуска:
```bash
docker exec portal-worker-leads-report node dist/workers/leadsReportCron.js
```
Проверить:
- В обеих тестовых таблицах появились свежие лиды за 30 дней.
- В таблице `external_sync_runs` две записи со `status='success'`.
- Максим и Нина смотрят и подтверждают, что данные корректные.

---

### Task 12: Прогон полного набора тестов

**Files:** нет

- [ ] **Step 1: Запустить весь Jest**

Run: `cd app && npm test`
Expected: PASS всех тестов, включая новые `extractUtm`, `platformMapper`, `rowBuilder`.

- [ ] **Step 2: TypeCheck всего проекта**

Run: `cd app && npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Финальный коммит-маркер (если что-то поправили)**

Если тесты/typecheck что-то нашли и вы исправляли — отдельный commit с фиксами.

---

## Приложение: Диаграмма зависимостей модулей

```
Phase 1 — наполнение Sheets:
worker/leadsReportCron.ts
    │
    ├─── lib/leadsReport/report.ts
    │       ├─── lib/leadsReport/rowBuilder.ts
    │       │       ├─── lib/leadsReport/extractUtm.ts
    │       │       ├─── lib/leadsReport/platformMapper.ts
    │       │       └─── lib/leadsReport/config.ts
    │       ├─── lib/leadsReport/extractCustomField.ts
    │       └─── lib/googleSheets/writer.ts
    │               └─── lib/googleSheets/auth.ts
    │
    └─── worker/_shared.ts (существующий)

Phase 2 — TG-саммари:
worker/leadsReportBot.ts (резидентный, long polling)
    ├─── lib/tgBot/telegramClient.ts (fetch к api.telegram.org)
    └─── lib/leadsReport/subscribers.ts (CRUD подписчиков)

worker/leadsReportSummaryCron.ts (пятница 18:00 МСК)
    ├─── lib/leadsReport/summary.ts — оркестратор
    │       ├─── lib/leadsReport/channels.ts — 5 каналов с фильтрами
    │       ├─── lib/leadsReport/metrics.ts — SQL для (пришло / встреч было / запланировано)
    │       └─── lib/leadsReport/summaryFormatter.ts — формат сообщения
    ├─── lib/tgBot/telegramClient.ts
    └─── lib/leadsReport/subscribers.ts (читает получателей)
```

Каждый файл имеет одну ответственность и тестируется независимо (кроме `report.ts` и `summary.ts` — там интеграция).

---

# Phase 2 — Пятничный саммари в TG-бот

Начинаем только после того, как Phase 1 (Tasks 1-12) выкатан на прод и работает 2-3 дня без замечаний.

### Task 13: Миграция — таблица подписчиков + новый source

**Files:**
- Create: `supabase/migrations/20260724_0001_leads_report_subscribers.sql`

- [ ] **Step 1: Создать миграцию**

Создать файл `supabase/migrations/20260724_0001_leads_report_subscribers.sql`:

```sql
-- Таблица подписчиков TG-бота саммари (см. docs/superpowers/plans/2026-07-22-leads-report-automation.md).
-- Админы прописаны в env LEADS_REPORT_TG_ADMIN_IDS и получают саммари всегда,
-- в БД лежат только те, кого админы добавили командой /add.

create table if not exists public.leads_report_subscribers (
  chat_id      bigint primary key,
  username     text,
  first_name   text,
  added_by     bigint not null,           -- chat_id того, кто добавил
  added_at     timestamptz not null default now()
);

comment on table public.leads_report_subscribers is
  'Подписчики TG-бота с пятничным саммари продаж. Управляются командами /add /remove в @leads_report_bot.';

alter table public.leads_report_subscribers enable row level security;

drop policy if exists leads_report_subscribers_select_auth on public.leads_report_subscribers;
create policy leads_report_subscribers_select_auth on public.leads_report_subscribers
  for select using (auth.uid() is not null);

grant all on public.leads_report_subscribers to service_role, postgres;

-- Расширить check-constraint external_sync_runs.source новым источником для саммари-крона.
alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika','amo_leads','amo_events','bank_tochka','bank_tbank',
    'attribution','amo_enrich',
    'leads_report_marketing','leads_report_outreach',
    'leads_report_summary'
  ));
```

- [ ] **Step 2: Применить локально**

Run:
```bash
psql "$LOCAL_SUPABASE_DB_URL" -f supabase/migrations/20260724_0001_leads_report_subscribers.sql
psql "$LOCAL_SUPABASE_DB_URL" -c "\d leads_report_subscribers"
```
Expected: таблица создана с ожидаемыми колонками.

- [ ] **Step 3: Коммит**

```bash
git add supabase/migrations/20260724_0001_leads_report_subscribers.sql
git commit -m "feat(db): add leads_report_subscribers table + leads_report_summary source"
```

---

### Task 14: Telegram Bot Client (fetch helper)

Простая обёртка над Bot API. Без внешних библиотек — только `fetch`.

**Files:**
- Create: `app/src/lib/tgBot/telegramClient.ts`
- Test: `app/tests/lib/tgBot/telegramClient.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать файл `app/tests/lib/tgBot/telegramClient.test.ts`:

```typescript
import { escapeMarkdownV2 } from '@/lib/tgBot/telegramClient';

describe('escapeMarkdownV2', () => {
  it('экранирует все спецсимволы MarkdownV2', () => {
    expect(escapeMarkdownV2('Hello_world.test!')).toBe(
      'Hello\\_world\\.test\\!',
    );
  });

  it('пустая строка → пустая', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });

  it('не трогает обычные буквы и цифры', () => {
    expect(escapeMarkdownV2('abc 123')).toBe('abc 123');
  });
});
```

- [ ] **Step 2: Прогнать — упадёт**

Run: `cd app && npx jest tests/lib/tgBot/telegramClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализовать telegramClient**

Создать файл `app/src/lib/tgBot/telegramClient.ts`:

```typescript
const API_BASE = 'https://api.telegram.org';

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number };
    text?: string;
  };
};

export type SendMessageOptions = {
  chatId: number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML';
};

/** Экранирует спецсимволы MarkdownV2 (для безопасной вставки user-content в шаблон). */
export function escapeMarkdownV2(input: string): string {
  return input.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Вызов Bot API method с проверкой ошибок. */
async function callApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${API_BASE}/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await resp.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${json.description ?? 'unknown'}`,
    );
  }
  return json.result as T;
}

/** Long polling — получить обновления (25 сек ожидания). */
export async function getUpdates(
  token: string,
  offset: number,
): Promise<TelegramUpdate[]> {
  return await callApi<TelegramUpdate[]>(token, 'getUpdates', {
    offset,
    timeout: 25,
    allowed_updates: ['message'],
  });
}

/** Отправить сообщение в чат. */
export async function sendMessage(
  token: string,
  opts: SendMessageOptions,
): Promise<void> {
  await callApi(token, 'sendMessage', {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: opts.parseMode,
  });
}
```

- [ ] **Step 4: Прогнать тест — пройдёт**

Run: `cd app && npx jest tests/lib/tgBot/telegramClient.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 6: Коммит**

```bash
git add app/src/lib/tgBot/telegramClient.ts app/tests/lib/tgBot/telegramClient.test.ts
git commit -m "feat(tgBot): add Telegram Bot API client (fetch-based, no deps)"
```

---

### Task 15: Subscribers CRUD

**Files:**
- Create: `app/src/lib/leadsReport/subscribers.ts`

- [ ] **Step 1: Реализовать CRUD**

Создать файл `app/src/lib/leadsReport/subscribers.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export type Subscriber = {
  chat_id: number;
  username: string | null;
  first_name: string | null;
  added_by: number;
  added_at: string;
};

/** Список chat_id админов (из env `LEADS_REPORT_TG_ADMIN_IDS`, через запятую). */
export function getAdminIds(): number[] {
  const raw = process.env.LEADS_REPORT_TG_ADMIN_IDS ?? '';
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function isAdmin(chatId: number): boolean {
  return getAdminIds().includes(chatId);
}

export async function listSubscribers(
  db: SupabaseClient,
): Promise<Subscriber[]> {
  const { data, error } = await db
    .from('leads_report_subscribers')
    .select('*')
    .order('added_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Subscriber[];
}

export async function addSubscriber(
  db: SupabaseClient,
  chatId: number,
  addedBy: number,
  info: { username?: string; first_name?: string } = {},
): Promise<void> {
  const { error } = await db.from('leads_report_subscribers').upsert(
    {
      chat_id: chatId,
      username: info.username ?? null,
      first_name: info.first_name ?? null,
      added_by: addedBy,
    },
    { onConflict: 'chat_id' },
  );
  if (error) throw error;
}

export async function removeSubscriber(
  db: SupabaseClient,
  chatId: number,
): Promise<boolean> {
  const { error, count } = await db
    .from('leads_report_subscribers')
    .delete({ count: 'exact' })
    .eq('chat_id', chatId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Полный список получателей саммари: админы (из env) ∪ подписчики (из БД). Уникальный. */
export async function getAllRecipients(
  db: SupabaseClient,
): Promise<number[]> {
  const admins = getAdminIds();
  const subs = await listSubscribers(db);
  const all = new Set<number>([...admins, ...subs.map((s) => s.chat_id)]);
  return Array.from(all);
}
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Коммит**

```bash
git add app/src/lib/leadsReport/subscribers.ts
git commit -m "feat(leadsReport): add subscribers CRUD + admin resolver"
```

---

### Task 16: TG Bot Worker (long polling, команды)

Резидентный воркер, крутится в `pollLoop`. Обрабатывает `/start`, `/whoami`, `/add`, `/remove`, `/list`.

**Files:**
- Create: `app/worker/leadsReportBot.ts`

- [ ] **Step 1: Реализовать воркер**

Создать файл `app/worker/leadsReportBot.ts`:

```typescript
/**
 * TG-бот для управления подписчиками пятничного саммари.
 * Резидентный процесс, long polling через getUpdates.
 *
 * Команды:
 *   /start          — проверка доступа + приветствие
 *   /whoami         — показать свой chat_id + статус (admin/subscriber/none)
 *   /add <chat_id>  — только админ, добавить подписчика
 *   /remove <chat_id> — только админ, убрать подписчика
 *   /list           — только админ, показать всех получателей
 *
 * Env:
 *   LEADS_REPORT_TG_BOT_TOKEN
 *   LEADS_REPORT_TG_ADMIN_IDS (через запятую)
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
  setupGracefulShutdown,
} from './_shared';
import {
  getUpdates,
  sendMessage,
  type TelegramUpdate,
} from '@/lib/tgBot/telegramClient';
import {
  addSubscriber,
  getAllRecipients,
  isAdmin,
  listSubscribers,
  removeSubscriber,
} from '@/lib/leadsReport/subscribers';

const WORKER_ID = 'leads-report-bot';
const TOKEN = process.env.LEADS_REPORT_TG_BOT_TOKEN ?? '';

async function handleUpdate(
  db: ReturnType<typeof requireSupabaseAdmin>,
  update: TelegramUpdate,
  log: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text || !msg.from) return;

  const from = msg.from;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const [command, ...args] = text.split(/\s+/);

  log.info('cmd', { from: from.id, chat: chatId, command });

  const reply = (t: string) => sendMessage(TOKEN, { chatId, text: t });

  if (command === '/start') {
    const isAdm = isAdmin(from.id);
    const subs = await listSubscribers(db);
    const isSub = subs.some((s) => s.chat_id === from.id);
    if (isAdm) return reply('👋 Привет! Ты админ. Будешь получать пятничные саммари продаж.');
    if (isSub) return reply('👋 Привет! Ты в списке подписчиков. Будешь получать пятничные саммари продаж.');
    return reply(
      `👋 Нет доступа. Скинь свой chat_id админу для добавления:\n<code>${from.id}</code>`,
    );
  }

  if (command === '/whoami') {
    const isAdm = isAdmin(from.id);
    const subs = await listSubscribers(db);
    const isSub = subs.some((s) => s.chat_id === from.id);
    const role = isAdm ? 'admin' : isSub ? 'subscriber' : 'none';
    return reply(`Твой chat_id: ${from.id}\nСтатус: ${role}`);
  }

  if (command === '/add') {
    if (!isAdmin(from.id)) return reply('❌ Только админам.');
    const targetId = Number(args[0]);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply('Использование: /add <chat_id>');
    }
    await addSubscriber(db, targetId, from.id);
    return reply(`✅ Подписчик ${targetId} добавлен.`);
  }

  if (command === '/remove') {
    if (!isAdmin(from.id)) return reply('❌ Только админам.');
    const targetId = Number(args[0]);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply('Использование: /remove <chat_id>');
    }
    const removed = await removeSubscriber(db, targetId);
    return reply(removed ? `✅ Подписчик ${targetId} удалён.` : `⚠️ Не найден.`);
  }

  if (command === '/list') {
    if (!isAdmin(from.id)) return reply('❌ Только админам.');
    const recipients = await getAllRecipients(db);
    return reply(
      `Получатели саммари (всего ${recipients.length}):\n${recipients.join('\n')}`,
    );
  }

  // Неизвестная команда — молчим
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  if (!TOKEN) {
    log.error('LEADS_REPORT_TG_BOT_TOKEN not set, exiting');
    process.exit(1);
  }
  const db = requireSupabaseAdmin(log);
  const shutdown = setupGracefulShutdown(log);

  let offset = 0;
  log.info('bot started, entering long-polling loop');

  while (!shutdown.shouldStop()) {
    try {
      const updates = await getUpdates(TOKEN, offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(db, update, log);
        } catch (err) {
          log.error('handleUpdate failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('getUpdates failed, retrying in 5s', {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  log.info('bot stopped');
}

main().catch((err) => {
  console.error('[leadsReportBot] fatal', err);
  process.exit(1);
});
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Коммит**

```bash
git add app/worker/leadsReportBot.ts
git commit -m "feat(leadsReport): add TG bot worker (long-polling, /start /add /remove /list)"
```

---

### Task 17: Channels + Metrics + Summary Formatter

Три взаимосвязанных модуля.

**Files:**
- Create: `app/src/lib/leadsReport/channels.ts`
- Create: `app/src/lib/leadsReport/metrics.ts`
- Create: `app/src/lib/leadsReport/summaryFormatter.ts`
- Test: `app/tests/lib/leadsReport/summaryFormatter.test.ts`

- [ ] **Step 1: Реализовать channels.ts**

Создать файл `app/src/lib/leadsReport/channels.ts`:

```typescript
export type ChannelSummaryConfig = {
  name: 'marketing' | 'smm' | 'outreach' | 'partners' | 'tg_outreach';
  displayName: string;
  amoSourceFilter:
    | { equals: string }
    | { notIn: string[] };
};

export const SUMMARY_CHANNELS: ChannelSummaryConfig[] = [
  {
    name: 'marketing',
    displayName: 'Маркетинг',
    amoSourceFilter: {
      notIn: ['Email Outreach', 'Telegram Outreach', 'Партнёрка', 'SMM'],
    },
  },
  {
    name: 'smm',
    displayName: 'SMM',
    amoSourceFilter: { equals: 'SMM' },
  },
  {
    name: 'outreach',
    displayName: 'Аутрич',
    amoSourceFilter: { equals: 'Email Outreach' },
  },
  {
    name: 'partners',
    displayName: 'Партнёрка',
    amoSourceFilter: { equals: 'Партнёрка' },
  },
  {
    name: 'tg_outreach',
    displayName: 'TG Outreach',
    amoSourceFilter: { equals: 'Telegram Outreach' },
  },
];
```

- [ ] **Step 2: Реализовать metrics.ts**

Создать файл `app/src/lib/leadsReport/metrics.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';
import type { ChannelSummaryConfig } from '@/lib/leadsReport/channels';

const SOURCE_FIELD = 'Источник';
const MEETING_SCHEDULED_STATUS = 'Назначена встреча';
const MEETING_HELD_STATUS = 'Встреча проведена + КП отправлено';
const PIPELINE_ID = 7670334;
const WON_LOST = new Set([142, 143]);

export type ChannelMetrics = {
  channel: ChannelSummaryConfig;
  arrived: number;
  meetingsScheduled: number;
  meetingsHeld: number;
};

/** Проверка фильтра канала по значению «Источник» на конкретной сделке. */
function matches(source: string, filter: ChannelSummaryConfig['amoSourceFilter']): boolean {
  if ('equals' in filter) return source === filter.equals;
  return !filter.notIn.includes(source);
}

/**
 * Возвращает метрики за окно [weekStart, weekEnd) по всем 5 каналам.
 * Один SQL-запрос на amo_leads + один на amo_statuses, дальше — фильтры в памяти.
 * Простой и предсказуемый — данных мало (несколько сотен сделок в неделю).
 */
export async function computeAllChannelMetrics(
  db: SupabaseClient,
  channels: ChannelSummaryConfig[],
  weekStart: Date,
  weekEnd: Date,
): Promise<ChannelMetrics[]> {
  // 1. sort'ы этапов воронки — нужны для критерия «встреча была»
  const { data: statuses, error: sErr } = await db
    .from('amo_statuses')
    .select('status_id, status_name, sort')
    .eq('pipeline_id', PIPELINE_ID);
  if (sErr) throw sErr;

  const heldRow = (statuses ?? []).find((s) => s.status_name === MEETING_HELD_STATUS);
  const heldSort = heldRow?.sort ?? Infinity;
  const meetingHeldStatusIds = new Set(
    (statuses ?? [])
      .filter((s) => (s.sort ?? 0) >= heldSort && !WON_LOST.has(s.status_id))
      .map((s) => s.status_id),
  );

  // 2. одним махом достаём все сделки за неделю — и по created_at, и по updated_at
  //    (объединение — тогда получим суперсет и посчитаем всё в JS)
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  const { data: leads, error: lErr } = await db
    .from('amo_leads')
    .select('status_id, status_name, created_at, updated_at, raw')
    .or(
      `and(created_at.gte.${weekStartIso},created_at.lt.${weekEndIso}),and(updated_at.gte.${weekStartIso},updated_at.lt.${weekEndIso})`,
    );
  if (lErr) throw lErr;

  const results: ChannelMetrics[] = [];
  for (const channel of channels) {
    let arrived = 0;
    let meetingsScheduled = 0;
    let meetingsHeld = 0;

    for (const lead of leads ?? []) {
      const source = extractCustomField(lead.raw, SOURCE_FIELD) ?? '';
      if (!matches(source, channel.amoSourceFilter)) continue;

      const created = new Date(lead.created_at ?? 0);
      const updated = new Date(lead.updated_at ?? 0);
      const inWindow = (d: Date) => d >= weekStart && d < weekEnd;

      if (inWindow(created)) arrived += 1;
      if (
        inWindow(updated) &&
        lead.status_name === MEETING_SCHEDULED_STATUS
      ) {
        meetingsScheduled += 1;
      }
      if (
        inWindow(updated) &&
        typeof lead.status_id === 'number' &&
        meetingHeldStatusIds.has(lead.status_id)
      ) {
        meetingsHeld += 1;
      }
    }

    results.push({ channel, arrived, meetingsScheduled, meetingsHeld });
  }

  return results;
}
```

- [ ] **Step 3: Написать падающий тест для форматтера**

Создать файл `app/tests/lib/leadsReport/summaryFormatter.test.ts`:

```typescript
import { formatSummary } from '@/lib/leadsReport/summaryFormatter';
import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';

describe('formatSummary', () => {
  it('форматирует все 5 каналов по шаблону Егора', () => {
    const metrics = SUMMARY_CHANNELS.map((c, i) => ({
      channel: c,
      arrived: 10 + i,
      meetingsHeld: i,
      meetingsScheduled: i + 1,
    }));
    const text = formatSummary(
      new Date('2026-07-15T00:00:00Z'),
      new Date('2026-07-22T00:00:00Z'),
      metrics,
    );
    expect(text).toContain('📊 Отчёт продаж — неделя 15.07-21.07');
    expect(text).toContain('Маркетинг\nПришло — 10 | Встреч (Было/Запланировано) — 0/1');
    expect(text).toContain('TG Outreach\nПришло — 14 | Встреч (Было/Запланировано) — 4/5');
  });
});
```

- [ ] **Step 4: Прогнать — упадёт**

Run: `cd app && npx jest tests/lib/leadsReport/summaryFormatter.test.ts`
Expected: FAIL.

- [ ] **Step 5: Реализовать summaryFormatter.ts**

Создать файл `app/src/lib/leadsReport/summaryFormatter.ts`:

```typescript
import type { ChannelMetrics } from '@/lib/leadsReport/metrics';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function shortDate(d: Date): string {
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}`;
}

/** Формирует итоговое сообщение Егору. weekEnd — эксклюзивно (первый день следующей недели). */
export function formatSummary(
  weekStart: Date,
  weekEnd: Date,
  metrics: ChannelMetrics[],
): string {
  const inclusiveEnd = new Date(weekEnd);
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);

  const header = `📊 Отчёт продаж — неделя ${shortDate(weekStart)}-${shortDate(inclusiveEnd)}\n`;
  const sections = metrics.map(
    (m) =>
      `${m.channel.displayName}\nПришло — ${m.arrived} | Встреч (Было/Запланировано) — ${m.meetingsHeld}/${m.meetingsScheduled}`,
  );
  return [header, ...sections].join('\n');
}
```

- [ ] **Step 6: Прогнать — пройдёт**

Run: `cd app && npx jest tests/lib/leadsReport/summaryFormatter.test.ts`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add app/src/lib/leadsReport/channels.ts app/src/lib/leadsReport/metrics.ts app/src/lib/leadsReport/summaryFormatter.ts app/tests/lib/leadsReport/summaryFormatter.test.ts
git commit -m "feat(leadsReport): add 5-channel metrics + summary formatter"
```

---

### Task 18: Weekly Summary Cron Worker

**Files:**
- Create: `app/worker/leadsReportSummaryCron.ts`

- [ ] **Step 1: Реализовать оркестратор**

Создать файл `app/worker/leadsReportSummaryCron.ts`:

```typescript
/**
 * Пятничный саммари продаж — считает метрики по 5 каналам за прошедшую неделю
 * (пн-вс включительно) и шлёт единое сообщение всем получателям (админы + подписчики).
 *
 * Расписание: хостовый crontab на 139.60.162.12
 *   0 15 * * 5 docker exec portal-worker-leads-report-bot node dist/workers/leadsReportSummaryCron.js
 *   (пятница 15:00 UTC = 18:00 МСК)
 *
 * Env: LEADS_REPORT_TG_BOT_TOKEN, LEADS_REPORT_TG_ADMIN_IDS.
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
} from './_shared';
import { sendMessage } from '@/lib/tgBot/telegramClient';
import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import { computeAllChannelMetrics } from '@/lib/leadsReport/metrics';
import { formatSummary } from '@/lib/leadsReport/summaryFormatter';
import { getAllRecipients } from '@/lib/leadsReport/subscribers';

const WORKER_ID = 'leads-report-summary-cron';
const TOKEN = process.env.LEADS_REPORT_TG_BOT_TOKEN ?? '';

/** Возвращает [понедельник 00:00 UTC текущей недели, понедельник 00:00 UTC следующей). */
function currentIsoWeekBounds(now: Date): { start: Date; end: Date } {
  const day = now.getUTCDay(); // 0=вс, 1=пн, ...
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  if (!TOKEN) {
    log.error('LEADS_REPORT_TG_BOT_TOKEN not set, exiting');
    process.exit(1);
  }
  const db = requireSupabaseAdmin(log);

  const startedAt = new Date().toISOString();
  const { start, end } = currentIsoWeekBounds(new Date());
  log.info('computing metrics', { week_start: start.toISOString(), week_end: end.toISOString() });

  let status: 'success' | 'error' = 'success';
  let errorMessage: string | null = null;
  let recipientsSent = 0;
  let recipientsFailed = 0;

  try {
    const metrics = await computeAllChannelMetrics(db, SUMMARY_CHANNELS, start, end);
    const text = formatSummary(start, end, metrics);
    log.info('summary composed', { length: text.length });

    const recipients = await getAllRecipients(db);
    log.info('sending', { recipients: recipients.length });

    for (const chatId of recipients) {
      try {
        await sendMessage(TOKEN, { chatId, text });
        recipientsSent += 1;
      } catch (err) {
        recipientsFailed += 1;
        log.error('send failed', {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error('summary failed', { error: errorMessage });
  }

  await db.from('external_sync_runs').insert({
    source: 'leads_report_summary',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    records_upserted: recipientsSent,
    error: errorMessage,
    meta: {
      week_start: start.toISOString(),
      week_end: end.toISOString(),
      recipients_sent: recipientsSent,
      recipients_failed: recipientsFailed,
    },
  });

  log.info('done', { recipientsSent, recipientsFailed });
}

main().catch((err) => {
  console.error('[leadsReportSummaryCron] fatal', err);
  process.exit(1);
});
```

- [ ] **Step 2: Сборка**

Run: `cd app && npx tsc --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Коммит**

```bash
git add app/worker/leadsReportSummaryCron.ts
git commit -m "feat(leadsReport): add weekly summary cron (Fri 18:00 МСК)"
```

---

### Task 19: Сборка, деплой, ручные шаги для Phase 2

**Files:**
- Modify: `app/package.json` — добавить `leadsReportBot.ts` и `leadsReportSummaryCron.ts` в `build:workers`
- Modify: `Dockerfile.worker` — то же
- Modify: `docker-compose.prod.yml` — новый сервис `worker-leads-report-bot`
- Modify: `.semaphore/select-deploy-targets.sh` — добавить `worker-leads-report-bot`

- [ ] **Step 1: Расширить build:workers**

По аналогии с Task 10 Step 1 — добавить два новых файла в скрипт `build:workers`.

Проверка:
```bash
cd app && npm run build:workers
ls dist/workers/leadsReportBot.js dist/workers/leadsReportSummaryCron.js
```

- [ ] **Step 2: Dockerfile.worker**

Аналогично Task 10 Step 2.

- [ ] **Step 3: docker-compose.prod.yml — новый сервис**

Скопировать блок `worker-leads-report` (из Phase 1) как `worker-leads-report-bot`:
- `container_name: portal-worker-leads-report-bot`
- `command: ["node", "dist/workers/leadsReportBot.js"]` — резидентный бот, а не sleep infinity.
- Добавить env:
  ```yaml
  LEADS_REPORT_TG_BOT_TOKEN: ${LEADS_REPORT_TG_BOT_TOKEN}
  LEADS_REPORT_TG_ADMIN_IDS: ${LEADS_REPORT_TG_ADMIN_IDS}
  ```
- Оставить `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 4: Semaphore select-deploy-targets.sh**

Добавить `worker-leads-report-bot` в `ALL_WORKER_SERVICES`.

- [ ] **Step 5: Создать TG-бота через @BotFather**

Ручной шаг (пользователь):
1. Открыть @BotFather в Telegram.
2. `/newbot` → задать имя (например «Polza Sales Summary») и username (например `polza_sales_summary_bot`).
3. Получить токен вида `123456789:AAH...`.
4. Записать токен на прод-сервер в `.env`:
   ```
   LEADS_REPORT_TG_BOT_TOKEN=123456789:AAH...
   LEADS_REPORT_TG_ADMIN_IDS=833825243,475474557
   ```

- [ ] **Step 6: Crontab на prod для саммари**

На сервере 139.60.162.12 добавить в root crontab (`crontab -e`):
```
0 15 * * 5 docker exec portal-worker-leads-report-bot node dist/workers/leadsReportSummaryCron.js >> /var/log/leads-report-summary.log 2>&1
```
Пятница 15:00 UTC = 18:00 МСК.

- [ ] **Step 7: Первый ручной прогон + проверка**

После деплоя и настройки бота:

1. Оба админа (Дмитрий 833825243 и коллега 475474557) пишут боту `/start` — проверяют, что получают ответ «Ты админ, будешь получать саммари».
2. Один из админов запускает саммари вручную:
   ```bash
   docker exec portal-worker-leads-report-bot node dist/workers/leadsReportSummaryCron.js
   ```
3. Проверить: оба админа получили одинаковое сообщение с 5 секциями. В `external_sync_runs` — запись `leads_report_summary` со `status='success'`.

- [ ] **Step 8: Коммит правок сборки/деплоя**

```bash
git add app/package.json Dockerfile.worker docker-compose.prod.yml .semaphore/select-deploy-targets.sh
git commit -m "chore(leadsReport): wire TG bot + summary cron into build/deploy"
```
