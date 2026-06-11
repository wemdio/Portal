# «Соцсети» + «События» any-niche — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать сигналы «Соцсети» (полнота + чистота) и «События» (под любую нишу) рабочими в [websiteSignalProcessor](../../../app/src/lib/enrich/websiteSignalProcessor.ts).

**Architecture:** Чистим/фильтруем соцсети в `socialMediaExtractor`; добор полноты слоями в процессоре (static → Playwright-рендер → поиск канала через Serper); событийный LLM-промпт делаем ниша-независимым. Все источники соцсетей проходят один фильтр (`filterSocialUrls`).

**Tech Stack:** TypeScript, Next.js (server-only), cheerio, Jest 29, requesty (LLM), Serper (Google search API), Playwright.

**Соглашения:** тесты запускаются из каталога `app/` (`npm test -- <путь>` ИЛИ `npx jest <путь>`). Каждый commit заканчивается трейлером `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (политика репо). Спека: [2026-06-11-social-events-any-niche-design.md](../specs/2026-06-11-social-events-any-niche-design.md).

---

## File Structure

**Создаём:**
- `app/src/lib/search/serperClient.ts` — общий best-effort клиент Serper (`serperSearch`, `hasSerperKey`).
- `app/src/lib/enrich/extractors/deriveCompanyName.ts` — имя компании со страницы (`deriveCompanyName`, `domainRoot`).
- `app/src/lib/enrich/extractors/socialCompanyFinder.ts` — поиск офиц. канала компании через Serper (`findCompanySocials`).
- Тесты: `app/tests/lib/search/serperClient.test.ts`, `app/tests/lib/extractors/deriveCompanyName.test.ts`, `app/tests/lib/extractors/socialCompanyFinder.test.ts`.

**Модифицируем:**
- `app/src/lib/enrich/extractors/socialMediaExtractor.ts` — фильтр (боты, `/in/`), зонирование, потолки, экспорт `filterSocialUrls`.
- `app/src/lib/enrich/extractors/eventDetector.ts` — ниша-независимый `SYSTEM_PROMPT`.
- `app/src/lib/enrich/websiteSignalProcessor.ts` — единый разбор соцсетей + добор + переиспользование для событий.
- Тесты: `app/tests/lib/extractors/socialMediaExtractor.test.ts`, `app/tests/lib/extractors/eventDetector.test.ts`, `app/tests/lib/websiteSignalProcessor.test.ts`.

**Вне scope:** качество входного списка (junk-лиды), рефактор cisLeads на общий serperClient, новые колонки БД/заголовки экспорта.

---

## Task 1: socialMediaExtractor — фильтр, зонирование, потолки, `filterSocialUrls`

**Files:**
- Modify: `app/src/lib/enrich/extractors/socialMediaExtractor.ts`
- Test: `app/tests/lib/extractors/socialMediaExtractor.test.ts`

- [ ] **Step 1: Обновить существующие тесты под новое поведение**

В `socialMediaExtractor.test.ts` УДАЛИТЬ строку с личным LinkedIn из позитивного `it.each` (теперь `/in/` — не соцсеть компании):
```ts
    ['LinkedIn personal', 'https://linkedin.com/in/myname'],
```
ЗАМЕНИТЬ тест «keeps two accounts of the same family if they are different handles» (про company+`/in/`) на вариант без `/in/`:
```ts
  it('keeps two different handles of the same family (capped at 2)', () => {
    const html = wrap([
      'https://t.me/company_main',
      'https://t.me/company_news',
    ]);
    const result = extractSocialMedia(html);
    expect(result).toEqual(['https://t.me/company_main', 'https://t.me/company_news']);
  });
