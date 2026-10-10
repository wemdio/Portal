/**
 * Справочник компаний (pdl_companies) — третий источник английского аутрича.
 *
 * Зачем. Вакансии и YC дают 10–25 готовых компаний в день, а ящики английской
 * рассылки могут отправлять 160 первых писем. Источник вакансий выбирается за
 * два автосбора: их всего около 4 000 за 45 дней, новых ~150 в рабочий день.
 * Справочник — 19,5 млн компаний мира, из них под наши фильтры подходит около
 * миллиона, и он не кончается.
 *
 * Повод компании из справочника неизвестен заранее — его вытягивает разбор
 * сайта (siteProfile.occasions): открытая вакансия продаж на их собственной
 * странице вакансий, раунд, выход на новый рынок, конференция, стек продаж.
 * Компания, у которой не нашлось ни одного повода, отсеивается как и прежде
 * (`no_trigger`) — писать «просто так» мы не начинаем.
 *
 * Отрасли идут очередями (решение Максима 09.10.2026: «IT, Digital в первую
 * очередь, дальше по отклику смотреть»): сначала ИТ и цифровые услуги, затем
 * остальной B2B. Отрасли, которые наш же фильтр ICP потом выбросит (рестораны,
 * розница, медицина, образование, стаффинг, рекламные агентства), не берём
 * вовсе — за них не стоит платить ни поиском почты, ни разбором сайта.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain, PDL_COUNTRY_BY_CODE } from './resolveDomain';
import type { PolzaOutreachConfig } from './types';

export interface DirectoryCompany {
  name: string;
  domain: string;
  website: string;
  industry: string | null;
  /** Вилка размера как в справочнике: «51-200». */
  size: string | null;
  country: string | null;
  description: string | null;
}

/**
 * Первая очередь — ИТ и цифровые услуги. Значения отрасли берутся из
 * справочника как есть (нижний регистр, формулировки PDL).
 */
const IT_DIGITAL_INDUSTRIES = [
  'information technology and services',
  'computer software',
  'internet',
  'computer & network security',
  'information services',
  'computer networking',
  'computer hardware',
  'semiconductors',
  'telecommunications',
];

/**
 * Вторая очередь — остальной B2B, где у компании есть отдел продаж и сделка
 * дороже одной корзины: промышленность, логистика, финансы, консалтинг.
 */
const WIDE_B2B_INDUSTRIES = [
  'management consulting',
  'financial services',
  'mechanical or industrial engineering',
  'industrial automation',
  'logistics and supply chain',
  'transportation/trucking/railroad',
  'machinery',
  'electrical/electronic manufacturing',
  'wholesale',
  'import and export',
  'business supplies and equipment',
  'outsourcing/offshoring',
  'professional training & coaching',
  'renewables & environment',
  'packaging and containers',
  'warehousing',
  'maritime',
  'aviation & aerospace',
  'chemicals',
  'building materials',
];

/** Очереди отраслей в порядке обхода. */
export const DIRECTORY_INDUSTRY_TIERS: readonly (readonly string[])[] = [IT_DIGITAL_INDUSTRIES, WIDE_B2B_INDUSTRIES];

/**
 * Вилки размера и порядок их обхода. 51–200 первыми: отдел продаж уже есть, а
 * своего отдела лидогенерации, которому мы не нужны, ещё нет.
 */
const SIZE_ORDER = ['51-200', '11-50', '201-500'] as const;

/** Нижняя и верхняя границы вилки справочника — чтобы сверить с настройками запуска. */
const SIZE_BOUNDS: Record<string, [number, number]> = {
  '11-50': [11, 50],
  '51-200': [51, 200],
  '201-500': [201, 500],
};

/** Страница выборки из справочника. */
const PAGE = 1000;

/**
 * Насколько глубоко разрешаем случайный сдвиг по отрасли.
 *
 * Без сдвига каждый ночной сбор брал бы одни и те же первые строки: компании,
 * отсеянные не «навсегда» (нет повода, низкая оценка, сайт не открылся), в
 * память отказов не попадают и перебирались бы по кругу, а справочник так и
 * остался бы прочитанным на первые четыре тысячи.
 */
const MAX_RANDOM_OFFSET = 50_000;

interface LoadOptions {
  /** Сколько компаний нужно набрать. */
  want: number;
  /** Домены, которые брать не надо: уже готовы или недавно отсеяны. */
  skipDomains: ReadonlySet<string>;
}

/** Вилки размера, попадающие в настройки запуска (min_employees…max_employees). */
function sizesFor(config: PolzaOutreachConfig): string[] {
  return SIZE_ORDER.filter((size) => {
    const [lo, hi] = SIZE_BOUNDS[size];
    return hi >= config.min_employees && lo <= config.max_employees;
  });
}

export async function loadDirectoryCompanies(
  db: SupabaseClient,
  config: PolzaOutreachConfig,
  options: LoadOptions,
): Promise<DirectoryCompany[]> {
  const want = Math.max(0, options.want);
  if (want === 0) return [];
  const countries = config.countries.map((c) => PDL_COUNTRY_BY_CODE[c]).filter(Boolean);
  if (!countries.length) return [];
  const sizes = sizesFor(config);
  if (!sizes.length) return [];

  const out: DirectoryCompany[] = [];
  const seen = new Set<string>();

  for (const industries of DIRECTORY_INDUSTRY_TIERS) {
    for (const size of sizes) {
      if (out.length >= want) return out;
      // Сдвиг случайный, но один на (очередь × размер): страницы внутри идут
      // подряд, иначе выборка рвалась бы и повторялась.
      let from = Math.floor(Math.random() * MAX_RANDOM_OFFSET);
      // Сдвиг мог оказаться дальше конца выборки — тогда начинаем сначала.
      // Без этого отрасль с десятью тысячами компаний молча давала бы ноль.
      let restarted = false;
      while (out.length < want) {
        const { data, error } = await db
          .from('pdl_companies')
          .select('name,website,industry,size,country,description')
          .in('country', countries)
          .eq('size', size)
          .in('industry', industries as string[])
          .not('website', 'is', null)
          // Порядок обязателен: без него страницы range() не повторяемы и
          // строка может выпасть или прийти дважды.
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`directory companies load failed: ${error.message}`);
        if (!data?.length && from > 0 && !restarted) {
          restarted = true;
          from = 0;
          continue;
        }
        for (const row of data ?? []) {
          const domain = normalizeDomain(String(row.website ?? ''));
          if (!domain || !domain.includes('.')) continue;
          if (seen.has(domain) || options.skipDomains.has(domain)) continue;
          const name = String(row.name ?? '').trim();
          if (!name) continue;
          seen.add(domain);
          out.push({
            name,
            domain,
            website: `https://${domain}`,
            industry: row.industry ? String(row.industry) : null,
            size: row.size ? String(row.size) : null,
            country: row.country ? String(row.country) : null,
            description: row.description ? String(row.description) : null,
          });
          if (out.length >= want) break;
        }
        // Страница короче запрошенной — отрасль с этим размером кончилась.
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
    }
  }

  return out;
}
