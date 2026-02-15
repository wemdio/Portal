export type YandexMapsProxy = {
  enabled?: boolean;
  protocol?: 'http' | 'https' | 'socks5';
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
};

export type YandexMapsOrganization = {
  name: string;
  country: string;
  city: string;
  address: string;
  rating: string;
  reviews_count: string;
  website: string;
  email: string;
  phone: string;
  telegram: string;
  vk: string;
  instagram: string;
  whatsapp: string;
  card_url: string;
  working_hours: string;
  categories: string;
};

export type CollectLinksRequest = {
  search_url: string;
  max_results?: number;
  headless?: boolean;
  proxy?: YandexMapsProxy;
};

export type CollectLinksResponse = { links: string[] };

export type ParseOrgsRequest = {
  links: string[];
  headless?: boolean;
  proxy?: YandexMapsProxy;
};

export type ParseOrgsResponse = { organizations: YandexMapsOrganization[] };

function getServiceUrl() {
  return (process.env.YANDEXMAPS_SERVICE_URL?.trim() || 'http://yandexmaps:8000').replace(/\/+$/, '');
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${getServiceUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`yandexmaps service error ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  return (await res.json()) as T;
}

export async function yandexMapsHealth(): Promise<boolean> {
  const url = `${getServiceUrl()}/health`;
  const res = await fetch(url, { method: 'GET' });
  return res.ok;
}

export async function yandexMapsCollectLinks(req: CollectLinksRequest): Promise<CollectLinksResponse> {
  return await postJson<CollectLinksResponse>('/collect-links', req);
}

export async function yandexMapsParseOrgs(req: ParseOrgsRequest): Promise<ParseOrgsResponse> {
  return await postJson<ParseOrgsResponse>('/parse-orgs', req);
}

