# Integrations Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Когда «Интеграции» пусты (нет script-следов и секцию не распознали) — один ИИ-заход по полной /integrations добирает названия сервисов. База (signatures + scrape) и формат не меняются.

**Architecture:** `integrationsFromSignals` (детект скриптов) + `extractIntegrations` (scrape) остаются и дают итоговый merge. Если merge пуст — новый `llmExtractIntegrations` читает полный текст /integrations и возвращает список сервисов. `integrations` уходит из общего обрезанного `llmExtractFields`.

**Tech Stack:** TypeScript, cheerio, requesty (`gpt-4o-mini`), Jest.

**Spec:** `docs/superpowers/specs/2026-06-10-integrations-improvement-design.md`

---

## File Structure
- **Create** `app/src/lib/enrich/extractors/integrationsLlmExtractor.ts` — LLM по /integrations → string[].
- **Create** `app/tests/lib/extractors/integrationsLlmExtractor.test.ts`.
- **Modify** `app/src/lib/enrich/websiteSignalProcessor.ts` — LLM-добор когда merge пуст + чистка integrations из общего fallback.
- **Modify** `app/tests/lib/websiteSignalProcessor.test.ts` — мок `integrationsLlmExtractor`, кейс «merge пуст → LLM».

> Не трогаем: `integrationsExtractor.ts`, `signalDetector.ts`, `formatExtraValue.ts`, `types.ts` (формат/тип прежние), `llmExtractor.ts` (generic).

---

## Task 1: LLM-экстрактор `integrationsLlmExtractor`

**Files:**
- Create: `app/src/lib/enrich/extractors/integrationsLlmExtractor.ts`
- Test: `app/tests/lib/extractors/integrationsLlmExtractor.test.ts`

- [ ] **Step 1: Падающий тест**

Создать `app/tests/lib/extractors/integrationsLlmExtractor.test.ts`:
```ts
/**
 * @jest-environment node
 *
 * LLM по /integrations → список сервисов. fetch мокается на global.fetch.
 */

import { llmExtractIntegrations } from '@/lib/enrich/extractors/integrationsLlmExtractor';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.OPENROUTER_SIGNALS_API_KEY;
const ORIG_BRIEF = process.env.OPENROUTER_BRIEF_API_KEY;

function withMockFetch(impl: (...args: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function mockJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function intResponse(integrations: unknown) {
  return mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ integrations }) } }] });
}

const HTML = `<html><body><div class="info">${'Мы дружим со множеством полезных сервисов для удобной работы. '.repeat(8)}</div></body></html>`;

beforeEach(() => {
  process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key-int';
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

describe('llmExtractIntegrations — early returns', () => {
  it('returns [] without API key (no network call)', async () => {
    delete process.env.OPENROUTER_SIGNALS_API_KEY;
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return intResponse(['amoCRM']); });
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when text is too short (no network call)', async () => {
    const calls: unknown[] = [];
    withMockFetch(async (...a) => { calls.push(a); return intResponse(['amoCRM']); });
    expect(await llmExtractIntegrations('<body>тонко</body>')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('llmExtractIntegrations — successful path', () => {
  it('returns the list', async () => {
    withMockFetch(async () => intResponse(['amoCRM', 'Slack', 'Telegram']));
    expect(await llmExtractIntegrations(HTML)).toEqual(['amoCRM', 'Slack', 'Telegram']);
  });

  it('filters junk (length 2..40), dedups case-insensitively', async () => {
    withMockFetch(async () => intResponse(['a', 'amoCRM', 'amocrm', '   ', 'x'.repeat(50), 'Slack']));
    expect(await llmExtractIntegrations(HTML)).toEqual(['amoCRM', 'Slack']);
  });

  it('returns [] when integrations field is missing/not array', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ other: 'x' }) } }] }));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
});

describe('llmExtractIntegrations — error tolerance', () => {
  it('returns [] on non-2xx', async () => {
    withMockFetch(async () => mockJsonResponse({}, 429));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
  it('returns [] on malformed JSON', async () => {
    withMockFetch(async () => mockJsonResponse({ choices: [{ message: { content: 'nope {{' } }] }));
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
  it('returns [] when the network call throws', async () => {
    withMockFetch(async () => { throw new Error('ECONNRESET'); });
    expect(await llmExtractIntegrations(HTML)).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — FAIL (модуль не найден)**

Run (из `app/`): `npx jest tests/lib/extractors/integrationsLlmExtractor.test.ts`
Expected: FAIL — `Cannot find module …/integrationsLlmExtractor`.

- [ ] **Step 3: Реализовать extractor**

Создать `app/src/lib/enrich/extractors/integrationsLlmExtractor.ts`:
```ts
import 'server-only';
import * as cheerio from 'cheerio';

