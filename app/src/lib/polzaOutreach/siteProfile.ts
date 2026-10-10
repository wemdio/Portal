/**
 * Профиль компании по её сайту — один обход и один вызов LLM на компанию.
 *
 * Даёт блок Company fit Lead Score (B2B, понятный ICP, дорогая сделка, не
 * агентство/стаффинг/B2C), поля персонализации CEO (company_context,
 * likely_gtm_problem, outreach_angle, сегменты для письма 3), отраслевую
 * группу для роутера кейсов и повод «недавний запуск».
 *
 * Цитаты (B2B, ICP, запуск) сверяются со страницей дословно; несверившаяся —
 * отсутствует. Контекст, боль, угол и сегменты — формулировки модели, в
 * письмо идут только как гипотеза («I would probably start with…»).
 *
 * С 29.09.2026 (спека 2026-09-29-en-outreach-letters-pain-design.md) разбор
 * пишет боль компании для письма 1 (pain_line → {{pain}}) вместо строки «что
 * вы делаете» (about_line, отзыв продаж: «кринжик»). Боль строится от повода,
 * известного до разбора (найм — короткое название вакансии, YC), и от того,
 * что и кому компания продаёт; повод (с батчем YC) входит в ключ кэша.
 *
 * 30.09.2026 — первая выгрузка показала: почти все боли были не про продажи
 * компании, а про проблему её клиентов, которую решает продукт («When
 * managing self-checkout systems, the bottleneck is … human error in
 * scanning» — и следом «We take that off your plate»), а у найма — про подбор
 * людей. Задание переписано с примерами «не так / так» и стоит после
 * сегментов (боль называет покупателей), а painLineOf пропускает только
 * строку со словами о продажах и без слов о подборе.
 *
 * Вторая выгрузка того же дня: у 99 компаний из 100 стояла запасная боль —
 * строка модели не прошла проверку или пришла пустой, и узнать, какая, было
 * неоткуда. Теперь проверка смотрит на «настоящее узкое место» — часть после
 * «but»: «not finding candidates but knowing which clinics to target» — годная
 * строка, подбор в ней отвергнут самой фразой; отклонённая строка пишется в
 * лог воркера с причиной.
 *
 * Стек продаж (HubSpot, Salesforce, Apollo, Clay, Instantly, Outreach,
 * Lemlist) определяется по коду главной страницы, без LLM.
 *
 * ИИ — общий клиент аутричей с английским ключом (POLZA_EN_OUTREACH_API_KEY)
 * и дешёвой моделью разбора; раньше здесь звался русский callJson с русским
 * ключом. Обход сайта (crawlSite) общий с русским — это не ИИ.
 *
 * Готовый профиль живёт 30 дней в общем кэше аутричей: повторный запуск не
 * обходит сайт и не платит ИИ за ту же компанию.
 *
 * Ответ без главных полей (hasCoreFields) — сбой модели: LlmCallError, а не
 * профиль с пустыми полями по умолчанию.
 */

import { createHash } from 'node:crypto';
import { detectSignals } from '@/lib/enrich/signalDetector';
import { callOutreachJson, outreachModel } from '@/lib/outreachLlm/client';
import { LlmCallError } from '@/lib/outreachLlm/context';
import { asBool, asString, asStringArray, isBoolLike } from '@/lib/outreachLlm/json';
import { readSiteAnalysisCache, writeSiteAnalysisCache, type SiteAnalysisCacheKey } from '@/lib/outreachLlm/siteAnalysisCache';
import { acceptQuote } from '@/lib/polzaRuOutreach/evidence';
import { crawlSite, parseRuDate } from '@/lib/polzaRuOutreach/sources/siteSignals';
import { INDUSTRY_GROUPS, type IndustryGroup } from '@/lib/polzaRuOutreach/types';
import { isOutreachSourceTitle } from '@/lib/parsers/engHiring';
import { normalizeDomain } from './resolveDomain';

