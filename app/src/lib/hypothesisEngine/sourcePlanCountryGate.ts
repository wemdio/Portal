/**
 * ЗАМОК СТРАН ПРОЕКТА НА ЗАДАЧАХ СБОРА — близнец sourcePlanMarketGate.ts (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1A и F2).
 * Чистый модуль: ни БД, ни модели, ни логов.
 *
 * Действует только при market='us' и НЕПУСТОМ списке L (`brief.collect_countries`,
 * замороженном в `collect_info.countries` базы). Правила — строже, не мягче:
 *  - pdl: задача остаётся, только если у неё есть ключ «про кого» (непустые
 *    industries или name, HE_PDL_SCOPE_FILTER_KEYS) — иначе снимается
 *    (`pdl_no_scope`): срез «все компании этих стран» каталог не читает.
 *    Оставшейся задаче countries := L, что бы ни написал планировщик (пусто,
 *    'europe', чужая страна, подмножество L). Покрытие L — по построению;
 *  - funded: countries := L, задача не снимается;
 *  - eng_hiring: countries := iso2(L); пусто — снимается (`hiring_no_codes`):
 *    пустой список у фида значит «без фильтра»;
 *  - google_maps: только если в L есть США (выдача карт — только US), иначе
 *    снимается (`maps_us_not_listed`); geo := 'United States', если geo не
 *    строго американское (heUsMapsGeo);
 *  - прочие источники не трогаются (их у us снимает набор рынка раньше).
 * После наложения снимаются задачи-дубли по ключу среза (heCatalogSliceKey).
 * Замок никогда не добавляет задач, идемпотентен и возвращает ТОТ ЖЕ объект,
 * когда рынок не us, список пуст или ничего не изменилось.
 */

import { heCatalogSliceKey } from './catalogCursor';
import { engCountryIso2, ENG_COUNTRY_US, normalizeEngCountry } from './engCountries';
import type { HeMarket } from './market';
import type { HeCollectTask, HeSourcePlan } from './prompts/sourcePlan';
import { HE_PDL_SCOPE_FILTER_KEYS } from './schemas';

export type HeCountryDropReason = 'pdl_no_scope' | 'maps_us_not_listed' | 'hiring_no_codes' | 'duplicate_slice';

const US_STATES: ReadonlyArray<readonly [string, string]> = [
  ['al', 'alabama'], ['ak', 'alaska'], ['az', 'arizona'], ['ar', 'arkansas'], ['ca', 'california'],
  ['co', 'colorado'], ['ct', 'connecticut'], ['de', 'delaware'], ['fl', 'florida'], ['ga', 'georgia'],
  ['hi', 'hawaii'], ['id', 'idaho'], ['il', 'illinois'], ['in', 'indiana'], ['ia', 'iowa'],
  ['ks', 'kansas'], ['ky', 'kentucky'], ['la', 'louisiana'], ['me', 'maine'], ['md', 'maryland'],
  ['ma', 'massachusetts'], ['mi', 'michigan'], ['mn', 'minnesota'], ['ms', 'mississippi'], ['mo', 'missouri'],
  ['mt', 'montana'], ['ne', 'nebraska'], ['nv', 'nevada'], ['nh', 'new hampshire'], ['nj', 'new jersey'],
  ['nm', 'new mexico'], ['ny', 'new york'], ['nc', 'north carolina'], ['nd', 'north dakota'], ['oh', 'ohio'],
  ['ok', 'oklahoma'], ['or', 'oregon'], ['pa', 'pennsylvania'], ['ri', 'rhode island'], ['sc', 'south carolina'],
  ['sd', 'south dakota'], ['tn', 'tennessee'], ['tx', 'texas'], ['ut', 'utah'], ['vt', 'vermont'],
  ['va', 'virginia'], ['wa', 'washington'], ['wv', 'west virginia'], ['wi', 'wisconsin'], ['wy', 'wyoming'],
  ['dc', 'district of columbia'],
];
const STATE_CODES = US_STATES.map(([code]) => code).join('|');
const STATE_NAMES = US_STATES.map(([, name]) => name.replace(/ /g, '\\s+')).join('|');

