/**
 * OfData.ru API client — fetches company contacts from government registries
 * (EGRUL, Rosstat, GosZakupki) that DaData may not expose.
 *
 * Env: OFDATA_API_KEY
 * Docs: https://ofdata.ru/api
 */
import 'server-only';

const OFDATA_BASE = 'https://api.ofdata.ru/v2';

function getOfDataKey(): string {
  return (process.env.OFDATA_API_KEY ?? '').trim();
}

export function hasOfDataKey(): boolean {
  return getOfDataKey().length > 0;
}

export interface OfDataContact {
  phones: string[];
  emails: string[];
  sites: string[];
}

export interface OfDataDirector {
  fullName: string;
  inn: string | null;
  post: string | null;
}

export interface OfDataCompanyResult {
  name: string | null;
  inn: string;
  ogrn: string | null;
  directors: OfDataDirector[];
  contacts: OfDataContact;
}

function extractPhones(data: Record<string, unknown>): string[] {
  const contacts = data['Контакты'] as Record<string, unknown> | undefined;
  if (!contacts) return [];
  const raw = contacts['Тел'] as string[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => String(p).replace(/[\s()-]/g, '').trim())
    .filter((p) => p.length >= 6);
}

function extractEmails(data: Record<string, unknown>): string[] {
  const contacts = data['Контакты'] as Record<string, unknown> | undefined;
  if (!contacts) return [];
  const raw = contacts['Емэйл'] as string[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => e.includes('@') && e.includes('.'));
}

function extractSites(data: Record<string, unknown>): string[] {
  const contacts = data['Контакты'] as Record<string, unknown> | undefined;
  if (!contacts) return [];
  const raw = contacts['ВебСайт'] as string | string[] | undefined;
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

function extractDirectors(data: Record<string, unknown>): OfDataDirector[] {
  const raw = data['Руковод'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => ({
      fullName: String(d['ФИО'] ?? '').trim(),
      inn: d['ИНН'] ? String(d['ИНН']).trim() : null,
      post: d['НаимДолжн'] ? String(d['НаимДолжн']).trim() : null,
    }))
    .filter((d) => d.fullName.length > 2);
}

export async function fetchOfDataCompany(inn: string): Promise<OfDataCompanyResult | null> {
  const key = getOfDataKey();
  if (!key) return null;

  const url = `${OFDATA_BASE}/company?key=${encodeURIComponent(key)}&inn=${encodeURIComponent(inn)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`OfData HTTP ${res.status}`);
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const data = json.data;
    if (!data) return null;

    return {
      name: data['НаимСокр'] ? String(data['НаимСокр']).trim() : (data['НаимЮЛСокр'] ? String(data['НаимЮЛСокр']).trim() : null),
      inn: String(data['ИНН'] ?? inn),
      ogrn: data['ОГРН'] ? String(data['ОГРН']).trim() : null,
      directors: extractDirectors(data),
      contacts: {
        phones: extractPhones(data),
        emails: extractEmails(data),
        sites: extractSites(data),
      },
    };
  } catch (e) {
    console.error(`[ofdata] fetch failed for INN ${inn}:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
