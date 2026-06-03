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
  'сбербанк', 'сбер', 'тинькофф', 'tinkoff', 'альфа-банк', 'альфа банк', 'alfa-bank', 'втб',
  'райффайзен', 'raiffeisen', 'газпромбанк', 'россельхозбанк', 'промсвязьбанк', 'открытие',
  'банк россии', 'росбанк', 'мкб', 'московский кредитный банк', 'home credit', 'хоум кредит',
  'mts банк', 'мтс банк', 'ак барс', 'почта банк', 'юникредит', 'unicredit',
  // Oil & gas
  'газпром', 'лукойл', 'роснефть', 'татнефть', 'башнефть', 'сургутнефтегаз', 'новатэк', 'газпром нефть',
  // Metals & mining
  'северсталь', 'нлмк', 'норникель', 'норильский никель', 'русал', 'evraz', 'евраз', 'полюс',
  'мечел', 'трубная металлургическая компания', 'тмк',
  // Retail
  'магнит', 'x5', 'пятёрочка', 'пятерочка', 'перекрёсток', 'перекресток', 'лента',
  'дикси', 'metro', 'ашан', 'auchan', 'ikea', 'леруа мерлен', 'leroy merlin',
  'лемана про', 'лемана', 'oбувь россии', 'спортмастер', 'детский мир', 'fix price',
  'м.видео', 'мвидео', 'эльдорадо', 'eldorado', 'технониколь', 'технопарк', 'техносила',
  'комус', 'komus', 'рив гош', 'rive gauche', 'летуаль', 'iль де ботэ', 'золотое яблоко',
  'аптеки 36.6', '36.6', 'эко-культура', 'эко культура', 'mагнолия', 'tchibo', 'тинькофф магазин',
  // Telecom
  'мтс', 'билайн', 'мегафон', 'tele2', 'теле2', 'ростелеком', 'ер-телеком', 'ттк', 'мгтс',
  // Tech RU
  'яндекс', 'yandex', 'mail.ru', 'mailru', 'vk', 'vk group', 'касперский', 'kaspersky',
  'positive technologies', '1с', '1c', 'сбер devices', 'сбер ai', 'astra linux', 'астра линукс',
  'диасофт', 'r-style softlab', 'крок', 'croc', 'lanit', 'ланит', 'softline', 'софтлайн',
  // Marketplaces & delivery
  'авито', 'avito', 'ozon', 'wildberries', 'lamoda', 'самокат', 'delivery club',
  'сбермаркет', 'циан', 'cian', 'яндекс маркет', 'aliexpress', 'алиэкспресс', 'мегамаркет',
  'яндекс еда', 'яндекс лавка', 'купер', 'kupiprodai', 'юла',
  // Construction & real estate
  'самолёт', 'самолет', 'пик', 'донстрой', 'эталон', 'lsr', 'лср', 'инград',
  // Transport
  'аэрофлот', 'ржд', 's7', 'победа', 'ютэйр', 'utair', 'россия авиалинии',
  // State / infrastructure
  'росатом', 'ростех', 'россети', 'почта россии', 'росводоканал', 'росреестр',
  'сбербанк-технологии', 'мосэнерго', 'фск еэс', 'газпром медиа',
  // Insurance
  'ингосстрах', 'росгосстрах', 'ресо', 'согаз', 'альфастрахование', 'ренессанс страхование',
  'тинькофф страхование', 'манго страхование', 'вск',
  // Media
  'первый канал', 'нтв', 'вгтрк', 'тасс', 'риа новости', 'rbc', 'рбк', 'forbes',
  // Russian agriculture / food
  'мираторг', 'черкизово', 'эфко', 'данон', 'danone', 'нестле россия', 'марс россия',
  // Russian pharma
  'фармстандарт', 'отисифарм', 'р-фарм', 'инвитро', 'invitro', 'хеликс', 'хеликс лаборатория',
  // Global tech
  'microsoft', 'google', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'tesla',
  'salesforce', 'oracle', 'ibm', 'sap', 'adobe', 'cisco', 'intel', 'nvidia',
  'samsung', 'sony', 'toyota', 'boeing', 'siemens', 'philips', 'bmw', 'mercedes',
  'volkswagen', 'huawei', 'xiaomi', 'uber', 'airbnb', 'spotify', 'twitter',
  'linkedin', 'slack', 'zoom', 'shopify', 'stripe', 'paypal', 'visa', 'mastercard',
  'dell', 'hp', 'lenovo', 'asus', 'lg', 'panasonic', 'bosch', 'nestle', 'unilever',
  'coca-cola', 'pepsi', 'pepsico', 'procter', 'p&g', 'johnson', 'pfizer',
  'mckinsey', 'deloitte', 'kpmg', 'pwc', 'ey', 'ernst',
  'nike', 'adidas', 'zara', 'h&m', 'vmware', 'veeam', 'dell emc',
  // Russian B2B IT brands seen in customer lists
  'мой склад', 'моисклад', 'контур', 'kontur', 'битрикс24', 'битрикс', 'инвитро',
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