```

- [ ] **Step 2: Добавить новые failing-тесты (фильтр/зонирование/потолки)**

Добавить в конец `socialMediaExtractor.test.ts`:
```ts
describe('extractSocialMedia — filtering & scoping', () => {
  it('drops Telegram bot accounts (handle ending in "bot")', () => {
    const html = wrap(['https://t.me/some_bot', 'https://t.me/realchannel']);
    expect(extractSocialMedia(html)).toEqual(['https://t.me/realchannel']);
  });

  it('drops personal LinkedIn /in/ profiles, keeps /company/', () => {
    const html = wrap(['https://linkedin.com/in/john-ceo', 'https://linkedin.com/company/myco']);
    expect(extractSocialMedia(html)).toEqual(['https://linkedin.com/company/myco']);
  });

  it('ignores foreign socials inside article body when footer has company socials', () => {
    const html = `
      <article>
        <a href="https://t.me/habr_com">Habr TG</a>
        <a href="https://vk.com/habr">Habr VK</a>
      </article>
      <footer><a href="https://t.me/realcompany">Our TG</a></footer>
    `;
    expect(extractSocialMedia(html)).toEqual(['https://t.me/realcompany']);
  });

  it('falls back to whole-page scan when no regional socials are found', () => {
    const html = `<main><a href="https://t.me/bodyonly">tg</a></main>`;
    expect(extractSocialMedia(html)).toEqual(['https://t.me/bodyonly']);
  });

  it('caps at 2 accounts per family', () => {
    const html = wrap(['https://t.me/c1', 'https://t.me/c2', 'https://t.me/c3']);
    expect(extractSocialMedia(html)).toEqual(['https://t.me/c1', 'https://t.me/c2']);
  });
});
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run (из `app/`): `npx jest tests/lib/extractors/socialMediaExtractor.test.ts`
Expected: FAIL (бот/`/in/` пока попадают; `filterSocialUrls` ещё нет; зонирование не реализовано).

- [ ] **Step 4: Реализовать изменения в `socialMediaExtractor.ts`**

(a) В `SOCIAL_PATTERNS` убрать `in` из LinkedIn-паттерна:
```ts
  // LinkedIn: только /company /school /showcase. Личные /in/ — это люди, не
  // соцсеть компании; для outreach это шум, поэтому /in/ исключён.
  {
    family: 'linkedin',
    match: /^https?:\/\/(?:www\.|[a-z]{2}\.)?linkedin\.com\/(?:company|school|showcase)\/([A-Za-z0-9\-_.%]+)\/?(?:\?.*)?$/i,
    requireHandle: true,
  },
```

(b) Добавить потолки рядом с `SHARE_INTENT_PATTERNS`:
```ts
// Потолки на одну компанию: ≤2 аккаунта на сеть и ≤8 всего — отсекает «пакеты»
// чужих/дублирующих ссылок (встроенные виджеты, агрегаторы).
const MAX_PER_FAMILY = 2;
const MAX_TOTAL = 8;
```

(c) В `classifyUrl`, внутри цикла по `SOCIAL_PATTERNS`, добавить дроп ботов перед `return`:
```ts
  for (const pat of SOCIAL_PATTERNS) {
    const m = normalized.match(pat.match);
    if (!m) continue;
    if (pat.requireHandle && (!m[1] || m[1].length === 0)) continue;
    // Telegram-боты (@…bot) — не канал компании, выкидываем.
    if (pat.family === 'telegram' && /bot$/i.test(m[1] ?? '')) return null;
    return { family: pat.family, normalized };
  }
  return null;
```

(d) Заменить функцию `extractSocialMedia` (целиком) на пару `filterSocialUrls` + новый `extractSocialMedia`:
```ts
/**
 * Классифицировать произвольный список URL'ов в очищенный, упорядоченный и
 * ограниченный список соцсетей компании. Дедуп по нормализованной форме,
 * потолки MAX_PER_FAMILY / MAX_TOTAL, порядок — по SOCIAL_PATTERNS. Боты,
 * личные LinkedIn /in/, share/intent уже отсеяны в classifyUrl. Используется
 * и HTML-извлекателем, и поиском каналов через Serper (DRY).
 */
export function filterSocialUrls(rawUrls: string[]): string[] {
  const byFamily = new Map<SocialFamily, string[]>();
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const c = classifyUrl(raw);
    if (!c) continue;
    if (seen.has(c.normalized)) continue;
    seen.add(c.normalized);
    const arr = byFamily.get(c.family) ?? [];
    if (arr.length >= MAX_PER_FAMILY) continue;
    arr.push(c.normalized);
    byFamily.set(c.family, arr);
  }
  const out: string[] = [];
  const written = new Set<SocialFamily>();
  for (const pat of SOCIAL_PATTERNS) {
    if (written.has(pat.family)) continue;
    written.add(pat.family);
    const arr = byFamily.get(pat.family);
    if (arr) out.push(...arr);
  }
  return out.slice(0, MAX_TOTAL);
}

/**
 * Найти ссылки на соцсети в HTML. Сначала ищем в «фирменных» зонах
 * (footer/header/nav + контейнеры/ссылки с social/contact в class/id) — там
 * живут соцсети компании. Если там пусто — обходим всю страницу. Это отсекает
 * чужие соцсети из тела статей/встроенных виджетов (кейс Хабра), не ломая
 * обычные сайты с иконками в подвале.
 */
export function extractSocialMedia(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();

  const hrefs = (sel: string): string[] => {
    const out: string[] = [];
    $(sel).each((_, a) => {
      const href = ($(a).attr('href') ?? '').trim();
      if (/^https?:\/\//i.test(href)) out.push(href);
    });
    return out;
  };

  const REGION =
    'footer a, header a, nav a, [class*="social"] a, [id*="social"] a, ' +
    '[class*="contact"] a, [id*="contact"] a, a[class*="social"], a[id*="social"]';

  let urls = filterSocialUrls(hrefs(REGION));
  if (urls.length === 0) urls = filterSocialUrls(hrefs('a'));
  return urls;
}
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `npx jest tests/lib/extractors/socialMediaExtractor.test.ts`
Expected: PASS (все describe, включая обновлённые и новые).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/enrich/extractors/socialMediaExtractor.ts app/tests/lib/extractors/socialMediaExtractor.test.ts
git commit -m "feat(signals): social media — drop bots/personal/foreign, region-scope, caps, filterSocialUrls"
```

