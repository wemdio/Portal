/**
 * Метки каталога PDL для плана сборки market='us': отрасли, размеры и страны,
 * которые пишет планировщик, сверяются со списком значений, реально лежащих в
 * pdl_companies (RPC pdl_facets, миграция 20260609_0001).
 *
 * Зачем. Фильтр каталога — точное совпадение (`industry = any(...)` в
 * search_pdl_companies). Метка, которой в каталоге нет, не находит НИЧЕГО и
 * молчит: «hospital and health care» вместо «hospital & health care» или «usa»
 * вместо «united states» превращают срез в ноль строк без единой ошибки. Модель
 * пишет такие метки охотно, а сохранённый план (he_catalog_cursors) повторяет
 * их каждую ночь, пока не изменится вход планировщика.
 *
 * Что делает разбор (resolveHePdlFilters) — по каждой из трёх осей:
 *  - метка совпала со значением каталога после нормализации (регистр, «&» ↔
 *    «and», пунктуация, «10,001+» ↔ «10001+», короткие имена стран из списка
 *    ниже) — заменяется значением каталога;
 *  - метки в каталоге нет, а другие метки той же оси есть — снимается. Выдача
 *    от этого не меняется (`= any` по несуществующему значению не находит
 *    ничего), меняется только строка лога: её видно;
 *  - НИ ОДНОЙ метки оси нет в каталоге — ось оставляется как написана и
 *    помечается мёртвой (`dead`). Снять её целиком нельзя: срез без отраслей
 *    или без стран — это весь каталог, то есть расширение в тысячи раз, о
 *    котором никто не просил. Исключение — размеры: порог размера и так
 *    снимается, когда у среза остаётся «про кого» (отрасль или имя), ровно по
 *    правилу необоснованного порога (heTaskWithoutUnfoundedSize).
 * Что делать с мёртвым срезом, решает вызывающий (stages/baseCollect.ts).
 *
 * Чтение справочника (loadHePdlFacets) — fail-open: отказ, пустой ответ или
 * срок → null, и план идёт с метками как написаны (поведение до этой правки).
 * Сборку чтение справочника не останавливает никогда.
 *
 * Цена чтения: pdl_facets — три GROUP BY по всему каталогу (~19,5 млн строк),
 * поэтому ответ живёт в памяти процесса FACETS_TTL_MS, одновременные вызовы
 * ждут одно чтение, а после отказа FACETS_FAILURE_COOLDOWN_MS справочник не
 * читается вовсе. Читает только фаза PLAN стадии base_collect (новый план,
 * починка «нет каталога», повторная проба среза, платное расширение плана) —
 * переиспользованный план справочник не читает.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { HeCollectTask } from './prompts/sourcePlan';

export type HePdlFilters = NonNullable<HeCollectTask['pdl_filters']>;

type HePdlAxis = 'industries' | 'sizes' | 'countries';

const HE_PDL_AXES: readonly HePdlAxis[] = ['industries', 'sizes', 'countries'];

/** Справочник: нормализованный ключ → значение ровно как в pdl_companies. */
export interface HePdlFacets {
  industries: ReadonlyMap<string, string>;
  sizes: ReadonlyMap<string, string>;
  countries: ReadonlyMap<string, string>;
}

/** Каталог перезаливается дампом, между перезаливками значения те же. */
const FACETS_TTL_MS = 6 * 60 * 60 * 1000;
/** После отказа чтения справочник не читаем — каждый план шёл бы через тот же срок. */
const FACETS_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
/** Срок одного чтения справочника; дольше — план идёт с метками как написаны. */
const FACETS_TIMEOUT_MS = 45_000;

let cached: { at: number; facets: HePdlFacets } | null = null;
let failedAt: number | null = null;
let inFlight: Promise<HePdlFacets | null> | null = null;

/** Отрасль и страна: регистр, «&» ↔ «and», пунктуация и пробелы не различаются. */
function labelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Размер: «51 - 200», «51–200 employees» и «10,001+» — те же корзины, что «51-200» и «10001+». */
function sizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/employees?/g, '')
    .replace(/[‒-―]/g, '-')
    .replace(/[\s,]+/g, '');
}

function axisKey(axis: HePdlAxis, value: string): string {
  return axis === 'sizes' ? sizeKey(value) : labelKey(value);
}

/**
 * Короткие имена стран, которые модель пишет вместо названия из каталога.
 * Ключи — уже в форме labelKey. Подставляются, только если цель есть в
 * справочнике.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  us: 'united states',
  usa: 'united states',
  'u s': 'united states',
  'u s a': 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  'u k': 'united kingdom',
  'great britain': 'united kingdom',
  uae: 'united arab emirates',
};

function readAxis(raw: unknown, axis: HePdlAxis): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const value = item && typeof item === 'object' ? (item as { value?: unknown }).value : null;
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = axisKey(axis, value);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

/** Ответ pdl_facets → справочник; null, если хоть одна ось пуста (разбирать нечем). */
export function parseHePdlFacets(data: unknown): HePdlFacets | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const facets: HePdlFacets = {
    industries: readAxis(row.industries, 'industries'),
    sizes: readAxis(row.sizes, 'sizes'),
    countries: readAxis(row.countries, 'countries'),
  };
  return HE_PDL_AXES.every((axis) => facets[axis].size > 0) ? facets : null;
}

