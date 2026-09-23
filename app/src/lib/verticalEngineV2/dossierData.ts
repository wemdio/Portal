/**
 * Инфраструктурный слой «досье вертикали» Vertical Engine v2.
 *
 * Собирает объективные рыночные цифры по сегменту без LLM:
 *  - companies_total — число уникальных компаний в широкой ОКВЭД-выборке;
 *    считается тем же условием, что и выборка при сборе базы, дубли по ИНН
 *    объединяются, строки без ИНН остаются отдельными компаниями;
 *  - directory_rows_total / companies_with_* — честная воронка от сырых
 *    строк справочника к компаниям с указанными каналами связи. Это ещё не
 *    число проверенных или готовых к запуску email;
 *  - hh_vacancies_total / hh_vacancies_sample — открытые вакансии hh.ru
 *    по названию вертикали и топовой целевой должности (через боевой путь
 *    hh-парсера: прокси-пул + HH_ACCESS_TOKEN, fetchWithRetry);
 *  - signals — детерминированные болевые сигналы по выборке вакансий.
 *
 * Все внешние вызовы fail-safe: ошибка/таймаут → null, исключений наружу нет.
 * Результат складывается в ve_vertical_dossiers.data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import { fetchWithRetry } from '@/lib/parsers/hhParser';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getVeDirectoryPlanPopulation, veDirectoryFiltersSlice } from './directoryPopulation';
import { matchVeDossierIndustryCategories } from './dossierIndustryMatch';

export interface VeDossierSignal {
  kind: string;
  label: string;
  value: string;
  source?: string;
}

export interface VeDossierCounters {
  /** Уникальных компаний в сегменте; compatibility-поле для старых consumers. */
  companies_total: number | null;
  /** Как считали companies_total (фильтры/причина null). */
  companies_note?: string;
  /** Сырых строк директории до объединения дублей по ИНН. */
  directory_rows_total?: number | null;
  /** Уникальных компаний по ИНН; строки без ИНН считаются отдельно. */
  companies_unique_total?: number | null;
  /** Уникальных компаний, где хотя бы в одной строке указан email. */
  companies_with_email?: number | null;
  /** Уникальных компаний, где хотя бы в одной строке указан телефон. */
  companies_with_phone?: number | null;
  /** Уникальных компаний хотя бы с одним из двух каналов. */
  companies_with_any_contact?: number | null;
  /** Найдено открытых вакансий на hh.ru (null — запрос не удался). */
  hh_vacancies_total: number | null;
  /** Примеры названий вакансий (до 10). */
  hh_vacancies_sample: string[];
  signals: VeDossierSignal[];
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

/* ─────────────────── Директория компаний: честная статистика ─────────────────── */

export interface VeDirectorySegmentStats {
  directory_rows_total: number | null;
  companies_unique_total: number | null;
  /** Канал указан хотя бы в одной строке компании, прошедшей условие среза. */
  companies_with_email: number | null;
  companies_with_phone: number | null;
  /** Счётчик выборки «email или телефон» не считает — в новых досье null, карточка его не показывает. */
  companies_with_any_contact: number | null;
  error?: string;
}

export interface VeDirectorySegmentStatsFilters {
  okvedCodes: string[];
  includeIp?: boolean;
  regionCodes?: string[];
  revenueFrom?: number;
  revenueTo?: number;
  employeesFrom?: number;
  employeesTo?: number;
  requireEmail?: boolean;
}

const emptyDirectoryStats = (error?: string): VeDirectorySegmentStats => ({
  directory_rows_total: null,
  companies_unique_total: null,
  companies_with_email: null,
  companies_with_phone: null,
  companies_with_any_contact: null,
  ...(error ? { error } : {}),
});

