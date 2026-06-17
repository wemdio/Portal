import 'server-only';
import * as cheerio from 'cheerio';
import { SIGNALS_LLM_MODEL } from './signalsModel';

/**
 * LLM-счётчик кейсов для столбца «Кол-во кейсов». Вызывается, когда эвристика
 * (extractCasesCount по карточкам/числу) дала 0, но кейсы могут быть в
 * нестандартной вёрстке. Читает ПОЛНЫЙ текст /cases (а не обрезок) и возвращает:
 *   - точное число (approximate:false) → number;
 *   - оценку-минимум (approximate:true) → строка «N+»;
 *   - нет кейсов / ошибка → null.
 * Никогда не throw'ит.
 */

// Модель централизована в signalsModel.ts (env: OPENROUTER_SIGNALS_MODEL).
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
        model: SIGNALS_LLM_MODEL,
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
