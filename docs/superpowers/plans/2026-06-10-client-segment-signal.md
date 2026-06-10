# Client Segment Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить наполнение столбца «Клиенты» (хрупкий список брендов) на короткий LLM-вывод сегмента клиентов компании («стоматологии», «B2B-стройка»), используя только `gpt-4o-mini`.

**Architecture:** Новый extractor-ключ `client_segment` (лейбл колонки остаётся «Клиенты») с собственным extractor-модулем, который собирает текст страниц (главная + /about + /cases) и подписи логотипов (alt) и одним вызовом `gpt-4o-mini` через requesty-роутер возвращает 2-3 слова сегмента. Старая customers-ветка как источник столбца удаляется. Конфиг (UI/route/worker) полностью data-driven через `ExtractorKey`/`ALL_EXTRACTOR_KEYS`/`EXTRACTOR_LABELS`, поэтому ручных правок там нет — только `types.ts`.

**Tech Stack:** TypeScript, Next.js, cheerio, requesty LLM-роутер (`gpt-4o-mini`), Jest (`@jest-environment node`, мок через `global.fetch` и `jest.mock`).

**Spec:** `docs/superpowers/specs/2026-06-10-client-segment-signal-design.md`

---

## File Structure

- **Create** `app/src/lib/enrich/extractors/clientSegmentExtractor.ts` — единственный источник значения столбца. Собирает материал + один LLM-вызов. Экспорт: `extractClientSegment(mainHtml, aboutHtml?, casesHtml?): Promise<string>`.
- **Create** `app/tests/lib/extractors/clientSegmentExtractor.test.ts` — юнит-тест с моком `global.fetch`.
- **Modify** `app/src/lib/enrich/extractors/types.ts` — новый ключ/лейбл/подстраницы/поле; замена `customers`→`client_segment` в активных списках.
- **Modify** `app/src/lib/enrich/extractors/formatExtraValue.ts` — рендер `client_segment` (строка/DASH).
- **Modify** `app/tests/lib/extractors/formatExtraValue.test.ts` — кейсы для `client_segment`.
- **Modify** `app/src/lib/enrich/websiteSignalProcessor.ts` — удалить customers-ветку, добавить client_segment-ветку, почистить импорты.
- **Modify** `app/tests/lib/websiteSignalProcessor.test.ts` — замокать новый extractor, переписать customers-кейсы.
- **Delete** `app/src/lib/enrich/extractors/llmCustomersExtractor.ts` + `app/tests/lib/extractors/llmCustomersExtractor.test.ts` — мёртвый код после замены.
- **Modify** `app/src/components/DatabaseSpreadsheet.tsx` — миграция legacy-ключа `customers`→`client_segment` в пресетах из localStorage.

> **Не трогаем:** `customersExtractor.ts` (от `extractCustomers` зависит сигнал `enterprise_logos`), route.ts, worker, SignalEnrichmentModal.tsx — они data-driven и не хардкодят ключ.

---

## Task 1: types.ts — регистрация сигнала `client_segment`

**Files:**
- Modify: `app/src/lib/enrich/extractors/types.ts`

> Нет юнит-теста (чистая конфигурация) — проверяется компиляцией в Task 2+ и финальным `tsc`. `customers` НАМЕРЕННО остаётся в `ExtractorKey`, `EXTRACTOR_LABELS`, `EXTRACTOR_TO_SUBPAGES` (это `Record<ExtractorKey,…>` — TS требует все ключи union; плюс рендер старых данных), но убирается из активных списков (`ALL_EXTRACTOR_KEYS`, группы, пресеты).

- [ ] **Step 1: Добавить ключ в `ExtractorKey` union**

Найти в union (около строки 33-35):
```ts
  | 'profile'
  | 'customers'
  | 'cases_count'
```
Заменить на:
```ts
  | 'profile'
  | 'customers'        // legacy: не предлагается в UI, остаётся для рендера старых result_text
  | 'client_segment'   // наполняет столбец «Клиенты» сегментом ЦА (заменил список брендов)
  | 'cases_count'
```