const PAGE_TEXT_CHARS = 3500;
// Страницы длиннее — уже описание компании (блок «данные» в Lead Score).
const DESCRIPTIVE_PAGE_CHARS = 300;

/**
 * Инструменты продаж в коде сайта.
 *
 * 10.10.2026 список расширен с семи аутрич-сервисов до всего, что говорит
 * «у компании есть машина продаж»: CRM, автоматизация маркетинга, запись на
 * встречи, разбор звонков. Повод с сайта находился у 14% компаний, и этого
 * мало — справочник на миллион компаний при таком проценте превращается в
 * сто тысяч. Рекламные пиксели сюда намеренно НЕ входят: они стоят почти
 * везде, и повод «у вас есть Google Ads» не повод вовсе.
 */
const OUTBOUND_TOOLS_RE =
  /\b(apollo\.io|clay\.com|instantly\.ai|outreach\.io|lemlist|salesloft|smartlead|zoominfo|lusha|cognism|gong\.io|chorus\.ai|chilipiper|calendly|marketo|pardot|klaviyo|activecampaign|mailchimp|dripify|expandi|phantombuster)\b/i;

/** CRM и чаты из общего детектора: те, что значат отдел продаж, а не аналитику. */
const STACK_SIGNAL_IDS = new Set([
  'hubspot', 'salesforce', 'pipedrive', 'zohocrm', 'creatio', 'amocrm', 'bitrix24', 'megaplan', 'planfix',
  'intercom', 'drift', 'tidio',
]);

export type SiteExclusion = 'staffing' | 'job_board' | 'lead_gen_agency' | 'marketing_agency' | 'b2c' | 'local_service' | 'course';

/** Разделы с вакансиями — их страницы обходим ради повода «нанимают в продажи». */
const CAREERS_HINT = /(careers?|jobs?|vacanc|join-?us|we-?are-?hiring|work-?with-?us|open-?roles?|positions?)/i;

/** Тип повода, найденного на сайте (кроме запуска и стека — у них свои поля). */
export type SiteOccasionType = 'hiring' | 'funding' | 'expansion' | 'event';

export interface SiteOccasionFound {
  type: SiteOccasionType;
  /** Название вакансии или дословная цитата со страницы. */
  title: string;
  url: string;
  date: string | null;
}

export interface SiteProfile {
  reachable: boolean;
  isB2b: boolean;
  b2bQuote: string | null;
  businessModel: 'saas' | 'service' | 'platform' | 'other';
  icpQuote: string | null;
  highValue: boolean;
  exclusion: SiteExclusion | null;
  /** Название, как компания пишет себя на сайте (сверено со страницами); в письма — вместо имени из адреса вакансии. */
  brandName: string | null;
  /** Боль компании для письма 1 ({{pain}}) с учётом повода; прошла проверку painLineOf. */
  painLine: string | null;
  /**
   * Поводы, найденные на самом сайте, — кроме запуска (он отдельным полем
   * ради совместимости со старым кэшем) и стека (он без ИИ, по коду страницы).
   *
   * 10.10.2026: до этого с сайта доставались ровно два повода — запуск и стек,
   * и повод находился у 14% компаний. Для справочника это приговор: без повода
   * строка отсеивается (`no_trigger`), то есть миллион компаний превращался бы
   * в сто с небольшим тысяч. Эти поводы приходят тем же одним вызовом ИИ, то
   * есть бесплатно, а цитата сверяется со страницей дословно.
   */
  occasions: SiteOccasionFound[];
  companyContext: string | null;
  likelyGtmProblem: string | null;
  outreachAngle: string | null;
  segments: string[];
  industryGroup: IndustryGroup | null;
  launch: { quote: string; url: string; date: string | null } | null;
  techStack: string[];
  hasDescription: boolean;
}

export const EMPTY_PROFILE: SiteProfile = {
  reachable: false,
  isB2b: false,
  b2bQuote: null,
  businessModel: 'other',
  icpQuote: null,
  highValue: false,
  exclusion: null,
  brandName: null,
  painLine: null,
  occasions: [],
  companyContext: null,
  likelyGtmProblem: null,
  outreachAngle: null,
  segments: [],
  industryGroup: null,
  launch: null,
  techStack: [],
  hasDescription: false,
};

