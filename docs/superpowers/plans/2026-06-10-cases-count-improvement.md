# Cases Count Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Кол-во кейсов» перестаёт быть пустым/`0` при наличии кейсов: точный счёт по карточкам остаётся, а где не вышло — `gpt-4o-mini` по полному тексту /cases даёт число или оценку «N+».

**Architecture:** Эвристика `extractCasesCount` считает точно (бесплатно). Если она дала `0`, новый extractor `llmCountCases` читает полный текст /cases и возвращает точное число или строку-оценку `«N+»`. `cases_count` становится `number | string`; `case_industries` не трогаем.

**Tech Stack:** TypeScript, cheerio, requesty LLM-роутер (`gpt-4o-mini`), Jest.

**Spec:** `docs/superpowers/specs/2026-06-10-cases-count-improvement-design.md`

---

## File Structure
- **Create** `app/src/lib/enrich/extractors/casesCountLlmExtractor.ts` — LLM-счётчик кейсов (полный текст /cases → число | «N+» | null).
- **Create** `app/tests/lib/extractors/casesCountLlmExtractor.test.ts` — юнит с моком `global.fetch`.
- **Modify** `app/src/lib/enrich/extractors/types.ts` — `cases_count?: number | string`.
- **Modify** `app/src/lib/enrich/extractors/formatExtraValue.ts` — рендер `cases_count` для числа и строки.
- **Modify** `app/tests/lib/extractors/formatExtraValue.test.ts` — кейс «N+».
- **Modify** `app/src/lib/enrich/websiteSignalProcessor.ts` — heuristic→LLM, убрать cases_count из общего LLM-fallback.
- **Modify** `app/tests/lib/websiteSignalProcessor.test.ts` — мок `casesCountLlmExtractor`, кейс «эвристика 0 → LLM».

> Не трогаем: `casesCountExtractor.ts` (точный счёт), `caseIndustriesExtractor.ts`, `llmExtractor.ts` (generic, поле остаётся, просто не запрашивается).

---

## Task 1: Тип + рендер `cases_count` (число | «N+»)

**Files:**
- Modify: `app/src/lib/enrich/extractors/types.ts`
- Modify: `app/src/lib/enrich/extractors/formatExtraValue.ts`
- Test: `app/tests/lib/extractors/formatExtraValue.test.ts`

- [ ] **Step 1: Падающий тест**

В `formatExtraValue.test.ts` после теста «renders positive counts as plain strings» (около строки 53) добавить:
```ts
  it('renders cases_count estimate string «N+» as-is; empty → DASH', () => {
    expect(formatExtraValue('cases_count', '20+')).toBe('20+');
    expect(formatExtraValue('cases_count', '  15+  ')).toBe('15+');
    expect(formatExtraValue('cases_count', '')).toBe('–');
    expect(formatExtraValue('cases_count', 23)).toBe('23');
    expect(formatExtraValue('cases_count', 0)).toBe('–');
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts -t "estimate string"`
Expected: FAIL — `formatExtraValue('cases_count', '20+')` возвращает `'–'` (строка попадает в number-only ветку).

- [ ] **Step 3: Тип в types.ts**

Найти в `ExtractedData`:
```ts
  customers?: string[];
  /** Сегмент клиентов компании («стоматологии», «B2B-стройка») — наполнение столбца «Клиенты». */
  client_segment?: string;
  cases_count?: number;
```
Заменить последнюю строку:
```ts
  cases_count?: number;
```
на:
```ts
  /** Точное число (23) ИЛИ строка-оценка «N+» (20+) от LLM-счётчика. */
  cases_count?: number | string;
```

- [ ] **Step 4: Рендер в formatExtraValue.ts**

Найти:
```ts
    case 'cases_count':
    case 'vacancies_count':
    case 'team_size':
      // 0 = "we didn't find any" → DASH, not "0". A real published "у нас 0
      // открытых вакансий" is rare and not worth distinguishing.
      return typeof value === 'number' && value > 0 ? String(value) : EMPTY_CELL_DASH;
```
Заменить на (выделяем cases_count в отдельную ветку — он теперь number | string):
```ts
    case 'cases_count':
      // number — точное; строка «N+» — оценка LLM; 0/пусто → DASH.
      if (typeof value === 'number') return value > 0 ? String(value) : EMPTY_CELL_DASH;
      if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : EMPTY_CELL_DASH;
      return EMPTY_CELL_DASH;
    case 'vacancies_count':
    case 'team_size':
      // 0 = "we didn't find any" → DASH, not "0". A real published "у нас 0
      // открытых вакансий" is rare and not worth distinguishing.
      return typeof value === 'number' && value > 0 ? String(value) : EMPTY_CELL_DASH;
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/enrich/extractors/types.ts src/lib/enrich/extractors/formatExtraValue.ts tests/lib/extractors/formatExtraValue.test.ts
git commit -m "feat(signals): cases_count supports «N+» estimate (number | string)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: LLM-счётчик кейсов `casesCountLlmExtractor`

**Files:**
- Create: `app/src/lib/enrich/extractors/casesCountLlmExtractor.ts`
- Test: `app/tests/lib/extractors/casesCountLlmExtractor.test.ts`

- [ ] **Step 1: Падающий тест** (образец — clientSegmentExtractor.test.ts)

Создать `app/tests/lib/extractors/casesCountLlmExtractor.test.ts`:
```ts
/**
 * @jest-environment node
 *
 * LLM-счётчик кейсов. fetch мокается на уровне global.fetch.
 */

