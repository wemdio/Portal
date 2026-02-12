export const DEFAULT_MAX_ABOUT_CANDIDATES = 4;

type BuildAboutCandidatesInput = {
  mainUrl: string;
  discoveredLinks: string[];
  staticCandidates: string[];
  maxCandidates?: number;
};

function normalizeCandidate(raw: string): string {
  const withoutHash = raw.replace(/#.*$/, '');
  const withoutQuery = withoutHash.replace(/\?.*$/, '');
  return withoutQuery.replace(/\/+$/, '');
}

function normalizeCandidateKey(raw: string): string {
  return normalizeCandidate(raw).replace(/^https?:\/\//i, '').toLowerCase();
}

export function buildAboutCandidates({
  mainUrl,
  discoveredLinks,
  staticCandidates,
  maxCandidates = DEFAULT_MAX_ABOUT_CANDIDATES,
}: BuildAboutCandidatesInput): string[] {
  const safeMax = Number.isFinite(maxCandidates) ? Math.max(1, Math.floor(maxCandidates)) : DEFAULT_MAX_ABOUT_CANDIDATES;
  const normalizedMain = normalizeCandidate(mainUrl);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of [...discoveredLinks, ...staticCandidates]) {
    if (!candidate) continue;
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    if (normalized === normalizedMain) continue;

    const key = normalizeCandidateKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);

    if (result.length >= safeMax) break;
  }

  return result;
}
