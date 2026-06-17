import 'server-only';
import * as cheerio from 'cheerio';
import { SIGNALS_LLM_MODEL } from './signalsModel';

/**
 * LLM-добор для столбцов «Открытых вакансий» + «Кого нанимают». Вызывается,
 * когда эвристика (extractHiring по карточкам/тексту/агрегаторам) не нашла
 * вакансии и/или профессии. Читает ПОЛНЫЙ текст /careers и одним вызовом
 * возвращает количество вакансий (число | «N+» | null) и список профессий.
 * Никогда не throw'ит.
 */

// Модель централизована в signalsModel.ts (env: OPENROUTER_SIGNALS_MODEL).
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
        model: SIGNALS_LLM_MODEL,
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
