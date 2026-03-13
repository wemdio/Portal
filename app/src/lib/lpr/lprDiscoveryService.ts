import type {
  LprSearchConfig,
  ApolloPersonRaw,
  ContactCandidate,
  LprSeniority,
  LprProvider,
} from '@/types/lpr';
import { searchPeople } from './apolloClient';
import { enrichPerson } from './pdlClient';
import { LPR_CONFIG } from './config';

// ─── Title normalization helpers ─────────────────────────────────────────────

function inferSeniority(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  const seniorities: [string, string[]][] = [
    ['c_suite', ['chief ', 'ceo', 'cfo', 'cto', 'coo', 'cmo', 'cio', 'ciso', 'cro', 'cpo']],
    ['owner', ['owner']],
    ['founder', ['founder', 'co-founder']],
    ['partner', ['partner']],
    ['vp', ['vice president', 'vp ']],
    ['head', ['head of', 'head,']],
    ['director', ['director']],
    ['manager', ['manager']],
    ['senior', ['senior', 'lead', 'principal']],
  ];
  for (const [level, keywords] of seniorities) {
    if (keywords.some((kw) => t.includes(kw))) return level;
  }
  return null;
}

function inferFunction(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [fn, keywords] of Object.entries(LPR_CONFIG.FUNCTION_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return fn;
  }
  return null;
}

function seniorityScore(seniority: string | null): number {
  if (!seniority) return 0;
  return LPR_CONFIG.SENIORITY_WEIGHTS[seniority] ?? 0;
}

function computeScore(candidate: Omit<ContactCandidate, 'score'>): number {
  let score = 0;

  score += seniorityScore(candidate.seniority) * 10;

  if (candidate.function_area) score += 15;

  if (candidate.work_email) score += 20;
  if (candidate.phone) score += 15;
  if (candidate.linkedin_url) score += 5;

  if (candidate.pdl_likelihood != null) {
    score += candidate.pdl_likelihood * 2;
  }

  if (candidate.data_freshness) {
    const ageMs = Date.now() - new Date(candidate.data_freshness).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 90) score += 10;
    else if (ageDays < 180) score += 5;
  }

  return score;
}

// ─── Provider-agnostic result ────────────────────────────────────────────────

export interface DiscoveryResult {
  candidates: ContactCandidate[];
  total_found: number;
  enriched_count: number;
  usable_count: number;
  apollo_credits_used: number;
  pdl_credits_used: number;
}

// ─── Provider interface ──────────────────────────────────────────────────────

interface LprDiscoveryProvider {
  readonly name: LprProvider;
  discover(jobId: string, config: LprSearchConfig): Promise<DiscoveryResult>;
}

// ─── Apollo + PDL provider (existing behaviour) ─────────────────────────────

class ApolloPdlProvider implements LprDiscoveryProvider {
  readonly name: LprProvider = 'apollo_pdl';

