/**
 * Очистка названий компаний для писем ENG-базы (market='us') — ТОЛЬКО
 * детерминированные правила, без модели.
 *
 * Что делается (по порядку, cleanCompanyNameEn):
 *  1. декоративные кавычки вокруг всего названия; «X LLC dba Y» → Y
 *     (голое «dba» — только после юрформы, «d/b/a» — всегда);
 *  2. хвост-слоган после « | », « • », « · » («Bright Dental | Family
 *     Dentistry in Austin» → «Bright Dental»), если голова — не служебное
 *     слово сайта («Home | …» не трогается);
 *  3. хвост-локация после « - », « – », « — », запятой или в скобках, если
 *     КАЖДОЕ его слово — локация: слово из адреса этой же строки, штат США
 *     (название или код), «USA», сторона света, downtown/uptown/midtown
 *     («The Joint Chiropractic - Plano» при адресе в Plano →
 *     «The Joint Chiropractic»). Хвост после запятой бывает вторым именем
 *     фирмы («Baker, Austin» — два партнёра, и Austin же город строки),
 *     поэтому ОДНО слово после запятой срезается, только если это штат
 *     (название, код капсом) или USA, а хвост с «&»/«and» не срезается вовсе
 *     (commaTailReadsAsPlace);
 *  4. юридическая форма в конце (Inc., LLC, L.L.C., Ltd., Corp., Co., PLLC,
 *     LLP, LP, PC, PA, GmbH …), повторно до трёх раз («Co., Ltd.»); «Co.»
 *     после «&» / «and» — часть бренда («Smith & Co.») и остаётся. Не
 *     срезается и там, где остаток читается не названием (keepsLegalSuffix):
 *     одно общее слово («Spa Corp», «Dental LLC») или, у Co/Corp, «The X»
 *     («The Smile Co» — так называется бренд);
 *  5. пунктуация, повисшая на концах;
 *  6. регистр — только у названия ЦЕЛИКОМ капсом или целиком строчными, и
 *     только у слов, где это безопасно (см. recaseWord): «ACME LOGISTICS» →
 *     «Acme Logistics», «HVAC», «IBM», «KPMG», «LA» остаются капсом. Название
 *     из одного слова не перекрашивается: строчное («ihop») — никогда,
 *     капсом («IHOP») — если и исходное было одним словом. Название капсом,
 *     где есть слово из 2–3 букв с гласной, которого нет в списках (BUY, ACE,
 *     GYM — или ABC, AAA, US), не перекрашивается вовсе: юрформа срезается,
 *     капс остаётся («BEST BUY CO., INC.» → «BEST BUY», а не «Best BUY»).
 * Смешанный регистр («iRobot», «eBay») не трогается никогда.
 *
 * Страж: результат обязан выводиться из исходного (faithfulCompanyName,
 * companyNames.ts) и сохранять хотя бы одно содержательное слово; иначе
 * письмо получает исходное название, как до этой правки.
 *
 * ПОЧЕМУ БЕЗ МОДЕЛИ (раунд 3 переноса, отчёт лейна names-cases). Модельный
 * проход потребовал бы чекпойнта в he_bases.collect_info, а эта колонка до
 * финальной записи несёт харвест задач (до 10 МБ, см. dropCollectWorkState в
 * stages/baseCollect.ts): запись чекпойнта после каждого пакета пересылала бы
 * его целиком. Без чекпойнта повтор стадии платил бы за очистку повторно.
 * Чего правила не чинят: слоган без разделителя («Acme Roofing - Best Roofer
 * in Dallas») и город без адреса в строке остаются как есть; аббревиатура,
 * записанная строчными и с гласной и не попавшая в KEEP_UPPER, в названии из
 * нескольких слов получает только заглавную первую букву («fico scores» →
 * «Fico Scores»), а капсом — тоже («FICO, INC.» → «Fico»); «LA» в
 * названии капсом остаётся «LA» и там, где это испанский артикль («LA QUINTA
 * INNS» → «LA Quinta Inns»); фирма «Jones, Washington» читается штатом
 * («Jones»); общее слово вне списка GENERIC_NAME_WORDS теряет юрформу
 * («Acme Corp» → «Acme» — так и задумано, но и «Shine Corp» → «Shine»).
 */