- [ ] **Step 2: Убрать `customers` из `ALL_EXTRACTOR_KEYS`, добавить `client_segment`**

В массиве `ALL_EXTRACTOR_KEYS` (около строки 69):
```ts
  'customers',
  'cases_count',
```
Заменить на:
```ts
  'client_segment',
  'cases_count',
```

- [ ] **Step 3: `EXTRACTOR_TO_SUBPAGES` — оставить customers, добавить client_segment**

```ts
  customers: ['cases'],
  cases_count: ['cases'],
```
Заменить на:
```ts
  customers: ['cases'],
  client_segment: ['cases', 'about'],
  cases_count: ['cases'],
```

- [ ] **Step 4: `EXTRACTOR_LABELS` — оба ключа = «Клиенты»**

```ts
  customers: 'Клиенты',
  cases_count: 'Кол-во кейсов',
```
Заменить на:
```ts
  customers: 'Клиенты',
  client_segment: 'Клиенты',
  cases_count: 'Кол-во кейсов',
```

- [ ] **Step 5: `BUILTIN_PRESETS` — заменить `customers`→`client_segment` в `outreach` и `audit`**

В пресете `outreach.extractors` строку `'customers',` заменить на `'client_segment',`.
В пресете `audit.extractors` строку `'customers',` заменить на `'client_segment',`.
(`all` использует `[...ALL_EXTRACTOR_KEYS]` — обновится автоматически после Step 2.)

- [ ] **Step 6: `EXTRACTOR_GROUPS` — заменить в группе `customers`**

```ts
    extractors: ['customers', 'cases_count', 'case_industries', 'enterprise_logos'],
```
Заменить на:
```ts
    extractors: ['client_segment', 'cases_count', 'case_industries', 'enterprise_logos'],
```
(`id: 'customers'` группы НЕ меняем — это идентификатор аккордеона, на него завязан `openGroups` в модалке.)

- [ ] **Step 7: `ExtractedData` — добавить поле**

```ts
  customers?: string[];
  cases_count?: number;
```
Заменить на:
```ts
  customers?: string[];
  /** Сегмент клиентов компании («стоматологии», «B2B-стройка») — наполнение столбца «Клиенты». */
  client_segment?: string;
  cases_count?: number;
```

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/enrich/extractors/types.ts
git commit -m "feat(signals): register client_segment extractor key (replaces customers in UI)"
```

---

## Task 2: formatExtraValue — рендер `client_segment`

**Files:**
- Modify: `app/src/lib/enrich/extractors/formatExtraValue.ts`
- Test: `app/tests/lib/extractors/formatExtraValue.test.ts`

- [ ] **Step 1: Написать падающий тест**

В `formatExtraValue.test.ts` в массив ключей теста «renders undefined/null as DASH for every key» (около строки 11) добавить `'client_segment'`:
```ts
      'pricing_model', 'blog_last_post', 'stack', 'profile',
      'pricing_min', 'hiring_roles', 'client_segment',
```
И добавить новый тест после теста про text fields (около строки 93):
```ts
  it('renders client_segment as plain string; empty/whitespace → DASH', () => {
    expect(formatExtraValue('client_segment', 'стоматологии')).toBe('стоматологии');
    expect(formatExtraValue('client_segment', 'B2B-стройка')).toBe('B2B-стройка');
    expect(formatExtraValue('client_segment', '   ')).toBe('–');
    expect(formatExtraValue('client_segment', '')).toBe('–');
  });
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts -t client_segment`
Expected: FAIL — `formatExtraValue('client_segment', 'стоматологии')` возвращает `'–'` (ключ попадает в `default` ветку).

- [ ] **Step 3: Добавить ветку в `formatExtraValue`**

В `formatExtraValue.ts` найти текстовый блок (около строки 93):
```ts
    case 'blog_last_post':
    case 'stack':
    case 'profile':
      return typeof value === 'string' && value.trim().length > 0
        ? value
        : EMPTY_CELL_DASH;
