import * as cheerio from 'cheerio';
import { PricingModel } from './types';

const FREE_TRIAL_RE = /free trial|free forever|бесплатно навсегда|14[-\s]?days?\s+(?:free\s+)?trial|пробный период|попроб[а-яё]+\s+бесплатно|start (?:your )?free trial/i;

const PRICE_RE = /(?:\d[\d\s]{0,8}\d|\d)\s*[₽$€]|[$€]\s*(?:\d[\d\s]{0,8}\d|\d)|\d[\d\s]{0,8}\s*(?:руб|usd|eur)/i;

const CONTACT_CTA_RE = /talk to sales|contact sales|book(?:\s+a)?\s+demo|request (?:a )?demo|заказать демо|связаться с продажами|связаться с менеджером/i;

const PRICING_WORDS_RE = /pricing|цены|тарифы|стоимость|\bplans\b/i;

const ENTERPRISE_WORDS_RE = /enterprise|корпоративн|для крупного бизнеса|enterprise customers/i;

const PLAN_SELECTOR = '[class*="plan"], [class*="pricing-card"], [class*="tariff"], [class*="тариф"], [class*="price-card"]';

export function extractPricingModel(html: string): PricingModel {
  if (!html) return 'unknown';
  const text = html;

  if (FREE_TRIAL_RE.test(text)) return 'freemium';
  if (PRICE_RE.test(text)) return 'self-serve';

  const $ = cheerio.load(html);
  const planCount = $(PLAN_SELECTOR).length;
  const hasContact = CONTACT_CTA_RE.test(text);
  const hasPricing = PRICING_WORDS_RE.test(text);
  const hasEnterprise = ENTERPRISE_WORDS_RE.test(text);

  if (planCount >= 2 && hasContact) return 'sales-led';
  if (hasContact && (hasEnterprise || hasPricing)) return 'enterprise';

  return 'unknown';
}
