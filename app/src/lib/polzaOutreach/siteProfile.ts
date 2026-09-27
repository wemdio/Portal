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
import { normalizeDomain } from './resolveDomain';

const PAGE_TEXT_CHARS = 3500;
// Страницы длиннее — уже описание компании (блок «данные» в Lead Score).
const DESCRIPTIVE_PAGE_CHARS = 300;

const OUTBOUND_TOOLS_RE = /\b(apollo\.io|clay\.com|instantly\.ai|outreach\.io|lemlist|salesloft|smartlead)\b/i;

export type SiteExclusion = 'staffing' | 'job_board' | 'lead_gen_agency' | 'marketing_agency' | 'b2c' | 'local_service' | 'course';

export interface SiteProfile {
  reachable: boolean;
  isB2b: boolean;
  b2bQuote: string | null;
  businessModel: 'saas' | 'service' | 'platform' | 'other';
  icpQuote: string | null;
  highValue: boolean;
  exclusion: SiteExclusion | null;
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
  "company_context": string,      // what the company does, 5–15 words, plain English, no hype
  "likely_gtm_problem": string,   // a plausible go-to-market challenge for a company like this, 8–20 words, phrased as a hypothesis
  "outreach_angle": string,       // the angle to open with, 5–15 words
  "segments": [string, string, string], // three target customer segments THIS company could sell to, 2–7 words each, no numbers
  "industry_group": string,       // one of ${JSON.stringify(INDUSTRY_GROUPS)} or "": it_saas = SaaS/AI/software/MarTech; manufacturing = industrial/equipment/hardware; hr_education = HR tech/recruiting software/workforce; horeca = hospitality/local networks; auto_logistics = marketplaces/service platforms/automotive/logistics; digital_agency = digital/event/marketing/production agencies
  "launch": { "quote": string, "url": string, "date_text": string } // a RECENT product launch/new product announcement: verbatim quote, page URL, verbatim date text; empty strings if none
}
Rules: quotes are copied character-for-character from the page text; never invent; prefer "" over a guess.`;

/**
 * Версия кода разбора ответа (что и как попадает в SiteProfile: сверка цитат,
 * чистка сегментов, даты). Правка промпта меняет ключ кэша сама (хэш ниже), а
 * правку разбора код не видит — её отмечаем, подняв это значение.
 */
const SITE_PARSER_VERSION = 'p1';

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
    hasDescription: cached.hasDescription === true || Boolean(fallbackDescription),
  };
}

export interface SiteProfileOptions {
  /** Нормализованный домен — ключ кэша профиля; по умолчанию берётся из адреса сайта. */
  domain?: string;
  /**
   * ИИ ответил целым ответом (профиль не из кэша): раннер по этому обнуляет
   * серию «ИИ не ответил» — предохранитель «ИИ молчит» считает только ответы
   * модели, и ответ без главных полей ответом не считается.
   */
  onLlmAnswer?: () => void;
}

function detectTechStack(html: string): string[] {
  const stack = new Set<string>();
  for (const s of detectSignals(html)) {
    if (s.id === 'hubspot' || s.id === 'salesforce') stack.add(s.name);
  }
  const m = html.match(OUTBOUND_TOOLS_RE);
  if (m) stack.add(m[1].toLowerCase());
  return Array.from(stack);
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
  const cacheKey: SiteAnalysisCacheKey | null = domain.includes('.')
    ? { lang: 'en', domain, promptVersion: SITE_PROMPT_VERSION, model: outreachModel('en', 'analysis') }
    : null;
  if (cacheKey) {
    const cached = profileFromCache(await readSiteAnalysisCache(cacheKey), fallbackDescription);
    if (cached) return cached;
  }

  const { pages, homeHtml } = await crawlSite(website);
  if (!pages.length) return EMPTY_PROFILE;

  const user = [
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

  const clean = (v: unknown, maxWords: number) => {
    const t = asString(v).replace(/\s+/g, ' ').trim();
    return t && t.split(' ').length <= maxWords ? t : null;
  };

  const pagesDescribe = pages.some((p) => p.text.length > DESCRIPTIVE_PAGE_CHARS);
  const profile: SiteProfile = {
    reachable: true,
    isB2b: asBool(raw.is_b2b) && Boolean(b2bQuote),
    b2bQuote,
    businessModel: model === 'saas' || model === 'service' || model === 'platform' ? model : 'other',
    icpQuote: acceptQuote(allText, asString(raw.icp_quote)),
    highValue: asBool(raw.high_value),
    exclusion: ['staffing', 'job_board', 'lead_gen_agency', 'marketing_agency', 'b2c', 'local_service', 'course'].includes(exclusion) ? exclusion : null,
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
