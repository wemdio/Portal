import { extractEmails } from '@/lib/tools/dfybUtils';
import { normalizeVeCompanyInn, normalizeVeCompanyName } from './collectionIdentity';
import { veOfficialWebsiteCandidates } from './relevanceEvidence';

/**
 * Что эта база уже отправляла в проверку — по компаниям, а не по строкам.
 *
 * Отметка-строка (veAcquisitionReceipt) сравнивает строку целиком. Строка, у
 * которой вычеркнули занятый адрес или нормализовали сайт («krezol-ns.ru» →
 * «https://krezol-ns.ru/», новая подпись источника), выглядела новой и уходила
 * в конструктор снова: у b5934955 91 партия подряд состояла из 2–3 одних и тех
 * же компаний. Здесь компания узнаётся по ИНН, без ИНН — по названию вместе с
 * сайтом, а новым считается только то, чего база ещё не видела: адрес или сайт.
 */
export type VeSeenCompanies = Map<string, { emails: Set<string>; hosts: Set<string> }>;

interface VeSeenRow { company?: unknown; inn?: unknown; email?: unknown; website?: unknown }

/** Те же сайты, что оставит нормализация строки: сырой и обработанный вид совпадают. */
function websiteHosts(value: unknown): string[] {
  return veOfficialWebsiteCandidates(String(value ?? '')).map((url) => url.hostname.replace(/^www\./, ''));
}

function siteKeys(row: VeSeenRow): string[] {
  const name = normalizeVeCompanyName(row.company);
  return name ? websiteHosts(row.website).map((host) => `site:${JSON.stringify([name, host])}`) : [];
}

/** Строка с ИНН узнаётся только по ИНН; одно название без сайта компанию не доказывает. */
function lookupKeys(row: VeSeenRow): string[] {
  const inn = normalizeVeCompanyInn(row.inn);
  return inn ? [`inn:${inn}`] : siteKeys(row);
}

/** Отметки любого формата: старые из четырёх полей и нынешние с адресом и источником. */
export function buildVeSeenCompanies(rows: unknown[]): VeSeenCompanies {
  const seen: VeSeenCompanies = new Map();
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as VeSeenRow;
    const inn = normalizeVeCompanyInn(row.inn);
    const keys = [...(inn ? [`inn:${inn}`] : []), ...siteKeys(row)];
    if (!keys.length) continue;
    const emails = extractEmails(String(row.email ?? ''));
    const hosts = websiteHosts(row.website);
    for (const key of keys) {
      let entry = seen.get(key);
      if (!entry) seen.set(key, entry = { emails: new Set(), hosts: new Set() });
      for (const email of emails) entry.emails.add(email);
      for (const host of hosts) entry.hosts.add(host);
    }
  }
  return seen;
}

/**
 * Компания уже прошла через эту базу, и строка не несёт ни нового адреса, ни
 * нового сайта. emails — адреса строки после вычёркивания занятых другими.
 */
export function veSeenCompanyCovers(
  seen: VeSeenCompanies, row: VeSeenRow, emails: string[] = extractEmails(String(row.email ?? '')),
): boolean {
  const entries = lookupKeys(row).map((key) => seen.get(key))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (!entries.length) return false;
  return emails.every((email) => entries.some((entry) => entry.emails.has(email)))
    && websiteHosts(row.website).every((host) => entries.some((entry) => entry.hosts.has(host)));
}
