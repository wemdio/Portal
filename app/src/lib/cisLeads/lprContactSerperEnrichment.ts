import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { serperSearchDetailed } from '@/lib/parsers/serperSearch';

const PERSONAL_SERPER_LIMIT = 25; // max contacts to enrich per job
const QUERY_DELAY_MS = 400;

const PHONE_PATTERN = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

function extractPhoneFromText(text: string): string | null {
  const m = text.match(PHONE_PATTERN);
  if (!m?.[0]) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function extractEmailFromText(text: string): string | null {
  const m = text.match(EMAIL_PATTERN);
  return m?.[0]?.toLowerCase() ?? null;
}

/**
 * For LPRs that have only name (e.g. from EGRUL), run a personal Serper search
 * "ФИО" "Company" email телефон and fill channel_phone / channel_email.
 */
export async function runLprContactSerperEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; contactsUpdated: number }> {
  if (!supabaseAdmin || !hasSerperKey()) return { processed: 0, contactsUpdated: 0 };

  const { data: leadRows } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(
    new Set((leadRows ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)),
  );
  if (companyIds.length === 0) return { processed: 0, contactsUpdated: 0 };

  const { data: contactsWithoutChannels } = await supabaseAdmin
    .from('company_contacts')
    .select('id, company_id, full_name')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .is('channel_phone', null)
    .is('channel_email', null)
    .order('score', { ascending: false })
    .limit(PERSONAL_SERPER_LIMIT * 2);

  if (!contactsWithoutChannels?.length) return { processed: 0, contactsUpdated: 0 };

  const companyIdSet = new Set(companyIds);
  const byCompany = new Map<string, typeof contactsWithoutChannels>();
  for (const c of contactsWithoutChannels as Array<{ id: string; company_id: string; full_name: string }>) {
    if (!companyIdSet.has(c.company_id)) continue;
    const list = byCompany.get(c.company_id) ?? [];
    if (list.length < 2) list.push(c);
    byCompany.set(c.company_id, list);
  }

  const toEnrich: Array<{ id: string; company_id: string; full_name: string }> = [];
  for (const list of byCompany.values()) {
    toEnrich.push(...list);
    if (toEnrich.length >= PERSONAL_SERPER_LIMIT) break;
  }

  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name')
    .in('id', [...new Set(toEnrich.map((c) => c.company_id))]);

  const companyMap = new Map(
    (companies ?? []).map((c) => [
      String((c as { id?: unknown }).id),
      (c as { id: string; name: string; short_name: string | null }),
    ]),
  );

  let contactsUpdated = 0;

  for (const contact of toEnrich) {
    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    const query = `"${contact.full_name.replace(/"/g, ' ')}" "${companyName.replace(/"/g, ' ')}" email телефон`;
    try {
      const { results } = await serperSearchDetailed(query, { num: 8, gl: 'ru', hl: 'ru' });
      const text = results.map((r) => `${r.title} ${r.snippet}`).join(' ');
      const phone = extractPhoneFromText(text);
      const email = extractEmailFromText(text);
      const update: Record<string, string | null> = {};
      if (phone) update.channel_phone = phone;
      if (email) update.channel_email = email;
      if (Object.keys(update).length === 0) continue;

      const { error } = await supabaseAdmin
        .from('company_contacts')
        .update(update)
        .eq('id', contact.id)
        .eq('user_id', userId);

      if (!error) contactsUpdated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Not enough credits') || msg.includes('401') || msg.includes('403')) {
        console.warn('[cis-leads] lprContactSerperEnrichment: API credits exhausted');
        break;
      }
    }

    await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
  }

  return { processed: toEnrich.length, contactsUpdated };
}