import { llmCountCases } from '@/lib/enrich/extractors/casesCountLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function countResponse(count: number, approximate: boolean) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ count, approximate }) } }] });
}

// Текст ≥200 символов, чтобы пройти guard.
const CASES_HTML = `<html><body><div class="portfolio">${'Кейс для клиента: внедрили CRM и подняли продажи. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-cases-count';
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

describe('llmCountCases — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return countResponse(5, true); });
    expect(await llmCountCases(CASES_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when there is too little text (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return countResponse(5, true); });
    expect(await llmCountCases('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmCountCases — successful path', () => {
  it('returns a plain number when approximate=false', async () => {
    withMockFetch(async () => countResponse(23, false));
    expect(await llmCountCases(CASES_HTML)).toBe(23);
  });

  it('returns «N+» string when approximate=true', async () => {
    withMockFetch(async () => countResponse(20, true));
    expect(await llmCountCases(CASES_HTML)).toBe('20+');
  });

  it('returns null when count is 0 (no cases)', async () => {
    withMockFetch(async () => countResponse(0, false));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
});

describe('llmCountCases — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
  it('returns null when count is not a number', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ count: 'many' }) } }] }));
    expect(await llmCountCases(CASES_HTML)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/casesCountLlmExtractor.test.ts`
Expected: FAIL — `Cannot find module '@/lib/enrich/extractors/casesCountLlmExtractor'`.

- [ ] **Step 3: Реализовать extractor**

Создать `app/src/lib/enrich/extractors/casesCountLlmExtractor.ts`:
```ts
import 'server-only';
import * as cheerio from 'cheerio';

/**
 * LLM-счётчик кейсов для столбца «Кол-во кейсов». Вызывается, когда эвристика
 * (extractCasesCount по карточкам/числу) дала 0, но кейсы могут быть в
 * нестандартной вёрстке. Читает ПОЛНЫЙ текст /cases (а не обрезок) и возвращает:
 *   - точное число (approximate:false) → number;
 *   - оценку-минимум (approximate:true) → строка «N+»;
 *   - нет кейсов / ошибка → null.
 * Никогда не throw'ит.
 */

const MODEL = (process.env.OPENROUTER_CASES_COUNT_MODEL ?? 'openai/gpt-4o-mini').trim();
const TIMEOUT_MS = Number(process.env.LLM_CASES_COUNT_TIMEOUT_MS ?? '30000');
const MAX_TEXT_CHARS = 12000;
const MAX_COUNT = 100000;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

function pageText(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

const SYSTEM_PROMPT = `Ты считаешь количество кейсов/проектов в портфолио компании по тексту её страницы кейсов.

Верни JSON {"count": число, "approximate": true|false}:
- approximate=false — ты точно посчитал перечисленные кейсы ИЛИ на странице явно написано число («более 200 проектов»). count = это число.
- approximate=true — кейсы на странице явно есть, но точно посчитать нельзя. count = обоснованная НИЖНЯЯ оценка (сколько минимум).
- count=0 — кейсов/проектов на странице нет.

