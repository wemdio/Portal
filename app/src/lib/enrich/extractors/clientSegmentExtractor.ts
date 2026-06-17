import 'server-only';
import * as cheerio from 'cheerio';
import { SIGNALS_LLM_MODEL } from './signalsModel';

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

// Модель централизована в signalsModel.ts (env: OPENROUTER_SIGNALS_MODEL).
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
  // Срезаем с ОБОИХ концов кавычки, точки и пробелы одним проходом (модель
  // иногда оборачивает ответ в кавычки и/или ставит точку, в любом порядке).
  // Внутренние символы не трогаем.
  let s = raw.replace(/^[\s"'«».]+|[\s"'«».]+$/g, '').trim();
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
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
        model: SIGNALS_LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
      }),
    });

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
  } finally {
    clearTimeout(timer);
  }
}
