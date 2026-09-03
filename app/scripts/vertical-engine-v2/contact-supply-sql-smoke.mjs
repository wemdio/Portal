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
  await db.exec(migration('20260902_0001_vertical_engine_v2_contact_delivery.sql'));
  if (!process.env.SUPPLY_SMOKE_BASELINE) {
    await db.exec(migration('20260903_0001_vertical_engine_v2_contact_supply.sql'));
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
  await rows("update ve_templates set letters='[{\"body\":\"Changed\"}]' where id=$1", [id.template]);
  assert.equal(await scalar('select ve_contact_supply_approval_current($1) result', [plan.id]), false);
  await fails(() => scalar('select ve_reserve_contact_delivery_day($1,$2,0) result', [id.ve, now]), /approval is stale/);
  await fails(() => scalar("select ve_reserve_contact_delivery_activation($1,'campaign',$2,3,$3,$3) result", [itemId, randomUUID(), now]), /approval is stale/);
  await fails(() => scalar("select ve_mark_contact_delivery_attempt($1,$2,'campaign',$3) result", [randomUUID(), randomUUID(), [savedRows[0].id]]), /approval is stale/);
  await db.exec('set role service_role');
  await fails(() => rows('delete from ve_contact_supply_plans'), /permission denied/i);
  await fails(() => scalar('select ve_reserve_contact_delivery_day_before_supply($1,$2,0) result', [id.ve, now]), /permission denied/i);
  await db.exec('reset role');
  console.log('PASS continuous supply: approval, source identity, atomic enqueue/append/replay, campaign reuse, pause/stale rules, empty-day retry, and completed-slot hold.');
} catch (error) {
  console.error(error.message, error.where || '', error.stack?.split('\n').slice(1, 3).join('\n') || '');
  process.exitCode = 1;
} finally {
  await db.close();
}
