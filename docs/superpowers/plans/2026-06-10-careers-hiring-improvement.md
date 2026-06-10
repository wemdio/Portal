# Careers Hiring Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Открытых вакансий» перестаёт пустовать при наличии вакансий (пример moslift.ru/jobs/), «Кого нанимают» заполняется надёжнее — оба закрываются одним ИИ-заходом по полной /careers.

**Architecture:** Эвристика `extractHiring` (карточки/текст/внешние агрегаторы) остаётся. Если она не нашла вакансии и/или профессии — новый `llmExtractHiring` читает полный текст /careers и одним вызовом возвращает `{ vacancies: number|«N+»|null, professions[] }`. `vacancies_count` становится `number | string`.

**Tech Stack:** TypeScript, cheerio, requesty (`gpt-4o-mini`), Jest.

**Spec:** `docs/superpowers/specs/2026-06-10-careers-hiring-improvement-design.md`

---

## File Structure
- **Create** `app/src/lib/enrich/extractors/careersLlmExtractor.ts` — LLM по /careers → vacancies + professions.
- **Create** `app/tests/lib/extractors/careersLlmExtractor.test.ts`.
- **Modify** `app/src/lib/enrich/extractors/types.ts` — `vacancies_count?: number | string`.
- **Modify** `app/src/lib/enrich/extractors/formatExtraValue.ts` — рендер vacancies_count (число|строка).
- **Modify** `app/tests/lib/extractors/formatExtraValue.test.ts` — кейс «N+».
- **Modify** `app/src/lib/enrich/websiteSignalProcessor.ts` — LLM-добор + чистка hiring_roles из общего fallback.
- **Modify** `app/tests/lib/websiteSignalProcessor.test.ts` — мок `careersLlmExtractor`, кейс «эвристика 0 → LLM».

> Не трогаем: `hiringExtractor.ts` (эвристика + extractProfession + external links), `llmExtractor.ts`.

---

## Task 1: Тип + рендер `vacancies_count` (число | «N+»)

**Files:**
- Modify: `app/src/lib/enrich/extractors/types.ts`
- Modify: `app/src/lib/enrich/extractors/formatExtraValue.ts`
- Test: `app/tests/lib/extractors/formatExtraValue.test.ts`

- [ ] **Step 1: Падающий тест**

В `formatExtraValue.test.ts` после теста «renders cases_count estimate string …» добавить:
```ts
  it('renders vacancies_count estimate string «N+» as-is; empty → DASH', () => {
    expect(formatExtraValue('vacancies_count', '10+')).toBe('10+');
    expect(formatExtraValue('vacancies_count', 4)).toBe('4');
    expect(formatExtraValue('vacancies_count', 0)).toBe('–');
    expect(formatExtraValue('vacancies_count', '')).toBe('–');
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts -t "vacancies_count estimate"`
Expected: FAIL — `formatExtraValue('vacancies_count', '10+')` возвращает `'–'`.

- [ ] **Step 3: Тип в types.ts**

Найти:
```ts
  vacancies_count?: number;
```
Заменить на:
```ts
  /** Точное число (12) ИЛИ строка-оценка «N+» (10+) от LLM-счётчика вакансий. */
  vacancies_count?: number | string;
```

- [ ] **Step 4: Рендер в formatExtraValue.ts**

Найти:
```ts
    case 'vacancies_count':
    case 'team_size':
      // 0 = "we didn't find any" → DASH, not "0". A real published "у нас 0
      // открытых вакансий" is rare and not worth distinguishing.
      return typeof value === 'number' && value > 0 ? String(value) : EMPTY_CELL_DASH;
```
Заменить на:
```ts
    case 'vacancies_count':
      // number — точное; строка «N+» — оценка LLM; 0/пусто → DASH.
      if (typeof value === 'number') return value > 0 ? String(value) : EMPTY_CELL_DASH;
      if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : EMPTY_CELL_DASH;
      return EMPTY_CELL_DASH;
    case 'team_size':
      // 0 = "we didn't find any" → DASH, not "0". A real published "у нас 0
      // открытых вакансий" is rare and not worth distinguishing.
      return typeof value === 'number' && value > 0 ? String(value) : EMPTY_CELL_DASH;
```

