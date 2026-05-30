import * as cheerio from 'cheerio';
import { Currency, PriceValue } from './types';

const FREE_TRIAL_RE = /free trial|free forever|бесплатно навсегда|14[-\s]?days?\s+(?:free\s+)?trial|пробный период|попроб[а-яё]+\s+бесплатно|start (?:your )?free trial|тестовый доступ|демо[-\s]?доступ|бесплатная версия|free plan|try (?:it )?free|бесплатный тариф|бесплатный план|0\s*[₽$€]\s*\/\s*мес/i;

const MAX_PRICE = 100_000_000;
// A real service starting price is never a single-digit token — this floor
// kills the "1 ₽ / 2 ₽ / 5 ₽" noise the old global-minimum logic produced.
const MIN_PRICE = 10;

/** One price token — currency may sit before or after the number. */
const PRICE_TOKEN_RE =
  /(₽|руб(?:лей|ля|\.)?|\$|usd|eur|€)\s*(\d[\d\s]{0,8}\d|\d)|(\d[\d\s]{0,8}\d|\d)\s*(₽|руб(?:лей|ля|\.)?|\$|usd|eur|€)/gi;

/** CSS classes / ids / microdata that reliably mark a price or tariff block. */
const PRICE_BLOCK_SELECTOR = [
  '[class*="price"]', '[class*="pricing"]', '[class*="tariff"]', '[class*="tarif"]',
  '[class*="plan"]', '[class*="cost"]', '[class*="subscription"]',
  '[id*="price"]', '[id*="pricing"]', '[id*="tariff"]',
  '[itemprop="price"]', '[itemprop="offers"]',
].join(', ');

// A price elsewhere on the page is trusted only when it sits next to genuine
// pricing context: a keyword right before it, or a period marker right after.
const BEFORE_CTX_RE = /(?:^|[\s(])(?:от|тариф\w*|стоимост\w*|цен[аеоуы]|прайс\w*|pricing|price)\s*$/i;
const AFTER_CTX_RE = /^\s*(?:\/|за|в|per)?\s*(?:мес|month|mo\b|год|year|сут|day|чел|user|польз|проект|час|hour)/i;

// Per-unit / per-action rates ("от 590 ₽ за лид", "≈ 43 ₽ за лид", "5 ₽/SMS").
// These are unit prices, not a service's entry cost — they must not define the
// minimum unless the company publishes nothing else (see chooser below).
const PER_UNIT_AFTER_RE =
  /^\s*(?:\/|за)\s*(?:1\s*)?(?:лид\w*|клик\w*|клиент\w*|контакт\w*|заявк\w*|обращени\w*|показ\w*|подписчик\w*|регистрац\w*|касани\w*|посетител\w*|переход\w*|просмотр\w*|анкет\w*|номер\w*|целев\w*\s*действ\w*|смс|sms|звонок|звонк\w*)|^\s*per\s+(?:lead|click|contact|visit|impression|action)/i;

function detectCurrency(token: string): Currency {
  const lower = token.toLowerCase();
  if (lower.includes('₽') || lower.startsWith('руб')) return 'RUB';
  if (lower.includes('$') || lower === 'usd') return 'USD';
  if (lower.includes('€') || lower === 'eur') return 'EUR';
  return 'unknown';
}

function parsePriceValue(raw: string): number | null {
  const clean = raw.replace(/\s/g, '').replace(/,(\d{2})$/, '.$1');
  const value = parseFloat(clean);
  if (isNaN(value) || value < MIN_PRICE || value > MAX_PRICE) return null;
  return Math.round(value);
}

/** A parsed price plus whether it is a per-unit rate (per lead/click/…). */
type Candidate = PriceValue & { perUnit: boolean };

function priceFromMatch(m: RegExpExecArray, after: string): Candidate | null {
  const cur = m[1] ?? m[4] ?? '';
  const num = m[2] ?? m[3] ?? '';
  const value = parsePriceValue(num);
  if (value === null) return null;
  return { value, currency: detectCurrency(cur), perUnit: PER_UNIT_AFTER_RE.test(after) };
}

/** Strip tags so adjacent elements are separated by whitespace, decode the
 *  few entities that matter for prices, and collapse runs of spaces. */
function htmlToSpacedText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#8381;|&#x20bd;/gi, '₽')
    .replace(/&#36;/g, '$')
    .replace(/&[a-z]{2,8};|&#\d{2,6};|&#x[0-9a-f]{2,5};/gi, ' ')
    .replace(/\s+/g, ' ');
}

/** Collect every price token in a string (used for trusted price blocks). */
function collectAll(text: string, out: Candidate[]): void {
  PRICE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRICE_TOKEN_RE.exec(text))) {
    const end = m.index + m[0].length;
    const pv = priceFromMatch(m, text.slice(end, end + 16));
    if (pv) out.push(pv);
  }
}

/** Collect price tokens that have nearby pricing context (used for body text). */
function collectInContext(text: string, out: Candidate[]): void {
  PRICE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRICE_TOKEN_RE.exec(text))) {
    const end = m.index + m[0].length;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(end, end + 16);
    if (BEFORE_CTX_RE.test(before) || AFTER_CTX_RE.test(after)) {
      const pv = priceFromMatch(m, after);
      if (pv) out.push(pv);
    }
  }
}

/**
 * Extract the minimum service price and free-trial flag from a pricing page.
 *
 * Prices are only trusted when they are either (a) inside an explicit
 * price/tariff block, or (b) next to pricing context ("от 30 000 ₽",
 * "990 ₽/мес"). A bare "<number><currency>" anywhere on the page is ignored —
 * the old "global minimum of every number" logic produced noise like "2 ₽".
 */
export function extractPricingDetails(html: string): { pricing_min?: PriceValue; free_trial: boolean } {
  if (!html) return { free_trial: false };

  const spacedText = htmlToSpacedText(html);
  const free_trial = FREE_TRIAL_RE.test(spacedText);

  const prices: Candidate[] = [];

  // 1. Any price inside an explicit price/tariff block is trusted as-is.
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  $(PRICE_BLOCK_SELECTOR).each((_, el) => {
    collectAll($(el).text(), prices);
  });

  // 2. Prices elsewhere need nearby pricing context.
  collectInContext(spacedText, prices);

  if (prices.length === 0) return { free_trial };

  // Prefer package/plan/period prices. A per-unit rate ("от 590 ₽ за лид")
  // defines the service minimum only when nothing else is published — otherwise
  // a tiny per-lead price would mask the real entry tariff.
  const packagePrices = prices.filter((p) => !p.perUnit);
  const pool = packagePrices.length > 0 ? packagePrices : prices;

  let min = pool[0];
  for (const p of pool) {
    if (p.value < min.value) min = p;
  }
  return { pricing_min: { value: min.value, currency: min.currency }, free_trial };
}
