/** Executable PostgreSQL regression smoke; never connects to Portal/prod.
 * Supply PGLITE_MODULE when @electric-sql/pglite is installed outside this repo.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const db = new PGlite();
let geographyBundleDir;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const scalar = async (sql, args = []) => (await rows(sql, args))[0].result;
const fails = async (run, pattern) => {
  await assert.rejects(run, pattern);
};
const migration = (name) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const preparationControl = migration('20261015_0030_ve_hypothesis_preparation_pause.sql');
const preparationFunction = (name) => {
  const definition = preparationControl.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]+?\\$\\$;`))?.[0];
  assert.ok(definition, `production SQL definition missing: ${name}`);
  return definition;
};
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
    // External shared child/preparation tables are read only by recovery.
    await db.exec(`create table public.base_constructor_jobs(id uuid primary key,status text);
      create table public.ve_outreach_preparations(project_id uuid,hypothesis_id uuid,base_id uuid,template_id uuid,
        status text not null default 'error',language text not null default 'ru',independent_control boolean not null default false,
        locked_until timestamptz,claim_token uuid,last_error text,updated_at timestamptz not null default now(),
        paused_at timestamptz,cancelled_at timestamptz,pause_state jsonb,primary key(project_id,hypothesis_id));
      create table public.ve_outreach_setups(project_id uuid primary key,selected_hypothesis_ids uuid[] not null default '{}',
        approved_bases jsonb not null default '{}',language text not null default 'ru');
      create table public.ve_outreach_runs(id uuid primary key,project_id uuid,status text,request jsonb);`);
    await db.exec(migration('20261020_0002_ve_legacy_supply_credit_recovery.sql'));
    // Execute the real shared frozen-audience predicate; remaining setup rows
    // above are narrow external-table fixtures, with the production columns.
    const frozenPredicate = migration('20260920_0001_ve_emails_per_company.sql')
      .match(/create or replace function public\.ve_base_audience_frozen[\s\S]+?\$\$;/)?.[0];
    assert.ok(frozenPredicate);
    await db.exec(frozenPredicate);
    await db.exec(migration('20261020_0006_ve_legacy_requesty_preview_recovery.sql'));
    await db.exec(migration('20261021_0004_ve_queue_persistence_recovery.sql'));
    await db.exec(preparationFunction('ve_completed_preparation_recoverable'));
    await db.exec(preparationFunction('ve_claim_outreach_preparation'));
    await db.exec(preparationFunction('ve_save_outreach_preparation'));
    await db.exec(migration('20261022_0001_ve_preparation_claim_fast_guard.sql'));
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
    await query("insert into base_constructor_jobs values($1,'completed')", [info.construct.bc_job_id]);
    await query("update ve_launch_queue_campaigns set remote_status=1,status_observed_at='2030-09-02T10:14:30Z' where item_id=$1", [itemId]);
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
  // Automatic legacy recovery uses a fresh management credit observation,
  // and must not convert repeated 402s into an unbounded paid retry loop.
  const fingerprint = 'c'.repeat(64);
  const fundedCredit = { balanceUsd: 10, monthlySpendUsd: 5, monthlyLimitUsd: 100 };
  const observeAndResume = async (fixture, overrides = {}) => {
    const current = await fixture.snapshot();
    return (await fixture.one('select ve_resume_legacy_requesty_supply($1,$2,$3,$4,$5,$6) result',
      [plan.id, overrides.updatedAt ?? current.plan.updated_at, overrides.fingerprint ?? fingerprint,
        JSON.stringify(overrides.credit === undefined ? fundedCredit : overrides.credit),
        overrides.observedAt ?? '2030-09-02T10:14:50Z', overrides.now ?? resumedAt])).result;
  };
  const previousRecovery = (credit = fundedCredit) => ({
    version: 1, source: 'legacy_supply', origin: 'automatic_requesty_credit',
    key_fingerprint: fingerprint, credit_signal: credit, credit_observed_at: '2030-09-02T10:11:00Z',
    blocked_at: '2030-09-02T10:10:00Z', resumed_at: '2030-09-02T10:11:00Z',
  });
  const setPreviousRecovery = (fixture, recovery) => fixture.query(`update ve_jobs
    set payload=payload||jsonb_build_object('requesty_billing_recovery',$2::jsonb) where id=$1`, [fixture.jobId, recovery]);
  for (const closed of [true, false]) await withBillingBatch(async (fixture) => {
    const before = await fixture.snapshot();
    assert.deepEqual(await observeAndResume(fixture), { resumed: true, reason: 'credit_available' });
    const after = await fixture.snapshot();
    assert.deepEqual(after.counts, before.counts);
    assert.equal(after.plan.status, 'active');
    assert.equal(after.batch.status, 'collecting');
    assert.equal(after.base.status, 'collecting');
    assert.equal(after.job.status, 'pending');
    assert.equal(after.base.row_count, 191);
    assert.deepEqual(after.base.data, before.base.data);
    assert.deepEqual(after.job.result, before.job.result);
    assert.equal(after.job.attempts, before.job.attempts);
    assert.equal(after.job.tokens_used, before.job.tokens_used);
    assert.equal(after.job.cost_usd, before.job.cost_usd);
    for (const key of ['target_checkpoint', 'tasks', 'construct', 'search_policy', 'relevance_reserve',
      'relevance_checkpoint', 'company_name_checkpoint']) assert.deepEqual(after.base.collect_info[key], before.base.collect_info[key], key);
    for (const key of ['round', 'max_rounds', 'max_candidates', 'candidates_processed', 'ready_rows', 'ready_target']) {
      assert.equal(after.base.collect_info.target_progress[key], before.base.collect_info.target_progress[key], key);
    }
    assert.equal(after.base.collect_info.supply_billing_resume.origin, 'automatic_requesty_credit');
    const recovery = after.job.payload.requesty_billing_recovery;
    assert.equal(recovery.version, 1);
    assert.equal(recovery.source, 'legacy_supply');
    assert.equal(recovery.origin, 'automatic_requesty_credit');
    assert.equal(recovery.key_fingerprint, fingerprint);
    assert.deepEqual(recovery.credit_signal, fundedCredit);
    assert.equal(Date.parse(recovery.resumed_at), Date.parse(resumedAt));
    assert.equal(after.job.payload.saved_receipt, 'keep');
    assert.equal((await observeAndResume(fixture, { updatedAt: before.plan.updated_at })).resumed, false);
    assert.deepEqual(await fixture.snapshot(), after);
    // The same stage fails again after recovery, with an unchanged positive
    // visible balance. Keep the baseline and wait for an actual improvement.
    await fixture.query(`update ve_bases set status='failed',error=$2,updated_at='2030-09-02T10:16:00Z',
      collect_info=jsonb_set(collect_info,'{target_progress}',collect_info->'target_progress'||
        jsonb_build_object('status','error','reason',$2::text)) where id=$1`, [fixture.baseId, billingError]);
    await fixture.query("update ve_jobs set status='done',finished_at='2030-09-02T10:16:00Z' where id=$1", [fixture.jobId]);
    await fixture.query("select ve_finish_contact_supply_batch($1,'error',$2,'2030-09-02T10:16:01Z')", [fixture.batchId, billingError]);
    const repeatedFailure = await fixture.snapshot();
    assert.deepEqual(await observeAndResume(fixture, { now: '2030-09-02T10:16:10Z', observedAt: '2030-09-02T10:16:05Z' }),
      { resumed: false, reason: 'awaiting_credit_change' });
    assert.deepEqual(await fixture.snapshot(), repeatedFailure);
    if (closed) {
      assert.equal((await observeAndResume(fixture, { now: '2030-09-02T10:16:10Z', observedAt: '2030-09-02T10:16:05Z',
        credit: { ...fundedCredit, balanceUsd: 20 } })).resumed, true);
      assert.deepEqual((await fixture.snapshot()).counts, before.counts);
    }
  }, { closed });
  for (const [previous, next] of [
    [fundedCredit, { ...fundedCredit, balanceUsd: 11 }],
    [fundedCredit, { ...fundedCredit, monthlyLimitUsd: 0 }],
    [fundedCredit, { ...fundedCredit, monthlyLimitUsd: 200 }],
    [fundedCredit, { ...fundedCredit, monthlySpendUsd: 0 }],
  ]) await withBillingBatch(async (fixture) => {
    await setPreviousRecovery(fixture, previousRecovery(previous));
    assert.equal((await observeAndResume(fixture, { credit: next })).resumed, true);
  });
  const deniedAutomaticCases = [
    ['expired credit probe', null, { observedAt: '2030-09-02T10:12:59Z' }],
    ['future credit probe', null, { observedAt: '2030-09-02T10:15:01Z' }],
    ['numeric string credit', null, { credit: { ...fundedCredit, balanceUsd: '10' } }],
    ['missing credit field', null, { credit: { balanceUsd: 10, monthlySpendUsd: 0 } }],
    ['invalid credit object', null, { credit: 'bad' }],
    ['negative credit', null, { credit: { ...fundedCredit, balanceUsd: -1 } }],
    ['zero credit', null, { credit: { ...fundedCredit, balanceUsd: 0 } }],
    ['monthly cap exhausted', null, { credit: { ...fundedCredit, monthlyLimitUsd: 5 } }],
    ['stale plan CAS', null, { updatedAt: '2030-09-02T10:11:00Z' }],
    ['manual plan pause', f => f.query("update ve_contact_supply_plans set status='paused' where id=$1", [plan.id])],
    ['approved but unlaunched plan', f => f.query("update ve_contact_supply_plans set status='approved' where id=$1", [plan.id])],
    ['missing launch item', f => f.query('update ve_contact_supply_plans set item_id=null where id=$1', [plan.id])],
    ['cancelled launch', f => f.query("update ve_launch_queue_items set status='cancelled' where id=$1", [itemId])],
    ['paused campaign', f => f.query("update ve_launch_queue_campaigns set remote_status=2 where item_id=$1", [itemId])],
    ['stale campaign', f => f.query("update ve_launch_queue_campaigns set status_observed_at='2030-09-02T10:00:00Z' where item_id=$1", [itemId])],
    ...['paused_at', 'cancelled_at'].map(field => [`specialist ${field} on original preview`, f => f.query(
      `insert into ve_outreach_preparations(project_id,hypothesis_id,base_id,${field}) values($1,$2,$3,$4)`,
      [id.ve, id.hypothesis, id.base, resumedAt])]),
    ['failed shared child', f => f.query("update base_constructor_jobs set status='failed' where id=$1", [f.info.construct.bc_job_id])],
    ['missing shared child', f => f.query('delete from base_constructor_jobs where id=$1', [f.info.construct.bc_job_id])],
    ['failed source child', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks,0,status}','"failed"') where id=$1`, [f.baseId])],
    ['dispatched source child', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks,0,status}','"dispatched"') where id=$1`, [f.baseId])],
    ['malformed task array', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks}','{}') where id=$1`, [f.baseId])],
    ['null task array', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks}','null') where id=$1`, [f.baseId])],
    ['malformed task entry', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks}','[null]') where id=$1`, [f.baseId])],
    ['already waiting', f => f.query(`update ve_jobs set payload=payload||'{"requesty_billing_wait":{}}' where id=$1`, [f.jobId])],
    ['malformed previous recovery', f => setPreviousRecovery(f, {})],
    ['other key recovery', f => setPreviousRecovery(f, { ...previousRecovery(), key_fingerprint: 'd'.repeat(64) })],
    ['previous numeric string', f => setPreviousRecovery(f, previousRecovery({ ...fundedCredit, balanceUsd: '10' }))],
    ['unchanged previous credit', f => setPreviousRecovery(f, previousRecovery())],
    ['less current credit', f => setPreviousRecovery(f, previousRecovery({ ...fundedCredit, balanceUsd: 11 }))],
    ['mixed provider plan', f => f.query("update ve_contact_supply_plans set last_error='Requesty timeout; Serper 402 insufficient balance' where id=$1", [plan.id])],
    ['ambiguous nested provider', f => f.query("update ve_contact_supply_plans set last_error='Requesty 402: Polza insufficient balance' where id=$1", [plan.id])],
    ['4020 is not 402', f => f.query("update ve_contact_supply_plans set last_error='Requesty 4020 insufficient balance' where id=$1", [plan.id])],
    ['mixed provider base', f => f.query(`update ve_bases set error='Requesty timeout; Serper 402',
      collect_info=jsonb_set(collect_info,'{target_progress,reason}','"Requesty timeout; Serper 402"') where id=$1`, [f.baseId])],
    ['stale billing reason with current unrelated failure', f => f.query("update ve_bases set error='Directory 404' where id=$1", [f.baseId])],
    ...deniedBillingCases.map(([label, change]) => [`saved state: ${label}`, change]),
  ];
  for (const [label, change, overrides] of deniedAutomaticCases) await withBillingBatch(async (fixture) => {
    if (change) await change(fixture);
    const before = await fixture.snapshot();
    assert.equal((await observeAndResume(fixture, overrides)).resumed, false, label);
    assert.deepEqual(await fixture.snapshot(), before, `${label}: automatic refusal must be atomic`);
  });
  await withBillingBatch(async (fixture) => {
    // Underlying normal eligibility fails *after* the manual repair. The
    // wrapper's subtransaction must undo every repaired row, not only plan.
    await fixture.query("update project_periods set status='closed' where id=$1", [id.period]);
    const before = await fixture.snapshot();
    assert.deepEqual(await observeAndResume(fixture), { resumed: false, reason: 'checkpoint_not_resumable' });
    assert.deepEqual(await fixture.snapshot(), before);
  });
  await withBillingBatch(async (fixture) => {
    await fixture.query(`create function public.test_recovery_infrastructure_failure() returns trigger
      language plpgsql as $$ begin raise exception 'Infrastructure write failed'; end; $$`);
    await fixture.query(`create trigger test_recovery_infrastructure_failure before update on ve_jobs
      for each row when (new.status='pending') execute function test_recovery_infrastructure_failure()`);
    const before = await fixture.snapshot();
    await fixture.query('savepoint infrastructure_refusal');
    await assert.rejects(() => observeAndResume(fixture), /Infrastructure write failed/);
    await fixture.query('rollback to savepoint infrastructure_refusal');
    assert.deepEqual(await fixture.snapshot(), before, 'infrastructure errors propagate and roll back all repaired rows');
  });
  // Historical preview recovery has no launch/supply plan. Preserve the
  // current paid preparation rather than using explicit retry's new allowance.
  const withBillingPreview = async (run, { pipeline = true, closed = true } = {}) => db.transaction(async (tx) => {
    const query = async (sql, args = []) => (await tx.query(sql, args)).rows;
    const one = async (sql, args = []) => (await query(sql, args))[0];
    const key = Object.fromEntries(['project', 'vertical', 'hypothesis', 'base', 'job', 'child'].map(k => [k, randomUUID()]));
    const checkpoint = { completed_round: closed ? 24 : 23, processed_rows: 2025,
      seen_rows: [{ company: 'Saved source', website: 'saved.example.org' }] };
    const info = { collection_mode: 'preview', ready_target: 500,
      target_progress: { mode: 'preview', status: 'error', reason: billingError, round: 24, max_rounds: 102,
        max_candidates: 10000, candidates_processed: 2025, ready_rows: 22, ready_target: 500, first_round_candidates: 100 },
      target_checkpoint: checkpoint, tasks: [{ source: 'companies_directory', status: 'done', harvest: [{ company: 'Saved candidate' }],
        directory_cursors: { existing_lane: 700 } }, { source: 'yandex_maps', status: 'pending' }],
      construct: { bc_job_id: key.child, status: 'done' },
      relevance_reserve: { version: 1, rows: [{ company: 'Saved review', _relevance_unchecked: true }] },
      relevance_checkpoint: { version: 2, verdicts: { paid: 'preserved' } },
      cost_policy: { version: 1, website_discovery: 'existing_then_configured' },
      search_policy: { version: 1, phase: 'existing', deferred_rows: [] },
      ...(pipeline ? { preview_pipeline: { version: 1, revision: 1546, checkpoint_id: randomUUID(), batches: [],
        completed_batches: 1, job_ids: [key.child] } } : {}),
    };
    const data = Array.from({ length: 22 }, (_, i) => ({ company: `Saved ${i}`, email: `saved${i}@example.org` }));
    await query("insert into ve_projects(id,created_by,name,website_url,status) values($1,$2,'Preview test','https://example.org','researched')", [key.project, id.actor]);
    await query("insert into ve_verticals(id,project_id,name,potential_pct) values($1,$2,'Clinical',50)", [key.vertical, key.project]);
    await query("insert into ve_hypotheses(id,project_id,vertical_id,title,tier,status) values($1,$2,$3,'Dentistry',1,'accepted')", [key.hypothesis, key.project, key.vertical]);
    await query(`insert into ve_bases(id,project_id,vertical_id,hypothesis_id,source,status,collect_info,data,row_count,error,updated_at)
      values($1,$2,$3,$4,'auto','failed',$5,$6,22,$7,'2030-09-02T10:12:00Z')`, [key.base, key.project, key.vertical, key.hypothesis, info, data, billingError]);
    await query("insert into base_constructor_jobs values($1,'completed')", [key.child]);
    await query(`insert into ve_jobs(id,project_id,stage,status,payload,result,attempts,tokens_used,cost_usd,finished_at)
      values($1,$2,'base_collect','done',$3,$4,1,4567,0.0125,'2030-09-02T10:12:01Z')`, [key.job, key.project,
      { base_id: key.base, collection_mode: 'preview', hypothesis_id: key.hypothesis, vertical_id: key.vertical },
      { rows: 22, base_id: key.base, target_status: 'error', relevance_checkpoint: info.relevance_checkpoint }]);
    await query('insert into ve_outreach_setups(project_id,selected_hypothesis_ids) values($1,$2)', [key.project, [key.hypothesis]]);
    await query(`insert into ve_outreach_preparations(project_id,hypothesis_id,base_id,independent_control,last_error,updated_at)
      values($1,$2,$3,true,$4,'2030-09-02T10:12:02Z')`, [key.project, key.hypothesis, key.base, billingError]);
    const snapshot = async () => ({
      preparation: (await one('select to_jsonb(p) value from ve_outreach_preparations p where project_id=$1', [key.project])).value,
      base: (await one('select to_jsonb(b) value from ve_bases b where id=$1', [key.base])).value,
      job: (await one('select to_jsonb(j) value from ve_jobs j where id=$1', [key.job])).value,
      child: (await one('select to_jsonb(c) value from base_constructor_jobs c where id=$1', [key.child]))?.value,
      counts: await one(`select (select count(*)::int from ve_jobs) jobs,(select count(*)::int from ve_bases) bases,
        (select count(*)::int from base_constructor_jobs) children,(select count(*)::int from ve_contact_supply_batches) batches`),
    });
    const resume = async (overrides = {}) => (await one('select ve_resume_legacy_requesty_preview($1,$2,$3,$4,$5,$6,$7,$8) result',
      [key.project, key.hypothesis, key.base, overrides.updatedAt ?? (await snapshot()).preparation.updated_at,
        overrides.fingerprint ?? fingerprint, overrides.credit ?? fundedCredit,
        overrides.observedAt ?? '2030-09-02T10:14:50Z', overrides.now ?? resumedAt])).result;
    await run({ key, query, one, info, snapshot, resume });
    await tx.rollback();
  });
  for (const pipeline of [false, true]) for (const closed of [false, true]) await withBillingPreview(async f => {
    const before = await f.snapshot();
    assert.deepEqual(await f.resume(), { resumed: true, reason: 'credit_available' });
    const after = await f.snapshot();
    assert.deepEqual(after.counts, before.counts);
    assert.equal(after.preparation.status, 'collecting');
    assert.equal(after.preparation.base_id, before.preparation.base_id);
    assert.equal(after.preparation.independent_control, true);
    assert.equal(after.job.id, before.job.id);
    assert.equal(after.job.status, 'pending');
    for (const field of ['attempts', 'tokens_used', 'cost_usd', 'result']) assert.deepEqual(after.job[field], before.job[field]);
    for (const field of ['data', 'row_count', 'sample_rows', 'columns']) assert.deepEqual(after.base[field], before.base[field]);
    assert.deepEqual(after.child, before.child);
    for (const field of ['target_checkpoint','preview_pipeline','construct','tasks','search_policy','cost_policy','relevance_checkpoint','relevance_reserve']) {
      assert.deepEqual(after.base.collect_info[field], before.base.collect_info[field], field);
    }
    assert.equal(after.base.collect_info.relevance_review_requested, closed ? true : undefined);
    const expectedTarget = { ...f.info.target_progress, status: 'collecting' };
    delete expectedTarget.reason;
    assert.deepEqual(after.base.collect_info.target_progress, expectedTarget);
    assert.equal(after.base.collect_info.preview_billing_resume.max_rounds, 102);
    assert.equal(after.base.collect_info.preview_billing_resume.max_candidates, 10000);
    assert.equal(after.job.payload.requesty_billing_recovery.source, 'legacy_preview');
    assert.deepEqual(after.job.payload.requesty_billing_recovery.credit_signal, fundedCredit);
    assert.equal((await f.resume({ updatedAt: before.preparation.updated_at })).resumed, false);
    assert.deepEqual(await f.snapshot(), after);
    await f.query(`update ve_bases set status='failed',error=$2,collect_info=jsonb_set(collect_info,'{target_progress}',
      collect_info->'target_progress'||jsonb_build_object('status','error','reason',$2::text)) where id=$1`, [f.key.base, billingError]);
    await f.query("update ve_jobs set status='done' where id=$1", [f.key.job]);
    await f.query("update ve_outreach_preparations set status='error',last_error=$2 where project_id=$1", [f.key.project, billingError]);
    const repeated = await f.snapshot();
    assert.equal((await f.resume()).reason, 'awaiting_credit_change');
    assert.deepEqual(await f.snapshot(), repeated);
    assert.equal((await f.resume({ credit: { ...fundedCredit, balanceUsd: 20 } })).resumed, true);
  }, { pipeline, closed });
  for (const [name, mutate, overrides] of [
    ['zero balance', null, { credit: { ...fundedCredit, balanceUsd: 0 } }],
    ['stale probe', null, { observedAt: '2030-09-02T10:12:59Z' }],
    ['stale CAS', null, { updatedAt: '2030-09-02T10:12:01Z' }],
    ['paused', f => f.query('update ve_outreach_preparations set paused_at=$2 where project_id=$1', [f.key.project, resumedAt])],
    ['cancelled', f => f.query('update ve_outreach_preparations set cancelled_at=$2 where project_id=$1', [f.key.project, resumedAt])],
    ['deselected', async f => { await f.query('update ve_outreach_preparations set independent_control=false where project_id=$1', [f.key.project]);
      await f.query("update ve_outreach_setups set selected_hypothesis_ids='{}' where project_id=$1", [f.key.project]); }],
    ['language changed', async f => { await f.query('update ve_outreach_preparations set independent_control=false where project_id=$1', [f.key.project]);
      await f.query("update ve_outreach_setups set language='en' where project_id=$1", [f.key.project]); }],
    ['hypothesis rejected', f => f.query("update ve_hypotheses set status='rejected' where id=$1", [f.key.hypothesis])],
    ['preparation pointer changed', f => f.query('update ve_outreach_preparations set base_id=$2 where project_id=$1', [f.key.project, randomUUID()])],
    ['claimed preparation', f => f.query('update ve_outreach_preparations set locked_until=$2 where project_id=$1', [f.key.project, '2030-09-02T10:16:00Z'])],
    ['job cancelled', f => f.query("update ve_jobs set status='cancelled' where id=$1", [f.key.job])],
    ['job running', f => f.query("update ve_jobs set status='running' where id=$1", [f.key.job])],
    ['new failed job', f => f.query(`insert into ve_jobs(project_id,stage,status,payload,created_at) values($1,'base_collect','failed',$2,clock_timestamp()+interval '1 second')`,
      [f.key.project, { base_id: f.key.base }])],
    ['already launched', f => f.query(`insert into ve_outreach_runs values($1,$2,'queued',$3)`, [randomUUID(), f.key.project, { items: [{ hypothesis_id: f.key.hypothesis }] }])],
    ['approved', f => f.query('update ve_outreach_setups set approved_bases=$2 where project_id=$1', [f.key.project, { [f.key.base]: {} }])],
    ['frozen audience', f => f.query(`insert into ve_templates(base_id,vertical_id,status,letters,launch_info) values($1,$2,'ready','[]','{}')`, [f.key.base, f.key.vertical])],
    ['non Requesty', f => f.query("update ve_bases set error='Serper 402' where id=$1", [f.key.base])],
    ['unrelated job failure', f => f.query("update ve_jobs set error='Directory 404' where id=$1", [f.key.job])],
    ['malformed checkpoint', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{target_checkpoint,completed_round}','"24"') where id=$1`, [f.key.base])],
    ['missing reserve', f => f.query("update ve_bases set collect_info=collect_info-'relevance_reserve' where id=$1", [f.key.base])],
    ['failed source', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks,0,status}','"failed"') where id=$1`, [f.key.base])],
    ['pending child identity', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{tasks,1,child_job_id}',to_jsonb($2::text)) where id=$1`, [f.key.base, f.key.child])],
    ['child failed', f => f.query("update base_constructor_jobs set status='failed' where id=$1", [f.key.child])],
    ['child missing', f => f.query('delete from base_constructor_jobs where id=$1', [f.key.child])],
    ['pending pipeline', f => f.query(`update ve_bases set collect_info=jsonb_set(collect_info,'{preview_pipeline,batches}','[{"id":"pending"}]') where id=$1`, [f.key.base])],
    ['different recovery key', f => f.query(`update ve_jobs set payload=payload||jsonb_build_object('requesty_billing_recovery',$2::jsonb) where id=$1`,
      [f.key.job, { ...previousRecovery(), key_fingerprint: 'b'.repeat(64) }])],
  ]) await withBillingPreview(async f => {
    if (mutate) await mutate(f);
    const before = await f.snapshot();
    assert.equal((await f.resume(overrides)).resumed, false, name);
    assert.deepEqual(await f.snapshot(), before, name);
  });
  await withBillingPreview(async f => {
    await f.query("update ve_outreach_setups set selected_hypothesis_ids='{}' where project_id=$1", [f.key.project]);
    assert.equal((await f.resume()).resumed, true, 'independent control survives checkbox deselection');
  });
  await withBillingPreview(async f => {
    await f.query('update ve_outreach_preparations set independent_control=false where project_id=$1', [f.key.project]);
    assert.equal((await f.resume()).resumed, true, 'still-selected legacy control resumes');
  });
  await withBillingPreview(async f => {
    await f.query(`create function test_preview_failure() returns trigger language plpgsql as $$ begin raise exception 'Preview write failed'; end; $$`);
    await f.query(`create trigger test_preview_failure before update on ve_outreach_preparations for each row execute function test_preview_failure()`);
    const before = await f.snapshot();
    await f.query('savepoint preview_failure');
    await assert.rejects(() => f.resume(), /Preview write failed/);
    await f.query('rollback to savepoint preview_failure');
    assert.deepEqual(await f.snapshot(), before, 'late write failure rolls back job and base too');
  });
  // NAFI: a saved constructor batch survived, but the parent's self-requeue
  // failed at the DB gateway. Recover only that same checkpoint and allowance.
  const queueError = 've_jobs requeue: An invalid response was received from the upstream server';
  const withQueueFailure = run => withBillingPreview(async f => {
    await f.query(`update ve_jobs set status='failed',error=$2,attempts=3 where id=$1`, [f.key.job, queueError]);
    const info = { ...f.info, target_progress: { ...f.info.target_progress, reason: queueError },
      tasks: f.info.tasks.map(task => ({ ...task, status: 'done' })),
      construct: { bc_job_id: f.key.child, status: 'dispatched' },
      preview_pipeline: { ...f.info.preview_pipeline, batches: [{ id: f.key.child, inserted: true,
        rows: [{ company: 'Already paid', website: 'saved.example.org' }] }] } };
    await f.query('update ve_bases set error=$2,collect_info=$3 where id=$1', [f.key.base, queueError, info]);
    await f.query('update ve_outreach_preparations set last_error=$2 where base_id=$1', [f.key.base, queueError]);
    const recover = async () => (await f.one('select ve_auto_resume_queue_persistence_failures(10,$1) result', ['2030-09-02T11:00:00Z'])).result;
    await run({ ...f, recover });
  }, { pipeline: true, closed: false });
  await withQueueFailure(async f => {
    const before = await f.snapshot();
    assert.equal(await f.recover(), 1);
    const after = await f.snapshot();
    assert.equal(after.base.status, 'collecting');
    assert.equal(after.preparation.status, 'collecting');
    assert.equal(after.job.status, 'pending');
    assert.equal(after.job.attempts, 3, 'original attempt allowance is not reset');
    for (const field of ['data', 'row_count', 'sample_rows', 'columns']) assert.deepEqual(after.base[field], before.base[field]);
    const expectedInfo = structuredClone(before.base.collect_info);
    expectedInfo.target_progress.status = 'collecting'; delete expectedInfo.target_progress.reason;
    assert.deepEqual(after.base.collect_info, expectedInfo, 'all source, child, paid result and budget checkpoints are unchanged');
    for (const field of ['result', 'tokens_used', 'cost_usd']) assert.deepEqual(after.job[field], before.job[field]);
    assert.deepEqual(after.child, before.child);
    assert.deepEqual(after.counts, before.counts, 'no replacement job/base/child');
    assert.equal(after.job.payload.queue_persistence_recovery.count, 1);
    assert.equal(await f.recover(), 0, 'an already recovered job is not enqueued twice');
    assert.deepEqual(await f.snapshot(), after);
  });
  for (const [name, mutate] of [
    ['paused', f => f.query("update ve_outreach_preparations set paused_at=now() where base_id=$1", [f.key.base])],
    ['cancelled', f => f.query("update ve_outreach_preparations set cancelled_at=now() where base_id=$1", [f.key.base])],
    ['new owner', f => f.query("update ve_jobs set status='running' where id=$1", [f.key.job])],
    ['newer job', f => f.query(`insert into ve_jobs(project_id,stage,status,payload,created_at) values($1,'base_collect','cancelled',$2,'2100-01-01')`,
      [f.key.project, { base_id: f.key.base, hypothesis_id: f.key.hypothesis }])],
    ['changed preparation', f => f.query('update ve_outreach_preparations set base_id=null where base_id=$1', [f.key.base])],
    ['unselected legacy preparation', async f => {
      await f.query('update ve_outreach_preparations set independent_control=false where base_id=$1', [f.key.base]);
      await f.query("update ve_outreach_setups set selected_hypothesis_ids='{}' where project_id=$1", [f.key.project]);
    }],
    ['approved audience', f => f.query('update ve_outreach_setups set approved_bases=$2 where project_id=$1', [f.key.project, { [f.key.base]: {} }])],
    ['missing checkpoint', f => f.query("update ve_bases set collect_info=collect_info-'target_checkpoint' where id=$1", [f.key.base])],
    ['wrong saved round', f => f.query("update ve_bases set collect_info=jsonb_set(collect_info,'{target_checkpoint,completed_round}','24') where id=$1", [f.key.base])],
    ['unfinished child', f => f.query("update base_constructor_jobs set status='processing' where id=$1", [f.key.child])],
    ['billing wait', f => f.query(`update ve_jobs set payload=payload||'{"requesty_billing_wait":{"version":1}}' where id=$1`, [f.key.job])],
    ['billing error', async f => {
      await f.query('update ve_jobs set error=$2 where id=$1', [f.key.job, billingError]);
      await f.query('update ve_bases set error=$2 where id=$1', [f.key.base, billingError]);
      await f.query('update ve_outreach_preparations set last_error=$2 where base_id=$1', [f.key.base, billingError]);
    }],
    ['recovery cap', f => f.query(`update ve_jobs set payload=payload||'{"queue_persistence_recovery":{"version":1,"count":3}}' where id=$1`, [f.key.job])],
  ]) await withQueueFailure(async f => {
    await mutate(f); const before = await f.snapshot();
    assert.equal(await f.recover(), 0, name);
    assert.deepEqual(await f.snapshot(), before, name);
  });
  await withQueueFailure(async f => {
    await f.query('set local role service_role');
    assert.equal(await f.recover(), 1, 'worker role can execute recovery');
    await f.query('reset role');
  });
  await withQueueFailure(async f => {
    // A page full of obsolete preparations must not starve a newer eligible
    // checkpoint. They fail before any retained JSON checkpoint is loaded.
    for (let index = 0; index < 11; index += 1) {
      const hypothesis = randomUUID();
      await f.query(`insert into ve_hypotheses(id,project_id,vertical_id,title,tier,status)
        values($1,$2,$3,'Obsolete preparation',1,'accepted')`, [hypothesis, f.key.project, f.key.vertical]);
      await f.query(`insert into ve_outreach_preparations(project_id,hypothesis_id,template_id,independent_control,last_error,updated_at)
        values($1,$2,$3,true,$4,'2030-09-02T09:00:00Z')`, [f.key.project, hypothesis, id.template, queueError]);
    }
    assert.equal((await f.one('select ve_auto_resume_queue_persistence_failures(1,$1) result', ['2030-09-02T11:00:00Z'])).result, 1);
    assert.equal((await f.one('select status from ve_jobs where id=$1', [f.key.job])).status, 'pending');
    assert.equal((await f.one("select count(*)::int n from ve_outreach_preparations where project_id=$1 and status='error'", [f.key.project])).n, 11);
  });
  assert.equal(await scalar('select ve_transient_collect_error($1) result', [queueError]), false);
  assert.equal(await scalar("select ve_transient_collect_error('ve_jobs requeue: fetch failed') result"), false);
  assert.equal(await scalar("select ve_transient_collect_error('Requesty 503: unavailable') result"), true);
  // Execute the real preparation claim/save functions. The former OR predicate
  // evaluated a large base JSON recovery query even for unrelated history.
  const withPreparationQueue = run => db.transaction(async tx => {
    const query = async (sql, args = []) => (await tx.query(sql, args)).rows;
    const one = async (sql, args = []) => (await query(sql, args))[0];
    const project = randomUUID(), vertical = randomUUID();
    await query(`insert into ve_projects(id,created_by,name,website_url,status)
      values($1,$2,'Preparation queue','https://example.org','researched')`, [project, id.actor]);
    await query("insert into ve_verticals(id,project_id,name,potential_pct) values($1,$2,'Test',50)", [vertical, project]);
    await query('insert into ve_outreach_setups(project_id) values($1)', [project]);
    const add = async (status, options = {}) => {
      const hypothesis = randomUUID(), base = options.completed ? randomUUID() : null;
      await query(`insert into ve_hypotheses(id,project_id,vertical_id,title,tier,status)
        values($1,$2,$3,'Saved hypothesis',1,'accepted')`, [hypothesis, project, vertical]);
      if (options.selected !== false) await query(`update ve_outreach_setups
        set selected_hypothesis_ids=array_append(selected_hypothesis_ids,$2) where project_id=$1`, [project, hypothesis]);
      if (base) {
        await query(`insert into ve_bases(id,project_id,vertical_id,hypothesis_id,source,status,collect_info,data,row_count,analysis)
          values($1,$2,$3,$4,'auto','analyzed',$5,$6,1,'{"summary":"Paid analysis preserved"}')`,
        [base, project, vertical, hypothesis,
          { collection_mode: 'preview', ready_target: 500, target_progress: { status: 'limited', ready_rows: 1,
            round: 100, max_rounds: 100, candidates_processed: 10000, max_candidates: 10000 },
          target_checkpoint: { completed_round: 100, seen_rows: [{ company: 'Saved company' }] } },
          [{ company: 'Saved company', email: 'saved@example.org', _email_status: 'ok' }]]);
        for (const stage of ['base_collect', 'base_analyze']) await query(`insert into ve_jobs(project_id,stage,status,payload,result,
          attempts,tokens_used,cost_usd,created_at,finished_at) values($1,$2,'done',$3,'{"saved":"paid result"}',3,1234,0.01,
            '2000-01-01','2001-01-01')`, [project, stage, { base_id: base, hypothesis_id: hypothesis }]);
      }
      await query(`insert into ve_outreach_preparations(project_id,hypothesis_id,base_id,status,last_error,
        independent_control,language,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [project, hypothesis, base, status, options.error ?? null, options.independent ?? false,
        options.language ?? 'ru', options.updatedAt ?? '2001-01-01']);
      return { project, hypothesis, base };
    };
    const claim = () => query('select * from ve_claim_outreach_preparation()');
    const paidSnapshot = async () => ({
      bases: await query('select to_jsonb(b) value from ve_bases b where project_id=$1 order by id', [project]),
      jobs: await query('select to_jsonb(j) value from ve_jobs j where project_id=$1 order by id', [project]),
    });
    const save = async (key, token) => (await one(`select ve_save_outreach_preparation($1,$2,$3,'collecting',$4,null,null,false) result`,
      [project, key.hypothesis, token, key.base])).result;
    await run({ query, one, add, claim, paidSnapshot, save, project });
    await tx.rollback();
  });
  await withPreparationQueue(async f => {
    for (let index = 0; index < 64; index += 1) {
      await f.add('ready', { completed: true, updatedAt: '1999-01-01' });
      await f.add('error', { completed: true, error: 'Requesty 402: insufficient balance', updatedAt: '1999-01-01' });
    }
    await f.add('error', { error: 'База ещё не готова к выбранной стадии', updatedAt: '1999-06-01' });
    const live = await f.add('collecting', { updatedAt: '2000-01-01' });
    const generating = await f.add('generating', { updatedAt: '2000-06-01' });
    const pending = await f.add('pending', { updatedAt: '2001-01-01' });
    await f.query(`create or replace function public.ve_completed_preparation_recoverable(p_project_id uuid,p_hypothesis_id uuid)
      returns boolean language plpgsql stable security definer set search_path='' as $$
      begin raise exception 'SMOKE_HEAVY_RECOVERY_MUST_NOT_RUN'; end $$;`);
    // The regression fixture actually fails the previous production query.
    await f.query('savepoint previous_claim');
    await f.query(preparationFunction('ve_claim_outreach_preparation'));
    await assert.rejects(f.claim, /SMOKE_HEAVY_RECOVERY_MUST_NOT_RUN/);
    await f.query('rollback to savepoint previous_claim');
    const before = await f.paidSnapshot();
    await f.query('set local role service_role');
    const first = (await f.claim())[0];
    await f.query('reset role');
    assert.equal(first.hypothesis_id, live.hypothesis, 'oldest live preparation remains first');
    assert.equal(first.status, 'collecting');
    assert.ok(first.claim_token);
    assert.ok(Date.parse(first.locked_until) > Date.now());
    const second = (await f.claim())[0];
    assert.equal(second.hypothesis_id, generating.hypothesis);
    assert.equal(second.status, 'generating');
    assert.equal((await f.claim())[0].hypothesis_id, pending.hypothesis, 'new work is not starved by terminal rows');
    assert.deepEqual(await f.claim(), [], 'leased preparations cannot be claimed twice; terminal history never calls heavy recovery');
    assert.deepEqual(await f.paidSnapshot(), before, 'claim does not enqueue jobs or mutate paid bases');
    await f.query("update ve_outreach_preparations set locked_until=now()-interval '1 second' where hypothesis_id=$1", [live.hypothesis]);
    const renewed = (await f.claim())[0];
    assert.equal(renewed.hypothesis_id, live.hypothesis);
    assert.notEqual(renewed.claim_token, first.claim_token);
    assert.equal(await f.save(live, first.claim_token), false, 'an expired owner cannot save after a new claim');
    assert.equal(await f.save(live, renewed.claim_token), true);
    await f.query('update ve_outreach_preparations set paused_at=clock_timestamp() where hypothesis_id=$1', [live.hypothesis]);
    assert.equal(await f.save(live, renewed.claim_token), false, 'pause wins even over the current claim');
    assert.deepEqual(await f.paidSnapshot(), before);
  });
  const coordinatorError = 'База ещё не готова к выбранной стадии';
  await withPreparationQueue(async f => {
    for (let index = 0; index < 64; index += 1) await f.add('error', {
      completed: true, error: 'Requesty 402: insufficient balance', updatedAt: '1999-01-01' });
    for (let index = 0; index < 64; index += 1) {
      const unfinished = await f.add('error', { completed: true, error: coordinatorError, updatedAt: '1999-02-01' });
      await f.query("delete from ve_jobs where project_id=$1 and payload->>'base_id'=$2 and stage='base_analyze'", [f.project, unfinished.base]);
    }
    const completed = await f.add('error', { completed: true, error: coordinatorError, updatedAt: '2000-01-01' });
    const pending = await f.add('pending', { updatedAt: '2001-01-01' });
    const before = await f.paidSnapshot();
    const recovered = (await f.claim())[0];
    assert.equal(recovered.hypothesis_id, completed.hypothesis, 'LIMIT follows the full predicate: 64 plausible but unfinished histories cannot starve completed recovery');
    assert.equal(recovered.base_id, completed.base);
    assert.equal(recovered.status, 'collecting', 'recovery advances to letters without granting a fresh collection');
    assert.equal(recovered.last_error, null);
    assert.equal((await f.claim())[0].hypothesis_id, pending.hypothesis);
    assert.deepEqual(await f.claim(), []);
    assert.deepEqual(await f.paidSnapshot(), before, 'saved rows, checkpoints, caps, job count and paid results stay unchanged');
  });
  const claimGuards = [
    ['paused', f => f.query('update ve_outreach_preparations set paused_at=clock_timestamp() where project_id=$1', [f.project])],
    ['cancelled', f => f.query('update ve_outreach_preparations set cancelled_at=clock_timestamp() where project_id=$1', [f.project])],
    ['active lease', f => f.query("update ve_outreach_preparations set locked_until=clock_timestamp()+interval '1 hour',claim_token=gen_random_uuid() where project_id=$1", [f.project])],
    ['unselected', f => f.query("update ve_outreach_setups set selected_hypothesis_ids='{}' where project_id=$1", [f.project])],
    ['changed language', f => f.query("update ve_outreach_setups set language='en' where project_id=$1", [f.project])],
  ];
  for (const status of ['pending', 'error']) for (const [name, mutate] of claimGuards) await withPreparationQueue(async f => {
    await f.add(status, { completed: status === 'error', error: status === 'error' ? coordinatorError : undefined });
    await mutate(f);
    const before = await f.paidSnapshot();
    const prepBefore = await f.query('select to_jsonb(p) value from ve_outreach_preparations p where project_id=$1', [f.project]);
    assert.deepEqual(await f.claim(), [], `${status}: ${name}`);
    assert.deepEqual(await f.paidSnapshot(), before, `${status}: ${name}`);
    assert.deepEqual(await f.query('select to_jsonb(p) value from ve_outreach_preparations p where project_id=$1', [f.project]), prepBefore);
  });
  for (const status of ['pending', 'error']) await withPreparationQueue(async f => {
    const independent = await f.add(status, { independent: true, selected: false, language: 'en',
      completed: status === 'error', error: status === 'error' ? coordinatorError : undefined });
    assert.equal((await f.claim())[0].hypothesis_id, independent.hypothesis, 'explicit independent control survives selection changes');
  });
  for (const [name, mutate] of [
    ['approved', (f, key) => f.query('update ve_outreach_setups set approved_bases=$2 where project_id=$1', [f.project, { [key.base]: {} }])],
    ['launched', (f, key) => f.query(`insert into ve_templates(base_id,vertical_id,status,letters,launch_info)
      select id,vertical_id,'ready','[]','{"campaigns":[]}' from ve_bases where id=$1`, [key.base])],
    ['failed paid stage', (f, key) => f.query("update ve_jobs set status='failed' where project_id=$1 and payload->>'base_id'=$2 and stage='base_collect'", [f.project, key.base])],
    ['active paid stage', (f, key) => f.query("update ve_jobs set status='running' where project_id=$1 and payload->>'base_id'=$2 and stage='base_collect'", [f.project, key.base])],
  ]) await withPreparationQueue(async f => {
    const key = await f.add('error', { completed: true, error: coordinatorError });
    await mutate(f, key);
    const before = await f.paidSnapshot();
    assert.deepEqual(await f.claim(), [], `completed recovery: ${name}`);
    assert.deepEqual(await f.paidSnapshot(), before, name);
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
  await db.exec('set role authenticated');
  await fails(() => scalar('select ve_resume_legacy_requesty_supply($1,$2,$3,$4,$5,$6) result',
    [plan.id, now, fingerprint, fundedCredit, now, now]), /permission denied/i);
  await fails(() => scalar('select ve_resume_legacy_requesty_preview($1,$2,$3,$4,$5,$6,$7,$8) result',
    [id.ve,id.hypothesis,id.base,now,fingerprint,fundedCredit,now,now]), /permission denied/i);
  await fails(() => scalar('select ve_auto_resume_queue_persistence_failures(10,$1) result', [now]), /permission denied/i);
  await fails(() => rows('select * from ve_claim_outreach_preparation()'), /permission denied/i);
  await fails(() => scalar('select ve_completed_preparation_recoverable($1,$2) result', [id.ve, id.hypothesis]), /permission denied/i);
  await db.exec('reset role');

  // The operator uses the same PostgreSQL connection for the entire transaction.
  // Execute its actual TS implementation against local PostgreSQL; no HTTP/model
  // mock can conceal a partial write or a second enqueue here.
  geographyBundleDir = mkdtempSync(resolve(tmpdir(), 've-geography-apply-'));
  const geographyBundle = resolve(geographyBundleDir, 'apply.cjs');
  await build({ stdin: { contents: `export * from './src/lib/verticalEngineV2/collectionGeographyRepairApply';
    export {veGeographyRepairHash} from './src/lib/verticalEngineV2/collectionGeographyRepair';`,
    resolveDir: resolve(root, 'app'), loader: 'ts' }, outfile: geographyBundle, bundle: true,
    platform: 'node', format: 'cjs', conditions: ['react-server'], logLevel: 'silent', tsconfig: resolve(root, 'app/tsconfig.json') });
  const { applyVeCollectionGeographyRepair: repair, veGeographyRepairHash: repairHash } = createRequire(import.meta.url)(geographyBundle);
  await db.exec(`alter table ve_outreach_setups add column if not exists revision bigint not null default 1;
    alter table ve_outreach_preparations add column if not exists resume_collection_requested boolean not null default false;
    alter table ve_bases add column if not exists max_emails_per_company integer;
    alter table base_constructor_jobs add column completed_at timestamptz, add column created_at timestamptz default now();
    create table ve_preparation_children(kind text, child_id uuid, project_id uuid, base_id uuid);`);
  const geographyFixture = async () => {
    const key = Object.fromEntries(['project', 'vertical', 'hypothesis', 'base', 'job', 'child', 'template', 'otherHypothesis', 'otherBase']
      .map(name => [name, randomUUID()]));
    const data = [0, 1, 2].map(i => ({ company: `Reviewed ${i}`, email: `reviewed${i}@example.test`,
      address: i === 1 ? 'Казань' : 'Москва', _email_status: 'ok',
      _ve_relevance: { status: 'relevant', context_hash: 'saved-paid-context' },
      _ve_company_name: { version: 1, source: `Reviewed ${i}`, website: '', status: 'ready', value: `Reviewed ${i}` } }));
    const info = { collection_mode: 'preview', ready_target: 500, limit: 100,
      target_progress: { mode: 'preview', ready_target: 500, ready_rows: 3, round: 88, max_rounds: 100,
        candidates_processed: 6806, max_candidates: 10000, status: 'limited' },
      target_checkpoint: { completed_round: 88, seen_rows: data },
      preview_pipeline: { version: 1, revision: 8, batches: [], completed_batches: 88, job_ids: [key.child] },
      relevance_reserve: { version: 1, rows: [data[1]] },
      tasks: [{ source: 'companies_directory', status: 'done', child_job_id: null, rows: 300,
        task: { source: 'companies_directory', rationale: 'Saved source', directory_filters: { okvedCodes: ['10'] } },
        directory_cursors: { existing: 2000 }, harvest: data }] };
    await rows(`insert into ve_projects(id,created_by,name,website_url,status)
      values($1,$2,'Geography repair','https://example.test','researched')`, [key.project, id.actor]);
    await rows("insert into ve_verticals(id,project_id,name,potential_pct) values($1,$2,'Food',50)", [key.vertical, key.project]);
    for (const hypothesis of [key.hypothesis, key.otherHypothesis]) await rows(`insert into ve_hypotheses(id,project_id,vertical_id,title,tier,status)
      values($1,$2,$3,'Reviewed audience',1,'accepted')`, [hypothesis, key.project, key.vertical]);
    await rows('insert into ve_outreach_setups(project_id,selected_hypothesis_ids,revision) values($1,$2,18)',
      [key.project, [key.hypothesis, key.otherHypothesis]]);
    for (const [base, hypothesis] of [[key.base, key.hypothesis], [key.otherBase, key.otherHypothesis]]) {
      await rows(`insert into ve_bases(id,project_id,vertical_id,hypothesis_id,source,status,collect_info,data,row_count,analysis,columns,sample_rows)
        values($1,$2,$3,$4,'auto','analyzed',$5,$6,3,'{"saved":"paid analysis"}','["company","email","address"]',$6)`,
      [base, key.project, key.vertical, hypothesis, info, data]);
      await rows(`insert into ve_outreach_preparations(project_id,hypothesis_id,base_id,status,pause_state)
        values($1,$2,$3,'ready','{"saved":"preparation"}')`, [key.project, hypothesis, base]);
    }
    await rows(`insert into ve_templates(id,base_id,vertical_id,status,letters) values($1,$2,$3,'ready','[{"subject":"Saved","body":"Paid letters"}]')`,
      [key.template, key.base, key.vertical]);
    await rows(`insert into ve_jobs(id,project_id,stage,status,payload,result,attempts,tokens_used,cost_usd)
      values($1,$2,'base_collect','done',$3,'{"relevance_checkpoint":{"verdicts":{"saved":"paid"}}}',3,1234,0.01)`,
      [key.job, key.project, { base_id: key.base, hypothesis_id: key.hypothesis }]);
    await rows("insert into base_constructor_jobs(id,status,completed_at) values($1,'completed',now())", [key.child]);
    await rows("insert into ve_preparation_children values('base_constructor_jobs',$1,$2,$3)", [key.child, key.project, key.base]);
    const artifact = { version: 1, project_id: key.project, hypothesis_id: key.hypothesis, base_id: key.base, setup_revision: 18,
      request: { repair_id: `review-${key.base}`, required: { version: 1, required: 'Москва и МО' },
        reviewed_data_hash: repairHash(data), ready_row_indices: [0, 2], prepared_at: '2030-09-02T12:00:00Z' } };
    const snapshot = async () => ({
      bases: await rows('select to_jsonb(b) value from ve_bases b where project_id=$1 order by id', [key.project]),
      prep: await rows('select to_jsonb(p) value from ve_outreach_preparations p where project_id=$1 order by hypothesis_id', [key.project]),
      jobs: await rows('select to_jsonb(j) value from ve_jobs j where project_id=$1 order by id', [key.project]),
      templates: await rows('select to_jsonb(t) value from ve_templates t where base_id=$1 order by id', [key.base]),
    });
    return { key, artifact, data, info, snapshot };
  };
  const geo = await geographyFixture(), geoBefore = await geo.snapshot();
  const dry = await repair(db, geo.artifact);
  assert.equal(dry.status, 'dry_run'); assert.equal(dry.persistent_writes, false);
  assert.equal(dry.ready_before, 3); assert.equal(dry.ready_after, 2); assert.equal(dry.held_rows, 1);
  assert.deepEqual(await geo.snapshot(), geoBefore, 'dry-run writes nothing, including timestamps');
  await assert.rejects(() => repair(db, geo.artifact, { apply: true }), /reviewed dry-run artifact/);
  await rows('update ve_templates set letters=$2 where id=$1', [geo.key.template, [{ subject: 'Edited', body: 'A specialist edited this' }]]);
  const editedBefore = await geo.snapshot();
  await assert.rejects(() => repair(db, dry.artifact, { apply: true, continueCollection: true }), /changed since dry-run/);
  assert.deepEqual(await geo.snapshot(), editedBefore, 'concurrent template edit rejects the stale artifact');
  const fresh = await repair(db, geo.artifact);
  const failAfterBase = { query: async (sql, args) => {
    if (/insert into public\.ve_jobs/i.test(sql)) throw new Error('Injected late enqueue failure');
    return db.query(sql, args);
  } };
  await assert.rejects(() => repair(failAfterBase, fresh.artifact, { apply: true, continueCollection: true }), /Injected late enqueue failure/);
  assert.deepEqual(await geo.snapshot(), editedBefore, 'late enqueue failure rolls back base and preparation together');
  const applied = await repair(db, fresh.artifact, { apply: true, continueCollection: true });
  assert.equal(applied.status, 'applied'); assert.equal(applied.persistent_writes, true);
  const geoAfter = await geo.snapshot(), repairedBase = geoAfter.bases.find(r => r.value.id === geo.key.base).value;
  assert.deepEqual(repairedBase.data, [geo.data[0], geo.data[2]]);
  assert.equal(repairedBase.status, 'collecting'); assert.equal(repairedBase.analysis, null, 'old paid analysis is archived, not displayed for a changed audience');
  assert.deepEqual(repairedBase.collect_info.geography_repair.previous_analysis, { saved: 'paid analysis' });
  assert.deepEqual(repairedBase.collect_info.geography_repair.held_ready_rows, [geo.data[1]]);
  assert.deepEqual(repairedBase.collect_info.target_checkpoint, geo.info.target_checkpoint);
  assert.equal(repairedBase.collect_info.target_progress.max_candidates, 10000);
  assert.equal(repairedBase.collect_info.target_progress.candidates_processed, 6806);
  assert.equal(repairedBase.collect_info.target_progress.max_rounds, 100);
  assert.equal(repairedBase.collect_info.target_progress.round, 89);
  assert.equal(geoAfter.jobs.length, 2, 'only one new bounded parent');
  assert.deepEqual(geoAfter.jobs.find(r => r.value.id === geo.key.job), geoBefore.jobs[0], 'terminal result and cost stay byte-for-byte unchanged');
  assert.deepEqual(geoAfter.templates, editedBefore.templates, 'letters remain unchanged');
  assert.deepEqual(geoAfter.bases.find(r => r.value.id === geo.key.otherBase), geoBefore.bases.find(r => r.value.id === geo.key.otherBase));
  assert.deepEqual(geoAfter.prep.find(r => r.value.base_id === geo.key.otherBase), geoBefore.prep.find(r => r.value.base_id === geo.key.otherBase));
  const newJob = geoAfter.jobs.find(r => r.value.id === applied.job_id).value;
  assert.equal(newJob.payload.base_id, geo.key.base); assert.equal(newJob.status, 'pending');
  assert.equal(newJob.payload.geography_repair_id, geo.artifact.request.repair_id);
  // An operator retry after a worker has added contacts must resolve the same
  // receipt; applying original row indices again would corrupt new results.
  await rows("update ve_bases set data=data||$2::jsonb,row_count=row_count+1 where id=$1", [geo.key.base, [{ email: 'new-after-repair@example.test' }]]);
  const afterGrowth = await geo.snapshot();
  const repeated = await repair(db, fresh.artifact, { apply: true, continueCollection: true });
  assert.equal(repeated.status, 'already_applied'); assert.equal(repeated.job_id, applied.job_id);
  assert.deepEqual(await geo.snapshot(), afterGrowth, 'retry neither reprojects nor enqueues twice after growth');
  for (const [name, mutate, reason] of [
    ['paused', f => rows('update ve_outreach_preparations set paused_at=now() where base_id=$1', [f.key.base]), 'paused_preparation_requires_separate_review'],
    ['cancelled', f => rows('update ve_outreach_preparations set cancelled_at=now() where base_id=$1', [f.key.base]), 'paused_preparation_requires_separate_review'],
    ['approved', f => rows('update ve_outreach_setups set approved_bases=$2 where project_id=$1', [f.key.project, { [f.key.base]: {} }]), 'approved_or_launched'],
    ['frozen', f => rows("update ve_templates set launch_info='{}' where id=$1", [f.key.template]), 'approved_or_launched'],
    ['accepted launch', f => rows('insert into ve_outreach_runs values($1,$2,\'queued\',$3)', [randomUUID(), f.key.project, { items: [{ base_id: f.key.base }] }]), 'approved_or_launched'],
    ['active parent', f => rows("update ve_jobs set status='running' where id=$1", [f.key.job]), 'active_parent_job'],
    ['active child', f => rows("update base_constructor_jobs set status='processing' where id=$1", [f.key.child]), 'active_child_job'],
    ['lease', f => rows('update ve_outreach_preparations set claim_token=gen_random_uuid(),locked_until=now() where base_id=$1', [f.key.base]), 'coordinator_lease_not_released'],
    ['deselected', f => rows("update ve_outreach_setups set selected_hypothesis_ids='{}' where project_id=$1", [f.key.project]), 'not_selected'],
  ]) {
    const f = await geographyFixture(), reviewed = await repair(db, f.artifact);
    await mutate(f); const before = await f.snapshot();
    const blocked = await repair(db, reviewed.artifact, { apply: true, continueCollection: true });
    assert.equal(blocked.status, 'blocked', name); assert.ok(blocked.reasons.includes(reason), `${name}: ${blocked.reasons}`);
    assert.deepEqual(await f.snapshot(), before, name);
  }
  const staleGeo = await geographyFixture(), staleReviewed = await repair(db, staleGeo.artifact);
  await rows('update ve_outreach_setups set revision=19 where project_id=$1', [staleGeo.key.project]);
  const staleBefore = await staleGeo.snapshot();
  await assert.rejects(() => repair(db, staleReviewed.artifact, { apply: true }), /setup or base binding changed/);
  assert.deepEqual(await staleGeo.snapshot(), staleBefore);
  console.log('PASS geography repair: read-only projection, stale CAS/template guards, pause/launch/worker guards, atomic rollback, bounded single enqueue and replay after growth.');
  console.log('PASS continuous supply: approval, atomic enqueue/append/replay, campaign reuse, pause/stale rules, empty-day retry, saved billing-batch resume, automatic credit recovery/rollback, and preparation claims without heavy checks of unrelated history.');
} catch (error) {
  console.error(error.message, error.where || '', error.stack?.split('\n').slice(1, 3).join('\n') || '');
  process.exitCode = 1;
} finally {
  await db.close();
  if (geographyBundleDir) rmSync(geographyBundleDir, { recursive: true, force: true });
}