```
Заменить на (добавить `case 'client_segment':`):
```ts
    case 'blog_last_post':
    case 'stack':
    case 'profile':
    case 'client_segment':
      return typeof value === 'string' && value.trim().length > 0
        ? value
        : EMPTY_CELL_DASH;
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts`
Expected: PASS (все кейсы, включая client_segment).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/extractors/formatExtraValue.ts app/tests/lib/extractors/formatExtraValue.test.ts
git commit -m "feat(signals): render client_segment cell as plain string"
```

---

## Task 3: clientSegmentExtractor — новый extractor

**Files:**
- Create: `app/src/lib/enrich/extractors/clientSegmentExtractor.ts`
- Test: `app/tests/lib/extractors/clientSegmentExtractor.test.ts`

- [ ] **Step 1: Написать падающий тест** (образец — `llmCustomersExtractor.test.ts`)

Создать `app/tests/lib/extractors/clientSegmentExtractor.test.ts`:
```ts
/**
 * @jest-environment node
 *
 * LLM-сигнал «Клиенты» (сегмент ЦА). Проверяем:
 *  1. Без API-ключа → '' (без сетевых вызовов).
 *  2. Пустой mainHtml → ''.
 *  3. Нет материала (короткий текст, нет alt) → '' без вызова LLM.
 *  4. Успех: модель вернула сегмент → нормализованная строка.
 *  5. Нормализация: кавычки/точка/длина срезаются.
 *  6. 429 / кривой JSON / throw / отсутствует поле → ''.
 *
 * fetch мокается на уровне global.fetch — не дёргаем requesty и не зависим от ключа.
 */

import { extractClientSegment } from '@/lib/enrich/extractors/clientSegmentExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}

function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function segmentResponse(segment: string) {
  return mockJsonResponse({
    choices: [{ message: { content: JSON.stringify({ segment }) } }],
  });
}

// Материал, гарантирующий hasMaterial=true: секция с logo-alt + длинный текст.
const HTML_WITH_CLIENTS = `
  <html><body>
    <section class="clients"><img alt="Стоматология Дента" /></section>
    <p>${'Мы делаем сайты и CRM для частных стоматологических клиник. '.repeat(8)}</p>
  </body></html>
`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-for-client-segment';
  delete process.env.OPENROUTER_BRIEF_API_KEY;
});

afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.OPENROUTER_SIGNALS_API_KEY;
  else process.env.OPENROUTER_SIGNALS_API_KEY = ORIG_KEY;
  if (ORIG_BRIEF === undefined) delete process.env.OPENROUTER_BRIEF_API_KEY;
  else process.env.OPENROUTER_BRIEF_API_KEY = ORIG_BRIEF;
  jest.clearAllMocks();
});

describe('extractClientSegment — early returns', () => {
  it('returns "" when no API key is configured (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return segmentResponse('стоматологии'); });
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('returns "" when mainHtml is empty', async () => {
    expect(await extractClientSegment('')).toBe('');
  });

  it('skips the LLM call when there is no alt AND text is too short', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...args) => { calls.push(args); return segmentResponse('x'); });
    const html = '<html><body><h1>Привет</h1><p>тут пусто</p></body></html>';
    expect(await extractClientSegment(html)).toBe('');
    expect(calls).toHaveLength(0);
  });
});

describe('extractClientSegment — successful path', () => {
  it('returns the model segment', async () => {
    withMockFetch(async () => segmentResponse('стоматологии'));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('стоматологии');
  });

  it('normalizes surrounding quotes, trailing dot and length', async () => {
    withMockFetch(async () => segmentResponse('  "B2B-стройка".  '));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('B2B-стройка');
  });

  it('returns "" when the model says it cannot tell', async () => {
    withMockFetch(async () => segmentResponse(''));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });
});

describe('extractClientSegment — error tolerance', () => {
  it('returns "" on non-2xx (429/5xx)', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" on malformed JSON content', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'not json {{' } }] }));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });

  it('returns "" when segment field is missing or not a string', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ other: 'x' }) } }] }));
    expect(await extractClientSegment(HTML_WITH_CLIENTS)).toBe('');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/clientSegmentExtractor.test.ts`