/**
 * Размер среза реестра тем же условием, что и выборка при сборе базы
 * (ve_directory_plan_population: основной ОКВЭД компании, запасной —
 * приблизительный). Прежний ve_directory_segment_stats смотрел только
 * приблизительный ОКВЭД и показывал 0 там, где сбор находит тысячи компаний
 * (86.2: 0 против 26 337).
 */
export async function getVeDirectorySegmentStats(
  filters: VeDirectorySegmentStatsFilters,
  supabase?: SupabaseClient,
): Promise<VeDirectorySegmentStats> {
  const client = supabase ?? supabaseAdmin;
  if (!client) return emptyDirectoryStats('admin-клиент Supabase не сконфигурирован');

  const slice = veDirectoryFiltersSlice({
    okvedCodes: filters.okvedCodes,
    includeIp: filters.includeIp ?? false,
    regionCodes: filters.regionCodes,
    revenueFrom: filters.revenueFrom,
    revenueTo: filters.revenueTo,
    employeesFrom: filters.employeesFrom,
    employeesTo: filters.employeesTo,
    hasEmail: filters.requireEmail === true,
  });
  const population = await getVeDirectoryPlanPopulation(client, [slice]);
  if (population.error) return emptyDirectoryStats(population.error);
  if ([
    population.directory_rows_total,
    population.companies_with_email,
    population.companies_with_phone,
  ].some((value) => value === null)) {
    return emptyDirectoryStats('некорректный ответ статистики директории');
  }
  return {
    directory_rows_total: population.directory_rows_total,
    companies_unique_total: population.companies_unique_total,
    companies_with_email: population.companies_with_email,
    companies_with_phone: population.companies_with_phone,
    companies_with_any_contact: null,
  };
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

function buildSignals(hhTotal: number | null, sample: string[]): VeDossierSignal[] {
  const signals: VeDossierSignal[] = [];
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
): Promise<VeDossierCounters> {
  const log = input.log ?? (() => {});
  const verticalName = (input.verticalName ?? '').trim();
  const synonyms = (input.synonyms ?? []).map((s) => s.trim()).filter(Boolean);
  const roleTitles = (input.roleTitles ?? []).map((s) => s.trim()).filter(Boolean);

  // ── 1. Наша директория компаний (фильтр по ОКВЭД-2) ──
  let companies_total: number | null = null;
  let directory_rows_total: number | null = null;
  let companies_unique_total: number | null = null;
  let companies_with_email: number | null = null;
  let companies_with_phone: number | null = null;
  let companies_with_any_contact: number | null = null;
  let companies_note: string | undefined;
  const matchText = [verticalName, ...synonyms].filter(Boolean).join(' ');
  const industryMatch = matchVeDossierIndustryCategories(verticalName, synonyms);
  const { categories } = industryMatch;
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
    const stats = await getVeDirectorySegmentStats(
      { okvedCodes, includeIp: false },
      deps?.supabase,
    );
    if (stats.error || stats.companies_unique_total === null) {
      companies_note = `${criteria}. Статистика вернула ошибку: ${stats.error ?? 'неизвестная'}.`;
    } else {
      directory_rows_total = stats.directory_rows_total;
      companies_unique_total = stats.companies_unique_total;
      companies_with_email = stats.companies_with_email;
      companies_with_phone = stats.companies_with_phone;
      companies_with_any_contact = stats.companies_with_any_contact;
      companies_total = companies_unique_total;
      companies_note = `${criteria}. Компании отобраны по основному ОКВЭД тем же условием, что и при сборе базы. Уникальные компании считаются по ИНН; строки без ИНН — отдельно. Email и телефоны из справочника ещё не валидированы.`;
    }
  }
  if (industryMatch.note && companies_note) companies_note += ` ${industryMatch.note}`;
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
    directory_rows_total,
    companies_unique_total,
    companies_with_email,
    companies_with_phone,
    companies_with_any_contact,
    hh_vacancies_total,
    hh_vacancies_sample,
    signals: buildSignals(hh_vacancies_total, hh_vacancies_sample),
  };
}
