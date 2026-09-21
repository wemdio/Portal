/**
 * S2 — восстановление домена компании.
 *
 * PDL-резолвер намеренно возвращает '' при коллизии имён — это правильное
 * поведение, «чинить» не надо (план, шаг 3). Нормализация домена — спека §8:
 * без протокола/www/пути/параметров, нижний регистр. LinkedIn и job board
 * вместо сайта компании не подставляются никогда (резолвер их и не отдаёт).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCompanyDomainViaPdl } from '@/lib/parsers/companyDomainResolver';

export interface PolzaDomainResolution {
  /** Нормализованный домен ('acme.com') или null, если не разрешился. */
  normalizedDomain: string | null;
  companyWebsite: string | null;
  /** Корзина размера из pdl_companies ('1-10', '11-50', ...), если нашлась. */
  companySize: string | null;
}

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .replace(/:\d+$/, '');
}

function cleanPdlWebsite(value: unknown): string {
  return normalizeDomain(String(value ?? ''));
}

/**
 * Размер компании из pdl_companies по уже разрешённому домену. Индекса на
 * website нет (19.5M строк), поэтому лезем тем же name-prefix запросом, что и
 * резолвер (покрыт trgm-индексом), и сверяем домен клиентски.
 */
async function lookupPdlSize(
  db: SupabaseClient,
  companyName: string,
  normalizedDomain: string,
): Promise<string | null> {
  const prefix = companyName.replace(/[%_]/g, ' ').trim();
  if (!prefix) return null;
  const { data, error } = await db
    .from('pdl_companies')
    .select('name,website,size')
    .ilike('name', `${prefix}%`)
    .limit(40);
  if (error || !Array.isArray(data)) return null;
  const sizes = new Set(
    data
      .filter((row) => row && cleanPdlWebsite(row.website) === normalizedDomain && row.size)
      .map((row) => String(row.size)),
  );
  return sizes.size === 1 ? [...sizes][0] : null;
}

export async function resolveCompanyDomain(
  db: SupabaseClient,
  companyName: string,
  countryCode: string | null,
): Promise<PolzaDomainResolution> {
  // Резолвер использует своего supabaseAdmin (в воркере это тот же клиент);
  // собственный тип DomainDb у него уже совместим с клиентом внутри модуля.
  const domain = normalizeDomain(await resolveCompanyDomainViaPdl(companyName, countryCode));
  if (!domain) {
    return { normalizedDomain: null, companyWebsite: null, companySize: null };
  }
  const companySize = await lookupPdlSize(db, companyName, domain);
  return {
    normalizedDomain: domain,
    companyWebsite: `https://${domain}`,
    companySize,
  };
}
