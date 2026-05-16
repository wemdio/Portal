/**
 * Генерация и расширение ключевых слов для Yandex Direct парсера.
 *
 * 1. Requesty/Claude → seed-ключи из описания аудитории
 * 2. Yandex Suggest API → расширение каждого seed-ключа (бесплатно)
 *
 * Порт keywords.py. Главное отличие — LLM-вызов идёт не напрямую в
 * Anthropic, а через наш Requesty-прокси (callOpenRouterChat), как и все
 * остальные AI-фичи Портала.
 */
import { callOpenRouterChat } from '@/lib/openrouter/client';
import { sleep } from './parser';

/** Модель для генерации ключей. Хайку достаточно — задача простая. */
const KEYWORD_MODEL = process.env.YANDEX_DIRECT_KEYWORD_MODEL ?? 'anthropic/claude-haiku-4-5';

const SYSTEM_PROMPT = `Ты эксперт по контекстной рекламе и Яндекс Директу.
Твоя задача — подобрать ключевые слова для мониторинга рекламы конкурентов.
Отвечай ТОЛЬКО валидным JSON-массивом строк, без пояснений и markdown.`;

function userPrompt(description: string, n: number): string {
  return `Аудитория / задача:
${description}

Подбери ${n} ключевых слов для мониторинга рекламы конкурентов в Яндекс Директе.

ПРАВИЛА:
- Фразы короткие: 1-3 слова (не длиннее!)
- Только реальные запросы, которые вводят в поиск
- Включи: бренды конкурентов, категорийные слова, проблемные слова

ПРИМЕРЫ хороших ключей: "calltouch", "roistat", "коллтрекинг", "сквозная аналитика", "crm для застройщика"
ПРИМЕРЫ плохих ключей: "сравнение calltouch и roistat для строительства" (слишком длинно)

Верни JSON-массив: ["ключ 1", "ключ 2", ...]`;
}

/**
 * Requesty/Claude генерирует seed-ключи по описанию аудитории.
 * Требует env OPENROUTER_YANDEX_DIRECT_API_KEY.
 */
export async function generateSeeds(description: string, n = 20): Promise<string[]> {
  const apiKey = (process.env.OPENROUTER_YANDEX_DIRECT_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_YANDEX_DIRECT_API_KEY не настроен в env');
  }

  const content = await callOpenRouterChat({
    apiKey,
    model: KEYWORD_MODEL,
    title: 'Portal — Yandex Direct keywords',
    temperature: 0.4,
    maxTokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(description, n) },
    ],
  });

  // Вытаскиваем JSON-массив даже если модель обернула в markdown / текст.
  let text = content.trim();
  if (text.includes('```')) {
    const parts = text.split('```');
    text = parts.length > 1 ? parts[1] : text;
    if (text.startsWith('json')) text = text.slice(4);
  }
  const match = text.match(/\[[\s\S]*\]/);
  if (match) text = match[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`AI вернул невалидный JSON ключей: ${content.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('AI вернул не массив ключей');
  }
  return parsed
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter(Boolean);
}

const SUGGEST_URL = 'https://suggest.yandex.ru/suggest-ya.cgi';

/**
 * Yandex Suggest API — автодополнения для расширения ключей.
 * Бесплатный, без авторизации. Ответ — JSONP вида suggest.apply(ARG1, ARG2).
 */
export async function suggestExpand(
  keyword: string,
  regionCode = 213,
  limit = 10,
): Promise<string[]> {
  try {
    const params = new URLSearchParams({
      part: keyword,
      uil: 'ru',
      lr: String(regionCode),
      limit: String(limit),
      svg: '1',
    });
    const res = await fetch(`${SUGGEST_URL}?${params.toString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const text = (await res.text()).trim();

    // JSONP: suggest.apply(ARG1, ARG2) → оборачиваем в [] для валидного JSON
    let data: unknown;
    if (text.startsWith('suggest.apply(') && text.endsWith(')')) {
      const inner = text.slice('suggest.apply('.length, -1);
      data = JSON.parse(`[${inner}]`);
    } else {
      data = JSON.parse(text);
    }
    // ARG1 = [query, [suggestions], []]
    const arg1 = Array.isArray(data) && data.length > 0 ? data[0] : [];
    const suggestions =
      Array.isArray(arg1) && arg1.length > 1 && Array.isArray(arg1[1]) ? arg1[1] : [];
    return suggestions
      .filter((s): s is string => typeof s === 'string' && s !== keyword)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Расширяет список seed-ключей через Yandex Suggest.
 * Возвращает объединённый список без дублей (seed + expansions).
 */
export async function expandAll(
  seeds: string[],
  regionCode = 213,
  delayMs = 300,
): Promise<string[]> {
  const all = [...seeds];
  const seen = new Set(seeds.map((s) => s.toLowerCase()));
  for (const seed of seeds) {
    const expansions = await suggestExpand(seed, regionCode);
    for (const kw of expansions) {
      const lower = kw.toLowerCase();
      if (!seen.has(lower)) {
        all.push(kw);
        seen.add(lower);
      }
    }
    await sleep(delayMs);
  }
  return all;
}

/**
 * Полный пайплайн генерации ключей:
 *   1. Requesty/Claude → seed-ключи
 *   2. Yandex Suggest → расширение (если expand=true)
 */
export async function buildKeywordList(
  description: string,
  regionCode = 213,
  nSeeds = 20,
  expand = true,
): Promise<string[]> {
  const seeds = await generateSeeds(description, nSeeds);
  if (seeds.length === 0) {
    throw new Error('AI не сгенерировал ни одного ключа');
  }
  if (!expand) return seeds;
  return expandAll(seeds, regionCode);
}
