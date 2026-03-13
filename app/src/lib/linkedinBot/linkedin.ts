/**
 * LinkedIn company search via linkedin-private-api (JS/TS, no Python).
 */
import { Client } from 'linkedin-private-api';
import { parseLinkedInSearchUrl } from './urlParser';

export type LinkedInCompany = {
  name: string | null;
  site: string | null;
  phone: string | null;
};

function getLoginFromEnv() {
  const login = process.env.LINKEDIN_LOGIN?.trim();
  const password = process.env.LINKEDIN_PASSWORD?.trim();
  return { login, password };
}

const DEFAULT_LIMIT = 600;
const MAX_LIMIT = 2000;

export type GetCompaniesOptions = {
  limit?: number;
  /** Override env credentials when provided */
  login?: string;
  password?: string;
};

export async function getCompanies(
  url: string,
  options?: GetCompaniesOptions
): Promise<{ status: 'ok'; companies: LinkedInCompany[] } | { status: 'error'; error: string }> {
  const { keywords, valid } = parseLinkedInSearchUrl(url);
  if (!valid || !keywords) {
    return { status: 'error', error: 'Invalid URL: must be linkedin.com/search/results/companies with keywords' };
  }

  let login: string | undefined;
  let password: string | undefined;
  if (options?.login && options?.password) {
    login = options.login;
    password = options.password;
  } else {
    const env = getLoginFromEnv();
    login = env.login;
    password = env.password;
  }
  if (!login || !password) {
    return { status: 'error', error: 'Укажите аккаунт LinkedIn или настройте LINKEDIN_LOGIN / LINKEDIN_PASSWORD' };
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options?.limit) || DEFAULT_LIMIT));

  try {
    const client = new Client();
    await client.login.userPass({ username: login, password });

    const scroller = client.search.searchCompanies({
      keywords,
      limit,
      skip: 0,
    });

    const all: LinkedInCompany[] = [];
    const seen = new Set<string>();

    for (;;) {
      const batch = await scroller.scrollNext();
      if (!batch || batch.length === 0) break;

      for (const hit of batch) {
        const raw = hit as unknown as { company?: Record<string, unknown> };
        const company = raw.company;
        if (!company || typeof company !== 'object') continue;

        const urn =
          (company.trackingUrn as string) ??
          (company.entityUrn as string) ??
          JSON.stringify(company);
        if (seen.has(urn)) continue;
        seen.add(urn);

        const title = company.title as { text?: string } | undefined;
        const name =
          (company.name as string) ??
          title?.text ??
          (company.verticalName as string) ??
          null;
        const site =
          (company.url as string) ??
          (company.companyPageUrl as string) ??
          (company.websiteUrl as string) ??
          null;
        const phoneObj = company.phone as { number?: string } | undefined;
        const phone = (phoneObj?.number as string) ?? (company.phone as string) ?? null;

        all.push({
          name: name ?? null,
          site: site ?? null,
          phone: phone ?? null,
        });

        if (all.length >= limit) break;
      }

      if (all.length >= limit) break;
    }

    return { status: 'ok', companies: all };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'error', error: msg };
  }
}