- [ ] **Step 5: Запустить — PASS**

Run (из `app/`): `npx jest tests/lib/extractors/formatExtraValue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/enrich/extractors/types.ts src/lib/enrich/extractors/formatExtraValue.ts tests/lib/extractors/formatExtraValue.test.ts
git commit -m "feat(signals): vacancies_count supports «N+» estimate (number | string)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: LLM-экстрактор `careersLlmExtractor`

**Files:**
- Create: `app/src/lib/enrich/extractors/careersLlmExtractor.ts`
- Test: `app/tests/lib/extractors/careersLlmExtractor.test.ts`

- [ ] **Step 1: Падающий тест**

Создать `app/tests/lib/extractors/careersLlmExtractor.test.ts`:
```ts
/**
 * @jest-environment node
 *
 * LLM по /careers: vacancies (число|«N+») + professions. fetch мокается на global.fetch.
 */

import { llmExtractHiring } from '@/lib/enrich/extractors/careersLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function hiringResponse(vacancies_count: number, approximate: boolean, professions: string[]) {
  return mockJsonResponse({
    choices: [{ message: { content: JSON.stringify({ vacancies_count, approximate, professions }) } }],
  });
}

const CAREERS_HTML = `<html><body><div class="team">${'Мы растём и ищем новых сотрудников в команду. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-careers';
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

describe('llmExtractHiring — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return hiringResponse(3, false, ['Повара']); });
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return hiringResponse(3, false, ['Повара']); });
    expect(await llmExtractHiring('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractHiring — successful path', () => {
  it('exact count + professions', async () => {
    withMockFetch(async () => hiringResponse(12, false, ['Лифтёры', 'Монтажники']));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: 12, professions: ['Лифтёры', 'Монтажники'] });
  });

  it('approximate count → «N+»', async () => {
    withMockFetch(async () => hiringResponse(10, true, []));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: '10+', professions: [] });
  });

  it('vacancies 0 but professions present → vacancies null', async () => {
    withMockFetch(async () => hiringResponse(0, false, ['Бариста']));
    expect(await llmExtractHiring(CAREERS_HTML)).toEqual({ vacancies: null, professions: ['Бариста'] });
  });

  it('returns null when both vacancies 0 and professions empty', async () => {
    withMockFetch(async () => hiringResponse(0, false, []));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });

  it('filters junk professions (length 3..60, max 5)', async () => {
    withMockFetch(async () => hiringResponse(0, false, ['ok', 'Грузчики', '   ', 'Электромонтажники']));
    const r = await llmExtractHiring(CAREERS_HTML);
    expect(r?.professions).toEqual(['Грузчики', 'Электромонтажники']);
  });
});

describe('llmExtractHiring — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractHiring(CAREERS_HTML)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — FAIL (модуль не найден)**

Run (из `app/`): `npx jest tests/lib/extractors/careersLlmExtractor.test.ts`
Expected: FAIL — `Cannot find module …/careersLlmExtractor`.

- [ ] **Step 3: Реализовать extractor**

Создать `app/src/lib/enrich/extractors/careersLlmExtractor.ts`:
```ts
import 'server-only';
import * as cheerio from 'cheerio';

/**
 * LLM-добор для столбцов «Открытых вакансий» + «Кого нанимают». Вызывается,
 * когда эвристика (extractHiring по карточкам/тексту/агрегаторам) не нашла
 * вакансии и/или профессии. Читает ПОЛНЫЙ текст /careers и одним вызовом
 * возвращает количество вакансий (число | «N+» | null) и список профессий.
 * Никогда не throw'ит.
 */

const MODEL = (process.env.OPENROUTER_CAREERS_MODEL ?? 'openai/gpt-4o-mini').trim();
const TIMEOUT_MS = Number(process.env.LLM_CAREERS_TIMEOUT_MS ?? '30000');
const MAX_TEXT_CHARS = 12000;
const MAX_COUNT = 500;
const MAX_PROFESSIONS = 5;

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

