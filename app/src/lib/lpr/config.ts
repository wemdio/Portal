export const LPR_CONFIG = {
  APOLLO_API_KEY: process.env.APOLLO_API_KEY ?? '',
  PDL_API_KEY: process.env.PDL_API_KEY ?? '',

  /**
   * Default provider for LPR discovery when the client does not specify one explicitly.
   * For backwards compatibility we keep Apollo/PDL as the default and let
   * CIS mode be enabled per-request or by domain heuristics.
   */
  DEFAULT_PROVIDER: (process.env.LPR_DEFAULT_PROVIDER ?? 'apollo_pdl') as 'apollo_pdl' | 'cis',

  MAX_CANDIDATES_PER_COMPANY: Number(process.env.LPR_MAX_CANDIDATES) || 25,
  MAX_ENRICHMENTS_PER_RUN: Number(process.env.LPR_MAX_ENRICHMENTS) || 10,
  TOP_N_RESULTS: Number(process.env.LPR_TOP_N) || 10,

  PDL_MIN_LIKELIHOOD: Number(process.env.LPR_PDL_MIN_LIKELIHOOD) || 5,
  CACHE_TTL_HOURS: Number(process.env.LPR_CACHE_TTL_HOURS) || 168, // 7 days

  DEFAULT_SENIORITIES: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'] as const,
  DEFAULT_FUNCTIONS: ['sales', 'marketing', 'operations', 'executive'] as const,

  SENIORITY_WEIGHTS: {
    owner: 10,
    founder: 10,
    c_suite: 9,
    partner: 8,
    vp: 7,
    head: 6,
    director: 5,
    manager: 3,
    senior: 1,
  } as Record<string, number>,

  FUNCTION_KEYWORDS: {
    sales: ['sales', 'business development', 'revenue', 'account', 'commercial'],
    marketing: ['marketing', 'growth', 'brand', 'communications', 'pr'],
    finance: ['finance', 'cfo', 'controller', 'treasury', 'accounting'],
    operations: ['operations', 'coo', 'supply chain', 'logistics'],
    engineering: ['engineering', 'cto', 'technology', 'development', 'r&d'],
    hr: ['hr', 'human resources', 'people', 'talent', 'recruiting'],
    procurement: ['procurement', 'purchasing', 'sourcing', 'vendor'],
    it: ['it', 'information technology', 'infrastructure', 'security', 'ciso'],
    legal: ['legal', 'compliance', 'counsel', 'regulatory'],
    executive: ['ceo', 'general manager', 'managing director', 'president', 'founder', 'owner'],
  } as Record<string, string[]>,
} as const;
