import type { SupabaseClient } from '@supabase/supabase-js';
import { parse } from 'tldts';
import { isFreeProvider } from '@/lib/emailValidation/shared';
import { isBlockedCompanyWebsiteDomain, isBlockedTechnicalEmailDomain } from '@/lib/companiesDirectory/contactPolicy';

export interface VeProjectExclusions {
  projectId: string;
  revision: number;
  inns: string[];
  domains: string[];
  updated_at: string | null;
}

export const VE_PROJECT_EXCLUSION_MAX_ENTRIES = 10_000;

/** No network, fuzzy company-name matching or inferred INN-to-domain joins. */
export function normalizeVeExclusionDomain(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  const raw = value.trim();
  if (/[\s@*\\]/.test(raw)) return null;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (host.length > 253 || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    const parsed = parse(host, { allowPrivateDomains: true });
    if (parsed.isIp || !parsed.domain || parsed.publicSuffix === host) return null;
    // Shared mailboxes, directories and social profiles do not identify a company.
    if (isFreeProvider(host) || isFreeProvider(parsed.domain)
      || isBlockedCompanyWebsiteDomain(host) || isBlockedTechnicalEmailDomain(host)
      || ['tilda.ws', 'wixsite.com', 'wordpress.com', 'blogspot.com'].includes(host)) return null;
    return host;
  } catch { return null; }
}

function normalizeInn(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const inn = String(value).trim();
  return /^(?:\d{10}|\d{12})$/.test(inn) ? inn : null;
}

export function validateVeProjectExclusionInput(input: unknown):
  { ok: true; revision: number; inns: string[]; domains: string[] }
  | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Нужны списки ИНН и доменов.'] };
  const body = input as Record<string, unknown>;
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) return { ok: false, errors: ['Обновите список исключений перед сохранением.'] };
  if (!Array.isArray(body.inns) || !Array.isArray(body.domains)
    || body.inns.length + body.domains.length > VE_PROJECT_EXCLUSION_MAX_ENTRIES) {
    return { ok: false, errors: [`Максимум ${VE_PROJECT_EXCLUSION_MAX_ENTRIES} ИНН и доменов суммарно.`] };
  }
  const errors: string[] = [], inns = new Set<string>(), domains = new Set<string>();
  body.inns.forEach((value, i) => {
    const inn = typeof value === 'string' ? normalizeInn(value) : null;
    if (inn) inns.add(inn);
    else if (errors.length < 10) errors.push(`ИНН №${i + 1}: нужно 10 или 12 цифр.`);
  });
  body.domains.forEach((value, i) => {
    const domain = normalizeVeExclusionDomain(value);
    if (domain) domains.add(domain);
    else if (errors.length < 10) errors.push(`Домен №${i + 1}: укажите сайт компании, без общих почтовых сервисов и каталогов.`);
  });
  return errors.length ? { ok: false, errors } : {
    ok: true, revision: Number(body.revision), inns: [...inns].sort(), domains: [...domains].sort(),
  };
}

export async function loadVeProjectExclusions(db: SupabaseClient, projectId: string): Promise<VeProjectExclusions> {
  const { data, error } = await db.from('ve_project_exclusions')
    .select('revision,inns,domains,updated_at').eq('project_id', projectId).maybeSingle();
  if (error) throw new Error('Не удалось проверить исключения проекта. Загрузка контактов отложена.');
  if (!data) return { projectId, revision: 0, inns: [], domains: [], updated_at: null };
  const validated = validateVeProjectExclusionInput(data);
  if (!validated.ok || validated.inns.length !== data.inns.length || validated.domains.length !== data.domains.length) {
    throw new Error('Список исключений проекта повреждён. Загрузка контактов отложена.');
  }
  return { projectId, ...validated, updated_at: typeof data.updated_at === 'string' ? data.updated_at : null };
}

const INN_KEYS = new Set(['inn', 'inns', 'инн', 'company_inn', 'tax_id', 'taxid']);
const SITE_KEYS = new Set(['website', 'website_url', 'site', 'site_url', 'url', 'domain', 'domains', 'company_domain', 'company_website', 'сайт', 'сайт_компании', 'email_domain']);
const EMAIL_KEYS = new Set(['email', 'e-mail', 'e_mail', 'emails', 'почта', 'электронная_почта', 'корпоративная_почта']);

/** Only known identity columns, including immutable private delivery metadata. */
export function getVeExclusionIdentity(row: Record<string, unknown>): { inns: Set<string>; domains: Set<string> } {
  const inns = new Set<string>(), domains = new Set<string>();
  const visit = (object: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(object)) {
      const field = key.trim().toLowerCase().replace(/\s+/g, '_');
      if (depth < 2 && ['custom_variables', '_ve_company_identity'].includes(field) && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, depth + 1);
      } else if (INN_KEYS.has(field)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          const inn = normalizeInn(item);
          if (inn) inns.add(inn);
        }
      } else if (SITE_KEYS.has(field) || EMAIL_KEYS.has(field)) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          if (typeof item !== 'string') continue;
          for (const part of item.split(/[\s,;|]+/)) {
            const source = EMAIL_KEYS.has(field) ? (/^[^@]+@([^@]+)$/.exec(part)?.[1] ?? '') : part;
            const domain = normalizeVeExclusionDomain(source);
            if (domain) domains.add(domain);
          }
        }
      }
    }
  };
  visit(row, 0);
  return { inns, domains };
}

export function getVeProjectExclusionIdentity(row: Record<string, unknown>): { inns: string[]; domains: string[] } {
  const identity = getVeExclusionIdentity(row);
  return { inns: [...identity.inns], domains: [...identity.domains] };
}

const compiledRules = new WeakMap<VeProjectExclusions, { inns: Set<string>; domains: Set<string> }>();
function compiled(rules: VeProjectExclusions) {
  let result = compiledRules.get(rules);
  if (!result) {
    result = { inns: new Set(rules.inns), domains: new Set(rules.domains) };
    compiledRules.set(rules, result);
  }
  return result;
}

function matchIdentity(identity: ReturnType<typeof getVeExclusionIdentity>, rules: VeProjectExclusions): 'inn' | 'domain' | null {
  const policy = compiled(rules);
  if ([...identity.inns].some((inn) => policy.inns.has(inn))) return 'inn';
  for (const domain of identity.domains) {
    let suffix = domain;
    while (suffix.includes('.')) {
      if (policy.domains.has(suffix)) return 'domain';
      suffix = suffix.slice(suffix.indexOf('.') + 1);
    }
  }
  return null;
}

export function matchVeProjectExclusion(row: Record<string, unknown>, rules: VeProjectExclusions): 'inn' | 'domain' | null {
  if (!rules.inns.length && !rules.domains.length) return null;
  return matchIdentity(getVeExclusionIdentity(row), rules);
}

export function filterVeProjectExcludedRows<T extends Record<string, unknown>>(rows: T[], rules: VeProjectExclusions): {
  kept: T[]; blockedCount: number; unidentifiedCount: number;
} {
  if (!rules.inns.length && !rules.domains.length) return { kept: rows, blockedCount: 0, unidentifiedCount: 0 };
  let blockedCount = 0, unidentifiedCount = 0;
  const kept = rows.filter((row) => {
    const identity = getVeExclusionIdentity(row);
    if (matchIdentity(identity, rules)) { blockedCount++; return false; }
    // A missing identifier prevents a full check of its corresponding list.
    if ((rules.inns.length && !identity.inns.size) || (rules.domains.length && !identity.domains.size)) unidentifiedCount++;
    return true;
  });
  return { kept, blockedCount, unidentifiedCount };
}
