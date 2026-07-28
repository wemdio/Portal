/**
 * Инфраструктурный слой «досье вертикали» (Hypothesis Engine).
 *
 * Собирает объективные рыночные цифры по сегменту без LLM:
 *  - companies_total — объём сегмента в нашей директории компаний: тот же
 *    счётчик, что подставляет объёмы в гипотезы «Нашей базы компаний»
 *    (searchCount → companies_directory_count_rpc), фильтр по ОКВЭД-2;
 *  - hh_vacancies_total / hh_vacancies_sample — открытые вакансии hh.ru
 *    по названию вертикали и топовой целевой должности (через боевой путь
 *    hh-парсера: прокси-пул + HH_ACCESS_TOKEN, fetchWithRetry);
 *  - signals — детерминированные болевые сигналы по выборке вакансий.
 *
 * Все внешние вызовы fail-safe: ошибка/таймаут → null, исключений наружу нет.
 * Результат складывается в he_vertical_dossiers.data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import { searchCount } from '@/lib/companiesSearch/rpcSearch';
import { fetchWithRetry } from '@/lib/parsers/hhParser';
import {
  getAllowedCompanyBaseIndustryCategories,
  type CompanyBaseIndustryCategory,
} from '@/lib/projectBriefHypotheses/ourBaseValidation';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export interface HeDossierSignal {
  kind: string;
  label: string;
  value: string;
  source?: string;
}

export interface HeDossierCounters {
  /** Компаний в сегменте по нашей директории (null — не удалось посчитать). */
  companies_total: number | null;
  /** Как считали companies_total (фильтры/причина null). */
  companies_note?: string;
  /** Найдено открытых вакансий на hh.ru (null — запрос не удался). */
  hh_vacancies_total: number | null;
  /** Примеры названий вакансий (до 10). */
  hh_vacancies_sample: string[];
  signals: HeDossierSignal[];
}

export interface CollectDossierCountersInput {
  verticalName: string;
  synonyms: string[];
  /** Целевые должности (из вокабуляра/вертикали). */
  roleTitles: string[];
  log?: (msg: string) => void;
}

export interface CollectDossierCountersDeps {
  /**
   * Подмена admin-клиента Supabase (тесты). По умолчанию используется общий
   * supabaseAdmin внутри searchCount — как в остальных серверных lib'ах.
   */
  supabase?: SupabaseClient;
  /** Подмена fetch (тесты). */
  fetchImpl?: typeof fetch;
}

/* ─────────────────── ОКВЭД-2: сопоставление вертикали ─────────────────── */

/**
 * Скоринг повторяет promptTokens/promptCategoryScore из ourBaseValidation
 * (те хелперы не экспортируются), а допустимый набор категорий (классы XX и
 * родительские группы XX.X) берём из того же модуля — тот самый whitelist,
 * который разрешён в контракте «Нашей базы компаний».
 */
const GENERIC_TOKEN_PREFIXES = [
  'деятел',
  'компан',
  'организ',
  'оказан',
  'област',
  'предос',
  'произв',
  'проч',
  'сервис',
  'услуг',
];

function significantTokens(value: string): string[] {
  return [...new Set(
    value
      .toLocaleLowerCase('ru-RU')
      .replace(/ё/g, 'е')
      .match(/[a-zа-я0-9]{4,}/g) ?? [],
  )].filter((token) => !GENERIC_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix)));
}

/**
 * В названиях ОКВЭД всё после «кроме …»/«исключая …» — негативный контекст
 * («Производство древесины …, кроме мебели»). Отрезаем, иначе «мебель»
 * ложно матчится на класс 16.
 */