---

## Task 2: serperClient — общий best-effort Serper

**Files:**
- Create: `app/src/lib/search/serperClient.ts`
- Test: `app/tests/lib/search/serperClient.test.ts`

- [ ] **Step 1: Failing-тест**

Создать `app/tests/lib/search/serperClient.test.ts`:
```ts
/** @jest-environment node */
jest.mock('server-only', () => ({}));

import { serperSearch, hasSerperKey } from '@/lib/search/serperClient';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.SERPER_API_KEY;

function withMockFetch(impl: (...a: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => { process.env.SERPER_API_KEY = 'k'; });
afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = ORIG_KEY;
  jest.clearAllMocks();
});

it('returns [] and does not call fetch without key', async () => {
  delete process.env.SERPER_API_KEY;
  const calls: unknown[] = [];
  withMockFetch(async (...a) => { calls.push(a); return res({ organic: [{ link: 'x' }] }); });
  expect(await serperSearch('q')).toEqual([]);
  expect(calls).toHaveLength(0);
  expect(hasSerperKey()).toBe(false);
});

it('returns only organic items that have a link', async () => {
  withMockFetch(async () => res({ organic: [{ link: 'https://t.me/x', title: 'X' }, { title: 'no link' }] }));
  expect(await serperSearch('q')).toEqual([{ link: 'https://t.me/x', title: 'X' }]);
});

it('returns [] on non-2xx', async () => {
  withMockFetch(async () => res({}, 429));
  expect(await serperSearch('q')).toEqual([]);
});

it('returns [] when fetch throws', async () => {
  withMockFetch(async () => { throw new Error('net'); });
  expect(await serperSearch('q')).toEqual([]);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest tests/lib/search/serperClient.test.ts`
Expected: FAIL (модуля нет).

- [ ] **Step 3: Реализовать `serperClient.ts`**

Создать `app/src/lib/search/serperClient.ts`:
```ts
import 'server-only';

const SERPER_API_URL = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 8_000;

export interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

export function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

/**
 * Best-effort обёртка над Serper (Google search API). Никогда не throw'ит:
 * нет ключа / non-2xx / timeout / сетевой сбой → []. Дефолт регион ru/ru.
 */
export async function serperSearch(
  query: string,
  opts?: { num?: number; gl?: string; hl?: string; signal?: AbortSignal; timeout?: number },
): Promise<SerperOrganicItem[]> {
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeout ?? DEFAULT_TIMEOUT_MS);
  if (opts?.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: opts?.num ?? 10, gl: opts?.gl ?? 'ru', hl: opts?.hl ?? 'ru' }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { organic?: SerperOrganicItem[] };
    return (data.organic ?? []).filter(
      (it): it is SerperOrganicItem => it != null && typeof it === 'object' && typeof it.link === 'string',
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest tests/lib/search/serperClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/search/serperClient.ts app/tests/lib/search/serperClient.test.ts
git commit -m "feat(search): add best-effort shared Serper client"
```

---

## Task 3: deriveCompanyName — имя компании со страницы