  async discover(jobId: string, config: LprSearchConfig): Promise<DiscoveryResult> {
    const seniorities = (config.seniorities?.length
      ? config.seniorities
      : [...LPR_CONFIG.DEFAULT_SENIORITIES]) as LprSeniority[];

    const maxCandidates = config.max_candidates ?? LPR_CONFIG.MAX_CANDIDATES_PER_COMPANY;
    const maxEnrichments = config.max_enrichments ?? LPR_CONFIG.MAX_ENRICHMENTS_PER_RUN;

    // Step 1: Apollo People Search (does NOT consume credits)
    const domains = config.company.domain ? [config.company.domain] : [];

    const apolloResult = await searchPeople({
      domains,
      seniorities,
      per_page: Math.min(maxCandidates, 100),
      page: 1,
    });

    // Step 2: Filter and rank Apollo results
    let filtered = apolloResult.people
      .filter((p) => p.title != null && p.title.length > 0)
      .map((p) => ({
        raw: p,
        seniority: inferSeniority(p.title),
        function_area: inferFunction(p.title),
      }));

    if (config.functions?.length) {
      const allowedFunctions = new Set(config.functions);
      const functionalFiltered = filtered.filter(
        (f) => f.function_area != null && allowedFunctions.has(f.function_area as string),
      );
      if (functionalFiltered.length > 0) filtered = functionalFiltered;
    }

    filtered.sort((a, b) => seniorityScore(b.seniority) - seniorityScore(a.seniority));

    const shortlist = filtered.slice(0, maxEnrichments);

    // Step 3: PDL enrichment for shortlist only
    let pdlCreditsUsed = 0;
    const candidates: ContactCandidate[] = [];

    for (const item of shortlist) {
      const raw = item.raw;

      const candidateBase: Omit<ContactCandidate, 'score'> = {
        job_id: jobId,
        apollo_id: raw.apollo_id,
        pdl_id: null,
        full_name: `${raw.first_name} ${raw.last_name_obfuscated}`,
        first_name: raw.first_name || null,
        last_name: null,
        title: raw.title,
        seniority: item.seniority,
        function_area: item.function_area,
        company_name: raw.organization_name ?? config.company.company_name ?? null,
        company_domain: config.company.domain ?? null,
        work_email: null,
        personal_email: null,
        phone: null,
        linkedin_url: null,
        enrichment_source: 'apollo',
        pdl_likelihood: null,
        data_freshness: raw.last_refreshed_at,
      };

      try {
        const enriched = await enrichPerson({
          first_name: raw.first_name || undefined,
          company: config.company.domain ?? config.company.company_name ?? undefined,
          profile: config.company.linkedin_url ?? undefined,
        });

        if (enriched) {
          pdlCreditsUsed += 1;
          candidateBase.pdl_id = enriched.pdl_id;
          candidateBase.full_name = enriched.full_name || candidateBase.full_name;
          candidateBase.first_name = enriched.first_name ?? candidateBase.first_name;
          candidateBase.last_name = enriched.last_name;
          candidateBase.title = enriched.job_title ?? candidateBase.title;
          candidateBase.seniority = inferSeniority(enriched.job_title) ?? item.seniority;
          candidateBase.function_area = inferFunction(enriched.job_title) ?? item.function_area;
          candidateBase.company_name = enriched.job_company_name ?? candidateBase.company_name;
          candidateBase.company_domain = enriched.job_company_website ?? candidateBase.company_domain;
          candidateBase.work_email = enriched.work_email;
          candidateBase.personal_email = enriched.personal_emails?.[0] ?? null;
          candidateBase.phone = enriched.phone_numbers?.[0] ?? null;
          candidateBase.linkedin_url = enriched.linkedin_url;
          candidateBase.enrichment_source = 'both';
          candidateBase.pdl_likelihood = enriched.likelihood;
        }
      } catch {
        // PDL enrichment failed for this person; keep Apollo-only data
      }

      candidates.push({
        ...candidateBase,
        score: computeScore(candidateBase),
      });
    }

    // Step 4: Final sort by score, dedup, return top-N
    candidates.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const deduped = candidates.filter((c) => {
      const key = `${c.full_name.toLowerCase()}|${(c.company_name ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const topN = deduped.slice(0, LPR_CONFIG.TOP_N_RESULTS);
    const usable = topN.filter((c) => c.work_email || c.phone);

    return {
      candidates: topN,
      total_found: apolloResult.total,
      enriched_count: pdlCreditsUsed,
      usable_count: usable.length,
      apollo_credits_used: 0, // Apollo search is free
      pdl_credits_used: pdlCreditsUsed,
    };
  }
}

// ─── CIS provider stub (implemented in subsequent steps) ─────────────────────

/**
 * CIS-native provider.
 *
 * NOTE: Implementation is added in follow-up tasks (cis-company-discovery,
 * cis-decision-maker-extraction, email-synthesis-validation). For now this
 * class is a thin wrapper that will be extended to call the CIS pipelines.
 */
class CisProvider implements LprDiscoveryProvider {
  readonly name: LprProvider = 'cis';

  async discover(): Promise<DiscoveryResult> {
    // Placeholder implementation; will be replaced with full CIS pipeline.
    return {
      candidates: [],
      total_found: 0,
      enriched_count: 0,
      usable_count: 0,
      apollo_credits_used: 0,
      pdl_credits_used: 0,
    };
  }
}

function pickProvider(config: LprSearchConfig): LprDiscoveryProvider {
  const requested = config.provider ?? LPR_CONFIG.DEFAULT_PROVIDER;
  if (requested === 'cis') {
    return new CisProvider();
  }
  return new ApolloPdlProvider();
}

// ─── Main discovery entrypoint ───────────────────────────────────────────────

export async function discoverLpr(
  jobId: string,
  config: LprSearchConfig,
): Promise<DiscoveryResult> {
  const provider = pickProvider(config);
  // For now we simply delegate; later we may add per-provider logging/metrics here.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  const seniorities = (config.seniorities?.length
    ? config.seniorities
    : [...LPR_CONFIG.DEFAULT_SENIORITIES]) as LprSeniority[];
  return provider.discover(jobId, { ...config, seniorities });
}
