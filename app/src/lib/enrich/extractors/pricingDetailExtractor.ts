import * as cheerio from 'cheerio';
import { Currency, PriceValue } from './types';

/**
 * Matches any "free entry-point" phrasing the company offers to try its
 * service. Covers four registers:
 *
 *  1. SaaS classics — "free trial", "free plan", "14-day free trial",
 *     "0₽/мес", "тестовый доступ", "демо-доступ".
 *  2. Agency / consulting — "бесплатная консультация / аудит / демо",
 *     "первая консультация бесплатно", "free strategy session".
 *  3. Education — "пробный урок", "первое занятие бесплатно".
 *  4. RU SMB / services-on-site — "бесплатный замер / выезд / расчёт /
 *     диагностика / доставка", "первый заказ бесплатно", "бесплатный
 *     звонок" — these are how small Russian construction / landscape /
 *     repair / delivery businesses advertise their try-before-you-buy.
 *
 * The trailing "бесплатн[а-яё]+ + X" alternation uses `[а-яё]+` instead of
 * `\w+` because JS `\w` is ASCII-only and would never match "бесплатную".
 */
const FREE_TRIAL_RE = /free trial|free forever|бесплатно навсегда|14[-\s]?days?\s+(?:free\s+)?trial|пробный период|попроб[а-яё]+\s+бесплатно|start (?:your )?free trial|тестовый доступ|демо[-\s]?доступ|бесплатная версия|free plan|try (?:it )?free|бесплатный тариф|бесплатный план|0\s*[₽$€]\s*\/\s*мес|бесплатн[а-яё]*\s+(?:консультац|аудит|демо|тест|урок|пилот|разбор|стратег[а-яё]*\s*сесси|вебинар|занятие|тренировк|пробник|замер|выезд|расч[её]т|диагностик|доставк|звонок|примерк|осмотр|обмер|анализ|проект|эскиз|тестирован|подбор|подключени|настройк|зам[её]р)|free\s+(?:consultation|audit|demo|pilot|strategy\s+session|sample|workshop|estimate|quote|measurement|delivery|installation|setup|onboarding)|первая\s+(?:консультаци|встреч|сесси|урок|занятие|тренировк)[а-яё]*\s+бесплатн|первое\s+(?:занятие|посещени|обращени)\s+бесплатн|первый\s+(?:заказ|выезд|урок|замер|осмотр|месяц)\s+бесплатн|пробн[а-яё]+\s+(?:урок|занятие|тренировк|встреч|консультац|период|доступ)/i;

