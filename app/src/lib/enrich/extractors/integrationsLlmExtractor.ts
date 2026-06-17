import 'server-only';
import * as cheerio from 'cheerio';
import { SIGNALS_LLM_MODEL } from './signalsModel';

/**
 * LLM-добор для столбца «Интеграции». Вызывается, когда итоговый список пуст
 * (нет script-следов через integrationsFromSignals и секцию не распознал
 * extractIntegrations). Читает ПОЛНЫЙ текст /integrations и возвращает список
 * сторонних сервисов, упомянутых как интеграции. Никогда не throw'ит.
 */

// Модель централизована в signalsModel.ts (env: OPENROUTER_SIGNALS_MODEL).
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
        model: SIGNALS_LLM_MODEL,
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
