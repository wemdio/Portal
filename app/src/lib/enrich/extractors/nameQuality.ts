/**
 * Shared name-quality predicates for the customers / integrations extractors.
 *
 * The DOM heuristics are deliberately lenient when *collecting* candidates;
 * these predicates are the precision filter. Anything that looks like a CMS
 * image hash, a design-tool export artifact, a nav/CTA label or a marketing
 * service name is rejected so the LLM fallback can take over instead.
 */

const VOWEL_RE = /[aeiouyаеёиоуыэюя]/i;

/**
 * Random CMS/Tilda image basenames look like `ayvervdk9wrpaqde6begp6jfmg`
 * or hex blobs like `3abc4d6a3ca0dabbed3`. Real company names are short,
 * contain spaces, or both — never a long digit-bearing single token.
 */
export function isHashLike(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false; // multi-word → not a hash
  if (/^[0-9a-f]{10,}$/i.test(t)) return true; // pure hex blob
  if (t.length >= 14 && /\d/.test(t)) return true; // long token with a digit
  if (t.length >= 24) return true; // implausibly long single word
  return false;
}

const DESIGN_ARTIFACT_RE: RegExp[] = [
  /^\d*\s*сло[йяе]\s*\d*$/i, // Photoshop "1 Слой 5" layer exports
  /^layer\s*\d*$/i,
  /^frame[\s\d]+$/i, // Figma "Frame 2 6 1"
  /^group\s*\d*$/i,
  /^rectangle\s*\d*$/i,
  /^(?:dummy|placeholder|noimage|untitled|default)\b/i,
  /^slogan\b/i,
  /^slide\s*\d*$/i,
  /^partner\s*\d*$/i, // alt="partner1"
  /^client\s*\d*$/i,
  /^logo\s*\d*$/i,
  /^\d+\s*(?:место|place)$/i, // "6 место" ranking badges
  /^pay\s+(?:icon|arrow)$/i,
];

export function isDesignArtifact(s: string): boolean {
  const t = s.trim();
  return DESIGN_ARTIFACT_RE.some((re) => re.test(t));
}

const CTA_PREFIX_RE =
  /^(?:подробн|читат|посмотрет|смотрет|узнат|скачат|отправ|обсуд|оставит|связат|напиш|подписат|подписк|зарегистр|регистрац|гаранти|преимуществ|политик|цен[аы]|стоимост)/i;

const NAV_EXACT = new Set<string>([
  'меню', 'главная', 'контакты', 'контакт', 'о нас', 'о компании', 'обо мне',
  'команда', 'вакансии', 'вакансия', 'работа у нас', 'отзывы', 'отзыв', 'faq',
  'блог', 'новости', 'услуги', 'наши услуги', 'тарифы', 'тариф', 'стоимость',
  'преимущества', 'карьера', 'войти', 'регистрация',
  'политика конфиденциальности', 'согласие на обработку данных',
  'все новости', 'все кейсы', 'все проекты',
]);

export function isNavOrCtaText(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/[!.…]+$/, '').trim();
  if (!t) return true;
  if (CTA_PREFIX_RE.test(t)) return true;
  if (NAV_EXACT.has(t)) return true;
  return false;
}

const SERVICE_RE =
  /(?:контекстн|таргетир|медийн|нативн|наружн)[а-я]*\s+реклам|\bseo\b|\bsmm\b|перформанс|веб-?аналитик|email-?маркетинг|контент-?маркетинг|управлени[ея]\s+репутаци|\bserm\b|разработк[аи]\s+(?:и\s+редизайн\s+)?сайт|редизайн\s+сайт|аудит\s+и\s+анализ|комплексн\w*\s+маркетинг|лидогенерац/i;

export function isServiceText(s: string): boolean {
  return SERVICE_RE.test(s.trim());
}

/** A candidate good enough to be *positively* counted as a real name. */
export function isPlausibleName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (isHashLike(t) || isDesignArtifact(t) || isNavOrCtaText(t) || isServiceText(t)) return false;
  if (/\s/.test(t)) {
    const words = t.split(/\s+/);
    return words.length <= 5 && t.length <= 50;
  }
  // single token: must read like a word, not a leftover slug
  if (t.length > 22) return false;
  return VOWEL_RE.test(t);
}

/**
 * Processor-level trust gate: decide whether a heuristic name list is good
 * enough to keep, or should be dropped so the LLM fallback runs instead.
 * A list is trusted when a majority of its entries look like real names.
 */
export function nameListLooksReal(names: string[]): boolean {
  if (names.length === 0) return false;
  const plausible = names.filter(isPlausibleName).length;
  return plausible >= Math.ceil(names.length / 2);
}