Expected: FAIL — `Cannot find module '@/lib/enrich/extractors/clientSegmentExtractor'`.

- [ ] **Step 3: Реализовать extractor**

Создать `app/src/lib/enrich/extractors/clientSegmentExtractor.ts`:
```ts
import 'server-only';
import * as cheerio from 'cheerio';

/**
 * LLM-источник столбца «Клиенты»: вместо списка брендов возвращает короткий
 * сегмент клиентов компании («стоматологии», «B2B-стройка»). Решение принимает
 * только модель — старого эвристического извлечения здесь нет.
 *
 * Вход модели: видимый текст /cases + /about + главной (релевантное вперёд) и
 * подписи логотипов клиентов (alt). Логотипы важны для b2b, где клиенты — это
 * стена логотипов, а не текст.
 *
 * Никогда не throw'ит: нет ключа / 429 / timeout / кривой JSON → ''.
 */

const MODEL = (process.env.OPENROUTER_CLIENT_SEGMENT_MODEL ?? 'openai/gpt-4o-mini').trim();
const TIMEOUT_MS = Number(process.env.LLM_CLIENT_SEGMENT_TIMEOUT_MS ?? '30000');
const MAX_TEXT_CHARS = 6000;
const MAX_ALT_CANDIDATES = 120;
const MAX_SEGMENT_LEN = 60;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

/** Видимый текст страницы: убираем неинформативные узлы, схлопываем пробелы. */
function pageText(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

/** Подписи логотипов: alt-атрибуты <img>, без пустых/слишком длинных. */
function logoAlts(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $('img[alt]').each((_, img) => {
    const alt = ($(img).attr('alt') ?? '').trim();
    if (!alt || alt.length < 2 || alt.length > 80) return;
    const key = alt.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(alt);
    if (out.length >= MAX_ALT_CANDIDATES) return false;
  });
  return out;
}

const SYSTEM_PROMPT = `Ты определяешь, КОГО обслуживает компания — её целевую аудиторию (сегмент клиентов) — по содержимому её сайта.

ВХОД: текст страниц (главная, «О компании», «Кейсы/Клиенты») и подписи к логотипам клиентов.

ЗАДАЧА: верни JSON {"segment": "..."} — короткую формулировку сегмента клиентов на русском, 2-3 слова: отрасль и/или тип клиентов.
Примеры хороших ответов: "стоматологии", "B2B-стройка", "интернет-магазины", "госзаказчики", "производственные предприятия", "рестораны и кафе", "застройщики".