// Job-posting / job-board pages carry salary numbers that otherwise pass our
// context regex as a "price". We treat the page as a job posting when ANY of
// the following holds, so the salary cannot leak as the company's price.
const JOBPOSTING_MICRODATA_RE =
  /"@type"\s*:\s*"JobPosting"|itemtype\s*=\s*["'][^"']*JobPosting/i;

// One strong signal is enough: salary or compensation token directly followed
// by a number (or "от/до/from"). Words like "зарплата" or "оклад" are very
// rare on a real services page, especially when stuck to a number.
const JOBPOSTING_SALARY_RE =
  /(?:зарплата|оклад|заработная\s+плата|з\/п|salary|compensation)[^а-яА-ЯёЁa-zA-Z\d]{0,12}(?:от|до|from|up\s+to|—|-|:)?\s*\d/i;

// Job-board pages (rabix.ru, hh.ru, superjob.ru, ...) saturate the markup
// with /vacancy/ links and class names like `vacancy-card`. A handful of
// such markers is enough to identify the page as a job board.
const JOBBOARD_SATURATION_RE = /\/vacancy\/|class\s*=\s*["'][^"']*vacancy|вакансия\s+\d|вакансий\s+(?:в|по)/gi;

const JOBPOSTING_TEXT_MARKERS: RegExp[] = [
  /требования\s+к\s+кандидату/i,
  /условия\s+работы/i,
  /обязанност[иеяй]\s*[:—\-]/i,
  /опыт\s+работы\s+(?:от\s+\d|не\s+мене[еа])/i,
  /job\s+(?:description|requirements?|responsibilities)/i,
  /резюме\s+отклика/i,
  /отклик\s+на\s+вакансию/i,
  /(?:оформление|оформляем)\s+по\s+тк\s+рф/i,
];

function looksLikeJobPosting(html: string): boolean {
  // 1 strong signal is enough.
  if (JOBPOSTING_MICRODATA_RE.test(html)) return true;
  if (JOBPOSTING_SALARY_RE.test(html)) return true;
  // Job-board saturation: ≥4 vacancy-class/path markers across the page.
  const boardMatches = html.match(JOBBOARD_SATURATION_RE);
  if (boardMatches && boardMatches.length >= 4) return true;
  // Otherwise need 2+ softer text markers.
  let score = 0;
  for (const re of JOBPOSTING_TEXT_MARKERS) {
    if (re.test(html)) score++;
    if (score >= 2) return true;
  }
  return false;
}

// Number multiplier suffix: "60 тыс / в месяц" → 60 × 1000 = 60 000.
// Without this leadconnect.ru's "₽ 60 тыс / мес" reads as a 60 ₽ price floor.
function readMultiplier(after: string): number {
  const trimmed = after.replace(/^\s+/, '').toLowerCase();
  if (trimmed.startsWith('млрд')) return 1_000_000_000;
  if (trimmed.startsWith('млн')) return 1_000_000;
  if (/^(?:тыс[\.а-яё]*|тыщ|k\b)/i.test(trimmed)) return 1000;
  return 1;
}

const MAX_PRICE = 100_000_000;
// A real service starting price is never a single-digit token — this floor
// kills the "1 ₽ / 2 ₽ / 5 ₽" noise the old global-minimum logic produced.
const MIN_PRICE = 10;

/** One price token — currency may sit before or after the number, and a
 *  thousand/million suffix may sit between number and currency. */
const PRICE_TOKEN_RE =
  /(₽|руб(?:лей|ля|\.)?|\$|usd|eur|€)\s*(\d[\d\s]{0,8}\d|\d)|(\d[\d\s]{0,8}\d|\d)\s*(тыс[\.а-яё]*|млн[\.а-яё]*|млрд[\.а-яё]*|тыщ\w*)?\s*(₽|руб(?:лей|ля|\.)?|\$|usd|eur|€)/gi;

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

/** Raw numeric value with no range checks (the floor/ceiling are applied
 *  after multipliers like "тыс"/"млн" so that "1 млн" survives the MIN floor). */
function parsePriceRaw(raw: string): number | null {
  const clean = raw.replace(/\s/g, '').replace(/,(\d{2})$/, '.$1');
  const value = parseFloat(clean);
  if (isNaN(value) || value <= 0) return null;
  return value;
}

/** A parsed price plus whether it is a per-unit rate (per lead/click/…). */
type Candidate = PriceValue & { perUnit: boolean };

function priceFromMatch(m: RegExpExecArray, after: string): Candidate | null {
  // Group layout for the extended PRICE_TOKEN_RE:
  //   m[1]: currency when before — "₽ 60 тыс"
  //   m[2]: number when currency-before
  //   m[3]: number when currency-after
  //   m[4]: multiplier between number and currency-after — "1 млн ₽"
  //   m[5]: currency when after
  const cur = m[1] ?? m[5] ?? '';
  const num = m[2] ?? m[3] ?? '';
  const baseValue = parsePriceRaw(num);
  if (baseValue === null) return null;
  // Inline multiplier (between number and currency, e.g. "1 млн ₽") takes
  // precedence; otherwise look in the after-window (e.g. "₽ 60 тыс /мес").
  const inlineMul = m[4] ? readMultiplier(m[4]) : 1;
  const multiplier = inlineMul > 1 ? inlineMul : readMultiplier(after);
  const value = Math.round(baseValue * multiplier);
  if (value < MIN_PRICE || value > MAX_PRICE) return null;
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
export function extractPricingDetails(html: string): { pricing_min?: PriceValue; free_trial?: boolean } {
  // Tri-state contract: this heuristic can ONLY confirm a free trial
  // (regex matched) or stay silent (returns undefined). It cannot say
  // "definitely no free trial" — that's an LLM-only call. The processor
  // merges these two sources and the applier renders undefined as DASH.
  if (!html) return {};

  // Job-posting pages carry salary numbers (зарплата, оклад, salary) that
  // otherwise pass our context regex as "price". Abort early so the salary
  // can never be misattributed as the company's service price.
  if (looksLikeJobPosting(html)) return {};

  const spacedText = htmlToSpacedText(html);
  const free_trial = FREE_TRIAL_RE.test(spacedText) ? true : undefined;

  const prices: Candidate[] = [];

  // 1. Any price inside an explicit price/tariff block is trusted as-is.
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  $(PRICE_BLOCK_SELECTOR).each((_, el) => {
    collectAll($(el).text(), prices);
  });

  // 2. Prices elsewhere need nearby pricing context.
  collectInContext(spacedText, prices);

  if (prices.length === 0) return free_trial ? { free_trial } : {};

  // Prefer package/plan/period prices. A per-unit rate ("от 590 ₽ за лид")
  // defines the service minimum only when nothing else is published — otherwise
  // a tiny per-lead price would mask the real entry tariff.
  const packagePrices = prices.filter((p) => !p.perUnit);
  const pool = packagePrices.length > 0 ? packagePrices : prices;

  let min = pool[0];
  for (const p of pool) {
    if (p.value < min.value) min = p;
  }
  const result: { pricing_min: PriceValue; free_trial?: boolean } = {
    pricing_min: { value: min.value, currency: min.currency },
  };
  if (free_trial) result.free_trial = true;
  return result;
}