const SYSTEM_PROMPT = `Ты анализируешь страницу вакансий/карьеры компании по её тексту.

Верни JSON {"vacancies_count": число, "approximate": true|false, "professions": ["..."]}:
- vacancies_count: число открытых вакансий. approximate=false — точно посчитал перечисленные вакансии ИЛИ число явно на странице. approximate=true — вакансии есть, но точно нельзя (count = НИЖНЯЯ оценка). 0 — вакансий нет.
- professions: до 5 КОНКРЕТНЫХ профессий, которых нанимают (существительные мн.ч., на русском, 1-3 слова): «Лифтёры», «Монтажники», «Менеджеры по продажам», «Бариста». [] если не нашёл.

Только JSON, без markdown. Не выдумывай: нет вакансий — {"vacancies_count": 0, "approximate": false, "professions": []}.`;

function normalizeVacancies(count: unknown, approximate: unknown): number | string | null {
  const n = typeof count === 'number' ? Math.round(count) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_COUNT) return null;
  return approximate === true ? `${n}+` : n;
}

function normalizeProfessions(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of arr) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (t.length < 3 || t.length > 60) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_PROFESSIONS) break;
  }
  return out;
}

export async function llmExtractHiring(
  careersHtml: string,
  mainHtml?: string | null,
): Promise<{ vacancies: number | string | null; professions: string[] } | null> {
  const apiKey = getApiKey();
  const text = pageText(careersHtml || '') || pageText(mainHtml || '');
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
        'X-Title': 'Portal - Careers LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    let parsed: { vacancies_count?: unknown; approximate?: unknown; professions?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const vacancies = normalizeVacancies(parsed.vacancies_count, parsed.approximate);
    const professions = normalizeProfessions(parsed.professions);
    if (vacancies === null && professions.length === 0) return null;
    return { vacancies, professions };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — PASS**

Run (из `app/`): `npx jest tests/lib/extractors/careersLlmExtractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/enrich/extractors/careersLlmExtractor.ts tests/lib/extractors/careersLlmExtractor.test.ts
git commit -m "feat(signals): add careersLlmExtractor (gpt-4o-mini, /careers -> vacancies + professions)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Интеграция в процессор + обновление тестов

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`

- [ ] **Step 1: Обновить тест процессора**

После мока `casesCountLlmExtractor` добавить:
```ts
jest.mock('@/lib/enrich/extractors/careersLlmExtractor', () => ({
  llmExtractHiring: jest.fn().mockResolvedValue({ vacancies: '7+', professions: ['Грузчики'] }),
}));
```

Добавить новый кейс в describe «deep fetch and per-extractor selection»:
```ts
  it('vacancies_count/hiring_roles: heuristic 0 → uses LLM', async () => {
    mockUrlResponses({
      // class="hiring-block" не матчит VACANCY_SELECTOR, числа нет →
      // extractHiring даёт 0/[] → зовётся llmExtractHiring (мок).
      'example.com/careers': '<div class="hiring-block">Ищем сотрудников в команду на разные роли, подробности по запросу.</div>',
      'example.com': '<a href="/careers">Вакансии</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['vacancies_count', 'hiring_roles'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.vacancies_count).toBe('7+');
      expect(result.hiring_roles).toEqual(['Грузчики']);
    }
  });
```

> Существующий «full extractor set» использует `<a class="vacancy">…</a>` ×2 → heuristic vacancies=2, professions непусты → LLM не вызывается, кейс остаётся зелёным.

- [ ] **Step 2: Запустить — новый падает**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts -t "heuristic 0 → uses LLM"`
Expected: FAIL — `vacancies_count` = `0`/undefined (LLM-добора ещё нет).

- [ ] **Step 3: Импорт в websiteSignalProcessor.ts**

После строки `import { extractHiring, findExternalCareerLinks } from '@/lib/enrich/extractors/hiringExtractor';` добавить:
```ts
import { llmExtractHiring } from '@/lib/enrich/extractors/careersLlmExtractor';
```

- [ ] **Step 4: Заменить присвоение hiring на LLM-добор**

Найти:
```ts
    if (extractors.includes('vacancies_count')) out.vacancies_count = hiring.vacancies_count;
    if (extractors.includes('hiring_roles')) {
      // New shape: array of top-5 concrete profession names. See
      // HiringResult docstring for the rationale behind dropping the old
      // 5-bool-categories representation.
      out.hiring_roles = hiring.professions;
    }
  }