**Files:**
- Create: `app/src/lib/enrich/extractors/deriveCompanyName.ts`
- Test: `app/tests/lib/extractors/deriveCompanyName.test.ts`

- [ ] **Step 1: Failing-тест**

Создать `app/tests/lib/extractors/deriveCompanyName.test.ts`:
```ts
/** @jest-environment node */
import { deriveCompanyName, domainRoot } from '@/lib/enrich/extractors/deriveCompanyName';

it('prefers og:site_name', () => {
  const html = '<head><meta property="og:site_name" content="Acme Corp"><title>Главная — Acme</title></head>';
  expect(deriveCompanyName(html, 'https://acme.ru')).toBe('Acme Corp');
});

it('takes the first non-generic title segment', () => {
  const html = '<head><title>Главная — Lidorium — Агентство</title></head>';
  expect(deriveCompanyName(html, 'https://lidorium.ru')).toBe('Lidorium');
});

it('falls back to the domain root when no name on page', () => {
  expect(deriveCompanyName('', 'https://www.syntonic.ru/contacts')).toBe('syntonic');
});

it('domainRoot strips www and tld', () => {
  expect(domainRoot('https://www.komus-contact.ru/')).toBe('komus-contact');
  expect(domainRoot('bad input')).toBe('');
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest tests/lib/extractors/deriveCompanyName.test.ts`
Expected: FAIL (модуля нет).

- [ ] **Step 3: Реализовать `deriveCompanyName.ts`**

```ts
import * as cheerio from 'cheerio';

// Общие «не-бренд» сегменты title — пропускаем при выборе имени компании.
const STOPWORDS = new Set([
  'главная', 'home', 'контакты', 'contacts', 'contact', 'о компании', 'о нас',
  'about', 'about us', 'услуги', 'services', 'цены', 'pricing', 'блог', 'blog',
]);

/** Имя компании со страницы: og:site_name → первый «осмысленный» сегмент
 *  title → корень домена. Для поисковых запросов (Serper), не для отображения. */
export function deriveCompanyName(html: string, url: string): string {
  if (html) {
    const $ = cheerio.load(html);
    const og = ($('meta[property="og:site_name"]').attr('content') ?? '').trim();
    if (og.length >= 2) return clean(og);
    const appName = ($('meta[name="application-name"]').attr('content') ?? '').trim();
    if (appName.length >= 2) return clean(appName);
    const title = ($('title').first().text() ?? '').trim();
    if (title) {
      const segs = title
        .split(/\s*[—\-|:·»]\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !STOPWORDS.has(s.toLowerCase()));
      if (segs.length > 0) return clean(segs[0]);
    }
  }
  return domainRoot(url);
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Корневой токен домена ("www.komus-contact.ru" → "komus-contact"). */
export function domainRoot(url: string): string {
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest tests/lib/extractors/deriveCompanyName.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/extractors/deriveCompanyName.ts app/tests/lib/extractors/deriveCompanyName.test.ts
git commit -m "feat(signals): derive company name from page for channel search"
```

---

## Task 4: socialCompanyFinder — поиск офиц. канала через Serper

**Files:**
- Create: `app/src/lib/enrich/extractors/socialCompanyFinder.ts`
- Test: `app/tests/lib/extractors/socialCompanyFinder.test.ts`
- Depends on: Task 1 (`filterSocialUrls`), Task 2 (`serperSearch`), Task 3 (`domainRoot`).

- [ ] **Step 1: Failing-тест**

Создать `app/tests/lib/extractors/socialCompanyFinder.test.ts`:
```ts
/** @jest-environment node */
jest.mock('server-only', () => ({}));

import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.SERPER_API_KEY;

// Роутим мок по URL: запросы к serper.dev → организик; всё прочее → HEAD-проверка.
function route(handlers: { serper: () => unknown; head: (url: string) => unknown }) {
  (global.fetch as unknown) = jest.fn().mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('serper.dev')) return Promise.resolve(handlers.serper());
    return Promise.resolve(handlers.head(u));
  });
}
function serperRes(organic: unknown) {
  return { ok: true, status: 200, json: async () => ({ organic }) };
}

beforeEach(() => { process.env.SERPER_API_KEY = 'k'; });
afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = ORIG_KEY;
  jest.clearAllMocks();
});

it('returns [] without a serper key', async () => {
  delete process.env.SERPER_API_KEY;
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('finds a company telegram channel matching the domain', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_official', title: 'Acme', snippet: 'acme.ru — наш канал' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual(['https://t.me/acme_official']);
});

it('rejects an unrelated channel (no name/domain match)', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/random_news', title: 'Случайный', snippet: 'ни при чём' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('drops a matched but unreachable channel', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_dead', title: 'Acme', snippet: 'acme.ru' }]),
    head: () => ({ ok: false }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('drops bots even if returned by search', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_bot', title: 'Acme', snippet: 'acme.ru' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest tests/lib/extractors/socialCompanyFinder.test.ts`