const SYSTEM = `You analyze a company's website for Polza Agency, a B2B outbound agency (we find target accounts, enrich contacts, write sequences and hand over qualified replies). Return STRICT JSON:
{
  "is_b2b": boolean,              // sells to businesses/organizations
  "b2b_quote": string,            // VERBATIM quote from a page proving it sells to businesses; ""
  "business_model": "saas" | "service" | "platform" | "other",
  "icp_quote": string,            // VERBATIM quote naming who the customers are (industries, roles, company types); "" if not stated
  "high_value": boolean,          // high-value B2B deal (enterprise/mid-market software, industrial equipment, professional services with large contracts)
  "exclusion": string,            // "staffing" | "job_board" | "lead_gen_agency" | "marketing_agency" | "b2c" | "local_service" | "course" | "" — only if clearly true
  "brand_name": string,           // the company name exactly as the site writes it, without Inc./LLC/GmbH; ""
  "company_context": string,      // what the company does, 5–15 words, plain English, no hype
  "likely_gtm_problem": string,   // a plausible go-to-market challenge for a company like this, 8–20 words, phrased as a hypothesis
  "outreach_angle": string,       // the angle to open with, 5–15 words
  "segments": [string, string, string], // three target customer segments THIS company could sell to, 2–7 words each, no numbers
  "pain_line": string,            // ONE sentence for a cold email from an outbound agency to this company, 14–36 words. It is about THIS COMPANY'S OWN SELLING — how its team finds, reaches and wins its buyers (the segments above) — in the situation of the OCCASION from the message. Pattern: "When [their sales situation from the occasion], the bottleneck is usually not [the obvious thing] but [the real sales obstacle]." The real obstacle is a selling one: knowing which accounts to go after first, reaching the right people at their buyers, getting enough first conversations, a list the new hire can work from day one. Name their buyers in plain words, never their product. It is NEVER the problem their product solves for their customers and NEVER about recruiting: for a hiring occasion the obvious thing is "the hire itself", not candidates, talent or culture. Plain spoken English; no numbers, questions, quotes, brackets or praise; never retell what the company does ("you provide", "you offer"); never "we"/"our"; "" if the pages do not say clearly what they sell and to whom. See PAIN_LINE EXAMPLES below
  "industry_group": string,       // one of ${JSON.stringify(INDUSTRY_GROUPS)} or "": it_saas = SaaS/AI/software/MarTech; manufacturing = industrial/equipment/hardware; hr_education = HR tech/recruiting software/workforce; horeca = hospitality/local networks; auto_logistics = marketplaces/service platforms/automotive/logistics; digital_agency = digital/event/marketing/production agencies
  "launch": { "quote": string, "url": string, "date_text": string }, // a RECENT product launch/new product announcement: verbatim quote, page URL, verbatim date text; empty strings if none
  "hiring": { "title": string, "url": string },   // an OPEN SALES / GTM / demand-generation role listed on the site (careers page): the job title copied VERBATIM (e.g. "Account Executive", "Head of Demand Generation") and the page URL. Only roles that sell or generate pipeline — never engineering, support, finance or HR. Empty strings if none
  "funding": { "quote": string, "url": string, "date_text": string }, // the company raising money: a verbatim quote naming a round or an investor ("raised $4M Series A", "backed by …"); empty strings if none
  "expansion": { "quote": string, "url": string, "date_text": string }, // entering a NEW market, country, region or opening a new office: verbatim quote; empty strings if none
  "event": { "quote": string, "url": string, "date_text": string } // the company taking part in a conference/trade show/webinar ("meet us at …", "visit our booth"): verbatim quote; empty strings if none
}
Rules: quotes are copied character-for-character from the page text; never invent; prefer "" over a guess.

PAIN_LINE EXAMPLES (do not copy the wording, write your own for this company):
- Sells camera AI for self-checkout to retail chains; occasion: Y Combinator.
  WRONG (their customers' problem, not their selling): "When managing self-checkout systems, the bottleneck is usually not the technology but the human error in scanning."
  RIGHT: "After YC, the bottleneck is usually not the product but getting loss prevention leads at large retail chains to take a first conversation."
- Sells legal software to law firms and in-house legal teams; occasion: hiring for an Account Executive role.
  WRONG (recruiting): "When hiring for key roles, the bottleneck is usually not finding candidates but ensuring they align with your goals."
  WRONG (their customers' problem): "When managing legal operations, the bottleneck is usually not the technology but the lack of visibility into case statuses."
  RIGHT: "When a new Account Executive starts, the bottleneck is usually not the hire itself but knowing which law firms and in-house legal teams are worth the first weeks."
- Sells scheduling software to waste haulers; no occasion.
  RIGHT: "Selling to waste haulers, the bottleneck is usually not the demo but finding which regional operators are ready to change how they plan routes and who decides there."`;

