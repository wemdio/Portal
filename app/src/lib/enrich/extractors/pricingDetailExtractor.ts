import { Currency, PriceValue } from './types';

const FREE_TRIAL_RE = /free trial|free forever|бесплатно навсегда|14[-\s]?days?\s+(?:free\s+)?trial|пробный период|попроб[а-яё]+\s+бесплатно|start (?:your )?free trial/i;

const PRICE_AFTER_RE = /(\d[\d\s]{0,8}\d|\d)\s*([₽$€]|руб(?:лей|ля|\.)?|usd|eur)/gi;
const PRICE_BEFORE_RE = /([$€]|usd|eur)\s*(\d[\d\s]{0,8}\d|\d)/gi;

const MAX_PRICE = 100_000_000;

function detectCurrency(token: string): Currency {
  const lower = token.toLowerCase();
  if (lower.includes('₽') || lower.startsWith('руб')) return 'RUB';
  if (lower.includes('$') || lower === 'usd') return 'USD';
  if (lower.includes('€') || lower === 'eur') return 'EUR';
  return 'unknown';
}

function parsePriceValue(raw: string): number | null {
  const clean = raw.replace(/\s/g, '');
  const value = parseInt(clean, 10);
  if (isNaN(value) || value <= 0 || value > MAX_PRICE) return null;
  return value;
}

export function extractPricingDetails(html: string): { pricing_min?: PriceValue; free_trial: boolean } {
  if (!html) return { free_trial: false };
  const free_trial = FREE_TRIAL_RE.test(html);

  const prices: PriceValue[] = [];
  let m: RegExpExecArray | null;

  PRICE_AFTER_RE.lastIndex = 0;
  while ((m = PRICE_AFTER_RE.exec(html))) {
    const value = parsePriceValue(m[1]);
    if (value === null) continue;
    prices.push({ value, currency: detectCurrency(m[2]) });
  }

  PRICE_BEFORE_RE.lastIndex = 0;
  while ((m = PRICE_BEFORE_RE.exec(html))) {
    const value = parsePriceValue(m[2]);
    if (value === null) continue;
    prices.push({ value, currency: detectCurrency(m[1]) });
  }

  if (prices.length === 0) return { free_trial };

  let min = prices[0];
  for (const p of prices) {
    if (p.value < min.value) min = p;
  }
  return { pricing_min: min, free_trial };
}