ПРАВИЛА:
- Это сегмент КЛИЕНТОВ компании, а не описание самой компании и не её услуги.
- 2-3 слова, без точки в конце, на русском.
- Если по сайту понять нельзя — верни {"segment": ""}. Не выдумывай.
- Только JSON, без markdown и комментариев.`;

function buildUserMessage(
  mainHtml: string,
  aboutHtml?: string | null,
  casesHtml?: string | null,
): { message: string; hasMaterial: boolean } {
  const alts: string[] = [];
  const seen = new Set<string>();
  for (const a of [...logoAlts(casesHtml ?? ''), ...logoAlts(mainHtml), ...logoAlts(aboutHtml ?? '')]) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    alts.push(a);
    if (alts.length >= MAX_ALT_CANDIDATES) break;
  }

  const parts: string[] = [];
  const casesT = pageText(casesHtml ?? '');
  const aboutT = pageText(aboutHtml ?? '');
  const mainT = pageText(mainHtml);
  if (casesT) parts.push(`[КЕЙСЫ/КЛИЕНТЫ]\n${casesT}`);
  if (aboutT) parts.push(`[О КОМПАНИИ]\n${aboutT}`);
  if (mainT) parts.push(`[ГЛАВНАЯ]\n${mainT}`);
  let text = parts.join('\n\n');
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  const hasMaterial = alts.length > 0 || text.length >= 200;

  const userParts: string[] = [];
  if (alts.length > 0) userParts.push(`[ПОДПИСИ ЛОГОТИПОВ КЛИЕНТОВ]\n${alts.join(', ')}`);
  if (text) userParts.push(text);
  return { message: userParts.join('\n\n'), hasMaterial };
}

function normalizeSegment(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  s = s.replace(/^["'«»]+|["'«»]+$/g, '').trim(); // обрамляющие кавычки
  s = s.replace(/[.\s]+$/g, '').trim();           // концевая точка/пробелы
  if (s.length > MAX_SEGMENT_LEN) s = s.slice(0, MAX_SEGMENT_LEN).trim();
  return s;
}

export async function extractClientSegment(
  mainHtml: string,
  aboutHtml?: string | null,
  casesHtml?: string | null,
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey || !mainHtml) return '';

  const { message, hasMaterial } = buildUserMessage(mainHtml, aboutHtml, casesHtml);
  if (!hasMaterial) return '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Client Segment LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
      }),
    });
    clearTimeout(timer);

    if (!res.ok) return '';
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return '';

    let parsed: { segment?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return '';
    }
    return normalizeSegment(parsed.segment);
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run (из `app/`): `npx jest tests/lib/extractors/clientSegmentExtractor.test.ts`
Expected: PASS (все describe-блоки).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/extractors/clientSegmentExtractor.ts app/tests/lib/extractors/clientSegmentExtractor.test.ts
git commit -m "feat(signals): add clientSegmentExtractor (gpt-4o-mini, text + logo alts)"
```

---

## Task 4: Интеграция в websiteSignalProcessor + обновление его тестов

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`

- [ ] **Step 1: Обновить тест процессора (мок нового extractor + переписать customers-кейсы)**

В начало `websiteSignalProcessor.test.ts` после существующего `jest.mock('@/lib/enrich/websiteParser', …)` (строка 8) добавить мок нового extractor:
```ts
jest.mock('@/lib/enrich/extractors/clientSegmentExtractor', () => ({
  extractClientSegment: jest.fn().mockResolvedValue('тест-сегмент'),
}));
```

Заменить кейс «without extractors option …» (около строки 282) — проверку `result.customers` на `result.client_segment`:
```ts
    if ('stack' in result) {
      expect(result.client_segment).toBeUndefined();
      expect(result.pricing_model).toBeUndefined();
    }
```

Заменить кейс «with extractors=["customers"] — discovers /cases …» (строки ~305-322) целиком на (client_segment грузит И /cases, И /about → main + 2 подстраницы = 3 fetch):
```ts
  it('with extractors=["client_segment"] — discovers /cases + /about, fetches main + both', async () => {
    mockUrlResponses({
      'example.com/cases': '<section class="clients"><img alt="Сбербанк" /></section>',
      'example.com/about': '<p>О компании</p>',
      'example.com': '<html><body><a href="/cases">Кейсы</a><a href="/about">О нас</a><a href="/pricing">Цены</a></body></html>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['client_segment'] });

    const fetchedUrls = fetchHtmlWithRetryMock.mock.calls.map((c) => c[0] as string);
    expect(fetchedUrls.some((u) => u.includes('/cases'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('/about'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('/pricing'))).toBe(false);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.pricing_model).toBeUndefined();
    }
  });
```

Заменить кейс «with extractors=["customers","cases_count"] …» (строки ~324-348) на client_segment + cases_count (cases грузится один раз; about — один раз):
```ts
  it('with extractors=["client_segment","cases_count"] — fetches /cases only ONCE', async () => {
    mockUrlResponses({
      'example.com/cases': `
        <section class="clients"><img alt="Газпром" /></section>
        <article class="case-card">x</article>
        <article class="case-card">y</article>
      `,
      'example.com/about': '<p>О компании</p>',
      'example.com': '<a href="/cases">Cases</a><a href="/about">About</a>',
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['client_segment', 'cases_count'],
    });

    const casesFetches = fetchHtmlWithRetryMock.mock.calls.filter((c) => (c[0] as string).includes('/cases'));
    expect(casesFetches).toHaveLength(1);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.cases_count).toBe(2);
    }
  });
