/** Executable PostgreSQL regression smoke; never connects to Portal/prod.
 * Supply PGLITE_MODULE when @electric-sql/pglite is installed outside this repo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const db = new PGlite();
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const scalar = async (sql, args = []) => (await rows(sql, args))[0].result;
const fails = async (run, pattern) => {
  await assert.rejects(run, pattern);
};
const migration = (name) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role readonly;
    create table public.projects(id uuid primary key);
    create table public.project_periods(id uuid primary key, project_id uuid references public.projects,
      status text, deadline date, contacts_done text);
  `);
  await db.exec(migration('20260820_0001_vertical_engine_v2_foundation.sql'));
  await db.exec(migration('20260821_0001_vertical_engine_v2_runtime.sql'));
  await db.exec(migration('20260824_0002_vertical_engine_v2_base_per_hypothesis.sql'));
  await db.exec(migration('20260826_0001_vertical_engine_v2_fix_collecting_unique.sql'));
  await db.exec(migration('20260828_0001_vertical_engine_v2_segmentation_audits.sql'));
  await db.exec(migration('20260828_0003_vertical_engine_v2_launch_portfolio.sql'));
  await db.exec(migration('20260831_0001_vertical_engine_v2_launch_preset_binding.sql'));
  await db.exec(migration('20260901_0004_vertical_engine_v2_base_collect_job_guard.sql'));
  await db.exec(migration('20260902_0001_vertical_engine_v2_contact_delivery.sql'));
  if (!process.env.SUPPLY_SMOKE_BASELINE) {
    await db.exec(migration('20260903_0001_vertical_engine_v2_contact_supply.sql'));
    await db.exec(migration('20261020_0001_ve_supply_billing_resume.sql'));
  }
  const now = '2030-09-02T10:00:00Z'; // Monday, independent of machine weekday.
  const id = Object.fromEntries(['project', 'period', 've', 'actor', 'vertical', 'hypothesis', 'base', 'template', 'audit', 'reservation', 'preset']
    .map((key) => [key, randomUUID()]));
  await rows('insert into projects values ($1)', [id.project]);
  await rows("insert into project_periods values($1,$2,'active','2030-09-30','0')", [id.period, id.project]);
  await rows(`insert into ve_projects(id,created_by,name,website_url,launch_preset_id,launch_instantly_account_id,launch_preset_bound_at,launch_preset_bound_by)
    values($1,$2,'Test','https://example.org',$3,'workspace',$4,$2)`, [id.ve, id.actor, id.preset, now]);
  await rows("insert into ve_verticals(id,project_id,name,potential_pct) values($1,$2,'Clinics',50)", [id.vertical, id.ve]);
  await rows("insert into ve_hypotheses(id,project_id,vertical_id,title,tier,status) values($1,$2,$3,'Dentists',1,'accepted')", [id.hypothesis, id.ve, id.vertical]);
  await rows(`insert into ve_bases(id,project_id,vertical_id,hypothesis_id,source,status,collect_info,columns,data)
    values($1,$2,$3,$4,'auto','analyzed','{"collection_mode":"preview","ready_target":1000,"target_progress":{"status":"limited","ready_rows":1}}','["email"]','[{"email":"preview@example.org"}]')`, [id.base, id.ve, id.vertical, id.hypothesis]);
  await rows(`insert into ve_templates(id,base_id,vertical_id,letters,status)
    values($1,$2,$3,'[{"subject":"Hello","body":"Message"}]','ready')`, [id.template, id.base, id.vertical]);
  await rows(`insert into ve_segmentation_audits(id,project_id,template_id,base_id,requested_by,status,input_hash,summary,
      assignments,launch_status,launch_reservation_id)
    values($1,$2,$3,$4,$5,'ready',repeat('a',64),'{"unclassified_rows_total":0,"launchable_rows_total":1}',
      '[{"row_index":0,"segment":null}]','running',$6)`, [id.audit, id.ve, id.template, id.base, id.actor, id.reservation]);
  await scalar(`select ve_bind_contact_delivery_plan($1,$2,$3,100,array[1,2,3,4,5]::smallint[],'UTC',20,$4,$5) result`,
    [id.ve, id.project, id.period, id.actor, now]);
  const launchInfo = { preset_id: id.preset, instantly_account_id: 'workspace', mailbox_ids: ['sender@example.org'],
    campaigns: [{ campaign_id: 'campaign', leads_count: 0 }] };
  const initial = [{ campaign_id: 'campaign', source_row_index: 0, drip_order: 0, lead_payload: { email: 'preview@example.org' } }];
  const finalize = () => scalar(`select ve_finalize_template_contact_delivery($1,$2,$3,'succeeded',$4,null,$5,$6) result`,
    [id.audit, id.template, id.reservation, launchInfo, now, initial]);
  await fails(finalize, /approval|approved/i);
  const revision = await scalar('select ve_contact_supply_preview_revision($1) result', [id.template]);
  const approve = () => scalar(`select ve_approve_contact_supply($1,$2,$3,$8,$4,$5,100,'workspace',$6,$7) result`,
    [id.template, id.audit, revision, id.project, id.period, id.actor, now, id.preset]);
  await rows("update ve_hypotheses set title='Changed during approval' where id=$1", [id.hypothesis]);
  await fails(approve, /preview changed/);
  await rows("update ve_hypotheses set title='Dentists' where id=$1", [id.hypothesis]);
  await rows("update ve_bases set collect_info=jsonb_set(collect_info,'{target_progress,status}','\"error\"') where id=$1", [id.base]);
  await fails(approve, /terminal|preview.*ready/);
  await rows("update ve_bases set collect_info=jsonb_set(collect_info,'{target_progress,status}','\"limited\"') where id=$1", [id.base]);
  await rows("update ve_hypotheses set status='rejected' where id=$1", [id.hypothesis]);
  await fails(approve, /rejected|hypothesis/);
  await rows("update ve_hypotheses set status='accepted' where id=$1", [id.hypothesis]);
  await fails(() => scalar(`select ve_approve_contact_supply($1,$2,'stale',$7,$3,$4,100,'workspace',$5,$6) result`,
    [id.template, id.audit, id.project, id.period, id.actor, now, id.preset]), /preview changed/);
  const plan = await approve();
  const launched = await finalize();
  const itemId = launched.queue_item.id;
  assert.equal((await rows('select item_id from ve_contact_supply_plans where id=$1', [plan.id]))[0].item_id, itemId);
  await rows("update ve_launch_queue_items set status='active' where id=$1", [itemId]);
  const batchResult = await scalar('select ve_enqueue_contact_supply_batch($1,25,$2) result', [plan.id, now]);
  const duplicate = await scalar('select ve_enqueue_contact_supply_batch($1,25,$2) result', [plan.id, now]);
  assert.equal(duplicate.batch.id, batchResult.batch.id);
  assert.equal(duplicate.created, false);
  const batch = batchResult.batch;
  await rows(`update ve_bases set status='analyzed',columns='["email"]',data='[{"email":"new@example.org"},{"email":"preview@example.org"}]' where id=$1`, [batch.base_id]);
  const auditResult = await scalar('select ve_enqueue_contact_supply_audit($1,$2) result', [batch.id, now]);
  await rows(`update ve_segmentation_audits set status='ready',input_hash=repeat('b',64),
    summary='{"unclassified_rows_total":0,"launchable_rows_total":2}',assignments='[{"row_index":0,"segment":null},{"row_index":1,"segment":null}]',
    supply_leads='[{"email":"new@example.org"},{"email":"preview@example.org"}]',
    supply_source_revision=ve_contact_supply_preview_revision(template_id) where id=$1`, [auditResult.audit_id]);
  const additions = [{ campaign_id: 'campaign', source_row_index: 0, lead_payload: { email: 'new@example.org' } },
    { campaign_id: 'campaign', source_row_index: 1, lead_payload: { email: 'preview@example.org' } }];
  await fails(() => scalar('select ve_append_contact_supply_batch($1,$2,$3,$4) result',
    [batch.id, auditResult.audit_id, [{ ...additions[0], campaign_id: 'another-campaign' }], now]), /campaign.*segment/);
  await fails(() => scalar('select ve_append_contact_supply_batch($1,$2,$3,$4) result',
    [batch.id, auditResult.audit_id, [{ ...additions[0], lead_payload: { email: 'unaudited@example.org' } }], now]), /payload differs/);
  await rows("update ve_hypotheses set title='Changed audience' where id=$1", [id.hypothesis]);
  await fails(() => scalar('select ve_append_contact_supply_batch($1,$2,$3,$4) result', [batch.id, auditResult.audit_id, additions, now]), /approval|rules/i);
  await rows("update ve_hypotheses set title='Dentists' where id=$1", [id.hypothesis]);
  const added = await scalar('select ve_append_contact_supply_batch($1,$2,$3,$4) result', [batch.id, auditResult.audit_id, additions, now]);
  assert.equal(added.appended_count, 1);
  const replay = await scalar('select ve_append_contact_supply_batch($1,$2,$3,$4) result', [batch.id, auditResult.audit_id, additions, now]);
  assert.equal(replay.replayed, true);
  assert.equal((await rows('select count(*)::int n from ve_launch_queue_campaigns where item_id=$1', [itemId]))[0].n, 1);
  assert.equal((await rows('select max(drip_order)::int n from ve_contact_delivery_rows where item_id=$1', [itemId]))[0].n, 1);
  const savedRows = (await rows('select to_jsonb(r) snapshot from ve_contact_delivery_rows r where item_id=$1', [itemId])).map(r => r.snapshot);
  // Empty supply must not irrevocably consume today's only delivery turn.
  await db.transaction(async (tx) => {
    await tx.query('delete from ve_contact_delivery_rows where item_id=$1', [itemId]);
    await tx.query('update ve_launch_queue_campaigns set ready_leads_count=0,ready_remaining_count=0 where item_id=$1', [itemId]);
    await tx.query('update ve_launch_queue_items set ready_leads_count=0,ready_remaining_count=0 where id=$1', [itemId]);
    const empty = (await tx.query('select ve_reserve_contact_delivery_day($1,$2,0) result', [id.ve, now])).rows[0].result;
    assert.equal(empty.status, 'no_ready_rows');
    const completed = (await tx.query('select ve_reconcile_launch_campaign_statuses($1,$2,$3) result',
      [itemId, [{ campaign_id: 'campaign', status: 3, status_observed_at: now }], now])).rows[0].result;
    assert.equal(completed.item.status, 'active');
    await tx.query('insert into ve_contact_delivery_rows select * from jsonb_populate_recordset(null::ve_contact_delivery_rows,$1)', [savedRows]);
    await tx.query('update ve_launch_queue_campaigns set ready_leads_count=2,ready_remaining_count=2 where item_id=$1', [itemId]);
    await tx.query('update ve_launch_queue_items set ready_leads_count=2,ready_remaining_count=2 where id=$1', [itemId]);
    const reopened = (await tx.query('select ve_reserve_contact_delivery_day($1,$2,0) result', [id.ve, now])).rows[0].result;
    assert.equal(reopened.status, 'reserved');
    assert.equal(reopened.effective_count, 2);
    await tx.rollback();
  });
  await scalar("select ve_set_contact_supply_status($1,'paused',$2,$3) result", [plan.id, id.actor, now]);
  await fails(() => scalar('select ve_enqueue_contact_supply_batch($1,25,$2) result', [plan.id, now]), /paused|active/i);
  await scalar("select ve_set_contact_supply_status($1,'active',$2,$3) result", [plan.id, id.actor, now]);
  await db.transaction(async (tx) => {
    const retryBatch = (await tx.query('select ve_enqueue_contact_supply_batch($1,10,$2) result', [plan.id, '2030-09-02T10:05:00Z'])).rows[0].result.batch;
    await tx.query(`update ve_bases set status='analyzed',data='[{"email":"retry@example.org"}]',
      collect_info=collect_info||'{"target_progress":{"status":"target_reached","ready_rows":1}}' where id=$1`, [retryBatch.base_id]);
    const failedAudit = (await tx.query('select ve_enqueue_contact_supply_audit($1,$2) result', [retryBatch.id, now])).rows[0].result;
    await tx.query("update ve_segmentation_audits set status='failed' where id=$1", [failedAudit.audit_id]);
    await tx.query("select ve_finish_contact_supply_batch($1,'error','Transient audit failure',$2)", [retryBatch.id, now]);
    await tx.query("select ve_set_contact_supply_status($1,'active',$2,$3)", [plan.id, id.actor, now]);
    const resumed = (await tx.query('select status,audit_id,base_id from ve_contact_supply_batches where id=$1', [retryBatch.id])).rows[0];
    assert.equal(resumed.status, 'collecting');
    assert.equal(resumed.audit_id, null);
    assert.equal(resumed.base_id, retryBatch.base_id);
    const retriedAudit = (await tx.query('select ve_enqueue_contact_supply_audit($1,$2) result', [retryBatch.id, now])).rows[0].result;
    assert.notEqual(retriedAudit.audit_id, failedAudit.audit_id);
    await tx.rollback();
  });
  // A legacy billing failure closed the batch and parent job after saving a
  // paid constructor and partial verdicts. Resume must reuse all three IDs,
  // not silently replace that batch or grant it another acquisition budget.
  const billingError = 'Requesty 402: insufficient balance';
  const resumedAt = '2030-09-02T10:15:00Z';
  const withBillingBatch = async (run, { closed = true } = {}) => db.transaction(async (tx) => {
    const query = async (sql, args = []) => (await tx.query(sql, args)).rows;
    const one = async (sql, args = []) => (await query(sql, args))[0];
    const enqueued = (await one('select ve_enqueue_contact_supply_batch($1,500,$2) result',
      [plan.id, '2030-09-02T10:10:00Z'])).result;
    const batchId = enqueued.batch.id, baseId = enqueued.base_id, jobId = enqueued.job_id;
    const savedContacts = Array.from({ length: 191 }, (_, i) => ({
      company: `Saved company ${i}`, email: `saved${i}@example.org`, _email_status: 'ok',
    }));
    const info = {
      collection_mode: 'supply', supply_batch_id: batchId, hypothesis_id: id.hypothesis, ready_target: 500,
      target_progress: { mode: 'supply', status: 'error', reason: billingError, round: 71, max_rounds: 100,
        max_candidates: 10000, candidates_processed: 6753, ready_rows: 191, ready_target: 500,
        ready_companies: 175, ready_contacts: 191, counted_per_company: 3, first_round_candidates: 2000 },
      target_checkpoint: { completed_round: closed ? 71 : 70, processed_rows: 6753,
        seen_rows: [{ company: 'Paid source receipt', website: 'https://example.org' }] },
      tasks: [{ source: 'companies_directory', status: 'done', rows: 6753, exhausted: false,
        task: { source: 'companies_directory', directory_filters: { okved: ['86.23'] } },
        cursor: { page: 18, after_id: 'saved-cursor' }, harvest: [{ company: 'Preserved candidate' }] }],
      construct: { bc_job_id: randomUUID(), status: 'done', rows: 175 },
      search_policy: { version: 1, phase: 'existing', deferred_rows: [], construct_rows: [{ company: 'Paid constructor input' }] },
      relevance_reserve: { version: 1, rows: [{ company: 'Waiting verdict', email: 'waiting@example.org',
        _email_status: 'ok', _relevance_unchecked: true }], source_rows: [{ company: 'Preserved evidence' }] },
      relevance_checkpoint: { version: 2, context_hash: 'a'.repeat(64), verdicts: { paid: { status: 'relevant' } } },
      company_name_checkpoint: { context: 'saved-company-name-scope', names: { paid: 'Saved company' } },
    };
    const result = { relevance_checkpoint: info.relevance_checkpoint, company_name_checkpoint: info.company_name_checkpoint,
      saved_receipt: 'keep' };
    await query(`update ve_bases set status='failed',error=$2,collect_info=$3,data=$4,row_count=191,
      sample_rows=$5,columns='["company","email"]',updated_at='2030-09-02T10:12:00Z' where id=$1`,
    [baseId, billingError, info, savedContacts, savedContacts.slice(0, 3)]);
    await query(`update ve_jobs set status='done',result=$2,attempts=2,tokens_used=15000,cost_usd=0.125,
      payload=payload||'{"saved_receipt":"keep"}',progress='{"phase":"relevance_review"}',
      started_at='2030-09-02T10:11:00Z',finished_at='2030-09-02T10:12:01Z',
      updated_at='2030-09-02T10:12:01Z' where id=$1`, [jobId, result]);
    await query("select ve_finish_contact_supply_batch($1,'error',$2,'2030-09-02T10:12:02Z')", [batchId, billingError]);
    const snapshot = async () => ({
      base: (await one('select to_jsonb(b) value from ve_bases b where id=$1', [baseId])).value,
      batch: (await one('select to_jsonb(b) value from ve_contact_supply_batches b where id=$1', [batchId])).value,
      job: (await one('select to_jsonb(j) value from ve_jobs j where id=$1', [jobId])).value,
      plan: (await one('select to_jsonb(p) value from ve_contact_supply_plans p where id=$1', [plan.id])).value,
      counts: await one(`select (select count(*)::int from ve_jobs) jobs,
        (select count(*)::int from ve_bases) bases,(select count(*)::int from ve_contact_supply_batches) batches,
        (select count(*)::int from ve_contact_delivery_rows) deliveries,
        (select count(*)::int from ve_launch_queue_campaigns) campaigns`),
    });
    const resume = async () => (await one("select ve_set_contact_supply_status($1,'active',$2,$3) result",
      [plan.id, id.actor, resumedAt])).result;
    await run({ query, one, batchId, baseId, jobId, info, result, savedContacts, snapshot, resume });
    await tx.rollback();
  });
  for (const closed of [true, false]) await withBillingBatch(async (fixture) => {
    const { snapshot, resume, info, result, savedContacts, batchId, jobId } = fixture;
    const before = await snapshot();
    await resume();
    const after = await snapshot();
    assert.deepEqual(after.counts, before.counts);
    assert.equal(after.plan.status, 'active');
    assert.equal(after.batch.status, 'collecting');
    assert.equal(after.batch.audit_id, null);
    assert.equal(after.batch.appended_count, 0);
    assert.equal(after.base.status, 'collecting');
    assert.equal(after.base.error, null);
    assert.deepEqual(after.base.data, savedContacts);
    assert.deepEqual(after.base.sample_rows, before.base.sample_rows);
    assert.equal(after.base.row_count, 191);
    assert.equal(after.base.collect_info.target_progress.status, 'collecting');
    assert.equal(after.base.collect_info.target_progress.reason, undefined);
    const expectedProgress = { ...info.target_progress, status: 'collecting' };
    delete expectedProgress.reason;
    assert.deepEqual(after.base.collect_info.target_progress, expectedProgress);
    for (const key of ['target_checkpoint', 'tasks', 'construct', 'search_policy', 'relevance_reserve',
      'relevance_checkpoint', 'company_name_checkpoint']) assert.deepEqual(after.base.collect_info[key], info[key], key);
    assert.equal(after.base.collect_info.relevance_review_requested, closed ? true : undefined);
    const receipt = after.base.collect_info.supply_billing_resume;
    assert.equal(receipt.version, 1);
    assert.equal(receipt.batch_id, batchId);
    assert.equal(receipt.job_id, jobId);
    assert.equal(receipt.max_rounds, 100);
    assert.equal(receipt.max_candidates, 10000);
    assert.equal(Date.parse(receipt.resumed_at), Date.parse(resumedAt));
    assert.ok(Number.isFinite(Date.parse(receipt.blocked_at)));
    assert.equal(after.job.status, 'pending');
    assert.equal(after.job.started_at, null);
    assert.equal(after.job.finished_at, null);
    assert.equal(after.job.error, null);
    assert.equal(Date.parse(after.job.run_after), Date.parse(resumedAt));
    assert.equal(after.job.attempts, 2);
    assert.equal(after.job.tokens_used, 15000);
    assert.equal(Number(after.job.cost_usd), 0.125);
    assert.deepEqual(after.job.result, result);
    assert.deepEqual(after.job.payload, before.job.payload);
    await resume();
    const replay = await snapshot();
    assert.deepEqual(replay.base, after.base);
    assert.deepEqual(replay.batch, after.batch);
    assert.deepEqual(replay.job, after.job);
    assert.deepEqual(replay.counts, after.counts);
    if (closed) {
      await fixture.query("select ve_finish_contact_supply_batch($1,'error',$2,'2030-09-02T10:16:00Z')", [batchId, billingError]);
      assert.deepEqual(await snapshot(), replay, 'old runner must not close a resumed collecting base');
      await fixture.query(`update ve_bases set status='analyzed',updated_at='2030-09-02T10:16:00Z',
        collect_info=jsonb_set(collect_info,'{target_progress,status}','"limited"') where id=$1`, [fixture.baseId]);
      const finishedBase = await snapshot();
      await fixture.query("select ve_finish_contact_supply_batch($1,'error',$2,'2030-09-02T10:14:00Z')", [batchId, billingError]);
      assert.deepEqual(await snapshot(), finishedBase, 'old sweep timestamp must not close a newly finished recovery');
      await fixture.query("select ve_finish_contact_supply_batch($1,'limited','Saved cap reached','2030-09-02T10:17:00Z')", [batchId]);
      const finalized = await snapshot();
      assert.equal(finalized.plan.status, 'limited');
      assert.equal(finalized.batch.status, 'failed');
      assert.equal(finalized.batch.error, 'Saved cap reached');
      assert.deepEqual(finalized.base, finishedBase.base);
      assert.deepEqual(finalized.job, finishedBase.job);
    }
  }, { closed });
  await withBillingBatch(async (fixture) => {
    const progress = { ...fixture.info.target_progress, round: 1, max_rounds: 3, max_candidates: 1000,
      candidates_processed: 0, ready_rows: 0, ready_companies: 0, ready_contacts: 0 };
    await fixture.query(`update ve_bases set data='[]',sample_rows='[]',row_count=0,
      collect_info=jsonb_set(collect_info-'target_checkpoint'-'construct','{target_progress}',$2) where id=$1`,
    [fixture.baseId, progress]);
    await fixture.resume();
    const after = await fixture.snapshot();
    assert.equal(after.base.collect_info.relevance_review_requested, undefined);
    assert.equal(after.base.collect_info.target_checkpoint, undefined);
    assert.equal(after.base.collect_info.target_progress.round, 1);
    assert.equal(after.base.collect_info.target_progress.max_rounds, 3);
    assert.equal(after.base.collect_info.target_progress.max_candidates, 1000);
    assert.equal(after.base.collect_info.target_progress.candidates_processed, 0);
    assert.equal(after.base.collect_info.supply_billing_resume.max_rounds, 3);
    assert.equal(after.base.collect_info.supply_billing_resume.max_candidates, 1000);
  }, { closed: false });
  await withBillingBatch(async (fixture) => {
    const recovery = { validation_error: billingError, has_buffered_candidates: false,
      round_low_relevance: 3, round_relevance_unchecked: 7 };
    await fixture.query("update ve_bases set collect_info=collect_info||jsonb_build_object('company_name_recovery',$2::jsonb) where id=$1",
      [fixture.baseId, recovery]);
    await fixture.query(`update ve_jobs set payload=payload||'{"requesty_billing_wait":{"version":1},"requesty_billing_recovery":{"version":1}}' where id=$1`,
      [fixture.jobId]);
    const before = await fixture.snapshot();
    // Explicit pause must never revive the base or consume saved work.
    await fixture.query("select ve_set_contact_supply_status($1,'paused',$2,$3)", [plan.id, id.actor, resumedAt]);
    const paused = await fixture.snapshot();
    assert.equal(paused.plan.status, 'paused');
    assert.deepEqual(paused.base, before.base);
    assert.deepEqual(paused.batch, before.batch);
    assert.deepEqual(paused.job, before.job);
    await fixture.resume();
    const after = await fixture.snapshot();
    assert.deepEqual(after.base.collect_info.company_name_recovery, { ...recovery, retry_validation_after_cleanup: true });
    assert.equal(after.job.payload.requesty_billing_wait, undefined);
    assert.equal(after.job.payload.requesty_billing_recovery, undefined);
    assert.equal(after.job.payload.saved_receipt, 'keep');
    assert.deepEqual(after.job.result, before.job.result);
  });
  const deniedBillingCases = [
    ['active job', async ({ query, jobId }) => query("update ve_jobs set status='running' where id=$1", [jobId])],
    ['cancelled job', async ({ query, jobId }) => query("update ve_jobs set status='cancelled' where id=$1", [jobId])],
    ['refill payload', async ({ query, jobId }) => query("update ve_jobs set payload=payload||'{\"refill\":true}' where id=$1", [jobId])],
    ['wrong batch scope', async ({ query, jobId }) => query("update ve_jobs set payload=jsonb_set(payload,'{supply_batch_id}',to_jsonb($2::text)) where id=$1", [jobId, randomUUID()])],
    ['wrong hypothesis scope', async ({ query, jobId }) => query("update ve_jobs set payload=jsonb_set(payload,'{hypothesis_id}',to_jsonb($2::text)) where id=$1", [jobId, randomUUID()])],
    ['wrong project scope', async ({ query, baseId }) => {
      const otherProjectId = randomUUID();
      await query("insert into ve_projects(id,created_by,name,website_url) values($1,$2,'Other project','https://other.example.org')", [otherProjectId, id.actor]);
      await query('update ve_bases set project_id=$2 where id=$1', [baseId, otherProjectId]);
    }],
    ['missing checkpoint', async ({ query, baseId }) => query("update ve_bases set collect_info=collect_info-'target_checkpoint' where id=$1", [baseId])],
    ['numeric string checkpoint', async ({ query, baseId }) => query("update ve_bases set collect_info=jsonb_set(collect_info,'{target_progress,round}','\"71\"') where id=$1", [baseId])],
    ['open checkpoint with closed-review marker', async ({ query, baseId }) => query(`update ve_bases
      set collect_info=jsonb_set(collect_info,'{target_checkpoint,completed_round}','70')||'{"relevance_review_requested":true}' where id=$1`, [baseId])],
    ['skipped checkpoint', async ({ query, baseId }) => query("update ve_bases set collect_info=jsonb_set(collect_info,'{target_checkpoint,completed_round}','69') where id=$1", [baseId])],
    ['budget already exceeded', async ({ query, baseId }) => query("update ve_bases set collect_info=jsonb_set(collect_info,'{target_progress,max_rounds}','70') where id=$1", [baseId])],
    ['wrong base mode', async ({ query, baseId }) => query("update ve_bases set collect_info=jsonb_set(collect_info,'{collection_mode}','\"preview\"') where id=$1", [baseId])],
    ['already appended rows', async ({ query, batchId }) => query("update ve_contact_supply_batches set appended_count=1 where id=$1", [batchId])],
    ['changed approval', async ({ query }) => query("update ve_hypotheses set title='Changed billing audience' where id=$1", [id.hypothesis])],
    ['newer cancelled attempt', async ({ query, baseId, batchId }) => query(`insert into ve_jobs(project_id,stage,status,payload,created_at,updated_at)
      values($1,'base_collect','cancelled',$2,'2030-09-02T10:13:00Z','2030-09-02T10:13:00Z')`,
    [id.ve, { base_id: baseId, supply_batch_id: batchId, collection_mode: 'supply' }])],
  ];
  for (const [label, change] of deniedBillingCases) await withBillingBatch(async (fixture) => {
    await change(fixture);
    const before = await fixture.snapshot();
    await fixture.query('savepoint rejected_resume');
    await assert.rejects(fixture.resume, undefined, label);
    await fixture.query('rollback to savepoint rejected_resume');
    assert.deepEqual(await fixture.snapshot(), before, `${label}: rejected resume changed persisted state`);
  });
  await withBillingBatch(async (fixture) => {
    await fixture.query("update ve_bases set error='Directory HTTP 404' where id=$1", [fixture.baseId]);
    await fixture.query("update ve_contact_supply_batches set error='Directory HTTP 404' where id=$1", [fixture.batchId]);
    await fixture.query("update ve_bases set collect_info=jsonb_set(collect_info,'{target_progress,reason}','\"Directory HTTP 404\"') where id=$1", [fixture.baseId]);
    const before = await fixture.snapshot();
    await fixture.resume();
    const after = await fixture.snapshot();
    assert.equal(after.plan.status, 'active');
    assert.deepEqual(after.base, before.base);
    assert.deepEqual(after.batch, before.batch);
    assert.deepEqual(after.job, before.job);
    assert.deepEqual(after.counts, before.counts);
  });
  await rows("update ve_templates set letters='[{\"body\":\"Changed\"}]' where id=$1", [id.template]);
  assert.equal(await scalar('select ve_contact_supply_approval_current($1) result', [plan.id]), false);
  await fails(() => scalar('select ve_reserve_contact_delivery_day($1,$2,0) result', [id.ve, now]), /approval is stale/);
  await fails(() => scalar("select ve_reserve_contact_delivery_activation($1,'campaign',$2,3,$3,$3) result", [itemId, randomUUID(), now]), /approval is stale/);
  await fails(() => scalar("select ve_mark_contact_delivery_attempt($1,$2,'campaign',$3) result", [randomUUID(), randomUUID(), [savedRows[0].id]]), /approval is stale/);
  await db.exec('set role service_role');
  await fails(() => rows('delete from ve_contact_supply_plans'), /permission denied/i);
  await fails(() => scalar('select ve_reserve_contact_delivery_day_before_supply($1,$2,0) result', [id.ve, now]), /permission denied/i);
  await db.exec('reset role');
  console.log('PASS continuous supply: approval, atomic enqueue/append/replay, campaign reuse, pause/stale rules, empty-day retry, and saved billing-batch resume/rollback.');
} catch (error) {
  console.error(error.message, error.where || '', error.stack?.split('\n').slice(1, 3).join('\n') || '');
  process.exitCode = 1;
} finally {
  await db.close();
}
