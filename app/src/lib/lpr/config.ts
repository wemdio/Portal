export const LPR_CONFIG = {
  DEFAULT_PROVIDER: 'cis' as const,

  MAX_CANDIDATES_PER_COMPANY: Number(process.env.LPR_MAX_CANDIDATES) || 25,
  MAX_ENRICHMENTS_PER_RUN: Number(process.env.LPR_MAX_ENRICHMENTS) || 10,
  TOP_N_RESULTS: Number(process.env.LPR_TOP_N) || 10,

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
