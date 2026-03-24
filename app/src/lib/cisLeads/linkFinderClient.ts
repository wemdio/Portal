/**
 * LinkFinder AI API client — поиск LinkedIn по имени и компании.
 * https://linkfinderai.com/api-documentation
 *
 * Требует: LINKFINDER_API_KEY
 */

const LINKFINDER_API_URL = 'https://api.linkfinderai.com';

function getApiKey(): string {
  return (process.env.LINKFINDER_API_KEY ?? '').trim();
}

export function hasLinkFinderKey(): boolean {
  return getApiKey().length > 0;
}

interface LinkFinderResponse {
  result: string | null;
  status: 'success' | 'error';
  message?: string;
}

/**
 * Ищет LinkedIn profile URL по полному имени и названию компании.
 * input_data формат: "Full Name Company Name" (пример: "Bill Gates Microsoft")
 */
export async function findLinkedInByNameAndCompany(
  fullName: string,
  companyName: string,
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const name = String(fullName ?? '').trim();
  const company = String(companyName ?? '').trim();
  if (!name || !company) return null;

  const inputData = `${name} ${company}`;

  try {
    const res = await fetch(LINKFINDER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        type: 'lead_full_name_to_linkedin_url',
        input_data: inputData,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LinkFinder ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as LinkFinderResponse;
    if (data.status !== 'success' || !data.result || typeof data.result !== 'string') {
      return null;
    }

    const url = data.result.trim();
    if (!url) return null;

    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (!host.endsWith('linkedin.com') || !parsed.pathname.startsWith('/in/')) {
        return null;
      }
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
