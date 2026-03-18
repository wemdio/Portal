import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  yandexMapsHealth,
  yandexMapsCollectLinks,
  yandexMapsParseOrgs,
  type YandexMapsOrganization,
} from '@/lib/parsers/yandexMapsServiceClient';

const BATCH_LIMIT = 15;

function buildSearchUrl(companyName: string, city?: string | null): string {
  const q = city ? `${companyName} ${city}` : companyName;
  return `https://yandex.ru/maps/?text=${encodeURIComponent(q)}`;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return digits.length >= 10 ? `+${digits}` : null;
}

export async function runYandexMapsEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; updated: number }> {
  if (!supabaseAdmin) return { processed: 0, updated: 0 };

  const healthy = await yandexMapsHealth();
  if (!healthy) {
    console.warn('[cis-leads] yandexMapsEnrichment: service not available, skipping');
    return { processed: 0, updated: 0 };
  }

  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(new Set(
    (leads ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean),
  ));
  if (companyIds.length === 0) return { processed: 0, updated: 0 };

  const { data: companiesWithoutPhone } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name, city')
    .in('id', companyIds)
    .is('phone', null)
    .limit(BATCH_LIMIT);

  if (!companiesWithoutPhone?.length) return { processed: 0, updated: 0 };

  let processed = 0;
  let updated = 0;

  for (const company of companiesWithoutPhone as Array<{ id: string; name: string; short_name: string | null; city: string | null }>) {
    const searchName = company.short_name || company.name;

    try {
      const searchUrl = buildSearchUrl(searchName, company.city);
      const { links } = await yandexMapsCollectLinks({
        search_url: searchUrl,
        max_results: 3,
        headless: true,
      });

      if (links.length === 0) { processed++; continue; }

      const { organizations } = await yandexMapsParseOrgs({
        links: links.slice(0, 1),
        headless: true,
      });

      const org = organizations[0] as YandexMapsOrganization | undefined;
      if (!org) { processed++; continue; }

      const companyUpdate: Record<string, string | null> = {};
      if (org.phone) {
        const p = normalizePhone(org.phone);
        if (p) companyUpdate.phone = p;
      }
      if (org.email) companyUpdate.email = org.email;
      if (org.website && !company.short_name) companyUpdate.site = org.website;

      if (Object.keys(companyUpdate).length > 0) {
        await supabaseAdmin
          .from('companies')
          .update(companyUpdate)
          .eq('id', company.id);
        updated++;
        console.log(`[cis-leads] yandexMaps: ${searchName} → phone=${companyUpdate.phone ?? '-'} email=${companyUpdate.email ?? '-'}`);
      }

      processed++;
    } catch (e) {
      console.error(`[cis-leads] yandexMapsEnrichment failed for ${searchName}:`, e instanceof Error ? e.message : e);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return { processed, updated };
}
