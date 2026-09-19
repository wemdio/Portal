/**
 * Opt-in switch of the calibrated relevance triage (see relevanceTriage.ts).
 * Off unless BOTH the mode and the provider key are configured, so a deploy of
 * this code changes nothing by itself. An optional project list limits a canary.
 * Kept free of server-only imports: selection predicates read it as well.
 */
export const VE_RELEVANCE_TRIAGE_VERSION = 1;

export function isVeRelevanceTriageEnabled(projectId?: string | null): boolean {
  if ((process.env.VE_RELEVANCE_TRIAGE ?? '').trim().toLowerCase() !== 'jev') return false;
  if (!(process.env.TYPESAFE_API_KEY ?? '').trim()) return false;
  const projects = (process.env.VE_RELEVANCE_TRIAGE_PROJECTS ?? '').split(/[\s,;]+/).filter(Boolean);
  return projects.length === 0 || (typeof projectId === 'string' && projects.includes(projectId));
}