/**
 * Версия кода разбора ответа (что и как попадает в SiteProfile: сверка цитат,
 * чистка сегментов, даты). Правка промпта меняет ключ кэша сама (хэш ниже), а
 * правку разбора код не видит — её отмечаем, подняв это значение.
 */
const SITE_PARSER_VERSION = 'p5';

/**
 * Версия для ключа кэша: версия разбора + короткий хэш текста SYSTEM. Поправили
 * промпт — старые профили просто не находятся, и 30 дней не отдаются разборы
 * по прежним правилам, даже если версию поднять забыли.
 */
export const SITE_PROMPT_VERSION = `en-site:${SITE_PARSER_VERSION}:${createHash('sha256').update(SYSTEM).digest('hex').slice(0, 12)}`;

const BUSINESS_MODELS: readonly string[] = ['saas', 'service', 'platform', 'other'];

/** Модель бизнеса из ответа; регистр не важен: «SaaS» — это saas, а не сбой модели. */
function businessModelOf(raw: Record<string, unknown>): string {
  return asString(raw.business_model).toLowerCase();
}

/**
 * Главные поля разбора: B2B да/нет и дорогая сделка да/нет — на них стоит
 * блок Company fit в Lead Score. У цитат, контекста и сегментов есть законное
 * «пусто», а эти два да/нет модель обязана решить в любом ответе. Без них
 * ответ — сбой модели (пустой объект, чужая схема), а не «не B2B»:
 * buildSiteProfile бросает LlmCallError, строка уходит в «ИИ не ответил» и в
 * серию предохранителя, а не отсеивается молча по пустому разбору; в кэш
 * такой ответ не попадает, иначе компания 30 дней отсеивалась бы по нему.
 *
 * Модель бизнеса в это правило не входит: любое значение вне списка (в том
 * числе пустое) — «other». Это законная оценка, а не повод терять строку:
 * «marketplace» вместо «platform» — модель ответила, просто своими словами.
 */
function hasCoreFields(raw: Record<string, unknown>): boolean {
  return isBoolLike(raw.is_b2b) && isBoolLike(raw.high_value);
}

/**
 * Профиль из кэша — только целый и открывшийся: битая запись — промах, а не
 * падение строки. Описание из каталога (YC, вакансия) приходит с кандидатом,
 * а не с сайта, поэтому в кэше «есть описание» — только по страницам, а
 * каталожное добавляем заново.
 */
function profileFromCache(raw: unknown, fallbackDescription: string | null): SiteProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cached = raw as Partial<SiteProfile>;
  if (
    cached.reachable !== true ||
    typeof cached.isB2b !== 'boolean' ||
    typeof cached.highValue !== 'boolean' ||
    !BUSINESS_MODELS.includes(String(cached.businessModel)) ||
    !Array.isArray(cached.segments) ||
    !Array.isArray(cached.techStack)
  ) {
    return null;
  }
  return {
    ...EMPTY_PROFILE,
    ...cached,
    reachable: true,
    // Профили, записанные до 10.10.2026, поля поводов не знают вовсе.
    occasions: Array.isArray(cached.occasions) ? cached.occasions : [],
    hasDescription: cached.hasDescription === true || Boolean(fallbackDescription),
  };
}

