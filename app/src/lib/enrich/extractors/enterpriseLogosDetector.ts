import * as cheerio from 'cheerio';

/**
 * Curated list of major RU + Global enterprises whose name in a customer
 * list is a strong signal of "the website serves enterprise clients".
 *
 * Match rule: case-insensitive, normalized (strip punctuation), word-boundary.
 * Add/remove names here without touching call sites.
 */
const ENTERPRISE_NAMES_LOWER: string[] = [
  // Banks & finance
  'сбербанк', 'сбер', 'тинькофф', 'tinkoff', 'альфа-банк', 'alfa-bank', 'втб',
  'райффайзен', 'raiffeisen', 'газпромбанк', 'россельхозбанк', 'промсвязьбанк', 'открытие',
  // Oil & gas
  'газпром', 'лукойл', 'роснефть', 'татнефть', 'башнефть', 'сургутнефтегаз', 'новатэк',
  // Metals & mining
  'северсталь', 'нлмк', 'норникель', 'норильский никель', 'русал', 'evraz', 'евраз', 'полюс',
  // Retail
  'магнит', 'x5', 'пятёрочка', 'пятерочка', 'перекрёсток', 'перекресток', 'лента',
  'дикси', 'metro', 'ашан', 'auchan', 'ikea', 'леруа мерлен', 'leroy merlin',
  // Telecom
  'мтс', 'билайн', 'мегафон', 'tele2', 'теле2', 'ростелеком', 'ер-телеком',
  // Tech RU
  'яндекс', 'yandex', 'mail.ru', 'mailru', 'vk', 'vk group', 'касперский', 'kaspersky',
  'positive technologies', '1с', '1c',
  // Marketplaces & delivery
  'авито', 'avito', 'ozon', 'wildberries', 'lamoda', 'самокат', 'delivery club',
  'сбермаркет', 'циан', 'cian',
  // Construction & real estate
  'самолёт', 'самолет', 'пик', 'донстрой',
  // Transport
  'аэрофлот', 'ржд', 's7', 'победа',
  // State / infrastructure
  'росатом', 'ростех', 'россети', 'почта россии',
  // Insurance
  'ингосстрах', 'росгосстрах', 'ресо', 'согаз', 'альфастрахование',
  // Media
  'первый канал', 'нтв', 'вгтрк', 'тасс', 'риа новости',
  // Global tech
  'microsoft', 'google', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'tesla',
  'salesforce', 'oracle', 'ibm', 'sap', 'adobe', 'cisco', 'intel', 'nvidia',
  'samsung', 'sony', 'toyota', 'boeing', 'siemens', 'philips', 'bmw', 'mercedes',
  'volkswagen', 'huawei', 'xiaomi', 'uber', 'airbnb', 'spotify', 'twitter',
  'linkedin', 'slack', 'zoom', 'shopify', 'stripe', 'paypal', 'visa', 'mastercard',
  'dell', 'hp', 'lenovo', 'asus', 'lg', 'panasonic', 'bosch', 'nestle', 'unilever',
  'coca-cola', 'pepsi', 'pepsico', 'procter', 'p&g', 'johnson', 'pfizer',
  'mckinsey', 'deloitte', 'kpmg', 'pwc', 'ey', 'ernst',
  'nike', 'adidas', 'zara', 'h&m',
];

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/["'`«»“”„‚‹›]/g, '')
    .replace(/[^\p{L}\p{N}\s.\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAnyEnterprise(norm: string): boolean {
  if (!norm) return false;
  for (const enterprise of ENTERPRISE_NAMES_LOWER) {
    if (norm === enterprise) return true;
    const re = new RegExp(`(^|[\\s\\-])${escapeRegex(enterprise)}([\\s\\-]|$)`);
    if (re.test(norm)) return true;
  }
  return false;
}

export function detectEnterpriseLogos(names: string[]): boolean {
  if (!names || names.length === 0) return false;
  for (const raw of names) {
    if (matchesAnyEnterprise(normalizeName(raw))) return true;
  }
  return false;
}

export function detectEnterpriseInHtml(html: string): boolean {
  if (!html) return false;
  const $ = cheerio.load(html);
  let found = false;
  $('img[alt]').each((_, el) => {
    if (found) return false;
    const alt = ($(el).attr('alt') ?? '').trim();
    if (alt && alt.length >= 2 && alt.length <= 80) {
      if (matchesAnyEnterprise(normalizeName(alt))) found = true;
    }
  });
  return found;
}