```
Заменить на:
```ts
    // LLM-добор по полному тексту /careers, когда эвристика не нашла вакансии
    // и/или профессии (нестандартная вёрстка, напр. moslift.ru/jobs/). Один
    // вызов закрывает оба столбца. См. careersLlmExtractor.
    let vacancies: number | string = hiring.vacancies_count;
    let professions = hiring.professions;
    if ((vacancies === 0 || professions.length === 0) && !signal?.aborted) {
      const llm = await llmExtractHiring(careersHtml ?? main.html, main.html);
      if (llm) {
        if (vacancies === 0 && llm.vacancies !== null) vacancies = llm.vacancies;
        if (professions.length === 0 && llm.professions.length > 0) professions = llm.professions;
      }
    }

    if (extractors.includes('vacancies_count')) out.vacancies_count = vacancies;
    if (extractors.includes('hiring_roles')) out.hiring_roles = professions;
  }
```

- [ ] **Step 5: Убрать hiring_roles из общего LLM-fallback**

`type LlmField`: убрать `| 'hiring_roles'`:
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'integrations' | 'hiring_roles';
```
→
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'integrations';
```
Удалить блок (комментарий + add):
```ts
  // hiring_roles is now a string[] of professions (see HiringResult). Ask
  // the LLM for help when the heuristic returned an empty list — usually
  // means the careers page used a layout / class names we don't recognise,
  // or the company has no /careers and the LLM has to read /about for hints.
  if (extractors.includes('hiring_roles') && (!Array.isArray(out.hiring_roles) || out.hiring_roles.length === 0)) llmNeeded.add('hiring_roles');
```
Удалить строку применения:
```ts
      if (Array.isArray(llmResult.hiring_roles) && llmResult.hiring_roles.length > 0 && llmNeeded.has('hiring_roles')) out.hiring_roles = llmResult.hiring_roles;
```

- [ ] **Step 6: Запустить тесты процессора — PASS**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (новый кейс + существующие, включая full set с heuristic-вакансиями).

- [ ] **Step 7: Commit**

```bash
git add src/lib/enrich/websiteSignalProcessor.ts tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): /careers LLM fallback fills vacancies_count + hiring_roles

When card/text heuristics + external aggregators find no vacancies/professions,
one llmExtractHiring call over the full /careers text fills both columns
(vacancies as N or «N+», professions list). Drops hiring_roles from the generic
LLM fallback.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Полная проверка

- [ ] **Step 1: Типы (моя зона чистая)**

Run (из `app/`): `npx tsc --noEmit 2>&1 | grep -E "careersLlm|websiteSignalProcessor|formatExtraValue|extractors/types"`
Expected: пусто (предсуществующие RouteImpl в `client/*` — не наши).

- [ ] **Step 2: ESLint затронутых файлов**

Run (из `app/`): `npx eslint src/lib/enrich/extractors/careersLlmExtractor.ts src/lib/enrich/extractors/types.ts src/lib/enrich/extractors/formatExtraValue.ts src/lib/enrich/websiteSignalProcessor.ts`
Expected: 0 errors.

- [ ] **Step 3: Полный тест-сьют**

Run (из `app/`): `npm test`
Expected: зелёное, кроме предсуществующего env-флака `leadTelegramAlerts` (CHANGELOG_CHAT_ID из локального .env — не связан).

---

## Self-Review notes
- **Spec coverage:** формат number|«N+» (Task 1), LLM по /careers с vacancies+professions + guard + нормализация (Task 2), эвристика→LLM-добор + чистка hiring_roles из общего fallback (Task 3), external-fallback не тронут, тесты (все задачи).
- **Тип-консистентность:** `llmExtractHiring(careersHtml, mainHtml?) → { vacancies: number|string|null; professions: string[] } | null` — одна сигнатура; `vacancies_count?: number | string` согласован с рендером.
- **Совместимость:** старые `result_text` с числовым `vacancies_count` рендерятся как раньше; `hiring_roles` уже `string[]`.
