import { randomUUID } from 'node:crypto';
import { planVeCollectionGeographyRepair, prepareVeGeographyRepairContinuation, veGeographyRepairHash,
  type VeGeographyRepairPlan, type VeGeographyRepairRequest, type VeGeographyRepairSnapshot } from './collectionGeographyRepair';

type Row = Record<string, unknown>;
type PreparedPlan = Exclude<VeGeographyRepairPlan, { status: 'blocked' }>;
export interface VeGeographyRepairDb {
  /** A single dedicated connection, not a pool.query callback. */
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}
export interface VeGeographyRepairArtifact {
  version: 1; project_id: string; hypothesis_id: string; base_id: string; setup_revision: number;
  request: VeGeographyRepairRequest;
  /** Returned by dry-run. Apply never accepts unreviewed current state implicitly. */
  expected?: PreparedPlan['expected'] & { templates_hash: string };
}
export interface VeGeographyRepairApplyResult {
  status: 'blocked' | 'dry_run' | 'applied' | 'already_applied'; reasons?: string[];
  project_id: string; hypothesis_id: string; base_id: string; repair_id: string;
  persistent_writes: boolean; job_id?: string;
  ready_before?: number; ready_after?: number; held_rows?: number;
  budget?: PreparedPlan['budget']; continuation?: PreparedPlan['continuation'];
  /** Safe artifact: IDs, reviewed indices and hashes, never company/contact data. */
  artifact?: VeGeographyRepairArtifact;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function validateArtifact(input: VeGeographyRepairArtifact): void {
  if (input.version !== 1 || ![input.project_id, input.hypothesis_id, input.base_id].every((id) => UUID.test(id))
    || !Number.isSafeInteger(input.setup_revision) || input.setup_revision < 1
    || !Array.isArray(input.request?.ready_row_indices) || !/^[a-f0-9]{64}$/.test(input.request?.reviewed_data_hash ?? '')) {
    throw new Error('Invalid geography repair artifact');
  }
}

/** Load one preview, under the same project/job fences as preparation workers.
 * Row locks are used only by apply. Dry-run is a consistent READ ONLY snapshot. */
async function snapshot(db: VeGeographyRepairDb, input: VeGeographyRepairArtifact, lock: boolean): Promise<{
  snapshot: VeGeographyRepairSnapshot; templatesHash: string;
}> {
  const rows = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[]) => {
    const result = await rows(sql, args);
    if (result.length !== 1) throw new Error('Geography repair binding is missing or ambiguous');
    return result[0].item as Row;
  };
  if (lock) await rows('select pg_advisory_xact_lock(hashtextextended($1::text,22082029))', [input.project_id]);
  const setup = await one(`select to_jsonb(s) item from public.ve_outreach_setups s where project_id=$1::uuid${lock ? ' for update' : ''}`, [input.project_id]);
  const prep = await one(`select to_jsonb(p) item from public.ve_outreach_preparations p
    where project_id=$1::uuid and hypothesis_id=$2::uuid${lock ? ' for update' : ''}`, [input.project_id, input.hypothesis_id]);
  if (Number(setup.revision) !== input.setup_revision || prep.base_id !== input.base_id) throw new Error('Geography repair setup or base binding changed');
  const hypotheses = await rows(`select id from public.ve_hypotheses where id=$1::uuid and project_id=$2::uuid
    and vertical_id is not null and status is distinct from 'rejected'${lock ? ' for share' : ''}`, [input.hypothesis_id, input.project_id]);
  if (hypotheses.length !== 1) throw new Error('Geography repair hypothesis is unavailable');
  const jobs = await rows(`select to_jsonb(j) item from public.ve_jobs j join public.ve_bases b on b.id::text=j.payload->>'base_id'
    where b.project_id=$1::uuid and b.hypothesis_id=$2::uuid and j.project_id=$1::uuid
    order by j.id${lock ? ' for update of j' : ''}`, [input.project_id, input.hypothesis_id]);
  // The editor/approval path owns a template advisory lock. Acquire it before
  // any base/template row lock so a concurrent editor cannot cross this fence.
  const templateIds = await rows('select id from public.ve_templates where base_id=$1::uuid order by id', [input.base_id]);
  if (lock) for (const template of templateIds) await rows('select pg_advisory_xact_lock(hashtextextended($1::text,22082028))', [template.id]);
  const base = await one(`select to_jsonb(b) item from public.ve_bases b where id=$1::uuid${lock ? ' for update' : ''}`, [input.base_id]);
  if (base.project_id !== input.project_id || base.hypothesis_id !== input.hypothesis_id) throw new Error('Geography repair base identity changed');
  const templates = await rows(`select to_jsonb(t) item from public.ve_templates t where base_id=$1::uuid
    order by id${lock ? ' for update' : ''}`, [input.base_id]);
  if (veGeographyRepairHash(templateIds.map((row) => row.id)) !== veGeographyRepairHash(templates.map((row) => (row.item as Row).id))) {
    throw new Error('Geography repair template set changed');
  }
  const childrenByKind = new Map<string, Set<string>>(['base_constructor_jobs', 'parser_jobs', 'google_maps_jobs'].map((kind) => [kind, new Set<string>()]));
  const addChild = (kind: string, id: unknown) => {
    if (id === undefined || id === null || id === '') return;
    if (typeof id !== 'string' || !UUID.test(id) || !childrenByKind.has(kind)) throw new Error('Invalid saved child identity');
    childrenByKind.get(kind)!.add(id);
  };
  const links = await rows(`select c.kind,c.child_id from public.ve_preparation_children c join public.ve_bases b on b.id=c.base_id
    where b.project_id=$1::uuid and b.hypothesis_id=$2::uuid order by c.kind,c.child_id${lock ? ' for share of c' : ''}`, [input.project_id, input.hypothesis_id]);
  for (const link of links) addChild(String(link.kind), link.child_id);
  const info = record(base.collect_info), pipeline = record(info.preview_pipeline);
  addChild('base_constructor_jobs', record(info.construct).bc_job_id);
  addChild('base_constructor_jobs', record(record(info.saved_email_recovery).batch).id);
  for (const id of Array.isArray(pipeline.job_ids) ? pipeline.job_ids : []) addChild('base_constructor_jobs', id);
  for (const batch of Array.isArray(pipeline.batches) ? pipeline.batches : []) addChild('base_constructor_jobs', record(batch).id);
  for (const task of Array.isArray(info.tasks) ? info.tasks : []) {
    const state = record(task);
    if (state.child_job_id) addChild(state.source === 'google_maps' ? 'google_maps_jobs' : 'parser_jobs', state.child_job_id);
  }
  const children: VeGeographyRepairSnapshot['children'] = [];
  for (const [kind, ids] of childrenByKind) {
    if (!ids.size) continue;
    // kind is a fixed internal allowlist; only IDs come from the snapshot.
    // All three child tables carry completion/creation timestamps. Do not read
    // their potentially large paid result/data payloads merely to fence status.
    const saved = await rows(`select id,status,completed_at,created_at from public.${kind}
      where id=any($1::uuid[]) order by id${lock ? ' for update' : ''}`, [[...ids].sort()]);
    if (saved.length !== ids.size) throw new Error('Saved geography repair child is missing');
    for (const child of saved) children.push({ id: String(child.id), status: String(child.status),
      updated_at: child.completed_at instanceof Date ? child.completed_at.toISOString()
        : child.created_at instanceof Date && child.completed_at == null ? child.created_at.toISOString()
          : String(child.completed_at ?? child.created_at ?? '') });
  }
  const flags = (await rows(`select public.ve_base_audience_frozen($1::uuid) frozen,
    exists(select 1 from public.ve_outreach_runs r where r.project_id=$2::uuid and r.status<>'cancelled'
      and exists(select 1 from jsonb_array_elements(coalesce(r.request->'items','[]'::jsonb)) x where x->>'base_id'=$1::text)) accepted_launch`,
  [input.base_id, input.project_id]))[0];
  return { snapshot: { project_id: input.project_id, setup_revision: Number(setup.revision),
    selected: Array.isArray(setup.selected_hypothesis_ids) && setup.selected_hypothesis_ids.includes(input.hypothesis_id),
    approved: Object.prototype.hasOwnProperty.call(record(setup.approved_bases), input.base_id),
    frozen: flags.frozen === true, accepted_launch: flags.accepted_launch === true,
    base: base as unknown as VeGeographyRepairSnapshot['base'],
    preparation: { base_id: String(prep.base_id), hypothesis_id: String(prep.hypothesis_id), status: String(prep.status),
      updated_at: String(prep.updated_at), paused_at: prep.paused_at as string | null, cancelled_at: prep.cancelled_at as string | null,
      pause_state: prep.pause_state as Row | null, locked_until: prep.locked_until as string | null,
      claim_token: prep.claim_token as string | null, independent_control: prep.independent_control === true },
    jobs: jobs.map(({ item }) => item as VeGeographyRepairSnapshot['jobs'][number]), children },
  templatesHash: veGeographyRepairHash(templates.map(({ item }) => item)) };
}