Expected: FAIL (модуля нет).

- [ ] **Step 3: Реализовать `socialCompanyFinder.ts`**

```ts
import 'server-only';
import { serperSearch, hasSerperKey } from '@/lib/search/serperClient';
import { filterSocialUrls } from '@/lib/enrich/extractors/socialMediaExtractor';
import { domainRoot } from '@/lib/enrich/extractors/deriveCompanyName';

const MAX_QUERIES = 4;
const VERIFY_TIMEOUT_MS = 6_000;

/**
 * Найти официальные каналы компании (Telegram/VK) через Google/Serper, когда
 * на сайте соцсетей нет. Возвращает только релевантные (имя/домен встречаются
 * в выдаче), прошедшие общий фильтр (боты/личные/потолки) и достижимые (HEAD).
 * Best-effort: нет ключа / сбой → []. Никогда не throw'ит.
 */
export async function findCompanySocials(
  companyName: string,
  domain: string,
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  if (!hasSerperKey()) return [];
  const name = (companyName ?? '').trim();
  const root = domainRoot(domain ?? '');
  if (!name && !root) return [];

  const queries = buildQueries(name, root).slice(0, MAX_QUERIES);
  const candidates: string[] = [];
  for (const q of queries) {
    if (opts?.signal?.aborted) break;
    const items = await serperSearch(q, { num: 10, signal: opts?.signal });
    for (const it of items) {
      const link = (it.link ?? '').trim();
      if (link && matchesCompany(it, name, root)) candidates.push(link);
    }
  }

  const filtered = filterSocialUrls(candidates);
  const verified: string[] = [];
  for (const url of filtered) {
    if (opts?.signal?.aborted) break;
    if (await verifyReachable(url, opts?.signal)) verified.push(url);
  }
  return verified;
}

function buildQueries(name: string, root: string): string[] {
  const q: string[] = [];
  if (name) { q.push(`site:t.me ${name}`); q.push(`site:vk.com ${name}`); }
  if (root) { q.push(`site:t.me ${root}`); q.push(`site:vk.com ${root}`); }
  return Array.from(new Set(q));
}

function matchesCompany(
  it: { title?: string; snippet?: string; link?: string },
  name: string,
  root: string,
): boolean {
  const text = `${it.title ?? ''} ${it.snippet ?? ''} ${it.link ?? ''}`.toLowerCase();
  if (root.length >= 3 && text.includes(root.toLowerCase())) return true;
  const tokens = name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  return tokens.some((t) => text.includes(t));
}

async function verifyReachable(url: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx jest tests/lib/extractors/socialCompanyFinder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/extractors/socialCompanyFinder.ts app/tests/lib/extractors/socialCompanyFinder.test.ts
git commit -m "feat(signals): find official company channels via Serper when site has none"
```

---

## Task 5: websiteSignalProcessor — единый разбор соцсетей + добор + события

**Files:**
- Modify: `app/src/lib/enrich/websiteSignalProcessor.ts`
- Test: `app/tests/lib/websiteSignalProcessor.test.ts`
- Depends on: Task 1, 3, 4.

- [ ] **Step 1: Failing-тесты процессора**

