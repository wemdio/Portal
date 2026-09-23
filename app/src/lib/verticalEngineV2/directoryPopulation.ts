/**
 * Размер реестровой части плана — тем же условием, что и выборка.
 *
 * Выборка идёт через companies_directory_fetch_rpc (точный ОКВЭД с запасным
 * приблизительным, регион, ИП, пороги, «есть email»), вторая очередь ещё
 * проверяет «порог или пустое поле» на строке. Прежний счётчик
 * ve_directory_segment_stats смотрел только приблизительный ОКВЭД и расходился
 * с выборкой в разы (86.2: 0 против 27 848 строк), а при двух срезах не считал
 * ничего. ve_directory_plan_population считает объединение срезов одним
 * проходом, компания по ИНН входит один раз.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { OKVED2_TREE, reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import type { VeCollectTask } from './prompts/sourcePlan';

export interface VeDirectoryPopulationSlice {
  okved_prefixes: string[] | null;
  region_codes: string[] | null;
  include_ip: boolean;
  has_email: boolean;
  revenue_from?: number;
  revenue_to?: number;
  employees_from?: number;
  employees_to?: number;
  keep_revenue_from?: number;
  keep_revenue_to?: number;
  keep_employees_from?: number;
  keep_employees_to?: number;
}

export interface VeDirectoryPlanPopulation {
  directory_rows_total: number | null;
  /** Компаний в объединении срезов (ИНН, без ИНН — строка). */
  companies_unique_total: number | null;
  /** Из них ещё не взяты другими базами проекта. */
  companies_available: number | null;
  companies_with_email: number | null;
  companies_with_phone: number | null;
  slice_companies: number[];
  error?: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Как filtersToRpcParams: верхние коды, буквенная секция — её классы. */
function okvedPrefixes(codes: string[] | undefined): string[] | null {
  const prefixes = reduceToTopCodes(new Set((codes ?? []).map((code) => code.trim()).filter(Boolean))).flatMap((code) =>
    /^[A-Z]$/i.test(code) ? OKVED2_TREE.find((node) => node.code === code)?.children?.map((child) => child.code) ?? [code] : [code]);
  return prefixes.length ? prefixes : null;
}

/** Реестровая задача плана → срез для подсчёта; прочие источники размера не имеют. */
export function veDirectoryPopulationSlice(task: VeCollectTask): VeDirectoryPopulationSlice | null {
  if (task.source !== 'companies_directory') return null;
  const filters = task.directory_filters ?? {};
  const regions = (filters.regionCodes ?? []).map((code) => code.trim()).filter(Boolean);
  const slice: VeDirectoryPopulationSlice = {
    okved_prefixes: okvedPrefixes(filters.okvedCodes),
    region_codes: regions.length ? regions : null,
    // Как mapDirectoryFilters: без явного разрешения ИП не берём.
    include_ip: filters.includeIp ?? false,
    has_email: filters.hasEmail === true,
  };
  if (finite(filters.revenueFrom)) slice.revenue_from = filters.revenueFrom;
  if (finite(filters.revenueTo)) slice.revenue_to = filters.revenueTo;
  if (finite(filters.employeesFrom)) slice.employees_from = filters.employeesFrom;
  if (finite(filters.employeesTo)) slice.employees_to = filters.employeesTo;
  const keep = filters.sizeOrUnknown;
  if (finite(keep?.revenueFrom)) slice.keep_revenue_from = keep.revenueFrom;
  if (finite(keep?.revenueTo)) slice.keep_revenue_to = keep.revenueTo;
  if (finite(keep?.employeesFrom)) slice.keep_employees_from = keep.employeesFrom;
  if (finite(keep?.employeesTo)) slice.keep_employees_to = keep.employeesTo;
  return slice;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const failed = (error: string): VeDirectoryPlanPopulation => ({
  directory_rows_total: null, companies_unique_total: null, companies_available: null,
  companies_with_email: null, companies_with_phone: null, slice_companies: [], error,
});

/** Один вызов на все срезы плана: складывать размеры срезов по отдельности нельзя. */
export async function getVeDirectoryPlanPopulation(
  supabase: SupabaseClient,
  slices: VeDirectoryPopulationSlice[],
  excludeInns: Iterable<string> = [],
): Promise<VeDirectoryPlanPopulation> {
  const exclude = [...new Set(excludeInns)];
  try {
    const { data, error } = await supabase.rpc('ve_directory_plan_population', {
      p_slices: slices, p_exclude_inns: exclude.length ? exclude : null,
    });
    if (error) return failed(error.message ?? String(error));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return failed('некорректный ответ счётчика реестра');
    const payload = data as Record<string, unknown>;
    const result: VeDirectoryPlanPopulation = {
      directory_rows_total: count(payload.directory_rows_total),
      companies_unique_total: count(payload.companies_unique_total),
      companies_available: count(payload.companies_available),
      companies_with_email: count(payload.companies_with_email),
      companies_with_phone: count(payload.companies_with_phone),
      slice_companies: Array.isArray(payload.slice_companies) ? payload.slice_companies.map((value) => count(value) ?? 0) : [],
    };
    if (result.companies_unique_total === null || result.companies_available === null
      || result.companies_available > result.companies_unique_total) return failed('некорректный ответ счётчика реестра');
    return result;
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** Источники без размера рынка: карты и вакансии не сообщают, сколько компаний в срезе. */
const VE_UNSIZED_SOURCE_LABELS: Record<string, string> = {
  hh_live: 'вакансии hh.ru', eng_hiring: 'вакансии', yandex_maps: 'Яндекс Карты', google_maps: 'Google Maps',
  pdl: 'каталог PDL', funded: 'каталог стартапов',
};

export function veUnsizedSourceLabels(tasks: VeCollectTask[]): string[] {
  return [...new Set(tasks.filter((task) => task.source !== 'companies_directory')
    .map((task) => VE_UNSIZED_SOURCE_LABELS[task.source] ?? task.source))];
}