/**
 * LLM-добор для столбца «Интеграции». Вызывается, когда итоговый список пуст
 * (нет script-следов через integrationsFromSignals и секцию не распознал
 * extractIntegrations). Читает ПОЛНЫЙ текст /integrations и возвращает список
 * сторонних сервисов, упомянутых как интеграции. Никогда не throw'ит.
 */

const MODEL = (process.env.OPENROUTER_INTEGRATIONS_MODEL ?? 'openai/gpt-4o-mini').trim();
const TIMEOUT_MS = Number(process.env.LLM_INTEGRATIONS_TIMEOUT_MS ?? '30000');
const MAX_TEXT_CHARS = 12000;
const MAX_INTEGRATIONS = 20;

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

const SYSTEM_PROMPT = `Ты извлекаешь сторонние сервисы, с которыми у компании есть интеграция, по тексту её страницы.

Верни JSON {"integrations": ["..."]} — названия сторонних сервисов/систем (CRM, телефония, аналитика, платёжные системы, маркетплейсы, мессенджеры, ERP), с которыми компания заявляет интеграцию. Только явно заявленные интеграции. НЕ услуги самой компании, пункты меню, кнопки, заголовки статей блога. Если интеграций не нашёл — [].

Только JSON, без markdown. Не выдумывай.`;

function normalize(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t.length < 2 || t.length > 40) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_INTEGRATIONS) break;
  }
  return out;
}

export async function llmExtractIntegrations(
  integrationsHtml: string,
  mainHtml?: string | null,
): Promise<string[]> {
  const apiKey = getApiKey();
  const text = pageText(integrationsHtml || '') || pageText(mainHtml || '');
  if (!apiKey || text.length < 200) return [];
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
        'X-Title': 'Portal - Integrations LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return [];

    let parsed: { integrations?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
    return normalize(parsed.integrations);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — PASS**

Run (из `app/`): `npx jest tests/lib/extractors/integrationsLlmExtractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/enrich/extractors/integrationsLlmExtractor.ts tests/lib/extractors/integrationsLlmExtractor.test.ts
git commit -m "feat(signals): add integrationsLlmExtractor (gpt-4o-mini, /integrations -> services list)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Интеграция в процессор + обновление тестов

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`

- [ ] **Step 1: Обновить тест процессора**

После мока `pricingLlmExtractor` добавить:
```ts
jest.mock('@/lib/enrich/extractors/integrationsLlmExtractor', () => ({
  llmExtractIntegrations: jest.fn().mockResolvedValue(['amoCRM', 'Slack']),
}));
```

Добавить новый кейс в describe «deep fetch and per-extractor selection»:
```ts
  it('integrations: empty merge → fills from LLM', async () => {
    mockUrlResponses({
      // нет script-следов и нет распознаваемой integration-секции →
      // signatures=[] и extractIntegrations=[] → merge пуст → llmExtractIntegrations (мок).
      'example.com/integrations': '<div class="info">Мы дружим со многими сервисами для вашего удобства каждый день.</div>',
      'example.com': '<a href="/integrations">Интеграции</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['integrations'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.integrations).toEqual(['amoCRM', 'Slack']);
    }
  });
```

> Существующие integrations-кейсы (martech-signatures, main-page signatures, full set) дают
> непустой merge → `llmExtractIntegrations` в них не вызывается, остаются зелёными.

- [ ] **Step 2: Запустить — новый падает**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts -t "empty merge"`
Expected: FAIL — `result.integrations` пуст/undefined (LLM-добора ещё нет).

- [ ] **Step 3: Импорт в websiteSignalProcessor.ts**

После строки `import { extractIntegrations } from '@/lib/enrich/extractors/integrationsExtractor';` добавить:
```ts
import { llmExtractIntegrations } from '@/lib/enrich/extractors/integrationsLlmExtractor';
```

- [ ] **Step 4: Заменить запись integrations на версию с LLM-добором**

Найти (конец integrations-блока):
```ts
    out.integrations = merged.slice(0, 20);
  }
```
Заменить на:
```ts
    // LLM-добор по полному тексту /integrations, когда ни следов скриптов, ни
    // распознанной секции не нашлось. См. integrationsLlmExtractor.
    let finalIntegrations = merged.slice(0, 20);
    if (finalIntegrations.length === 0 && !signal?.aborted) {
      const llm = await llmExtractIntegrations(subpageHtml.integrations ?? main.html, main.html);
      if (llm.length > 0) finalIntegrations = llm.slice(0, 20);
    }
    out.integrations = finalIntegrations;
  }