В `websiteSignalProcessor.test.ts` добавить мок finder к существующим `jest.mock(...)` (вверху файла, рядом с другими):
```ts
jest.mock('@/lib/enrich/extractors/socialCompanyFinder', () => ({
  findCompanySocials: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/enrich/extractors/socialPostsExtractor', () => ({
  extractSocialPosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/enrich/extractors/eventDetector', () => ({
  detectEventSignals: jest.fn().mockResolvedValue({ event_opening: true, event_opening_summary: 'Новый офис' }),
}));
```
И импорты для проверок (рядом с существующими import):
```ts
import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';
import { extractSocialPosts } from '@/lib/enrich/extractors/socialPostsExtractor';
const findCompanySocialsMock = findCompanySocials as jest.MockedFunction<typeof findCompanySocials>;
const extractSocialPostsMock = extractSocialPosts as jest.MockedFunction<typeof extractSocialPosts>;
```
Добавить новый describe в конец файла:
```ts
describe('processSignalsForUrl — social media discovery', () => {
  const ORIG_FETCH = global.fetch;
  beforeEach(() => {
    fetchHtmlWithRetryMock.mockReset();
    fetchHtmlWithPlaywrightMock.mockReset();
    findCompanySocialsMock.mockReset().mockResolvedValue([]);
    extractSocialPostsMock.mockReset().mockResolvedValue([]);
    // HEAD-пробы подстраниц (/about) → быстро «нет», без реальной сети.
    (global.fetch as unknown) = jest.fn().mockResolvedValue({ ok: false });
    delete process.env.SIGNALS_SOCIAL_DEEP;
  });
  afterEach(() => { global.fetch = ORIG_FETCH; delete process.env.SIGNALS_SOCIAL_DEEP; });

  it('reads socials from static footer without deep recall', async () => {
    const html = `<html><body><footer><a href="https://t.me/realco">tg</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html, status: 200 });
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://t.me/realco']);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('renders with Playwright when static HTML has no socials', async () => {
    const bare = `<html><body><p>no socials</p></body></html>`;
    const rendered = `<html><body><footer><a href="https://vk.com/rendered">vk</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(rendered);
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://vk.com/rendered']);
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('falls back to Serper finder when static and Playwright are both empty', async () => {
    const bare = `<html><body><p>none</p></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(bare);
    findCompanySocialsMock.mockResolvedValue(['https://t.me/found_by_search']);
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://t.me/found_by_search']);
    expect(findCompanySocialsMock).toHaveBeenCalled();
  });

  it('SIGNALS_SOCIAL_DEEP=0 disables Playwright + Serper recall', async () => {
    process.env.SIGNALS_SOCIAL_DEEP = '0';
    const bare = `<html><body><p>none</p></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual([]);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('feeds the resolved social urls into the event pipeline', async () => {
    const html = `<html><body><footer><a href="https://t.me/realco">tg</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html, status: 200 });
    const result = await processSignalsForUrl('example.com', {
      extractors: ['social_media', 'event_opening', 'event_opening_summary'],
    });
    expect(extractSocialPostsMock).toHaveBeenCalledWith(['https://t.me/realco'], expect.anything());
    expect('event_opening' in result && result.event_opening).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: FAIL (нет добора/флага; события не используют общий список).

- [ ] **Step 3: Реализовать изменения в `websiteSignalProcessor.ts`**

(a) Заменить импорт `extractSocialMedia` и добавить новые (рядом со строкой 27):
```ts
import { extractSocialMedia, filterSocialUrls } from '@/lib/enrich/extractors/socialMediaExtractor';
import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';
import { deriveCompanyName } from '@/lib/enrich/extractors/deriveCompanyName';
```

(b) Добавить хелпер рядом с `anyEventRequested`:
```ts
// Глубокий добор соцсетей (рендер браузером + поиск через Serper) дорогой —
// читаем флаг на каждом вызове, чтобы прод/тесты могли включить «быстрый
// режим» SIGNALS_SOCIAL_DEEP=0.
function socialDeepEnabled(): boolean {
  return (process.env.SIGNALS_SOCIAL_DEEP ?? '1') !== '0';
}
```

(c) Заменить блок `if (extractors.includes('social_media')) { … out.social_media = merged; }` на единый разбор:
```ts
  // ── Соцсети (общий результат для колонки «Соцсети» и для событий) ──────────
  // static (main+about) → если пусто и включён deep: рендер браузером → если
  // всё ещё пусто: поиск офиц. канала через Serper. Все источники проходят один
  // фильтр (боты/личные/чужие/потолки) в filterSocialUrls.
  const needSocial = extractors.includes('social_media') || anyEventRequested(extractors);
  let socialUrls: string[] = [];
  if (needSocial) {
    socialUrls = filterSocialUrls([
      ...extractSocialMedia(main.html),
      ...(subpageHtml.about ? extractSocialMedia(subpageHtml.about) : []),
    ]);
    if (socialUrls.length === 0 && socialDeepEnabled() && !signal?.aborted) {
      if (main.method === 'http') {
        const rendered = await fetchHtmlWithPlaywright(normalized, {
          timeout: PLAYWRIGHT_TIMEOUT_MS,
          signal,
        });
        if (rendered) socialUrls = extractSocialMedia(rendered);
      }
      if (socialUrls.length === 0 && !signal?.aborted) {
        let host = '';
        try { host = new URL(normalized).hostname; } catch { /* ignore */ }
        socialUrls = await findCompanySocials(deriveCompanyName(main.html, normalized), host, { signal });
      }
    }
    if (extractors.includes('social_media')) out.social_media = socialUrls;
  }
```

