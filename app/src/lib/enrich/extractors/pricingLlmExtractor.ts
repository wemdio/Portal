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