const NEGATIVE_CONTEXT_RE = /[\s(,;]+(?:кроме|исключая)(?:\s|:|$)/i;

function categoryTokens(categoryName: string): string[] {
  return significantTokens(categoryName.split(NEGATIVE_CONTEXT_RE)[0]);
}

function categoryScore(categoryName: string, queryTokens: string[]): number {
  const tokens = categoryTokens(categoryName);
  return tokens.reduce((score, categoryToken) => score + queryTokens.reduce((tokenScore, queryToken) => {
    if (categoryToken === queryToken) return tokenScore + 2;
    const sharedPrefixLength = Math.min(6, categoryToken.length, queryToken.length);
    return tokenScore + (sharedPrefixLength >= 4
      && categoryToken.slice(0, sharedPrefixLength) === queryToken.slice(0, sharedPrefixLength)
      ? 1
      : 0);
  }, 0), 0);
}

/**
 * Уверенное совпадение: хотя бы одно точное (+2) или стем-совпадение (+1)
 * токена вертикали с токеном названия категории — как у promptCategoryScore
 * в ourBaseValidation. Совпадений нет (score 0) → null + companies_note.
 */
const MIN_OKVED_MATCH_SCORE = 1;
const MAX_OKVED_CATEGORIES = 3;

function matchOkvedCategories(text: string): CompanyBaseIndustryCategory[] {
  const queryTokens = significantTokens(text);
  if (queryTokens.length === 0) return [];
  return getAllowedCompanyBaseIndustryCategories()
    .map((category) => ({ category, score: categoryScore(category.name, queryTokens) }))
    .filter((item) => item.score >= MIN_OKVED_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || a.category.code.localeCompare(b.category.code, 'ru-RU'))
    .slice(0, MAX_OKVED_CATEGORIES)
    .map((item) => item.category);
}

/* ─────────────────── Директория компаний: счётчик ─────────────────── */

interface SegmentCountResult {
  count: number | null;
  error?: string;
}

/**
 * Установленный путь подсчёта — searchCount (RPC companies_directory_count_rpc).
 * deps.supabase — узкий обход для тестов: та же RPC, только с ОКВЭД-префиксами
 * (остальные параметры имеют дефолты в сигнатуре функции).
 */
async function countSegmentCompanies(
  okvedCodes: string[],
  supabase?: SupabaseClient,
): Promise<SegmentCountResult> {
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('companies_directory_count_rpc', {
        p_okved_prefixes: okvedCodes,
        p_include_ip: false,
      });
      if (error) return { count: null, error: error.message ?? String(error) };
      const count = Number(data);
      return Number.isFinite(count)
        ? { count }
        : { count: null, error: 'некорректный ответ счётчика директории' };
    } catch (e) {
      return { count: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const filters: CompaniesSearchFilters = { okvedCodes, includeIp: false };
  const res = await searchCount(filters);
  if (res.error) return { count: null, error: res.error };
  return { count: res.count };
}

/* ───────────────────────────── hh.ru ───────────────────────────── */

const HH_API_URL = 'https://api.hh.ru/vacancies';
const HH_TIMEOUT_MS = 10_000;
const HH_SAMPLE_LIMIT = 10;

interface HhVacanciesPage {
  found: number;
  names: string[];
}

/**
 * Один запрос к api.hh.ru. Продакшен-путь — fetchWithRetry из hhParser:
 * тот же прокси-пул, OAuth-токен (HH_ACCESS_TOKEN) и UA, что у боевого
 * HH-парсера (прямой доступ к api.hh.ru с ДЦ-IP hh сейчас режет 403).
 * deps.fetchImpl — только для тестов (прямой fetch). Никогда не бросает.
 */
async function fetchHhVacancies(
  query: string,
  fetchImpl?: typeof fetch,
): Promise<HhVacanciesPage | null> {
  const url = `${HH_API_URL}?text=${encodeURIComponent(query)}&per_page=${HH_SAMPLE_LIMIT}`;
  try {
    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) return null;
        const json = (await res.json()) as { found?: unknown; items?: Array<{ name?: unknown }> };
        return parseHhPage(json);
      } finally {
        clearTimeout(timer);
      }
    }
    const json = await fetchWithRetry<{ found?: unknown; items?: Array<{ name?: unknown }> }>(url, {
      maxRetries: 2,
      timeoutMs: HH_TIMEOUT_MS,
    });
    return parseHhPage(json);
  } catch {
    return null;
  }
}

