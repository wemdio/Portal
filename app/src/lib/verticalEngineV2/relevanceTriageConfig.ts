/**
 * Opt-in switch of the calibrated relevance triage (see relevanceTriage.ts).
 * Off unless the mode is configured, so a deploy of this code changes nothing
 * by itself. The model answers through Requesty on the engine's own key, so
 * there is no second credential to check. An optional project list limits a
 * canary. Kept free of server-only imports: selection predicates read it too.
 */
export const VE_RELEVANCE_TRIAGE_VERSION = 1;

export function isVeRelevanceTriageEnabled(projectId?: string | null): boolean {
  if ((process.env.VE_RELEVANCE_TRIAGE ?? '').trim().toLowerCase() !== 'jev') return false;
  const projects = (process.env.VE_RELEVANCE_TRIAGE_PROJECTS ?? '').split(/[\s,;]+/).filter(Boolean);
  return projects.length === 0 || (typeof projectId === 'string' && projects.includes(projectId));
}