Только JSON, без markdown. Не выдумывай: если про кейсы ничего нет — {"count": 0, "approximate": false}.`;

function normalize(raw: { count?: unknown; approximate?: unknown }): number | string | null {
  const n = typeof raw.count === 'number' ? Math.round(raw.count) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_COUNT) return null;
  return raw.approximate === true ? `${n}+` : n;
}

export async function llmCountCases(
  casesHtml: string,
  mainHtml?: string | null,
): Promise<number | string | null> {
  const apiKey = getApiKey();
  const text = pageText(casesHtml || '') || pageText(mainHtml || '');
  if (!apiKey || text.length < 200) return null;
  const message = text.slice(0, MAX_TEXT_CHARS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Cases Count LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 40,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    let parsed: { count?: unknown; approximate?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    return normalize(parsed);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run (из `app/`): `npx jest tests/lib/extractors/casesCountLlmExtractor.test.ts`
Expected: PASS (все describe-блоки).

- [ ] **Step 5: Commit**

```bash
git add src/lib/enrich/extractors/casesCountLlmExtractor.ts tests/lib/extractors/casesCountLlmExtractor.test.ts
git commit -m "feat(signals): add casesCountLlmExtractor (gpt-4o-mini, full /cases text → N | «N+»)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Интеграция в процессор + обновление его тестов

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`

- [ ] **Step 1: Обновить тест процессора**

В `websiteSignalProcessor.test.ts` после мока `clientSegmentExtractor` (около строки 10) добавить:
```ts
jest.mock('@/lib/enrich/extractors/casesCountLlmExtractor', () => ({
  llmCountCases: jest.fn().mockResolvedValue('5+'),
}));
```

И в describe-блоке «deep fetch and per-extractor selection» добавить новый кейс (например после кейса про client_segment+cases_count):
```ts
  it('cases_count: heuristic 0 → uses LLM estimate', async () => {
    mockUrlResponses({
      // class="projects" не матчит CASE_SELECTOR (нет case-card/portfolio-item),
      // числа в тексте нет → extractCasesCount = 0 → зовётся llmCountCases (мок).
      'example.com/cases': '<div class="projects">Делали проекты для разных компаний и брендов.</div>',
      'example.com': '<a href="/cases">Кейсы</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['cases_count'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.cases_count).toBe('5+');
    }
  });
```

> Существующие кейсы с реальными `.case-card` (client_segment+cases_count → 2; full set → 1) дают heuristic>0, поэтому `llmCountCases` в них не вызывается и они остаются зелёными.

- [ ] **Step 2: Запустить — убедиться, что новый падает**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts -t "LLM estimate"`
Expected: FAIL — `result.cases_count` равен `0`/undefined (LLM-ветки ещё нет).

- [ ] **Step 3: Импорт в websiteSignalProcessor.ts**

После строки `import { extractCaseIndustries } from '@/lib/enrich/extractors/caseIndustriesExtractor';` добавить:
```ts
import { llmCountCases } from '@/lib/enrich/extractors/casesCountLlmExtractor';
```

- [ ] **Step 4: Заменить cases_count блок**

Найти:
```ts
  if (extractors.includes('cases_count')) {
    out.cases_count = extractCasesCount(casesHtml ?? '');
    if (out.cases_count === 0 && !casesHtml) out.cases_count = extractCasesCount(main.html);
  }
```
Заменить на:
```ts
  if (extractors.includes('cases_count')) {
    // Точный счёт по карточкам/числу — бесплатно. Если 0, кейсы всё же могут
    // быть в нестандартной вёрстке → спец. LLM по полному тексту /cases даёт
    // число или оценку «N+» (см. casesCountLlmExtractor). Так ячейка не пустеет
    // при наличии кейсов (раньше расходилось с «Отрасли в кейсах»).
    let casesCount: number | string = extractCasesCount(casesHtml ?? '');
    if (casesCount === 0 && !casesHtml) casesCount = extractCasesCount(main.html);
    if (casesCount === 0 && !signal?.aborted) {
      const llm = await llmCountCases(casesHtml ?? main.html, main.html);
      if (llm !== null) casesCount = llm;
    }
    out.cases_count = casesCount;
  }
```

- [ ] **Step 5: Убрать cases_count из общего LLM-fallback**

Строка `type LlmField = …`:
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'cases_count' | 'integrations' | 'hiring_roles';
```
Заменить на (без `'cases_count' |`):
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'integrations' | 'hiring_roles';
```
Удалить строку:
```ts
  if (extractors.includes('cases_count') && !out.cases_count) llmNeeded.add('cases_count');
```
Удалить строку:
```ts
      if (typeof llmResult.cases_count === 'number' && llmResult.cases_count > 0 && llmNeeded.has('cases_count')) out.cases_count = llmResult.cases_count;
```

- [ ] **Step 6: Запустить тесты процессора**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (включая новый «LLM estimate» и существующие cases_count кейсы).

- [ ] **Step 7: Commit**

```bash
git add src/lib/enrich/websiteSignalProcessor.ts tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): cases_count falls back to LLM count when heuristic is 0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Полная проверка

- [ ] **Step 1: Типы (моя зона должна быть чистой)**

Run (из `app/`): `npx tsc --noEmit 2>&1 | grep -E "casesCount|websiteSignalProcessor|formatExtraValue|extractors/types"`
Expected: пусто (предсуществующие RouteImpl-ошибки в `client/*` — не наши).

- [ ] **Step 2: ESLint затронутых файлов**

Run (из `app/`): `npx eslint src/lib/enrich/extractors/casesCountLlmExtractor.ts src/lib/enrich/extractors/types.ts src/lib/enrich/extractors/formatExtraValue.ts src/lib/enrich/websiteSignalProcessor.ts`
Expected: 0 errors.

- [ ] **Step 3: Полный тест-сьют**

Run (из `app/`): `npm test`
Expected: всё зелёное, кроме предсуществующего env-флака `leadTelegramAlerts` (CHANGELOG_CHAT_ID из локального .env — не связан).

---

## Self-Review notes
- **Spec coverage:** формат number|«N+» (Task 1), LLM-счётчик по полному тексту + guard (Task 2), heuristic→LLM в процессоре + чистка общего fallback (Task 3), case_industries не тронут, тесты (все задачи).
- **Тип-консистентность:** `llmCountCases(casesHtml, mainHtml?) → number | string | null` — одна сигнатура; `cases_count?: number | string` и рендер в formatExtraValue согласованы.
- **Совместимость:** старые `result_text` с числовым `cases_count` рендерятся как раньше (number-ветка).