/** Гео строго США: страна целиком, штат голым именем или «…, <штат|код>[ ZIP]» в конце. */
const US_COUNTRY_GEO_RE = /^(?:united\s+states(?:\s+of\s+america)?|u\.?s\.?a?\.?)$/i;
const US_STATE_GEO_RE = new RegExp(`^(?:${STATE_NAMES})$`, 'i');
const US_TAIL_GEO_RE = new RegExp(`,\\s*(?:${STATE_NAMES}|${STATE_CODES})(?:\\s+\\d{5}(?:-\\d{4})?)?\\s*$`, 'i');

/** maps_query.geo для задачи под замком: строго американское — как есть, иначе 'United States'. */
export function heUsMapsGeo(geo: string | undefined): string {
  const g = (geo ?? '').trim();
  if (g && (US_COUNTRY_GEO_RE.test(g) || US_STATE_GEO_RE.test(g) || US_TAIL_GEO_RE.test(g))) return g;
  return 'United States';
}

const US_ADDRESS_ZIP_RE = new RegExp(`\\b(?:${STATE_CODES.toUpperCase()})\\s+\\d{5}(?:-\\d{4})?\\b`);
const US_ADDRESS_TAIL_RE = /,\s*(?:united states|usa)\s*$/i;

/** Адрес строки карт — в США (код штата + ZIP или «, United States» в конце). Пустой — нет. */
export function heUsMapsAddress(address: string): boolean {
  const a = (address ?? '').trim();
  if (!a) return false;
  return US_ADDRESS_ZIP_RE.test(a) || US_ADDRESS_TAIL_RE.test(a);
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function iso2List(countries: readonly string[]): string[] {
  return [...new Set(countries.map(engCountryIso2).filter((c): c is string => c !== null))];
}

function pdlHasScope(filters: HeCollectTask['pdl_filters']): boolean {
  if (!filters) return false;
  return HE_PDL_SCOPE_FILTER_KEYS.some((key) => {
    const v = filters[key];
    return Array.isArray(v) ? v.some((x) => typeof x === 'string' && x.trim() !== '') : typeof v === 'string' && v.trim() !== '';
  });
}

/** Одна задача под замком. L пуст — та же задача без изменений. */
export function gateHeTaskCountries(
  task: HeCollectTask,
  countries: readonly string[],
): { task: HeCollectTask; changed: boolean } | { dropped: HeCountryDropReason } {
  if (countries.length === 0) return { task, changed: false };
  const L = [...countries];
  switch (task.source) {
    case 'pdl': {
      if (!pdlHasScope(task.pdl_filters)) return { dropped: 'pdl_no_scope' };
      if (sameList(task.pdl_filters?.countries, L)) return { task, changed: false };
      return { task: { ...task, pdl_filters: { ...task.pdl_filters, countries: L } }, changed: true };
    }
    case 'funded': {
      if (sameList(task.funded_filters?.countries, L)) return { task, changed: false };
      return { task: { ...task, funded_filters: { ...task.funded_filters, countries: L } }, changed: true };
    }
    case 'eng_hiring': {
      const codes = iso2List(L);
      if (codes.length === 0) return { dropped: 'hiring_no_codes' };
      const query = task.eng_hiring_query ?? { roles: [] };
      if (sameList(query.countries, codes)) return { task, changed: false };
      return { task: { ...task, eng_hiring_query: { ...query, countries: codes } }, changed: true };
    }
    case 'google_maps': {
      if (!L.includes(ENG_COUNTRY_US)) return { dropped: 'maps_us_not_listed' };
      if (!task.maps_query) return { task, changed: false };
      const geo = heUsMapsGeo(task.maps_query.geo);
      if (geo === task.maps_query.geo) return { task, changed: false };
      return { task: { ...task, maps_query: { ...task.maps_query, geo } }, changed: true };
    }
    default:
      return { task, changed: false };
  }
}

/**
 * План под замком. Тот же объект — при market≠'us', пустом L или если ничего
 * не изменилось. `changed` — сколько задач сужено.
 */
export function gateHeSourcePlanCountries(
  plan: HeSourcePlan,
  market: HeMarket,
  countries: readonly string[],
): { plan: HeSourcePlan; dropped: Array<{ source: string; reason: HeCountryDropReason }>; changed: number } {
  if (market !== 'us' || countries.length === 0) return { plan, dropped: [], changed: 0 };
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const dropped: Array<{ source: string; reason: HeCountryDropReason }> = [];
  const kept: HeCollectTask[] = [];
  const seenKeys = new Set<string>();
  let changed = 0;
  let touched = false;
  for (const task of tasks) {
    const gated = gateHeTaskCountries(task, countries);
    if ('dropped' in gated) {
      dropped.push({ source: String(task?.source ?? ''), reason: gated.dropped });
      touched = true;
      continue;
    }
    const key = heCatalogSliceKey(gated.task);
    if (key !== null) {
      if (seenKeys.has(key)) {
        dropped.push({ source: String(task?.source ?? ''), reason: 'duplicate_slice' });
        touched = true;
        continue;
      }
      seenKeys.add(key);
    }
    if (gated.changed) {
      changed += 1;
      touched = true;
    }
    kept.push(gated.task);
  }
  if (!touched) return { plan, dropped: [], changed: 0 };
  return { plan: { ...plan, tasks: kept }, dropped, changed };
}

/**
 * Срез платного расширения (всегда pdl) — строже обычного правила: модель,
 * назвавшая страну вне списка или нераспознанную метку, получает отказ, а не
 * подмену на L (подмена купила бы срез, о котором модель не думала).
 */
export function gateHeWidenTaskCountries(
  task: HeCollectTask,
  countries: readonly string[],
): { task: HeCollectTask } | { refused: 'outside_list' | 'pdl_no_scope' } {
  if (countries.length === 0) return { task };
  const pinned =
    task.source === 'pdl' ? task.pdl_filters?.countries : task.source === 'funded' ? task.funded_filters?.countries : undefined;
  if (pinned && pinned.length > 0) {
    const resolved = pinned.map(normalizeEngCountry);
    if (resolved.some((c) => c === null) || !resolved.some((c) => c !== null && countries.includes(c))) {
      return { refused: 'outside_list' };
    }
  }
  const gated = gateHeTaskCountries(task, countries);
  if ('dropped' in gated) return { refused: gated.dropped === 'pdl_no_scope' ? 'pdl_no_scope' : 'outside_list' };
  return { task: gated.task };
}

/** Задача уже под замком (замок её не меняет и не снимает). Пустой L — да. */
export function heTaskWithinCountries(task: HeCollectTask, countries: readonly string[]): boolean {
  if (countries.length === 0) return true;
  const gated = gateHeTaskCountries(task, countries);
  return !('dropped' in gated) && !gated.changed;
}

/**
 * Отказ исполнить задачу вне списка стран — ДО любого коллектора, то есть
 * ничего не оплачено. Ловит обработчик задачи в стадии (runDispatch): задача
 * 'failed', остальные идут своим путём.
 */
export class HeCountryRefusal extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`задача ${source} не укладывается в список стран проекта — задача не исполнялась, коллектор не вызывался`);
    this.name = 'HeCountryRefusal';
    this.source = source;
  }
}

/** Assert перед коллектором: задача не под замком → HeCountryRefusal. Пустой L — ничего. */
export function assertHeTaskWithinCountries(task: HeCollectTask, countries: readonly string[]): void {
  if (!heTaskWithinCountries(task, countries)) throw new HeCountryRefusal(String(task?.source ?? ''));
}