/** Operator-only, one-base atomic apply. No HTTP/LLM and no implicit continuation. */
export async function applyVeCollectionGeographyRepair(db: VeGeographyRepairDb, input: VeGeographyRepairArtifact,
  options: { apply?: boolean; continueCollection?: boolean } = {}): Promise<VeGeographyRepairApplyResult> {
  validateArtifact(input);
  if (options.continueCollection && !options.apply) throw new Error('Continuation requires explicit apply');
  if (options.apply && !input.expected) throw new Error('Apply requires the reviewed dry-run artifact');
  const result = { project_id: input.project_id, hypothesis_id: input.hypothesis_id, base_id: input.base_id,
    repair_id: input.request.repair_id, persistent_writes: false };
  await db.query(options.apply ? 'BEGIN READ WRITE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    const current = await snapshot(db, input, options.apply === true), state = current.snapshot;
    // Never adopt a human pause or revive its cancelled parent/result. A future
    // owned-pause protocol must drain and verify those exact children first.
    if (state.preparation.paused_at || state.preparation.cancelled_at) {
      await db.query('ROLLBACK'); return { ...result, status: 'blocked', reasons: ['paused_preparation_requires_separate_review'] };
    }
    if (state.approved || state.frozen || state.accepted_launch) {
      await db.query('ROLLBACK'); return { ...result, status: 'blocked', reasons: ['approved_or_launched'] };
    }
    const receipt = record(record(state.base.collect_info).geography_repair);
    if (receipt.continuation_job_id && receipt.repair_id === input.request.repair_id
      && receipt.original_data_hash === input.request.reviewed_data_hash
      && veGeographyRepairHash(receipt.required) === veGeographyRepairHash(input.request.required)
      && veGeographyRepairHash(receipt.reviewed_ready_indices) === veGeographyRepairHash(input.request.ready_row_indices)) {
      const job = state.jobs.find((candidate) => candidate.id === receipt.continuation_job_id);
      if (!job || job.payload.base_id !== input.base_id || job.payload.geography_repair_id !== input.request.repair_id) throw new Error('Geography continuation receipt has no matching job');
      await db.query('ROLLBACK'); return { ...result, status: 'already_applied', job_id: job.id };
    }
    const plan = planVeCollectionGeographyRepair(state, input.request);
    if (plan.status === 'blocked') { await db.query('ROLLBACK'); return { ...result, status: 'blocked', reasons: plan.reasons }; }
    const expected = { ...plan.expected, templates_hash: current.templatesHash };
    const safeArtifact = { ...input, expected };
    const summary = { ...result, ready_before: state.base.row_count, ready_after: plan.patch.row_count,
      held_rows: plan.patch.collect_info.geography_repair?.held_ready_rows.length ?? 0,
      budget: plan.budget, continuation: plan.continuation, artifact: safeArtifact };
    if (!options.apply) { await db.query('ROLLBACK'); return { ...summary, status: 'dry_run' }; }
    if (veGeographyRepairHash(input.expected) !== veGeographyRepairHash(expected)
      && (plan.status !== 'already_prepared' || options.continueCollection)) {
      throw new Error('Geography repair changed since dry-run; review a new artifact');
    }
    if (plan.status === 'already_prepared' && !options.continueCollection) {
      await db.query('ROLLBACK'); return { ...summary, status: 'already_applied' };
    }
    let collectInfo = plan.patch.collect_info, jobId: string | undefined;
    if (options.continueCollection) {
      const continuation = prepareVeGeographyRepairContinuation(collectInfo);
      if (!continuation.can_continue) { await db.query('ROLLBACK'); return { ...summary, status: 'blocked', reasons: [continuation.reason ?? 'continuation_unavailable'] }; }
      collectInfo = continuation.collect_info as typeof collectInfo;
      jobId = randomUUID();
      collectInfo = { ...collectInfo, geography_repair: { ...collectInfo.geography_repair!,
        continuation_job_id: jobId, continuation_started_at: new Date().toISOString() } };
    }
    const updated = await db.query(`update public.ve_bases set data=$2::jsonb,row_count=$3,sample_rows=$4::jsonb,
      collect_info=$5::jsonb,analysis=$9::jsonb,status=case when $6::boolean then 'collecting' else status end,error=null,updated_at=clock_timestamp()
      where id=$1::uuid and project_id=$7::uuid and hypothesis_id=$8::uuid returning id`,
    [input.base_id, JSON.stringify(plan.patch.data), plan.patch.row_count, JSON.stringify(plan.patch.sample_rows),
      JSON.stringify(collectInfo), !!jobId, input.project_id, input.hypothesis_id, JSON.stringify(plan.patch.analysis ?? null)]);
    if (updated.rows.length !== 1) throw new Error('Geography repair lost the base binding');
    if (jobId) {
      await db.query(`update public.ve_outreach_preparations set status='collecting',last_error=null,
        resume_collection_requested=false,locked_until=null,claim_token=null,
        pause_state=jsonb_build_object('resumed_base_id',$3::text),updated_at=clock_timestamp()
        where project_id=$1::uuid and hypothesis_id=$2::uuid and base_id=$3::uuid`, [input.project_id, input.hypothesis_id, input.base_id]);
      await db.query(`insert into public.ve_jobs(id,project_id,stage,status,payload)
        values($1::uuid,$2::uuid,'base_collect','pending',$3::jsonb)`, [jobId, input.project_id, JSON.stringify({
        base_id: input.base_id, hypothesis_id: input.hypothesis_id, collection_mode: 'preview',
        ready_target: collectInfo.ready_target ?? collectInfo.target_progress?.ready_target,
        limit: collectInfo.limit, geography_repair_id: input.request.repair_id })]);
    }
    await db.query('COMMIT');
    return { ...summary, status: 'applied', persistent_writes: true, ...(jobId ? { job_id: jobId } : {}) };
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* Preserve original failure. */ }
    throw error;
  }
}
