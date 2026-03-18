import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

const BATCH_LIMIT = 30;

const TRANSLIT_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

function transliterate(text: string): string {
  return text.toLowerCase().split('').map((ch) => TRANSLIT_MAP[ch] ?? ch).join('');
}

function extractDomain(site: string): string | null {
  try {
    const url = new URL(site.startsWith('http') ? site : `https://${site}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function generateEmailCandidates(firstName: string, lastName: string, domain: string): string[] {
  const f = transliterate(firstName);
  const l = transliterate(lastName);
  if (!f || !l || !domain) return [];

  const fi = f[0]!;

  return [
    `${fi}.${l}@${domain}`,       // i.ivanov@
    `${f}.${l}@${domain}`,        // ivan.ivanov@
    `${l}@${domain}`,             // ivanov@
    `${fi}${l}@${domain}`,        // iivanov@
    `${f}${l}@${domain}`,         // ivanivanov@
    `${l}.${fi}@${domain}`,       // ivanov.i@
    `${f}_${l}@${domain}`,        // ivan_ivanov@
    `${fi}-${l}@${domain}`,       // i-ivanov@
  ];
}

async function checkMx(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { Answer?: Array<{ type: number }> };
    return (data.Answer ?? []).some((a) => a.type === 15);
  } catch {
    return false;
  }
}

function parseFio(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { lastName: parts[0]!, firstName: parts[1]! };
}

export async function runEmailGuesser(jobId: string, userId: string): Promise<{ processed: number; emailsFound: number }> {
  if (!supabaseAdmin) return { processed: 0, emailsFound: 0 };

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
  if (companyIds.length === 0) return { processed: 0, emailsFound: 0 };

  const { data: contactsWithoutEmail } = await supabaseAdmin
    .from('company_contacts')
    .select('id, company_id, full_name')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .is('channel_email', null)
    .order('score', { ascending: false })
    .limit(BATCH_LIMIT * 2);

  if (!contactsWithoutEmail?.length) return { processed: 0, emailsFound: 0 };

  const relevantCompanyIds = [...new Set(
    (contactsWithoutEmail as Array<{ company_id: string }>).map((c) => c.company_id),
  )];

  const { data: companiesWithSite } = await supabaseAdmin
    .from('companies')
    .select('id, site')
    .in('id', relevantCompanyIds)
    .not('site', 'is', null);

  const domainByCompany = new Map<string, string>();
  for (const c of (companiesWithSite ?? []) as Array<{ id: string; site: string | null }>) {
    if (!c.site) continue;
    const domain = extractDomain(c.site);
    if (domain) domainByCompany.set(c.id, domain);
  }

  if (domainByCompany.size === 0) return { processed: 0, emailsFound: 0 };

  const mxCache = new Map<string, boolean>();
  async function hasMx(domain: string): Promise<boolean> {
    if (mxCache.has(domain)) return mxCache.get(domain)!;
    const ok = await checkMx(domain);
    mxCache.set(domain, ok);
    return ok;
  }

  let processed = 0;
  let emailsFound = 0;

  const toProcess = (contactsWithoutEmail as Array<{ id: string; company_id: string; full_name: string }>)
    .filter((c) => domainByCompany.has(c.company_id))
    .slice(0, BATCH_LIMIT);

  for (const contact of toProcess) {
    const domain = domainByCompany.get(contact.company_id);
    if (!domain) continue;

    const fio = parseFio(contact.full_name);
    if (!fio) continue;

    const mxOk = await hasMx(domain);
    if (!mxOk) { processed++; continue; }

    const candidates = generateEmailCandidates(fio.firstName, fio.lastName, domain);
    const bestCandidate = candidates[0];
    if (!bestCandidate) { processed++; continue; }

    const { error } = await supabaseAdmin
      .from('company_contacts')
      .update({ channel_email: bestCandidate })
      .eq('id', contact.id)
      .eq('user_id', userId);

    if (!error) {
      emailsFound++;
      console.log(`[cis-leads] emailGuesser: ${contact.full_name} → ${bestCandidate}`);
    }

    processed++;
  }

  return { processed, emailsFound };
}