```

Заменить кейс «subpage 404 does not fail main result …» (строки ~350-362): убрать завязку на customers, проверять client_segment (мок всё равно вернёт значение — extractor сам толерантен к пустым подстраницам):
```ts
  it('subpage 404 does not fail main result — graceful degradation', async () => {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('/cases') || url.includes('/about')) return { html: '', status: 404 };
      return { html: '<a href="/cases">Cases</a><a href="/about">About</a>', status: 200 };
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['stack', 'client_segment'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
    }
  });
```

Заменить кейс «subpage timeout does not block other subpages» (строки ~364-392): `extractors: ['client_segment', 'pricing_model']`, убрать `expect(result.customers)`, добавить `expect(result.client_segment).toBe('тест-сегмент')`, оставить `pricing_model === 'self-serve'`. Можно убрать `}, 15000)` → обычный таймаут (LLM замокан).

В кейсе «full extractor set …» (строки ~394-441): в массиве `extractors` заменить `'customers',` на `'client_segment',`; убрать строку `expect(result.customers).toEqual(['Тинькофф']);`; добавить `expect(result.client_segment).toBe('тест-сегмент');`. (`enterprise_logos: true` остаётся — он считает клиентов через `extractCustomers(casesHtml)` напрямую, не через удалённую ветку.)

- [ ] **Step 2: Запустить тест — убедиться, что падает на нужном**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: FAIL — `client_segment` не заполняется (ветки ещё нет) / `customers` ещё импортируется как было. Это ожидаемо до Step 3.

- [ ] **Step 3: Обновить импорты в `websiteSignalProcessor.ts`**

Строка 11:
```ts
import { extractCustomers, filterCustomerCandidates } from '@/lib/enrich/extractors/customersExtractor';
```
Заменить на (filterCustomerCandidates больше не нужен — он жил только в customers-ветке):
```ts
import { extractCustomers } from '@/lib/enrich/extractors/customersExtractor';
```

Строку 13 удалить полностью:
```ts
import { llmExtractCustomers } from '@/lib/enrich/extractors/llmCustomersExtractor';
```

После импорта `extractCustomers` (строка 11) добавить:
```ts
import { extractClientSegment } from '@/lib/enrich/extractors/clientSegmentExtractor';
```

> `nameListLooksReal` (строка 12) НЕ трогаем — он ещё используется в блоке `integrations`.

- [ ] **Step 4: Заменить customers-ветку на client_segment-ветку**

Найти блок (строки ~335-368):
```ts
  // Cases-related extractors (share /cases HTML, fallback to main)
  const casesHtml = subpageHtml.cases ?? null;
  if (extractors.includes('customers')) {
    out.customers = extractCustomers(casesHtml ?? '');
    if (out.customers.length === 0) out.customers = extractCustomers(main.html);
    // Trust gate: a thin or junk-heavy heuristic result is dropped so the
    // LLM fallback below produces clean company names instead.
    if (!nameListLooksReal(out.customers)) out.customers = [];
    // … (весь комментарий и блок до закрывающей скобки строки ~368)
    if (out.customers.length < 3) {
      const llmCustomers = await llmExtractCustomers(main.html, casesHtml);
      // … merge …
      out.customers = filterCustomerCandidates(merged).slice(0, 30);
    }
  }
