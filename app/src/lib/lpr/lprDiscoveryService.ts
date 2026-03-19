import 'server-only';

import type { LprSearchConfig, ContactCandidate } from '@/types/lpr';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { LPR_CONFIG } from './config';
import { hasDadataKey, suggestByName } from '@/lib/enrich/dadataClient';
import { guessLprRoleFromPost, guessRoleFromTitle, isLikelyLpr, normalizeInn } from '@/lib/cisLeads/lprRole';

// ─── Provider-agnostic result ────────────────────────────────────────────────

export interface DiscoveryResult {
  candidates: ContactCandidate[];
  total_found: number;
  enriched_count: number;
  usable_count: number;
}

// ─── Provider interface ──────────────────────────────────────────────────────

interface LprDiscoveryProvider {
  discover(jobId: string, config: LprSearchConfig): Promise<DiscoveryResult>;
}

class CisProvider implements LprDiscoveryProvider {
  async discover(jobId: string, config: LprSearchConfig): Promise<DiscoveryResult> {
    if (!supabaseAdmin) {
      return { candidates: [], total_found: 0, enriched_count: 0, usable_count: 0 };
    }

    const { data: jobRow } = await supabaseAdmin
      .from('lpr_jobs')
      .select('user_id')
      .eq('id', jobId)
      .single<{ user_id: string }>();
    const userId = jobRow?.user_id ?? null;

    const maxCandidates = config.max_candidates ?? LPR_CONFIG.MAX_CANDIDATES_PER_COMPANY;
    const maxResults = Math.min(LPR_CONFIG.TOP_N_RESULTS, maxCandidates);

    const companyCandidates = await findCompanies(config);
    const { companies, managementContact } = companyCandidates;

    if (managementContact && userId) {
      await upsertManagementContact({
        userId,
        companyId: managementContact.companyId,
        fullName: managementContact.fullName,
        post: managementContact.post,
      });
    }

    const contacts = await loadCompanyContacts({
      userId,
      companyIds: companies.map((c) => c.id),
      limit: maxCandidates,
    });

    const companyById = new Map(companies.map((c) => [c.id, c]));
    const mapped = contacts
      .filter((c) => isLikelyLpr(c.title, c.role_guess))
      .map((c) => mapContactToCandidate(jobId, c, companyById.get(c.company_id) ?? null));

    const filteredByConfig = applyConfigFilters(mapped, config);
    const sorted = filteredByConfig.sort((a, b) => b.score - a.score);
    const topN = sorted.slice(0, maxResults);
    const usable = topN.filter((c) => c.work_email || c.phone);

    return {
      candidates: topN,
      total_found: filteredByConfig.length,
      enriched_count: 0,
      usable_count: usable.length,
    };
  }
}

// ─── Main discovery entrypoint ───────────────────────────────────────────────

export async function discoverLpr(
  jobId: string,
  config: LprSearchConfig,
): Promise<DiscoveryResult> {
  const provider = new CisProvider();
  return provider.discover(jobId, config);
}

type CompanyRow = {
  id: string;
  name: string;
  short_name: string | null;
  brand_name: string | null;
  site: string | null;
};

type CompanyContactRow = {
  company_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role_guess: string | null;
  channel_phone: string | null;
  channel_email: string | null;
  channel_tg_username: string | null;
  score: number | null;
};

async function findCompanies(config: LprSearchConfig): Promise<{
  companies: CompanyRow[];
  managementContact: { companyId: string; fullName: string; post: string | null } | null;
}> {
  const companies = new Map<string, CompanyRow>();
  const companyName = normalizeQuery(config.company.company_name ?? '');
  const domain = normalizeDomain(config.company.domain ?? '');
  const domainLabel = extractDomainLabel(domain);

  if (companyName) {
    const rows = await queryCompaniesByName(companyName);
    rows.forEach((r) => companies.set(r.id, r));
  }
  if (domain) {
    const rows = await queryCompaniesByDomain(domain, domainLabel);
    rows.forEach((r) => companies.set(r.id, r));
  }

  let managementContact: { companyId: string; fullName: string; post: string | null } | null = null;

  if (companies.size === 0 && hasDadataKey() && companyName) {
    const suggestion = await suggestByName(companyName);
    if (suggestion) {
      const inn = normalizeInn(String(suggestion.data?.inn ?? ''));
      const company = await upsertCompanyFromDadata(suggestion, inn);
      if (company) companies.set(company.id, company);
      const managerName = String(suggestion.data?.management?.name ?? '').trim();
      const managerPost = String(suggestion.data?.management?.post ?? '').trim() || null;
      if (company && managerName) {
        managementContact = { companyId: company.id, fullName: managerName, post: managerPost };
      }
    }
  }

  return { companies: Array.from(companies.values()), managementContact };
}