/**
 * Справочник меток каталога. Никогда не бросает: null — читать нечем или не
 * вышло, и вызывающий оставляет метки плана как написаны.
 *
 * `signal` — сигнал джобы: прерванное им чтение отказом справочника НЕ
 * считается (окно FACETS_FAILURE_COOLDOWN_MS не включается), это судьба
 * прогона, а не каталога.
 */
export async function loadHePdlFacets(
  db: SupabaseClient,
  options: { signal?: AbortSignal; log?: (message: string) => void } = {},
): Promise<HePdlFacets | null> {
  const now = Date.now();
  if (cached && now - cached.at < FACETS_TTL_MS) return cached.facets;
  if (failedAt !== null && now - failedAt < FACETS_FAILURE_COOLDOWN_MS) return null;
  if (inFlight) return inFlight;

  const read = (async (): Promise<HePdlFacets | null> => {
    let reason: string;
    try {
      const { data, error } = await db.rpc('pdl_facets').abortSignal(AbortSignal.timeout(FACETS_TIMEOUT_MS));
      if (error) {
        reason = error.message;
      } else {
        const facets = parseHePdlFacets(data);
        if (facets) {
          cached = { at: Date.now(), facets };
          failedAt = null;
          return facets;
        }
        reason = 'пустой или непонятный ответ';
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (!options.signal?.aborted) failedAt = Date.now();
    options.log?.(
      `[base_collect] справочник меток каталога (pdl_facets) не прочитан: ${reason.slice(0, 120)} — ` +
        'метки плана идут как написаны',
    );
    return null;
  })();
  inFlight = read;
  try {
    return await read;
  } finally {
    inFlight = null;
  }
}

/** Итог разбора фильтров одного pdl-среза. */
export interface HePdlLabelResolution {
  filters: HePdlFilters;
  /** Заменённые метки: «как написала модель → как в каталоге». */
  mapped: string[];
  /** Снятые метки (в каталоге их нет, другие метки той же оси есть). */
  dropped: string[];
  /** Оси, у которых в каталоге нет ни одной метки: оставлены как написаны. */
  dead: HePdlAxis[];
}

function lookup(axis: HePdlAxis, raw: string, facets: HePdlFacets): string | null {
  const key = axisKey(axis, raw);
  const direct = facets[axis].get(key);
  if (direct !== undefined) return direct;
  if (axis !== 'countries') return null;
  const alias = COUNTRY_ALIASES[key];
  return alias !== undefined ? (facets.countries.get(alias) ?? null) : null;
}

/** Фильтры pdl-среза → метки каталога. Чистая функция, без чтений. */
export function resolveHePdlFilters(filters: HePdlFilters, facets: HePdlFacets): HePdlLabelResolution {
  const out: HePdlFilters = { ...filters };
  const mapped: string[] = [];
  const dropped: string[] = [];
  const dead: HePdlAxis[] = [];
  const unknownSizes: string[] = [];

  for (const axis of HE_PDL_AXES) {
    const labels = filters[axis];
    if (!labels || labels.length === 0) continue;
    const kept: string[] = [];
    const unknown: string[] = [];
    for (const raw of labels) {
      const hit = lookup(axis, raw, facets);
      if (hit === null) {
        unknown.push(raw);
        continue;
      }
      if (hit !== raw.trim().toLowerCase()) mapped.push(`${raw} → ${hit}`);
      if (!kept.includes(hit)) kept.push(hit);
    }
    if (kept.length > 0) {
      out[axis] = kept;
      dropped.push(...unknown.map((label) => `${axis}: ${label}`));
    } else if (axis === 'sizes') {
      unknownSizes.push(...unknown);
    } else {
      dead.push(axis);
    }
  }

  // Размеры без единой метки каталога снимаются, только если у среза остаётся
  // «про кого»: живая отрасль или имя. Иначе снятие сделало бы срезом весь
  // каталог — ось остаётся как написана и считается мёртвой.
  if (unknownSizes.length > 0) {
    const industriesLive = (out.industries?.length ?? 0) > 0 && !dead.includes('industries');
    const nameLive = typeof out.name === 'string' && out.name.trim() !== '';
    if (industriesLive || nameLive) {
      delete out.sizes;
      dropped.push(...unknownSizes.map((label) => `sizes: ${label}`));
    } else {
      dead.push('sizes');
    }
  }

  return { filters: out, mapped, dropped, dead };
}
