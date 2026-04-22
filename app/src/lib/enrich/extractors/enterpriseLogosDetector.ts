/**
 * Curated list of major RU + Global enterprises whose name in a customer
 * list is a strong signal of "the website serves enterprise clients".
 *
 * Match rule: case-insensitive, normalized (strip punctuation), word-boundary.
 * Add/remove names here without touching call sites.
 */
const ENTERPRISE_NAMES_LOWER: string[] = [
  'сбербанк', 'сбер',
  'газпром', 'лукойл', 'роснефть', 'татнефть', 'башнефть',
  'магнит', 'x5', 'пятёрочка', 'пятерочка', 'перекрёсток', 'перекресток', 'лента',
  'мтс', 'билайн', 'мегафон', 'tele2', 'теле2', 'ростелеком',
  'тинькофф', 'tinkoff', 'альфа-банк', 'alfa-bank', 'втб', 'райффайзен', 'raiffeisen',
  'северсталь', 'нлмк', 'норникель', 'норильский никель',
  'яндекс', 'yandex', 'mail.ru', 'mailru', 'vk', 'vk group',
  'авито', 'avito', 'ozon', 'wildberries', 'lamoda', 'самокат', 'delivery club', 'самолёт',
  'аэрофлот', 'ржд', 'росатом',
  'microsoft', 'google', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'tesla',
  'salesforce', 'oracle', 'ibm', 'sap', 'adobe', 'cisco', 'intel', 'nvidia',
  'samsung', 'sony', 'toyota', 'boeing',
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

export function detectEnterpriseLogos(names: string[]): boolean {
  if (!names || names.length === 0) return false;
  for (const raw of names) {
    const norm = normalizeName(raw);
    if (!norm) continue;
    for (const enterprise of ENTERPRISE_NAMES_LOWER) {
      if (norm === enterprise) return true;
      const re = new RegExp(`(^|[\\s\\-])${escapeRegex(enterprise)}([\\s\\-]|$)`);
      if (re.test(norm)) return true;
    }
  }
  return false;
}