/**
 * Повод компании, известный до разбора сайта: найм (короткое название
 * вакансии) или YC (батч); нет — null, боль строится от того, что и кому
 * компания продаёт. Найм здесь — ещё не подтверждённый повод: мандат на
 * outbound проверяет разбор вакансии после сайта.
 */
export type SiteOccasion = { type: 'hiring'; title: string } | { type: 'yc'; batch: string };

/** Повод словами для модели разбора. */
function occasionText(occasion: SiteOccasion | null): string {
  if (!occasion) return 'No specific occasion: build the pain from what they sell and to whom.';
  return occasion.type === 'hiring'
    ? `They are hiring for a ${occasion.title} role.`
    : // Батч («W24», «Winter 2024») модели не даём: цифр в боли быть не должно.
      'They recently went through Y Combinator.';
}

/**
 * Отпечаток повода в ключе кэша: разбор с болью под один повод не отдаётся
 * компании с другим (та же компания в новом запуске — уже с другой вакансией).
 */
export function occasionFingerprint(occasion: SiteOccasion | null): string {
  if (!occasion) return 'none';
  const value = (occasion.type === 'hiring' ? occasion.title : occasion.batch).replace(/\s+/g, ' ').trim().toLowerCase();
  return `${occasion.type}:${createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
}

export interface SiteProfileOptions {
  /** Нормализованный домен — ключ кэша профиля; по умолчанию берётся из адреса сайта. */
  domain?: string;
  /** Повод компании до разбора — для боли письма 1 ({{pain}}) и ключа кэша. */
  occasion?: SiteOccasion | null;
  /**
   * ИИ ответил целым ответом (профиль не из кэша): раннер по этому обнуляет
   * серию «ИИ не ответил» — предохранитель «ИИ молчит» считает только ответы
   * модели, и ответ без главных полей ответом не считается.
   */
  onLlmAnswer?: () => void;
}

/** Название с сайта — только если оно правда есть на страницах и похоже на название, а не на фразу. */
function brandNameOf(value: unknown, allText: string): string | null {
  const name = asString(value).replace(/\s+/g, ' ').replace(/^["'«]|["'»]$/g, '').trim();
  if (!name || name.length > 60 || name.split(' ').length > 6) return null;
  return allText.toLowerCase().includes(name.toLowerCase()) ? name : null;
}

// Боль уходит в письмо без правки человеком: реклама, обещания и голос «мы»
// в ней — брак, лучше письмо без неё.
const PAIN_BANNED_RE = /\b(leading|world-class|revolutionary|best-in-class|cutting-edge|innovative|amazing|impressive|guarantee[sd]?)\b/i;
// «We», «our» — голос самой компании, скопированный с сайта. Регистр важен: «US hospitals» — не «us».
const PAIN_OWN_VOICE_RE = /\b(?:[Ww]e|[Oo]ur|us)\b/;
// Пересказ того, что компания делает, — то, от чего боль и уводит («You provide
// tele-audiology solutions…»). «Your team is hiring» — не пересказ, его не трогаем.
const PAIN_RETELL_RE = /\byou (?:provide|offer)\b|\byour (?:company|business) (?:is|does|provides|offers)\b/i;
// Боль — про продажи самой компании: в «настоящем узком месте» (после «but»)
// есть слова о них — кого искать, до кого дойти, с кем говорить. «Sales»,
// «customers», «calls» сюда не входят нарочно: они встречаются и в проблемах
// клиентов компании («managing customer communication», «during calls»), а
// именно такие строки первая выгрузка и пропустила.
const PAIN_SELLING_RE =
  /\b(?:pipeline|accounts?|lists?|buyers?|prospects?|prospecting|outbound|outreach|conversations?|meetings?|demos?|deals?|decision[- ]makers?|pilots?|design partners?|territor(?:y|ies)|quota|first customers|new customers|in front of|who decides|who to (?:call|contact|target)|(?:which|what) [^.,;]{3,80}? (?:to|are|is|have|need) (?:target|prioriti[sz]e|go after|pursue|approach|call|contact|focus on|work|worth|ready|the best fit|most likely|an? |the |now)|(?:reach|reaching|get(?:ting)? to|get(?:ting)? through to) the (?:right|actual) (?:people|person|contacts?|teams?|leaders?|owners?)|sell(?:ing)? (?:in)?to|first (?:call|conversation|week)s?)\b/i;
// Про подбор людей — письмо читается как от кадрового агентства.
const PAIN_RECRUITING_RE = /\bcandidates?\b|\btalent\b|\bculture\b|\bapplicants?\b|\brecruit\w*|\balign/i;

/**
 * Почему строка {{pain}} не годится; null — годится. 1–2 законченных
 * предложения, 12–40 слов, без цифр (цифры в письме — только из кейса и
 * повода), вопросов, восклицаний, кавычек и скобок, без рекламы, голоса
 * «we/our» и пересказа деятельности. Настоящее узкое место — часть после
 * последнего «but» (нет его — вся строка) — про продажи самой компании, а не
 * про подбор людей.
 */
function painRejection(line: string): string | null {
  const words = line.split(' ').length;
  if (words < 12 || words > 40) return `длина ${words} слов`;
  // Апостроф внутри слова («don't», «team’s») — не кавычка.
  if (/\d|[?!"'‘’“”«»()[\]{}]/.test(line.replace(/(\w)['’](\w)/g, '$1$2'))) return 'цифры, кавычки, скобки или вопрос';
  // Предложения — по точке перед следующим словом: больше двух — не строка письма.
  if ((line.slice(0, -1).match(/\.\s+\S/g) ?? []).length > 1) return 'больше двух предложений';
  if (PAIN_BANNED_RE.test(line)) return 'рекламное слово';
  if (PAIN_OWN_VOICE_RE.test(line)) return 'голос «we/our»';
  if (PAIN_RETELL_RE.test(line)) return 'пересказ деятельности';
  const but = line.toLowerCase().lastIndexOf(' but ');
  const real = but >= 0 ? line.slice(but + 5) : line;
  if (PAIN_RECRUITING_RE.test(real)) return 'про подбор людей';
  if (!PAIN_SELLING_RE.test(real)) return 'не про продажи компании';
  return null;
}

function normalizePain(value: unknown): string {
  const line = asString(value).replace(/\s+/g, ' ').trim();
  return line && !/[.]$/.test(line) ? `${line}.` : line;
}

/**
 * Строка {{pain}} из ответа разбора, прошедшая проверку (painRejection). Не
 * прошла или пустая — null: в письмо идёт запасная боль по поводу
 * (buildLetters.fallbackPain).
 */
export function painLineOf(value: unknown): string | null {
  const line = normalizePain(value);
  if (!line || painRejection(line)) return null;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function detectTechStack(html: string): string[] {
  const stack = new Set<string>();
  for (const s of detectSignals(html)) {
    if (STACK_SIGNAL_IDS.has(s.id)) stack.add(s.name);
  }
  // Все совпадения, а не первое: «HubSpot + Apollo» — более узнаваемый повод,
  // чем один инструмент, и в письме он звучит конкретнее.
  for (const m of html.matchAll(new RegExp(OUTBOUND_TOOLS_RE.source, 'gi'))) {
    stack.add(m[1].toLowerCase());
    if (stack.size >= 3) break;
  }
  return Array.from(stack).slice(0, 3);
}

/**
 * Профиль компании по сайту. Сайт не открылся — EMPTY_PROFILE (reachable:
 * false). ИИ не ответил или ответил без главных полей — LlmCallError летит
 * наверх как есть: раннер отличает «сайт не открылся» от «ИИ не ответил» и от
 * исчерпанного лимита.
 */
export async function buildSiteProfile(
  website: string,
  fallbackDescription: string | null,
  options: SiteProfileOptions = {},
): Promise<SiteProfile> {
  const domain = options.domain || normalizeDomain(website);
  const occasion = options.occasion ?? null;
  // Боль пишется под повод: в ключе кэша — версия промпта и отпечаток повода.
  const cacheKey: SiteAnalysisCacheKey | null = domain.includes('.')
    ? { lang: 'en', domain, promptVersion: `${SITE_PROMPT_VERSION}:${occasionFingerprint(occasion)}`, model: outreachModel('en', 'analysis') }
    : null;
  if (cacheKey) {
    const cached = profileFromCache(await readSiteAnalysisCache(cacheKey), fallbackDescription);
    if (cached) return cached;
  }

  const { pages, homeHtml } = await crawlSite(website, undefined, CAREERS_HINT);
  if (!pages.length) return EMPTY_PROFILE;

  const user = [
    `=== OCCASION ===
${occasionText(occasion)}`,
    ...(fallbackDescription ? [`=== DIRECTORY DESCRIPTION (not a page) ===\n${fallbackDescription}`] : []),
    ...pages.map((p) => `=== PAGE ${p.url} ===\n${p.text.slice(0, PAGE_TEXT_CHARS)}`),
  ].join('\n\n');
  const raw = await callOutreachJson({ role: 'analysis', lang: 'en', system: SYSTEM, user, title: 'site', maxTokens: 1400 });
  if (!hasCoreFields(raw)) {
    // Ответ оплачен (клиент уже списал его с лимита), но серию «ИИ молчит» не
    // обнуляет: иначе модель, которая отвечает пустым объектом, предохранитель
    // не заметил бы.
    throw new LlmCallError('EN analysis «site»: в ответе нет обязательных полей (is_b2b, high_value)');
  }
  options.onLlmAnswer?.();

  const allText = pages.map((p) => p.text).join('\n');
  const pageByUrl = new Map(pages.map((p) => [p.url.replace(/\/+$/, ''), p]));
  const b2bQuote = acceptQuote(allText, asString(raw.b2b_quote));
  const model = businessModelOf(raw);
  const exclusion = asString(raw.exclusion) as SiteExclusion;
  const group = asString(raw.industry_group) as IndustryGroup;

  let launch: SiteProfile['launch'] = null;
  const l = (raw.launch ?? {}) as Record<string, unknown>;
  const page = pageByUrl.get(asString(l.url).replace(/\/+$/, ''));
  const launchQuote = page ? acceptQuote(page.text, asString(l.quote)) : null;
  if (page && launchQuote) {
    const dateText = asString(l.date_text);
    launch = { quote: launchQuote, url: page.url, date: dateText && acceptQuote(page.text, dateText, 12) ? parseEnDate(dateText) : null };
  }

  /**
   * Повод с цитатой: берём только то, что дословно есть на названной странице.
   * Модель, придумавшая раунд или конференцию, повода не создаёт — у неё не
   * сойдётся цитата. Страница не из обхода — тоже мимо: ссылку можно выдумать.
   */
  const quotedOccasion = (type: 'funding' | 'expansion' | 'event'): SiteOccasionFound | null => {
    const node = (raw[type] ?? {}) as Record<string, unknown>;
    const src = pageByUrl.get(asString(node.url).replace(/\/+$/, ''));
    if (!src) return null;
    const quote = acceptQuote(src.text, asString(node.quote));
    if (!quote) return null;
    const dateText = asString(node.date_text);
    return {
      type,
      title: quote,
      url: src.url,
      date: dateText && acceptQuote(src.text, dateText, 12) ? parseEnDate(dateText) : null,
    };
  };

  const occasions: SiteOccasionFound[] = [];

  /**
   * Вакансия с их собственной страницы вакансий. Название проверяем тем же
   * фильтром, что и вакансии из Jobhive: модель охотно называет «Software
   * Engineer» ролью продаж, если других вакансий на странице нет.
   */
  const h = (raw.hiring ?? {}) as Record<string, unknown>;
  const hiringPage = pageByUrl.get(asString(h.url).replace(/\/+$/, ''));
  const hiringTitle = hiringPage ? acceptQuote(hiringPage.text, asString(h.title), 12) : null;
  if (hiringPage && hiringTitle && isOutreachSourceTitle(hiringTitle)) {
    occasions.push({ type: 'hiring', title: hiringTitle, url: hiringPage.url, date: null });
  }
  for (const type of ['funding', 'expansion', 'event'] as const) {
    const found = quotedOccasion(type);
    if (found) occasions.push(found);
  }

  const clean = (v: unknown, maxWords: number) => {
    const t = asString(v).replace(/\s+/g, ' ').trim();
    return t && t.split(' ').length <= maxWords ? t : null;
  };

  // Без боли из разбора письмо получает запасную по поводу — одинаковую у
  // всех компаний. Почему её нет, иначе не узнать: строку модели нигде не видно.
  const painRaw = normalizePain(raw.pain_line);
  const painLine = painLineOf(raw.pain_line);
  if (!painLine) {
    const why = painRaw ? `${painRejection(painRaw) ?? 'отклонена'}: ${painRaw.slice(0, 300)}` : 'модель вернула пустую строку';
    console.warn(`[polza-outreach][site][WARN] ${domain}: боль не принята — ${why}`);
  }

  const pagesDescribe = pages.some((p) => p.text.length > DESCRIPTIVE_PAGE_CHARS);
  const profile: SiteProfile = {
    reachable: true,
    isB2b: asBool(raw.is_b2b) && Boolean(b2bQuote),
    b2bQuote,
    businessModel: model === 'saas' || model === 'service' || model === 'platform' ? model : 'other',
    icpQuote: acceptQuote(allText, asString(raw.icp_quote)),
    highValue: asBool(raw.high_value),
    exclusion: ['staffing', 'job_board', 'lead_gen_agency', 'marketing_agency', 'b2c', 'local_service', 'course'].includes(exclusion) ? exclusion : null,
    brandName: brandNameOf(raw.brand_name, allText),
    painLine,
    occasions,
    companyContext: clean(raw.company_context, 18),
    likelyGtmProblem: clean(raw.likely_gtm_problem, 24),
    outreachAngle: clean(raw.outreach_angle, 18),
    segments: asStringArray(raw.segments, 3)
      .map((s) => s.replace(/[.;!?]+$/, '').trim())
      .filter((s) => s && !/\d/.test(s) && s.split(/\s+/).length <= 7 && !/[{}"«»]/.test(s)),
    industryGroup: INDUSTRY_GROUPS.includes(group) ? group : null,
    launch,
    techStack: homeHtml ? detectTechStack(homeHtml) : [],
    hasDescription: pagesDescribe || Boolean(fallbackDescription),
  };
  // В кэш — только разобранный ИИ сайт; ответ без главных полей сюда не
  // доходит (бросили выше). Неоткрывшийся не запоминаем: завтра он может
  // открыться. Свежесть запуска продукта раннер сверяет по дате при чтении.
  if (cacheKey) await writeSiteAnalysisCache(cacheKey, { ...profile, hasDescription: pagesDescribe });
  return profile;
}

const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** «September 12, 2026», «12 Sep 2026», «2026-09-12», «12.09.2026». */
export function parseEnDate(text: string): string | null {
  const ru = parseRuDate(text);
  if (ru) return ru;
  const t = text.toLowerCase();
  const mdy = t.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  const dmy = t.match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  const hit = mdy ? { mon: mdy[1], day: mdy[2], year: mdy[3] } : dmy ? { mon: dmy[2], day: dmy[1], year: dmy[3] } : null;
  if (!hit) return null;
  const idx = EN_MONTHS.indexOf(hit.mon);
  if (idx < 0) return null;
  return `${hit.year}-${String(idx + 1).padStart(2, '0')}-${hit.day.padStart(2, '0')}`;
}
