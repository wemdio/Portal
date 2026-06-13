import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pickDomainFromSuggestions } from '@/lib/jobs/atsCompanyParser';

const execFileP = promisify(execFile);
const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';

export function domainToSiteUrl(domain: string | null | undefined): string | null {
  const clean = String(domain ?? '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return clean ? `https://${clean}` : null;
}

// Clearbit's WAF blocks node/undici by TLS fingerprint but lets curl through.
export async function resolveCompanyDomainByName(name: string): Promise<string> {
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