```
Заменить весь этот `if (extractors.includes('customers')) { … }` блок на:
```ts
  // Cases-related extractors (share /cases HTML, fallback to main)
  const casesHtml = subpageHtml.cases ?? null;
  // «Клиенты» теперь = сегмент ЦА. Источник только LLM (см. clientSegmentExtractor).
  // Старый эвристический список брендов удалён — он давал плохой результат.
  if (extractors.includes('client_segment')) {
    out.client_segment = await extractClientSegment(
      main.html,
      subpageHtml.about ?? null,
      casesHtml,
    );
  }
```

> `const casesHtml` остаётся объявленным — он используется ниже в `cases_count`/`case_industries`/`enterprise_logos`. Просто строка `const casesHtml` теперь стоит перед client_segment-блоком (как и было перед customers-блоком).

- [ ] **Step 5: Убрать `customers` из LLM-fallback типа**

Около строки 624 в типе `LlmField` убрать `'customers'`:
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'customers' | 'founded_year' | …;
```
Заменить на (без `'customers'`):
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | …;
```
И удалить устаревший комментарий про customers около строк 628-630:
```ts
  // customers вынесены в специализированный llmExtractCustomers выше —
  // там structured input и шире окно контекста, общий extractor не догоняет
  // (см. блок «if (extractors.includes('customers'))»).
```
(а также строку `if (llmResult.customers && … llmNeeded.has('customers')) out.customers = …` в блоке применения llm-результата, если она присутствует — убрать, т.к. `'customers'` больше не в `LlmField`.)

- [ ] **Step 6: Запустить тесты процессора — убедиться, что проходят**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (все кейсы, включая переписанные client_segment).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/enrich/websiteSignalProcessor.ts app/tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): wire client_segment into processor, drop customers branch"
```

---

## Task 5: Удалить мёртвый llmCustomersExtractor

**Files:**
- Delete: `app/src/lib/enrich/extractors/llmCustomersExtractor.ts`
- Delete: `app/tests/lib/extractors/llmCustomersExtractor.test.ts`