import {
  displayCompanyName,
  faithfulCompanyName,
  HE_COMPANY_CLEAN_FIELD,
  type HeCompanyCleanRow,
} from './companyNames';

/** Юрформы, которые срезаются в конце всегда (сравнение — без точек, lowercase). */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'pllc', 'plc',
  'llp', 'lllp', 'lp', 'pc', 'pa', 'pbc', 'gmbh', 'pty', 'pte',
]);

/**
 * Юрформы, совпадающие с обычными словами или кодами штатов («Day Spa», «SC»):
 * срезаются, только если написаны с точками («S.p.A.») или отделены запятой.
 */
const GUARDED_LEGAL_SUFFIXES = new Set([
  'sc', 'na', 'ag', 'sa', 'nv', 'bv', 'ab', 'oy', 'as', 'sas', 'srl', 'spa', 'sarl', 'kg',
]);

/** Слова, которые не делают остаток названием: «The Limited» не превращается в «The». */
const NON_SUBSTANTIVE_WORDS = new Set(['the', 'a', 'an', 'and', 'of']);

/** Голова слогана, которая сама не название: «Home | Bright Dental» не трогаем. */
const GENERIC_SITE_WORDS = new Set([
  'home', 'homepage', 'welcome', 'official', 'site', 'website', 'about', 'us', 'contact', 'page',
]);

const US_STATE_CODES = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks',
  'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny',
  'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc',
];

/** Штаты, чьё название — одно слово (хвост «, Texas» срезается и один). */
const US_STATE_SINGLE_WORD_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming',
]);

const US_STATE_NAME_WORDS = [
  ...US_STATE_SINGLE_WORD_NAMES,
  'new', 'hampshire', 'jersey', 'mexico', 'york', 'north', 'carolina', 'dakota', 'rhode', 'island',
  'south', 'west', 'district', 'columbia',
];

/** Слова, которые в хвосте названия всегда означают место, а не бренд. */
const LOCATION_WORDS = new Set([
  ...US_STATE_CODES,
  ...US_STATE_NAME_WORDS,
  'usa', 'us', 'u', 's', 'america', 'united', 'states',
  'east', 'northeast', 'northwest', 'southeast', 'southwest', 'central',
  'downtown', 'uptown', 'midtown',
]);

