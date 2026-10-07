import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeCollectTaskState, VeCollectInfo } from './stages/baseCollect';
import { veSourceStrategyKey, newVeAdaptiveCollection } from './adaptiveCollection';

/** A probe is not a new default source. At most three 10-result pages, and
 * every further page requires verified contact growth from the prior page. */
export function nextVeSearchProbe(previous: VeCollectInfo['web_search'], ready: number): number | null {
  if (!previous) return 1;
  return previous.page < 3 && ready > previous.ready_before ? previous.page + 1 : null;
}

export async function addVeSearchFallback(db: SupabaseClient, hypothesisId: string | null, locale: 'ru' | 'en',
  info: VeCollectInfo, tasks: VeCollectTaskState[], ready: number): Promise<boolean> {
  const page = nextVeSearchProbe(info.web_search, ready);
  if (!hypothesisId || !page) return false;
  const { data: control, error: controlError } = await db.from('ve_search_control').select('enabled,blocked_reason').eq('singleton', true).maybeSingle();
  // Old deployments / disabled feature keep the existing collection path.
  if (controlError || !control?.enabled || control.blocked_reason) return false;
  const { data: hypothesis, error } = await db.from('ve_hypotheses').select('title,description').eq('id', hypothesisId).maybeSingle();
  if (error || !hypothesis?.title) throw new Error('Search fallback hypothesis unavailable');
  // No paid query generation, no guesses from broad seller verticals. The
  // original hypothesis remains the input to all relevance gates.
  const query = info.web_search?.query ?? String(hypothesis.title).replace(/\s+/g, ' ').trim().slice(0, 270)
    + (locale === 'ru' ? ' официальный сайт' : ' official website');
  const task = { source: 'web_search' as const, rationale: 'Ограниченная поисковая проба после остановки исходных источников',
    search_query: { query, locale, page } };
  // Stop repeating the source that hit the no-growth guard. Preserve its
  // cursor/harvest; hit_ceiling is a limit, never proof of market exhaustion.
  for (const old of tasks) if (old.status === 'pending' || old.status === 'done') {
    old.status = 'done'; old.hit_ceiling = true;
  }
  tasks.push({ source: 'web_search', task, status: 'pending', child_job_id: null, rows: 0 });
  info.search_budget = true;
  info.web_search = { query, page, ready_before: ready };
  const policy = info.adaptive_collection ?? newVeAdaptiveCollection();
  policy.active_source = veSourceStrategyKey(task);
  policy.replan_needed = false;
  delete policy.replan_reason;
  info.adaptive_collection = policy;
  info.tasks = tasks;
  return true;
}