> `llmExtractCustomers` использовался только в удалённой customers-ветке (подтверждено grep'ом). `customersExtractor.ts` (`extractCustomers`, `filterCustomerCandidates`) НЕ удаляем — `extractCustomers` нужен `enterprise_logos`, и `customersExtractor.junk.test.ts` остаётся зелёным.

- [ ] **Step 1: Проверить, что нет других импортов**

Run (из корня репо): `npx rg "llmCustomersExtractor|llmExtractCustomers" app/src`
Expected: пусто (после Task 4 ссылок не осталось).

- [ ] **Step 2: Удалить файлы**

```bash
git rm app/src/lib/enrich/extractors/llmCustomersExtractor.ts app/tests/lib/extractors/llmCustomersExtractor.test.ts
```

- [ ] **Step 3: Прогнать весь тест-сьют extractors + applySignalJobResults**

Run (из `app/`): `npx jest tests/lib/extractors tests/lib/applySignalJobResults.test.ts tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS. Если `applySignalJobResults.test.ts` ссылается на `extra_cols` с `key: 'customers'` — заменить на `'client_segment'` (значение там — строка, а не массив).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(signals): remove dead llmCustomersExtractor (customers replaced by client_segment)"
```

---

## Task 6: Миграция legacy-пресетов в localStorage (UI)

**Files:**
- Modify: `app/src/components/DatabaseSpreadsheet.tsx`

> `sanitizeExtractorList` ([:326](app/src/components/DatabaseSpreadsheet.tsx:326)) уже отбрасывает снятый `customers` из последнего выбора. Этот шаг дополнительно **переименовывает** `customers`→`client_segment` в сохранённых пользовательских пресетах и последнем выборе, чтобы у тех, кто уже пользовался «Клиентами», галочка не потерялась. Чисто QoL, без тестов (UI).

- [ ] **Step 1: Добавить хелпер миграции рядом с `sanitizeExtractorList`** (после строки 337)

```ts
/**
 * Legacy-переименование: старый ключ `customers` (список брендов) заменён на
 * `client_segment` (сегмент ЦА) под тем же столбцом «Клиенты». Мапим его в
 * сохранённых пресетах/последнем выборе из localStorage, чтобы выбор не пропал.
 */
function migrateLegacyExtractorKeys(keys: unknown): ExtractorKey[] {
  if (!Array.isArray(keys)) return [];
  const mapped = keys.map((k) => (k === 'customers' ? 'client_segment' : k));
  return sanitizeExtractorList(mapped);
}
```

- [ ] **Step 2: Применить миграцию при загрузке из localStorage** (useEffect, строки ~7507-7522)

Заменить:
```ts
      const customPresets = presetsRaw
        ? (JSON.parse(presetsRaw) as Array<{ id: string; name: string; extractors: ExtractorKey[] }>)
        : [];
```
на:
```ts
      const customPresetsRaw = presetsRaw
        ? (JSON.parse(presetsRaw) as Array<{ id: string; name: string; extractors: ExtractorKey[] }>)
        : [];
      const customPresets = (Array.isArray(customPresetsRaw) ? customPresetsRaw : []).map((p) => ({
        ...p,
        extractors: migrateLegacyExtractorKeys(p.extractors),
      }));
```
И в `setSignalEnrichment(...)` заменить `selectedExtractors`-ветку, использующую `sanitizeExtractorList(lastSelection.extractors)`, на `migrateLegacyExtractorKeys(lastSelection.extractors)`:
```ts
        selectedExtractors:
          lastSelection?.extractors && Array.isArray(lastSelection.extractors)
            ? migrateLegacyExtractorKeys(lastSelection.extractors)
            : prev.selectedExtractors,
```
(строку `customPresets: Array.isArray(customPresets) ? customPresets : []` заменить на `customPresets,` — массив уже нормализован выше.)

- [ ] **Step 3: Проверить сборку фронта**

Run (из `app/`): `npx tsc --noEmit`
Expected: без ошибок типов.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/DatabaseSpreadsheet.tsx
git commit -m "feat(signals): migrate legacy customers preset key to client_segment in UI"
```

---

## Task 7: Полная проверка

- [ ] **Step 1: Линт + типы + весь тест-сьют**

Run (из `app/`): `npx tsc --noEmit && npm run lint && npm test`
Expected: всё зелёное. Починить любое упавшее (ожидаемые точки риска — тесты, ссылавшиеся на `customers`).

- [ ] **Step 2: Ручная проверка в превью** (см. `superpowers:verification-before-completion` / preview-инструменты)

Поднять dev-сервер, открыть инструмент «Базы», запустить «Сигналы» с пресетом Outreach на 2-3 реальных b2b-URL, убедиться, что столбец «Клиенты» заполняется коротким сегментом (а не списком/прочерком на сайтах с понятной ЦА). Приложить скриншот/лог.

- [ ] **Step 3: Финальный commit (если правки были на шаге 1)**

```bash
git add -A
git commit -m "test(signals): fix up suite after client_segment replacement"
```

---

## Self-Review notes
- **Spec coverage:** смысл=сегмент (Task 3 prompt), замена столбца с названием «Клиенты» (Task 1: лейбл client_segment='Клиенты'; customers убран из активных списков), только LLM/нет старого парсинга (Task 4: customers-ветка удалена; Task 5: llmCustomersExtractor удалён), модель gpt-4o-mini (Task 3), вход текст+alt (Task 3 buildUserMessage), guard «нет данных→прочерк» (Task 3 hasMaterial + formatExtraValue DASH в Task 2), старые данные не ломаются (Task 1/2: customers остаётся в ExtractorKey + formatExtraValue case).
- **enterprise_logos** не задет: использует `extractCustomers` напрямую ([websiteSignalProcessor.ts:378](app/src/lib/enrich/websiteSignalProcessor.ts:378)), `customersExtractor.ts` сохранён.
- **Тип-консистентность:** функция `extractClientSegment(mainHtml, aboutHtml?, casesHtml?)` — одна сигнатура во всех тасках; поле `client_segment?: string` и ключ `'client_segment'` едины.
