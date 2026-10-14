/** Offline comparison only. No DB, model, parser or campaign clients.
 * Build with esbuild, then pass a saved metadata JSONL as the only argument.
 * Input can include psql BEGIN/SET/ROLLBACK lines; contact data is never read.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { detectVeNicheSourceProfile, normalizeVeNicheSourceTask } from '../src/lib/verticalEngineV2/nicheSourcePolicy';
import { normalizeVeAudienceSourcePlan, veSourceDiscoveryIsExistingOnly, type VeSourceAudienceHypothesis } from '../src/lib/verticalEngineV2/sourceAudience';
import type { VeSourcePlan } from '../src/lib/verticalEngineV2/prompts/sourcePlan';

const path = process.argv[2];
if (!path) throw new Error('Usage: ve-audience-replay.cjs <saved-hypotheses.jsonl>');
const bytes = readFileSync(path);
const rows = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trimStart().startsWith('{'))
  .map((line) => JSON.parse(line) as Record<string, unknown>)
  .filter((row) => typeof row.id === 'string' && typeof row.title === 'string');

// Same representative input plan for both algorithms. These tasks describe
// the recorded source composition, not a claim to replay the saved SQL scan.
const plan: VeSourcePlan = { tasks: [
  { source: 'companies_directory', directory_filters: { okvedCodes: ['62'], regionCodes: ['77'], hasEmail: true }, rationale: 'IT' },
  { source: 'yandex_maps', maps_query: { queries: ['платёжные системы', 'финансовые технологии'], geo: 'Россия' }, rationale: 'Catalog' },
  { source: 'companies_directory', directory_filters: { okvedCodes: ['64'], hasEmail: true }, rationale: 'Finance' },
  { source: 'companies_directory', directory_filters: { okvedCodes: ['66'], employeesFrom: 3, hasEmail: true }, rationale: 'Services' },
] };
const changed: Array<{ id: string; project_id: unknown; before: string | null; after: string | null; decision: string }> = [];
const invariants = { task_count_preserved: true, source_types_preserved: true, geography_and_size_preserved: true,
  free_discovery_guard: true, input_not_mutated: true };
let candidateAlternativesBefore = 0, candidateAlternativesAfter = 0;
for (const row of rows) {
  const hypothesis: VeSourceAudienceHypothesis = { id: String(row.id), title: String(row.title),
    description: typeof row.description === 'string' ? row.description : null,
    status: typeof row.status === 'string' ? row.status : null, broad: row.broad === true,
    origin: row.origin === 'manual' ? 'manual' : 'generated' };
  const beforeProfile = detectVeNicheSourceProfile([hypothesis]);
  const before = beforeProfile ? { tasks: plan.tasks.map((task) => normalizeVeNicheSourceTask(task, beforeProfile)) } : plan;
  const original = JSON.stringify({ plan: before, hypothesis });
  const after = normalizeVeAudienceSourcePlan(before, [hypothesis]);
  invariants.input_not_mutated &&= original === JSON.stringify({ plan: before, hypothesis });
  invariants.task_count_preserved &&= before.tasks.length === after.plan.tasks.length;
  invariants.source_types_preserved &&= before.tasks.every((task, i) => task.source === after.plan.tasks[i].source);
  const boundaries = (input: VeSourcePlan) => input.tasks.map((task) => ({ geo: task.maps_query?.geo,
    area: task.hh_query?.area, ...Object.fromEntries(Object.entries(task.directory_filters ?? {})
      .filter(([key]) => !['nameTerms', 'identityCatalog'].includes(key))) }));
  invariants.geography_and_size_preserved &&= JSON.stringify(boundaries(before)) === JSON.stringify(boundaries(after.plan));
  invariants.free_discovery_guard &&= veSourceDiscoveryIsExistingOnly({ cost_policy: { version: 1, website_discovery: 'existing_only' } });
  if (beforeProfile !== after.profile) {
    changed.push({ id: hypothesis.id, project_id: row.project_id, before: beforeProfile, after: after.profile, decision: after.decision });
    candidateAlternativesBefore += before.tasks.filter((task) => task.source === 'companies_directory' && !task.directory_filters?.identityCatalog).length;
    candidateAlternativesAfter += after.plan.tasks.filter((task) => task.source === 'companies_directory' && !task.directory_filters?.identityCatalog).length;
  }
}
const report = { input_sha256: createHash('sha256').update(bytes).digest('hex'), hypotheses: rows.length,
  projects: new Set(rows.map((row) => row.project_id)).size, changed_profiles: changed,
  representative_plan_directory_branches_without_PSP_catalog: { before: candidateAlternativesBefore, after: candidateAlternativesAfter },
  invariants, external_calls: 0, cost_usd: 0, ready_contacts_delta: null,
  limitation: 'Replays deterministic source-plan policy on frozen metadata. Does not measure retrieval, relevance or email validation yield.' };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (Object.values(invariants).some((value) => !value)) process.exitCode = 1;