function words(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hasSubstantiveWord(value: string): boolean {
  return words(value).some((w) => !NON_SUBSTANTIVE_WORDS.has(w));
}

/** Хвост — только места: слова адреса строки и общие слова локаций США. */
function isLocationTail(tail: string, addressWords: ReadonlySet<string>): boolean {
  const list = words(tail);
  if (!list.length || list.length > 5) return false;
  return list.every((w) => LOCATION_WORDS.has(w) || addressWords.has(w));
}

/**
 * Хвост после запятой читается местом, а не вторым именем фирмы. Несколько
 * слов («, North Austin», «, Austin TX») — да (их проверил isLocationTail).
 * Одно слово — только штат: название («, Texas»), код капсом («, TX») или
 * USA; город строки сам по себе («Baker, Austin» при адресе в Austin) — нет:
 * так пишутся и фирмы из двух фамилий. Хвост с «&»/«and» — имена партнёров.
 */
function commaTailReadsAsPlace(tail: string): boolean {
  if (/&|\band\b/i.test(tail)) return false;
  const list = words(tail);
  if (list.length !== 1) return true;
  const word = list[0];
  if (US_STATE_SINGLE_WORD_NAMES.has(word) || word === 'usa') return true;
  return US_STATE_CODES.includes(word) && /^[A-Z]{2}\.?$/.test(tail.trim());
}

const TRIM_EDGE_PUNCTUATION_RE = /^[\s,;:.\-–—|•·/]+|[\s,;:\-–—|•·/]+$/g;

function trimEdges(value: string): string {
  return value.replace(TRIM_EDGE_PUNCTUATION_RE, '').replace(/\.+$/, (dots, offset: number, all: string) =>
    // Одна точка после сокращения до 4 букв («Smith & Co.», «Bros.», «J.B.»)
    // — часть названия; повисшие точки после обычного слова — нет.
    dots === '.' && /(?:^|[\s.&'’-])\p{L}{1,4}$/u.test(all.slice(0, offset)) ? dots : '',
  ).trim();
}

function stripDecorativeQuotes(value: string): string {
  const m = value.match(/^["“”'‘’«»](.+)["“”'‘’«»]$/);
  return m && hasSubstantiveWord(m[1]) ? m[1].trim() : value;
}

/**
 * «Acme Holdings LLC dba Bright Dental» → «Bright Dental». Голое «dba» —
 * только после юрформы: иначе это слово бренда («Remote DBA Experts»).
 */
function takeDbaBrand(value: string): string {
  const m = value.match(/^(.+?)\s(d\/b\/a|d\.b\.a\.?|dba)\s+(.+)$/i);
  if (!m || !hasSubstantiveWord(m[3])) return value;
  if (m[2].toLowerCase() === 'dba') {
    const headLast = (m[1].match(/([A-Za-z][A-Za-z.]*)[\s.,]*$/)?.[1] ?? '').replace(/\./g, '').toLowerCase();
    if (!LEGAL_SUFFIXES.has(headLast) && headLast !== 'co') return value;
  }
  return m[3].trim();
}

function stripTagline(value: string): string {
  const m = value.match(/^(.+?)\s+[|•·]\s+.+$/);
  if (!m) return value;
  const head = m[1].trim();
  const headWords = words(head);
  if (!hasSubstantiveWord(head) || headWords.every((w) => GENERIC_SITE_WORDS.has(w))) return value;
  return head;
}

function stripLocationTail(value: string, addressWords: ReadonlySet<string>): string {
  let current = value;
  for (let i = 0; i < 2; i += 1) {
    const paren = current.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    if (paren && hasSubstantiveWord(paren[1]) && isLocationTail(paren[2], addressWords)) {
      current = paren[1].trim();
      continue;
    }
    const dash = current.match(/^(.+)\s[-–—]\s(.+)$/);
    if (dash && hasSubstantiveWord(dash[1]) && isLocationTail(dash[2], addressWords)) {
      current = dash[1].trim();
      continue;
    }
    const comma = current.match(/^(.+?),\s*([^,]+)$/);
    if (
      comma &&
      hasSubstantiveWord(comma[1]) &&
      isLocationTail(comma[2], addressWords) &&
      commaTailReadsAsPlace(comma[2])
    ) {
      current = comma[1].trim();
      continue;
    }
    break;
  }
  return current;
}

/**
 * Остаток без юрформы — одно общее слово: «Spa Corp» → «Spa», «Dental LLC»
 * → «Dental» читаются в письме не названием, а словом. Юрформу тогда не
 * срезаем (письмо получает имя с ней). Список — частые общие слова названий
 * малого бизнеса; короткие (до 3 букв) берутся из COMMON_SHORT_WORDS.
 */
const GENERIC_NAME_WORDS = new Set([
  'dental', 'dentistry', 'smile', 'smiles', 'health', 'healthcare', 'care', 'medical', 'clinic',
  'wellness', 'pharmacy', 'vision', 'auto', 'motors', 'home', 'homes', 'realty', 'property',
  'properties', 'beauty', 'salon', 'fitness', 'gym', 'design', 'designs', 'media', 'energy', 'solar',
  'power', 'solutions', 'service', 'services', 'systems', 'consulting', 'marketing', 'logistics',
  'transport', 'trucking', 'freight', 'construction', 'builders', 'roofing', 'plumbing', 'electric',
  'heating', 'cooling', 'cleaning', 'landscaping', 'painting', 'flooring', 'insurance', 'capital',
  'financial', 'finance', 'legal', 'studio', 'studios', 'labs', 'group', 'partners', 'holdings',
  'industries', 'enterprises', 'international', 'global', 'national', 'american', 'general',
  'digital', 'creative', 'tech', 'technology', 'technologies', 'software', 'data', 'staffing',
  'food', 'foods', 'coffee', 'pizza', 'bakery', 'travel', 'events', 'printing', 'supply', 'supplies',
  'equipment', 'management', 'investments', 'development', 'security', 'water', 'glass', 'steel',
  'metal', 'metals',
]);

/** Юрформы, которые бывают частью бренда «The X Co» («The Smile Co», «The Honest Co»). */
const BRAND_LIKE_SUFFIXES = new Set(['co', 'corp', 'corporation']);

/** Остаток без юрформы `key` не читается названием — юрформу оставляем. */
function keepsLegalSuffix(rest: string, key: string): boolean {
  const list = words(rest);
  if (list.length === 1 && (GENERIC_NAME_WORDS.has(list[0]) || COMMON_SHORT_WORDS.has(list[0]))) return true;
  return BRAND_LIKE_SUFFIXES.has(key) && list.length === 2 && list[0] === 'the';
}

function stripLegalSuffixes(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    const m = current.match(/^(.*?)([\s,]+)([A-Za-z][A-Za-z.]*)[\s.,]*$/);
    if (!m) break;
    const [, head, separator, last] = m;
    const key = last.replace(/\./g, '').toLowerCase();
    const dotted = last.includes('.') && key.length > 1 && /\.\w/.test(last);
    const comma = separator.includes(',');
    const isSuffix =
      LEGAL_SUFFIXES.has(key) ||
      (GUARDED_LEGAL_SUFFIXES.has(key) && (dotted || comma)) ||
      (key === 'co' && !/(?:&|\band)\s*$/i.test(head));
    if (!isSuffix) break;
    const rest = head.replace(/[\s,]+$/, '');
    if (!hasSubstantiveWord(rest) || keepsLegalSuffix(rest, key)) break;
    current = rest;
  }
  return current;
}

/** Короткие (до 3 букв) слова английского, которые в названии — слова, а не аббревиатуры. */
const COMMON_SHORT_WORDS = new Set([
  'the', 'and', 'of', 'for', 'at', 'in', 'on', 'by', 'to', 'a', 'an', 'or', 'de', 'la', 'le', 'del',
  'van', 'von', 'law', 'bar', 'car', 'pet', 'art', 'spa', 'inn', 'bay', 'oak', 'sun', 'sea', 'sky',
  'red', 'big', 'top', 'one', 'two', 'new', 'old', 'air', 'gas', 'oil', 'tax', 'day', 'joy', 'fit',
  'kid', 'dog', 'cat', 'cup', 'tea', 'ice', 'hot', 'pro', 'web', 'app', 'box', 'fix', 'way', 'lab',
  'hub', 'net', 'my', 'all', 'go', 'bio', 'eco', 'max', 'key', 'job', 'pay', 'fox', 'bee', 'son',
  'men', 'man', 'her', 'his', 'our', 'out', 'up', 'run', 'map', 'pie', 'egg', 'bed', 'tri', 'mid',
  'non', 'pre', 'sub', 'co', 'op', 'dr', 'st', 'mt', 'ft', 'jr', 'sr', 'mr', 'mrs',
]);

/** Служебные слова — строчными, кроме первого слова названия. */
const MINOR_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'by', 'to', 'a', 'an', 'or', 'de', 'la', 'del', 'van', 'von']);

/** Аббревиатуры с гласной, которые иначе стали бы словом («Hvac», «Ihop», «Ibm Services»). */
const KEEP_UPPER = new Set(['hvac', 'usa', 'ymca', 'usaa', 'aarp', 'ceo', 'cpa', 'llc', 'ibm', 'ihop', 'nasa', 'ups']);

/**
 * Известные аббревиатуры, совпадающие со служебным или частым коротким словом
 * («LA» — и Los Angeles, и испанский артикль). Капсом остаются ТОЛЬКО в
 * названии, написанном капсом: там «LA FITNESS» — это LA, и «La Fitness»
 * читается неверно. В строчном названии регистра, по которому судить, нет.
 */
const CAPS_ACRONYMS = new Set(['la']);

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Регистр одного слова названия, написанного целиком капсом (allCaps) или
 * целиком строчными. Решение по слову, а не по названию: «ACME HVAC SERVICES»
 * → «Acme HVAC Services». Скобки и запятые по краям слова не меняются.
 *  - с цифрами: порядковое «1ST» → «1st», остальное — капсом как есть
 *    (строчное «3m» → «3M»);
 *  - известная аббревиатура из CAPS_ACRONYMS в названии капсом — капсом (LA),
 *    раньше правила служебных слов;
 *  - служебное слово не первым — строчными;
 *  - до 3 букв: обычное слово (COMMON_SHORT_WORDS) — с заглавной, иначе это
 *    аббревиатура и остаётся капсом (IBM, JD; название капсом со словом вроде
 *    ABC сюда не доходит — recaseName его не перекрашивает); у строчного названия
 *    аббревиатурой считается только слово без гласных (nyc → NYC), со
 *    гласной — слово (joe → Joe);
 *  - короткие части, склеенные «&» или точкой (AT&T, J.B.), — аббревиатура;
 *  - от 4 букв: с заглавной, если есть гласная и слово не в KEEP_UPPER;
 *    иначе капсом (KPMG, HVAC);
 *  - притяжательное «'S», «O'» и «MC…» — по-английски (JOE'S → Joe's,
 *    O'REILLY → O'Reilly, MCDONALD → McDonald).
 */
function recaseWord(word: string, first: boolean, allCaps: boolean): string {
  const edges = word.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  const [lead, core, tail] = edges ? [edges[1], edges[2], edges[3]] : ['', word, ''];
  if (!core) return word;
  const lower = core.toLowerCase();
  if (/\d/.test(core)) {
    const ordinal = lower.match(/^(\d+)(st|nd|rd|th)$/);
    return `${lead}${ordinal ? `${ordinal[1]}${ordinal[2]}` : core.toUpperCase()}${tail}`;
  }
  // Части внутри слова: AT&T, COCA-COLA, J.B., O'REILLY.
  const parts = core.split(/([-&./'’])/);
  const joinedAcronym = parts.length > 1 && /[&.]/.test(core);
  const possessive = /^.+['’]s$/i.test(core);
  const recased = parts
    .map((part, index) => {
      if (!/\p{L}/u.test(part)) return part;
      const p = part.toLowerCase();
      const prev = parts[index - 1];
      if ((prev === "'" || prev === '’') && p === 's' && index === parts.length - 1) return 's';
      if (allCaps && parts.length === 1 && CAPS_ACRONYMS.has(p)) return p.toUpperCase();
      if (parts.length === 1 && MINOR_WORDS.has(p)) return first ? capitalize(p) : p;
      if (KEEP_UPPER.has(p)) return p.toUpperCase();
      if (joinedAcronym && p.length <= 3) return p.toUpperCase();
      const vowel = /[aeiouy]/.test(p);
      if (p.length <= 3) {
        if (COMMON_SHORT_WORDS.has(p)) return capitalize(p);
        if (possessive && index === 0 && vowel) return capitalize(p);
        if (p.length === 1 || allCaps) return p.toUpperCase();
        return /[aeiou]/.test(p) ? capitalize(p) : p.toUpperCase();
      }
      if (!vowel) return p.toUpperCase();
      if (p.startsWith('mc')) return `Mc${capitalize(p.slice(2))}`;
      return capitalize(p);
    })
    .join('');
  return `${lead}${recased}${tail}`;
}

/** Слов (токенов с буквой или цифрой) в названии. */
function wordTokenCount(value: string): number {
  return value.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * В названии капсом есть слово, которое recaseWord оставил бы капсом, хотя
 * оно может быть обычным словом: 2–3 буквы, есть гласная (y — тоже), и его нет
 * ни в COMMON_SHORT_WORDS, ни в KEEP_UPPER, ни в CAPS_ACRONYMS. По капсу не
 * различить «BUY», «ACE», «JET», «ELM», «GYM», «ZEN» (слова) и «ABC», «AAA»,
 * «AI» (аббревиатуры). Исключения — те же, что у recaseWord: части, склеенные
 * «&» или точкой (AT&T, J.B.), и притяжательное «JOE'S».
 */
function hasAmbiguousCapsShortWord(value: string): boolean {
  return value.split(/\s+/).some((word) => {
    const core = word.match(/^[^\p{L}\p{N}]*(.*?)[^\p{L}\p{N}]*$/u)?.[1] ?? '';
    if (!core || /\d/.test(core)) return false;
    const parts = core.split(/[-&./'’]/);
    if (parts.length > 1 && /[&.]/.test(core)) return false;
    const possessive = /^.+['’]s$/i.test(core);
    return parts.some((part, index) => {
      const p = part.toLowerCase();
      if (p.length < 2 || p.length > 3 || !/[aeiouy]/.test(p) || (possessive && index === 0)) return false;
      return !COMMON_SHORT_WORDS.has(p) && !KEEP_UPPER.has(p) && !CAPS_ACRONYMS.has(p);
    });
  });
}

/**
 * Регистр всего названия — только целиком капсом или целиком строчными.
 * Одно слово не перекрашивается: по нему не видно, слово это или
 * аббревиатура («ihop», «IHOP» — не «Ihop»). Исключение — название капсом,
 * которое стало одним словом после очистки: «MCDONALD'S CORPORATION» — это
 * реестровая запись капсом, и «McDonald's» в ней верно. Название капсом с
 * неоднозначным коротким словом (hasAmbiguousCapsShortWord) не
 * перекрашивается вовсе: «ACE HARDWARE» верно как в источнике, а «ACE
 * Hardware» и «Best BUY» — нет. Цена: «ABC PLUMBING», «US FOODS» тоже остаются
 * капсом (как писали до очистки), а не «ABC Plumbing».
 */
function recaseName(value: string, original: string): string {
  const hasUpper = /\p{Lu}/u.test(value);
  const hasLower = /\p{Ll}/u.test(value);
  if (hasUpper === hasLower) return value;
  const allCaps = hasUpper;
  if (wordTokenCount(value) === 1 && (!allCaps || wordTokenCount(original) === 1)) return value;
  if (allCaps && hasAmbiguousCapsShortWord(value)) return value;
  let seenWord = false;
  return value
    .split(/(\s+)/)
    .map((token) => {
      if (!/[\p{L}\p{N}]/u.test(token)) return token;
      const out = recaseWord(token, !seenWord, allCaps);
      seenWord = true;
      return out;
    })
    .join('');
}

/**
 * Очищенное название для письма. Возвращает исходное (без лишних пробелов),
 * если правила ничего не нашли или результат не прошёл страж.
 * `address` — ячейка адреса той же строки: по её словам узнаётся хвост-город.
 */
export function cleanCompanyNameEn(raw: string, context?: { address?: string }): string {
  const original = displayCompanyName(raw);
  if (!original) return original;
  const addressWords = new Set(words(context?.address ?? ''));
  let name = stripDecorativeQuotes(original);
  name = takeDbaBrand(name);
  name = stripTagline(name);
  name = stripLocationTail(name, addressWords);
  name = stripLegalSuffixes(name);
  name = trimEdges(name);
  // Второй проход тех же правил: хвост, который открылся только после
  // первого («Acme - Plano, LLC» → «Acme - Plano» → «Acme»; «"Acme" Inc» →
  // «"Acme"» → «Acme»).
  name = stripDecorativeQuotes(trimEdges(stripLegalSuffixes(stripLocationTail(name, addressWords))));
  name = recaseName(displayCompanyName(name), original);
  if (!hasSubstantiveWord(name) || !faithfulCompanyName(name, original)) return original;
  return name;
}

/**
 * Дописать строкам ENG-базы очищенное имя (HE_COMPANY_CLEAN_FIELD). Поле
 * ставится только там, где имя для письма отличается от того, что без него
 * подставили бы читатели (ячейка после trim); у остальных строк поля нет (и
 * пришедшее со строкой снимается — значение всегда по текущей ячейке).
 * Возвращает новые объекты только для изменённых строк.
 *
 * Зовёт только сборка market='us' (stages/baseCollect.ts): RU-строки сюда не
 * попадают, и поля у них нет.
 */
export function withHeCleanCompanyNames<T extends { company: string; address?: string } & HeCompanyCleanRow>(
  rows: T[],
): { rows: T[]; changed: number } {
  let changed = 0;
  const out = rows.map((row) => {
    const { [HE_COMPANY_CLEAN_FIELD]: previous, ...rest } = row;
    const cell = String(row.company ?? '').trim();
    const clean = cell ? cleanCompanyNameEn(cell, { address: row.address }) : '';
    if (clean && clean !== cell) {
      changed += 1;
      return { ...rest, [HE_COMPANY_CLEAN_FIELD]: clean } as T;
    }
    return previous === undefined ? row : (rest as T);
  });
  return { rows: out, changed };
}
