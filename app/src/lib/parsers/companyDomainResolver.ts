import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { companyDedupKey, pickDomainFromSuggestions } from '@/lib/jobs/atsCompanyParser';

const execFileP = promisify(execFile);
const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';

// Our country_code (us/gb/...) → the lowercased full name stored in pdl_companies.country.
const PDL_COUNTRY_BY_CODE: Record<string, string> = {
  us: 'united states', gb: 'united kingdom', ca: 'canada', de: 'germany', fr: 'france',
  nl: 'netherlands', ie: 'ireland', es: 'spain', au: 'australia', sg: 'singapore',
};

type DomainDb = {
  from: (table: string) => {
    select: (cols: string) => {
      ilike: (col: string, pattern: string) => {
        limit: (n: number) => Promise<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
      };
    };
  };
};

export function domainToSiteUrl(domain: string | null | undefined): string | null {
  const clean = String(domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return clean ? `https://${clean}` : null;
}

function cleanDomain(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

// Resolve via the local PDL company catalog (pdl_companies: name, website, country) —
// no rate limit, ~19.5M rows, CC BY 4.0, disambiguated by country. Returns '' unless a
// single distinct company (one website after dedup) matches the normalized name; a
// wrong domain is worse than none. Needs a name index on pdl_companies to be fast.
export async function resolveCompanyDomainViaPdl(
  name: string,
  country?: string | null,
  db: DomainDb | null = supabaseAdmin as unknown as DomainDb | null,
): Promise<string> {
  if (!db) return '';
  const q = String(name ?? '').trim();
  const key = companyDedupKey(q);
  if (!key) return '';
  // Prefix match (index-assisted) keeps the candidate set small; the exact decision is
  // the normalized-key filter below, which also folds "Acme" / "Acme, Inc" together.
  const prefix = q.replace(/[%_]/g, ' ').trim();
  const { data, error } = await db.from('pdl_companies').select('name,website,country').ilike('name', `${prefix}%`).limit(40);
  if (error || !Array.isArray(data)) return '';

  let matches = data.filter((r) => r && r.website && companyDedupKey(String(r.name ?? '')) === key);
  const wanted = country ? PDL_COUNTRY_BY_CODE[String(country).toLowerCase()] : '';
  if (wanted) {
    const byCountry = matches.filter((r) => String(r.country ?? '').toLowerCase() === wanted);
    if (byCountry.length) matches = byCountry; // disambiguate by country when it helps
  }
  // Collision guard on DISTINCT website: same company across dupe rows is fine; two
  // different domains for the same name means distinct companies → refuse to guess.
  const sites = new Set(matches.map((r) => cleanDomain(r.website)).filter(Boolean));
  return sites.size === 1 ? [...sites][0] : '';
}

// Clearbit's WAF blocks node/undici by TLS fingerprint but lets curl through.
async function resolveViaClearbit(name: string): Promise<string> {
  const query = name.trim();
  if (!query) return '';
  const url = `${CLEARBIT_SUGGEST}?query=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await execFileP(
        'curl',
        ['-sS', '--max-time', '15', '-H', 'Accept: application/json', url],
        { timeout: 20_000, maxBuffer: 1024 * 1024 },
      );
      const domain = pickDomainFromSuggestions(query, JSON.parse(stdout));
      if (domain) return domain;
    } catch {
      /* transient curl/parse failure: retry once */
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return '';
}

// Local PDL catalog first (fast, no rate limit, country-disambiguated), then Clearbit
// autocomplete as a fallback. Both paths refuse to guess on ambiguous names.
export async function resolveCompanyDomainByName(
  name: string,
  opts: { country?: string | null; db?: DomainDb | null } = {},
): Promise<string> {
  const viaPdl = await resolveCompanyDomainViaPdl(name, opts.country, opts.db ?? (supabaseAdmin as unknown as DomainDb | null));
  if (viaPdl) return viaPdl;
  return resolveViaClearbit(name);
}