(d) В блоке событий заменить вычисление `socialUrlsForEvents` (и его использование) на общий `socialUrls`:
```ts
  if (anyEventRequested(extractors) && !signal?.aborted) {
    // socialUrls уже вычислен выше (static → render → Serper), переиспользуем.
    const posts = socialUrls.length > 0
      ? await extractSocialPosts(socialUrls, {
          timeout: subpageTimeout,
          maxPostsPerNetwork: 10,
          signal,
        })
      : [];
```
(остальная часть блока событий — `aboutText`, вызов `detectEventSignals`, присвоение `out.event_*` — без изменений.)

- [ ] **Step 4: Запустить — проходит (новый describe + существующие)**

Run: `npx jest tests/lib/websiteSignalProcessor.test.ts`
Expected: PASS (включая существующие stack/profile/playwright-тесты — они не запрашивают соцсети/события, путь добора не активируется).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/websiteSignalProcessor.ts app/tests/lib/websiteSignalProcessor.test.ts
git commit -m "feat(signals): unified social discovery (static→render→Serper), reuse for events"
```

---

## Task 6: eventDetector — ниша-независимый промпт

**Files:**
- Modify: `app/src/lib/enrich/extractors/eventDetector.ts`
- Test: `app/tests/lib/extractors/eventDetector.test.ts`

- [ ] **Step 1: Failing-тест на промпт**

Добавить в `eventDetector.test.ts` (в describe «parsing» или отдельный) тест, проверяющий системный промпт:
```ts
  it('uses a niche-agnostic system prompt (no HoReCa lock-in)', async () => {
    setApiKey('test-key');
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ event_opening: false, event_redesign: false, event_renovation: false, event_geo: [] }) } }],
      }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await detectEventSignals({ socialPosts: SAMPLE_POSTS });

    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const sys = body.messages.find((m) => m.role === 'system')!.content.toLowerCase();
    expect(sys).toContain('любой ниши');
    expect(sys).not.toContain('horeca');
  });

  it('detects a non-HoReCa opening (new office)', async () => {
    setApiKey('test-key');
    mockLlmResponse({
      event_opening: true,
      event_opening_summary: 'Открыли новый офис разработки в Новосибирске.',
      event_redesign: false,
      event_renovation: false,
      event_geo: ['Новосибирск'],
    });
    const result = await detectEventSignals({
      socialPosts: [{ network: 'telegram', url: 'https://t.me/s/itco', text: 'Открыли новый офис разработки в Новосибирске!', date: '2026-06-01' }],
    });
    expect(result.event_opening).toBe(true);
    expect(result.event_geo).toEqual(['Новосибирск']);
  });
