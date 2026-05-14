import * as cheerio from 'cheerio';
import { PricingModel } from './types';

const FREE_TRIAL_RE = /free trial|free forever|бесплатно навсегда|14[-\s]?days?\s+(?:free\s+)?trial|пробный период|попроб[а-яё]+\s+бесплатно|start (?:your )?free trial|тестовый доступ|демо[-\s]?доступ|бесплатная версия|free plan/i;

const PRICE_RE = /(?:\d[\d\s]{0,8}\d|\d)\s*[₽$€]|[$€]\s*(?:\d[\d\s]{0,8}\d|\d)|\d[\d\s]{0,8}\s*(?:руб|usd|eur)/i;

const CONTACT_CTA_RE = /talk to sales|contact sales|book(?:\s+a)?\s+demo|request (?:a )?demo|заказать демо|связаться с продажами|связаться с менеджером|оставить заявку|оставьте заявку|запросить (?:кп|предложение|коммерческое)|получить предложение|рассчитать стоимость|заказать звонок|обсудить проект|напишите нам|свяжитесь с нами|заказать консультацию|бесплатная консультация|получить консультацию|request (?:a )?quote|get (?:a )?quote|schedule (?:a )?call/i;

const PRICING_WORDS_RE = /pricing|цены|тарифы|стоимость|прайс|\bplans\b|расценки/i;

const ENTERPRISE_WORDS_RE = /enterprise|корпоративн|для крупного бизнеса|enterprise customers|индивидуальн\S*\s+(?:стоимост|цен|тариф|расчёт|расчет)/i;

const PLAN_SELECTOR = '[class*="plan"], [class*="pricing"], [class*="tariff"], [class*="тариф"], [class*="price-card"], [class*="price-table"]';

const CALCULATOR_RE = /калькулятор|calculator|рассчитать|подобрать тариф/i;
const CART_RE = /добавить в корзину|add to cart|купить|buy now|оформить заказ|в корзину/i;

const SERVICE_CTA_RE = /заказать проект|обсудить задачу|обсудить сотрудничество|начать проект|получить (?:кп|коммерческое)|запросить бриф|заполн\S+\s+бриф|оценить проект|оценка проекта|подать заявку|отправить заявку|написать в (?:whatsapp|telegram|чат)|заказать аудит|получить аудит|бесплатный аудит/i;
const FORM_RE = /<form[\s>]|<input[^>]+type=["'](?:text|email|tel|submit)/i;

export function extractPricingModel(html: string): PricingModel {
  if (!html) return 'unknown';
  const text = html;
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  const hasFree = FREE_TRIAL_RE.test(text);
  const hasPrice = PRICE_RE.test(text);
  const hasContact = CONTACT_CTA_RE.test(text) || CONTACT_CTA_RE.test(bodyText);
  const hasPricing = PRICING_WORDS_RE.test(text);
  const hasEnterprise = ENTERPRISE_WORDS_RE.test(text) || ENTERPRISE_WORDS_RE.test(bodyText);
  const hasCalculator = CALCULATOR_RE.test(text) || CALCULATOR_RE.test(bodyText);
  const hasCart = CART_RE.test(text) || CART_RE.test(bodyText);
  const planCount = $(PLAN_SELECTOR).length;

  if (hasFree && hasPrice) return 'freemium';
  if (hasFree) return 'freemium';

  if (hasCart) return 'self-serve';
  if (hasPrice && planCount >= 2) return 'self-serve';
  if (hasPrice && !hasContact) return 'self-serve';

  if (planCount >= 2 && hasContact) return 'sales-led';
  if (hasPrice && hasContact) return 'sales-led';
  if (hasCalculator && hasContact) return 'sales-led';
  if (hasContact && hasEnterprise) return 'enterprise';

  if (hasContact) return 'sales-led';
  if (hasPrice) return 'self-serve';
  if (hasPricing) return 'sales-led';

  const hasServiceCta = SERVICE_CTA_RE.test(text) || SERVICE_CTA_RE.test(bodyText);
  if (hasServiceCta) return 'sales-led';

  const hasForm = FORM_RE.test(text);
  if (hasForm && hasCalculator) return 'sales-led';

  return 'unknown';
}
