# Pricing Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять заполняемость «Мин. цена» / «Модель продаж» / «Free trial» — где эвристика молчит, один ИИ-заход по полной /pricing добирает все три. Форматы ячеек не меняются.

**Architecture:** Эвристики (`extractPricingModel`, `extractPricingDetails`) остаются первыми. Если модель `unknown`, и/или нет цены, и/или free_trial не определён — новый `llmExtractPricing` читает полный текст /pricing и одним вызовом добирает недостающее. Эти три поля уходят из общего обрезанного `llmExtractFields`.

**Tech Stack:** TypeScript, cheerio, requesty (`gpt-4o-mini`), Jest.

**Spec:** `docs/superpowers/specs/2026-06-10-pricing-improvement-design.md`

---

## File Structure
- **Create** `app/src/lib/enrich/extractors/pricingLlmExtractor.ts` — LLM по /pricing → {pricing_model, pricing_min, free_trial}.
- **Create** `app/tests/lib/extractors/pricingLlmExtractor.test.ts`.
- **Modify** `app/src/lib/enrich/websiteSignalProcessor.ts` — LLM-добор после pricing-блока + чистка трёх полей из общего fallback.
- **Modify** `app/tests/lib/websiteSignalProcessor.test.ts` — мок `pricingLlmExtractor`, кейс «эвристика пусто → LLM».

> Не трогаем: `pricingModelExtractor.ts`, `pricingDetailExtractor.ts`, `formatExtraValue.ts`, `types.ts` (форматы/типы прежние), `llmExtractor.ts` (generic).

---

## Task 1: LLM-экстрактор `pricingLlmExtractor`

**Files:**
- Create: `app/src/lib/enrich/extractors/pricingLlmExtractor.ts`
- Test: `app/tests/lib/extractors/pricingLlmExtractor.test.ts`

- [ ] **Step 1: Падающий тест**