```

- [ ] **Step 2: Запустить — падает**

Run: `npx jest tests/lib/extractors/eventDetector.test.ts -t "niche-agnostic"`
Expected: FAIL (текущий промпт содержит «HoReCa», не содержит «любой ниши»).

- [ ] **Step 3: Заменить `SYSTEM_PROMPT` в `eventDetector.ts`**

```ts
const SYSTEM_PROMPT = `Ты — аналитик сигналов для B2B-аутрича по компаниям ЛЮБОЙ ниши (услуги, IT, производство, ритейл, медицина, общепит, строительство, образование и т.д.). Тебе даются последние посты из соцсетей компании, последний пост блога и текст страницы «О компании». Найди 4 КЛЮЧЕВЫХ СОБЫТИЯ:

1. event_opening — компания запускает/открывает что-то новое: новый офис/филиал/точку/представительство, новый продукт/услугу/направление, выход в новый город или на новый рынок. Сигналы: «открываем», «скоро открытие», «запускаем», «новый офис/филиал/направление», «теперь и в <город>», «вышли на рынок», предзапуски и анонсы.

2. event_redesign — ребрендинг / редизайн / смена концепции. Сигналы: «обновили логотип», «новый бренд», «ребрендинг», «новый сайт», «новая концепция», «новое имя», смена названия, обновление фирменного стиля/позиционирования.

3. event_renovation — ремонт / переезд / новое помещение. Сигналы: «закрываемся на ремонт», «реновация», «реконструкция», «переезжаем», «новый офис/пространство», «после ремонта», «обновляем помещение».

4. event_geo — список городов, где у компании есть присутствие (офисы/филиалы/точки/представительства). Русские названия через запятую: «Москва», «Санкт-Петербург», «Казань». Только реальное присутствие — НЕ «доставляем по всей России». Если городов нет — пустой список.

Верни строго JSON (без markdown), форма:
{
  "event_opening": true | false,
  "event_opening_summary": "1-2 предложения о событии открытия (где, когда, что именно) или пустая строка если события нет",
  "event_redesign": true | false,
  "event_redesign_summary": "...",
  "event_renovation": true | false,
  "event_renovation_summary": "...",
  "event_geo": ["город1", "город2"] (может быть пустым),
  "event_geo_summary": "1 предложение про географию (например 'штаб в Москве, 4 точки в Питере') или пустая строка"
}

Правила вывода:
- true ставь только если в тексте ЕСТЬ явное упоминание события. Не додумывай по общим словам типа «развиваемся» / «растём».
- false ставь когда посты прочитал, но события явно нет.
- summary должна быть КОНКРЕТНОЙ: укажи где / когда / что именно. Без воды типа «компания активно развивается». Максимум 2 предложения.
- summary пустая строка когда signal=false.
- НЕ путай: открытие ≠ ребрендинг ≠ ремонт. Если в одном посте несколько событий — все true.
- geo: только города реального присутствия, не зоны доставки.`;
```
(Схема ответа и парсинг ниже — без изменений.)

- [ ] **Step 4: Запустить — проходит (новые + существующие)**

Run: `npx jest tests/lib/extractors/eventDetector.test.ts`
Expected: PASS (схема/парсинг не менялись → старые тесты зелёные; новые — про промпт и не-HoReCa).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/enrich/extractors/eventDetector.ts app/tests/lib/extractors/eventDetector.test.ts
git commit -m "feat(signals): make event detector niche-agnostic (not HoReCa-only)"
```

---

## Task 7: Полная верификация

**Files:** —

- [ ] **Step 1: Прогнать все затронутые тесты**

Run (из `app/`):
```bash
npx jest tests/lib/extractors/socialMediaExtractor.test.ts tests/lib/search/serperClient.test.ts tests/lib/extractors/deriveCompanyName.test.ts tests/lib/extractors/socialCompanyFinder.test.ts tests/lib/websiteSignalProcessor.test.ts tests/lib/extractors/eventDetector.test.ts
```
Expected: все PASS.

- [ ] **Step 2: Полный прогон unit-тестов + lint**

Run (из `app/`): `npm test` затем `npm run lint`
Expected: зелёно; новых регрессий нет.

- [ ] **Step 3: Проверка типов**

Run (из `app/`): `npx tsc --noEmit`
Expected: без ошибок в изменённых/новых файлах.

- [ ] **Step 4 (опц.): дымовой прогон на реальном URL**

Убедиться, что заданы `SERPER_API_KEY` и `OPENROUTER_SIGNALS_API_KEY` (или `OPENROUTER_BRIEF_API_KEY`), затем прогнать выгрузку сигналов с пресетом «Все» на 3–5 компаниях с JS-сайтами (напр. lidorium.ru, syntonic.ru) и проверить, что «Соцсети» заполнились, а событийные колонки дают Да/Нет (не сплошной «–»).

---

## Примечания

- **Производительность:** добор (Playwright ~10–18 с + Serper ~1–3 с) срабатывает только когда static-разбор дал 0 соцсетей. Отключается `SIGNALS_SOCIAL_DEEP=0`.
- **Junk-лиды** (rbc.ru / vc.ru / заголовки статей вместо компаний) — вне scope этого плана; отдельная задача по качеству входного списка.
- **Env:** `SERPER_API_KEY` (поиск каналов), `OPENROUTER_SIGNALS_API_KEY || OPENROUTER_BRIEF_API_KEY` (события). Без `SERPER_API_KEY` Serper-шаг тихо пропускается (Playwright-добор работает).