function parseHhPage(json: { found?: unknown; items?: Array<{ name?: unknown }> }): HhVacanciesPage | null {
  if (typeof json.found !== 'number' || !Number.isFinite(json.found)) return null;
  const names = (Array.isArray(json.items) ? json.items : [])
    .map((item) => (typeof item?.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
  return { found: json.found, names };
}

/* ────────────────────────── Сигналы ────────────────────────── */

const SALES_TITLE_RE = /sales|продаж|sdr|bdr/i;
const RECRUIT_TITLE_RE = /рекрут|recruit|\bhr\b|эйчар|подбор[а-яё]*\s+персонал|специалист[а-яё]*\s+по\s+кадрам/i;

function buildSignals(hhTotal: number | null, sample: string[]): HeDossierSignal[] {
  const signals: HeDossierSignal[] = [];
  if (sample.length > 0) {
    const sales = sample.filter((title) => SALES_TITLE_RE.test(title)).length;
    if (sales > 0) {
      signals.push({
        kind: 'outbound_diy',
        label: 'Сегмент сам строит аутбаунд',
        value: `${sales} из ${sample.length} вакансий — продажи`,
        source: 'hh.ru',
      });
    }
    const recruiting = sample.filter((title) => RECRUIT_TITLE_RE.test(title)).length;
    if (recruiting > 0) {
      signals.push({
        kind: 'hr_function_growth',
        label: 'В сегменте наращивают функцию найма',
        value: `${recruiting} из ${sample.length} вакансий — рекрутинг/HR`,
        source: 'hh.ru',
      });
    }
  }
  if (hhTotal !== null) {
    const bucket = hhTotal > 3000 ? 'высокая' : hhTotal >= 1000 ? 'средняя' : 'нишевая';
    signals.push({
      kind: 'activity',
      label: 'Активность найма в сегменте',
      value: `${bucket} (${hhTotal} открытых вакансий)`,
      source: 'hh.ru',
    });
  }
  return signals;
}

/* ────────────────────────── Сбор ────────────────────────── */

export async function collectDossierCounters(
  input: CollectDossierCountersInput,
  deps?: CollectDossierCountersDeps,
): Promise<HeDossierCounters> {
  const log = input.log ?? (() => {});
  const verticalName = (input.verticalName ?? '').trim();
  const synonyms = (input.synonyms ?? []).map((s) => s.trim()).filter(Boolean);
  const roleTitles = (input.roleTitles ?? []).map((s) => s.trim()).filter(Boolean);

  // ── 1. Наша директория компаний (фильтр по ОКВЭД-2) ──
  let companies_total: number | null = null;
  let companies_note: string | undefined;
  const matchText = [verticalName, ...synonyms].filter(Boolean).join(' ');
  const categories = matchText ? matchOkvedCategories(matchText) : [];
  if (categories.length === 0) {
    companies_note = matchText
      ? 'Нет уверенного совпадения вертикали с категориями ОКВЭД-2 — объём директории не считали.'
      : 'Не передано название вертикали — объём директории не считали.';
  } else if (!deps?.supabase && !supabaseAdmin) {
    companies_note = 'admin-клиент Supabase не сконфигурирован — объём директории недоступен.';
  } else {
    const criteria = `ОКВЭД-категории: ${categories.map((c) => `${c.code} ${c.name}`).join('; ')}; вся Россия; без ИП`;
    // Схлопываем предок/потомок (напр. 31 + 31.0 → 31) — как на входе searchCount.
    const okvedCodes = reduceToTopCodes(new Set(categories.map((c) => c.code)));
    const res = await countSegmentCompanies(okvedCodes, deps?.supabase);
    if (res.error || res.count === null) {
      companies_note = `${criteria}. Счётчик вернул ошибку: ${res.error ?? 'неизвестная'}.`;
    } else {
      companies_total = res.count;
      companies_note = `${criteria}. Источник: companies_directory (счётчик «Нашей базы компаний»).`;
    }
  }
  log(`[dossier] companies: ${companies_total ?? 'null'} — ${companies_note}`);

  // ── 2. hh.ru: вертикаль + топовая целевая должность ──
  const queries: string[] = [];
  if (verticalName) queries.push(verticalName);
  if (roleTitles.length > 0) queries.push(roleTitles[0]);
  let hh_vacancies_total: number | null = null;
  const hh_vacancies_sample: string[] = [];
  for (const query of queries.slice(0, 2)) {
    const page = await fetchHhVacancies(query, deps?.fetchImpl);
    if (!page) {
      log(`[dossier] hh.ru «${query}»: запрос не удался`);
      continue;
    }
    if (hh_vacancies_total === null) hh_vacancies_total = page.found;
    for (const name of page.names) {
      if (hh_vacancies_sample.length < HH_SAMPLE_LIMIT && !hh_vacancies_sample.includes(name)) {
        hh_vacancies_sample.push(name);
      }
    }
    log(`[dossier] hh.ru «${query}»: found=${page.found}, sample=${page.names.length}`);
  }

  return {
    companies_total,
    companies_note,
    hh_vacancies_total,
    hh_vacancies_sample,
    signals: buildSignals(hh_vacancies_total, hh_vacancies_sample),
  };
}