async function queryCompaniesByName(name: string): Promise<CompanyRow[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('companies')
    .select('id,name,short_name,brand_name,site')
    .ilike('name', `%${name}%`)
    .limit(10);
  return (data ?? []) as CompanyRow[];
}

async function queryCompaniesByDomain(domain: string, label: string | null): Promise<CompanyRow[]> {
  if (!supabaseAdmin) return [];
  const results: CompanyRow[] = [];
  const { data: bySite } = await supabaseAdmin
    .from('companies')
    .select('id,name,short_name,brand_name,site')
    .ilike('site', `%${domain}%`)
    .limit(10);
  (bySite ?? []).forEach((r) => results.push(r as CompanyRow));
  if (label) {
    const { data: byName } = await supabaseAdmin
      .from('companies')
      .select('id,name,short_name,brand_name,site')
      .ilike('name', `%${label}%`)
      .limit(10);
    (byName ?? []).forEach((r) => results.push(r as CompanyRow));
  }
  return dedupeCompanies(results);
}

function dedupeCompanies(rows: CompanyRow[]): CompanyRow[] {
  const seen = new Set<string>();
  const out: CompanyRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function upsertCompanyFromDadata(
  suggestion: Awaited<ReturnType<typeof suggestByName>>,
  inn: string | null,
): Promise<CompanyRow | null> {
  if (!supabaseAdmin || !suggestion) return null;
  const data = suggestion.data ?? {};
  const now = new Date().toISOString();
  const name =
    String(data.name?.full_with_opf ?? '').trim() ||
    String(suggestion.value ?? '').trim();
  const shortName = String(data.name?.short_with_opf ?? '').trim() || null;
  const region = String(data.address?.data?.region ?? '').trim() || null;
  const city = String(data.address?.data?.city ?? '').trim() || null;
  const ogrn = String(data.ogrn ?? '').trim() || null;

  if (!name) return null;

  if (inn) {
    const { data: row } = await supabaseAdmin
      .from('companies')
      .upsert(
        {
          inn,
          ogrn,
          name,
          short_name: shortName,
          brand_name: null,
          region,
          city,
          okved_main: null,
          employees_range: null,
          site: null,
          phone: null,
          email: null,
          source: 'dadata',
          source_confidence: 1.0,
          updated_at: now,
        },
        { onConflict: 'inn' },
      )
      .select('id,name,short_name,brand_name,site')
      .single<CompanyRow>();
    return row ?? null;
  }

  const { data: row } = await supabaseAdmin
    .from('companies')
    .insert({
      inn: null,
      ogrn,
      name,
      short_name: shortName,
      brand_name: null,
      region,
      city,
      okved_main: null,
      employees_range: null,
      site: null,
      phone: null,
      email: null,
      source: 'dadata',
      source_confidence: 0.7,
      updated_at: now,
    })
    .select('id,name,short_name,brand_name,site')
    .single<CompanyRow>();
  return row ?? null;
}

async function upsertManagementContact(params: {
  userId: string;
  companyId: string;
  fullName: string;
  post: string | null;
}) {
  if (!supabaseAdmin) return;
  const role = guessLprRoleFromPost(params.post);
  await supabaseAdmin
    .from('company_contacts')
    .upsert(
      {
        user_id: params.userId,
        company_id: params.companyId,
        source: 'dadata_management',
        full_name: params.fullName,
        first_name: null,
        last_name: null,
        title: params.post,
        role_guess: role,
        channel_phone: null,
        channel_tg_username: null,
        channel_email: null,
        source_url: null,
        score: 78,
        confidence: 0.85,
      },
      { onConflict: 'user_id,company_id,full_name' },
    );
}

async function loadCompanyContacts(params: {
  userId: string | null;
  companyIds: string[];
  limit: number;
}): Promise<CompanyContactRow[]> {
  if (!supabaseAdmin || params.companyIds.length === 0) return [];
  let query = supabaseAdmin
    .from('company_contacts')
    .select('company_id,full_name,first_name,last_name,title,role_guess,channel_phone,channel_email,channel_tg_username,score')
    .in('company_id', params.companyIds)
    .order('score', { ascending: false })
    .limit(params.limit);
  if (params.userId) query = query.eq('user_id', params.userId);
  const { data } = await query;
  return (data ?? []) as CompanyContactRow[];
}

function mapContactToCandidate(
  jobId: string,
  contact: CompanyContactRow,
  company: CompanyRow | null,
): ContactCandidate {
  const title = contact.title ?? null;
  const role = contact.role_guess ?? null;
  const roleMeta = guessRoleFromTitle(title);
  const seniority = mapRoleToSeniority(role, title);
  const functionArea = mapRoleToFunction(role, title);
  const score = computeCandidateScore(contact, roleMeta.score);

  return {
    job_id: jobId,
    full_name: contact.full_name,
    first_name: contact.first_name,
    last_name: contact.last_name,
    title,
    seniority,
    function_area: functionArea,
    company_name: company?.name ?? null,
    company_domain: company?.site ?? null,
    work_email: contact.channel_email ?? null,
    personal_email: null,
    phone: contact.channel_phone ?? null,
    linkedin_url: null,
    score,
    data_freshness: null,
  };
}

function computeCandidateScore(contact: CompanyContactRow, baseScore: number): number {
  let score = contact.score ?? baseScore;
  if (contact.channel_phone) score += 10;
  if (contact.channel_email) score += 10;
  if (contact.channel_tg_username) score += 5;
  return score;
}

function mapRoleToSeniority(role: string | null, title: string | null): string | null {
  const r = String(role ?? '').toLowerCase();
  if (r === 'owner') return 'owner';
  if (r === 'ceo') return 'c_suite';
  if (r === 'commercial' || r === 'director') return 'director';
  const t = String(title ?? '').toLowerCase();
  if (t.includes('vp ') || t.includes('vice president')) return 'vp';
  if (t.includes('head')) return 'head';
  return null;
}

function mapRoleToFunction(role: string | null, title: string | null): string | null {
  const r = String(role ?? '').toLowerCase();
  if (r === 'sales' || r === 'commercial') return 'sales';
  if (r === 'marketing') return 'marketing';
  if (r === 'ops') return 'operations';
  if (r === 'it') return 'it';
  if (r === 'hr') return 'hr';
  if (r === 'owner' || r === 'ceo' || r === 'director') return 'executive';
  const t = String(title ?? '').toLowerCase();
  if (t.includes('sales') || t.includes('продаж')) return 'sales';
  if (t.includes('маркет')) return 'marketing';
  if (t.includes('операц') || t.includes('operations')) return 'operations';
  if (t.includes('it') || t.includes('cto') || t.includes('tech')) return 'it';
  return null;
}

function applyConfigFilters(candidates: ContactCandidate[], config: LprSearchConfig): ContactCandidate[] {
  let out = candidates;
  if (config.seniorities?.length) {
    const allowed = new Set(config.seniorities);
    out = out.filter((c) => (c.seniority ? allowed.has(c.seniority as unknown as typeof config.seniorities[number]) : false));
  }
  if (config.functions?.length) {
    const allowed = new Set(config.functions);
    out = out.filter((c) => (c.function_area ? allowed.has(c.function_area as unknown as typeof config.functions[number]) : false));
  }
  return out;
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeDomain(raw: string): string {
  const input = normalizeQuery(raw);
  if (!input) return '';
  try {
    const url = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extractDomainLabel(domain: string): string | null {
  if (!domain) return null;
  const host = domain.replace(/^www\./i, '').toLowerCase();
  const parts = host.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const tld = parts[parts.length - 1];
  const secondLevel = parts[parts.length - 2];
  if (parts.length >= 3 && tld.length === 2 && ['co', 'com', 'org', 'net'].includes(secondLevel)) {
    return parts[parts.length - 3];
  }
  return secondLevel;
}