```

- [ ] **Step 5: Убрать integrations из общего LLM-fallback**

`type LlmField`:
```ts
  type LlmField = 'founded_year' | 'team_size' | 'case_industries' | 'integrations';
```
→
```ts
  type LlmField = 'founded_year' | 'team_size' | 'case_industries';
```
Удалить строку:
```ts
  if (extractors.includes('integrations') && (!out.integrations || out.integrations.length === 0)) llmNeeded.add('integrations');
```
Удалить строку применения:
```ts
      if (llmResult.integrations && llmResult.integrations.length > 0 && llmNeeded.has('integrations')) out.integrations = llmResult.integrations;
```

- [ ] **Step 6: Запустить тесты процессора — PASS**

Run (из `app/`): `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (новый кейс + существующие integrations-кейсы).

- [ ] **Step 7: Commit**

```bash
git add src/lib/enrich/websiteSignalProcessor.ts tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): /integrations LLM fallback fills empty integrations list

When signatures + scrape produce no integrations, one llmExtractIntegrations
call over the full /integrations text fills the list. Drops integrations from
the generic LLM fallback. Closes the 6-column signals backlog.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Полная проверка

- [ ] **Step 1: Типы (моя зона чистая)**

Run (из `app/`): `npx tsc --noEmit 2>&1 | grep -E "integrationsLlm|websiteSignalProcessor"`
Expected: пусто (предсуществующие RouteImpl в `client/*` — не наши).

- [ ] **Step 2: ESLint затронутых файлов**

Run (из `app/`): `npx eslint src/lib/enrich/extractors/integrationsLlmExtractor.ts src/lib/enrich/websiteSignalProcessor.ts`
Expected: 0 errors.

- [ ] **Step 3: Полный тест-сьют**

Run (из `app/`): `npm test`
Expected: зелёное, кроме предсуществующего env-флака `leadTelegramAlerts` (CHANGELOG_CHAT_ID из локального .env — не связан).

---

## Self-Review notes
- **Spec coverage:** LLM по /integrations + нормализация + guard (Task 1), merge→добор когда пусто + чистка integrations из общего fallback (Task 2), signatures/scrape/формат не тронуты, тесты (все задачи).
- **Тип-консистентность:** `llmExtractIntegrations(integrationsHtml, mainHtml?) → string[]` — одна сигнатура; `out.integrations` остаётся `string[]`.
- **Совместимость:** формат ячейки не меняется; общий `llmExtractFields` остаётся для founded_year/team_size/case_industries.