Создать `app/tests/lib/extractors/pricingLlmExtractor.test.ts`:
```ts
/**
 * @jest-environment node
 *
 * LLM по /pricing: model + min + free_trial. fetch мокается на global.fetch.
 */

import { llmExtractPricing } from '@/lib/enrich/extractors/pricingLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function pricingResponse(obj: unknown) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

const PRICING_HTML = `<html><body><div class="plans">${'Тариф для бизнеса с расширенными возможностями и поддержкой. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-pricing';
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

describe('llmExtractPricing — early returns', () => {
  it('returns null without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return pricingResponse({ pricing_model: 'self-serve' }); });
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return pricingResponse({ pricing_model: 'self-serve' }); });
    expect(await llmExtractPricing('<body>тонко</body>')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractPricing — successful path', () => {
  it('full result', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: 'self-serve', pricing_min: { value: 990, currency: 'RUB' }, free_trial: true }));
    expect(await llmExtractPricing(PRICING_HTML)).toEqual({
      pricing_model: 'self-serve',
      pricing_min: { value: 990, currency: 'RUB' },
      free_trial: true,
    });
  });

  it('partial: only free_trial=false', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: null, pricing_min: null, free_trial: false }));
    expect(await llmExtractPricing(PRICING_HTML)).toEqual({
      pricing_model: null, pricing_min: null, free_trial: false,
    });
  });

  it('filters invalid model and bad price → all null → returns null', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: 'foo', pricing_min: { value: 0, currency: 'RUB' }, free_trial: null }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });

  it('rejects price without valid currency', async () => {
    withMockFetch(async () => pricingResponse({ pricing_model: null, pricing_min: { value: 500, currency: 'XYZ' }, free_trial: null }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
});

describe('llmExtractPricing — error tolerance', () => {
  it('returns null on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
  it('returns null on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
  it('returns null when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractPricing(PRICING_HTML)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — FAIL (модуль не найден)**

Run (из `app/`): `npx jest tests/lib/extractors/pricingLlmExtractor.test.ts`
Expected: FAIL — `Cannot find module …/pricingLlmExtractor`.

- [ ] **Step 3: Реализовать extractor**

Создать `app/src/lib/enrich/extractors/pricingLlmExtractor.ts`:
```ts
import 'server-only';
import * as cheerio from 'cheerio';
import type { PricingModel, PriceValue, Currency } from './types';

/**
 * LLM-добор для столбцов «Модель продаж» / «Мин. цена» / «Free trial».
 * Вызывается, когда эвристика не определила модель (unknown), не нашла цену
 * и/или не подтвердила free trial. Читает ПОЛНЫЙ текст /pricing и одним
 * вызовом возвращает все три поля (любое может быть null). Никогда не throw'ит.
 */

const MODEL = (process.env.OPENROUTER_PRICING_MODEL ?? 'openai/gpt-4o-mini').trim();
const TIMEOUT_MS = Number(process.env.LLM_PRICING_TIMEOUT_MS ?? '30000');
const MAX_TEXT_CHARS = 12000;
const MAX_PRICE = 100_000_000;

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

const SYSTEM_PROMPT = `Ты извлекаешь условия продаж компании по тексту её страницы цен/тарифов.

Верни JSON {"pricing_model": "...", "pricing_min": {"value": число, "currency": "RUB|USD|EUR"} | null, "free_trial": true|false|null}:
- pricing_model: "self-serve" (публичные цены, можно купить онлайн) | "sales-led" (нужна заявка/менеджер/КП) | "enterprise" (индивидуальные условия для крупного бизнеса) | "freemium" (есть бесплатный план/период) | null (не определить).
- pricing_min: минимальная стартовая цена ПАКЕТА услуг/тарифа/подписки («от ...»). НЕ бери цены за единицу/действие («за лид», «за клик», «за заявку»), цены сторонних товаров, пороги бесплатной доставки, суммы из отзывов. Нет цены — null.
- free_trial: true, если есть ЛЮБОЙ бесплатный вход (пробный период, бесплатный план/демо, бесплатная консультация/аудит/первый урок). false — если за всё берут деньги сразу. null — непонятно.

Только JSON, без markdown. Не выдумывай.`;

const VALID_MODELS: PricingModel[] = ['self-serve', 'sales-led', 'enterprise', 'freemium'];
const VALID_CURRENCIES: Currency[] = ['RUB', 'USD', 'EUR'];

function normalizeModel(v: unknown): PricingModel | null {
  return typeof v === 'string' && (VALID_MODELS as string[]).includes(v) ? (v as PricingModel) : null;
}

function normalizeMin(v: unknown): PriceValue | null {
  if (typeof v !== 'object' || v === null) return null;
  const obj = v as { value?: unknown; currency?: unknown };
  const value = typeof obj.value === 'number' ? Math.round(obj.value) : NaN;
  const currency = typeof obj.currency === 'string' ? obj.currency.toUpperCase() : '';
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PRICE) return null;
  if (!(VALID_CURRENCIES as string[]).includes(currency)) return null;
  return { value, currency: currency as Currency };
}

function normalizeTrial(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export async function llmExtractPricing(
  pricingHtml: string,
  mainHtml?: string | null,
): Promise<{ pricing_model: PricingModel | null; pricing_min: PriceValue | null; free_trial: boolean | null } | null> {
  const apiKey = getApiKey();
  const text = pageText(pricingHtml || '') || pageText(mainHtml || '');
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
        'X-Title': 'Portal - Pricing LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    let parsed: { pricing_model?: unknown; pricing_min?: unknown; free_trial?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const pricing_model = normalizeModel(parsed.pricing_model);
    const pricing_min = normalizeMin(parsed.pricing_min);
    const free_trial = normalizeTrial(parsed.free_trial);
    if (pricing_model === null && pricing_min === null && free_trial === null) return null;
    return { pricing_model, pricing_min, free_trial };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — PASS**

Run (из `app/`): `npx jest tests/lib/extractors/pricingLlmExtractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/enrich/extractors/pricingLlmExtractor.ts tests/lib/extractors/pricingLlmExtractor.test.ts
git commit -m "feat(signals): add pricingLlmExtractor (gpt-4o-mini, /pricing -> model + min + free_trial)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Интеграция в процессор + обновление тестов

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`

- [ ] **Step 1: Обновить тест процессора**

После мока `careersLlmExtractor` добавить:
```ts
jest.mock('@/lib/enrich/extractors/pricingLlmExtractor', () => ({
  llmExtractPricing: jest.fn().mockResolvedValue({
    pricing_model: 'sales-led',
    pricing_min: { value: 50000, currency: 'RUB' },
    free_trial: true,
  }),
}));
```

Добавить новый кейс в describe «deep fetch and per-extractor selection»:
```ts
  it('pricing: heuristic blank → fills model/min/free_trial from LLM', async () => {
    mockUrlResponses({
      // нет цен/кнопок/тарифов/маркеров → extractPricingModel=unknown,
      // extractPricingDetails={} → зовётся llmExtractPricing (мок).
      'example.com/pricing': '<div class="info">Наши услуги помогают бизнесу расти и развиваться каждый день уверенно.</div>',
      'example.com': '<a href="/pricing">Цены</a>',
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['pricing_model', 'pricing_min', 'free_trial'],
    });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.pricing_model).toBe('sales-led');
      expect(result.pricing_min).toEqual({ value: 50000, currency: 'RUB' });
      expect(result.free_trial).toBe(true);
    }
  });
```

> Существующий «full extractor set» (/pricing = `990 ₽/мес` + «Купить») даёт heuristic model=self-serve и min={990,RUB} — добор их не перетирает (needs=false для model/min); free_trial там undefined → добор выставит из мока, но тест free_trial не проверяет. Остаётся зелёным.

- [ ] **Step 2: Запустить — новый падает**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts -t "fills model/min/free_trial"`
Expected: FAIL — поля пустые (LLM-добора ещё нет).

- [ ] **Step 3: Импорт в websiteSignalProcessor.ts**

После строки `import { extractPricingDetails } from '@/lib/enrich/extractors/pricingDetailExtractor';` добавить:
```ts
import { llmExtractPricing } from '@/lib/enrich/extractors/pricingLlmExtractor';
```

- [ ] **Step 4: Добавить LLM-добор после pricing-блока**

Найти конец pricing-блока (закрывающая скобка перед careers-комментарием):
```ts
    // Fallback to main page if subpage had nothing.
    if (!pricingHtml) {
      const mainDetails = extractPricingDetails(main.html);
      if (extractors.includes('pricing_min') && !out.pricing_min) out.pricing_min = mainDetails.pricing_min;
      if (extractors.includes('free_trial') && out.free_trial !== true && mainDetails.free_trial === true) {
        out.free_trial = true;
      }
    }
  }

  // Careers-related extractors (share /careers HTML, fallback to main,
```
Заменить на (добавить блок добора между `}` pricing и комментарием careers):
```ts
    // Fallback to main page if subpage had nothing.
    if (!pricingHtml) {
      const mainDetails = extractPricingDetails(main.html);
      if (extractors.includes('pricing_min') && !out.pricing_min) out.pricing_min = mainDetails.pricing_min;
      if (extractors.includes('free_trial') && out.free_trial !== true && mainDetails.free_trial === true) {
        out.free_trial = true;
      }
    }
  }

  // LLM-добор по полному тексту /pricing, когда эвристика не определила модель,
  // не нашла цену и/или не подтвердила free trial. Один вызов закрывает три
  // столбца. См. pricingLlmExtractor.
  {
    const needModel = extractors.includes('pricing_model') && (out.pricing_model === 'unknown' || !out.pricing_model);
    const needMin = extractors.includes('pricing_min') && !out.pricing_min;
    const needTrial = extractors.includes('free_trial') && out.free_trial === undefined;
    if ((needModel || needMin || needTrial) && !signal?.aborted) {
      const llm = await llmExtractPricing(pricingHtml ?? main.html, main.html);
      if (llm) {
        if (needModel && llm.pricing_model) out.pricing_model = llm.pricing_model;
        if (needMin && llm.pricing_min) out.pricing_min = llm.pricing_min;
        // free_trial: принимаем true И false, чтобы «Нет» попадал в ячейку.
        if (needTrial && llm.free_trial !== null) out.free_trial = llm.free_trial;
      }
    }
  }

  // Careers-related extractors (share /careers HTML, fallback to main,
```

- [ ] **Step 5: Убрать три pricing-поля из общего LLM-fallback**

`type LlmField`:
```ts
  type LlmField = 'pricing_model' | 'pricing_min' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'integrations';
```
→
```ts
  type LlmField = 'founded_year' | 'team_size' | 'case_industries' | 'integrations';
```
Удалить строки `llmNeeded.add` для pricing_model, pricing_min и free_trial-блок:
```ts
  if (extractors.includes('pricing_model') && (out.pricing_model === 'unknown' || !out.pricing_model)) llmNeeded.add('pricing_model');
  if (extractors.includes('pricing_min') && !out.pricing_min) llmNeeded.add('pricing_min');
```
(удалить обе строки) и
```ts
  // free_trial: ask the LLM whenever the heuristic didn't confirm (undefined).
  // It may return true OR false; we accept both so the user sees "Нет" instead
  // of the misleading DASH when the LLM is confident there's no trial.
  if (extractors.includes('free_trial') && out.free_trial === undefined) llmNeeded.add('free_trial');
```
(удалить весь блок). Затем удалить применения:
```ts
      if (llmResult.pricing_model && llmNeeded.has('pricing_model')) out.pricing_model = llmResult.pricing_model;
      if (llmResult.pricing_min && llmNeeded.has('pricing_min')) out.pricing_min = llmResult.pricing_min;
```
(удалить обе) и tri-state free_trial блок:
```ts
      // Tri-state merge: heuristic only sets true. Now accept either side of
      // the LLM's verdict so "Нет" (confident no) lands in the cell when the
      // model spotted a Contact-Sales-only page. Heuristic-true is preserved
      // (we don't downgrade Да → Нет just because LLM disagrees).
      if (llmNeeded.has('free_trial') && out.free_trial !== true) {
        if (llmResult.free_trial === true) out.free_trial = true;
        else if (llmResult.free_trial === false) out.free_trial = false;
      }
```
(удалить весь блок). Итоговый общий fallback применяет только founded_year, team_size, case_industries, integrations.

- [ ] **Step 6: Запустить тесты процессора — PASS**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (новый кейс + существующие, включая full set).

- [ ] **Step 7: Commit**

```bash
git add src/lib/enrich/websiteSignalProcessor.ts tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): /pricing LLM fallback fills model + min + free_trial

When pricing heuristics leave model unknown / no min price / unconfirmed trial,
one llmExtractPricing call over the full /pricing text fills the gaps. Drops
these three fields from the generic LLM fallback.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Полная проверка

- [ ] **Step 1: Типы (моя зона чистая)**

Run (из `app/`): `npx tsc --noEmit 2>&1 | grep -E "pricingLlm|websiteSignalProcessor"`
Expected: пусто (предсуществующие RouteImpl в `client/*` — не наши).

- [ ] **Step 2: ESLint затронутых файлов**

Run (из `app/`): `npx eslint src/lib/enrich/extractors/pricingLlmExtractor.ts src/lib/enrich/websiteSignalProcessor.ts`
Expected: 0 errors.

- [ ] **Step 3: Полный тест-сьют**

Run (из `app/`): `npm test`
Expected: зелёное, кроме предсуществующего env-флака `leadTelegramAlerts` (CHANGELOG_CHAT_ID из локального .env — не связан).

---

## Self-Review notes
- **Spec coverage:** один LLM-заход /pricing на три поля + нормализация + guard (Task 1), эвристика→добор + чистка трёх полей из общего fallback (Task 2), форматы/типы не тронуты, тесты (все задачи).
- **Тип-консистентность:** `llmExtractPricing(pricingHtml, mainHtml?) → { pricing_model: PricingModel|null; pricing_min: PriceValue|null; free_trial: boolean|null } | null` — одна сигнатура; типы полей совпадают с `ExtractedData`.
- **Совместимость:** форматы ячеек и эвристики не меняются; общий `llmExtractFields` остаётся для founded_year/team_size/case_industries/integrations.
