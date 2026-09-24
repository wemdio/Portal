/** Executable PostgreSQL smoke for VE2 contact delivery on a Portal project
 * without periods (migrations 20260924_0010, 20260924_0011); never connects to Portal/prod.
 *
 * Run from app/: node scripts/vertical-engine-v2/contact-delivery-without-period-sql-smoke.mjs
 * Supply PGLITE_MODULE when @electric-sql/pglite is installed outside this repo.
 * projects.deadline/launch_date are text here, as in production.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const migration = (name) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
let failures = 0;
const check = (ok, name, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
};
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
let inTransaction = false;
const begin = async () => { await db.exec('begin'); inTransaction = true; };
const commit = async () => { await db.exec('commit'); inTransaction = false; };
const expectError = async (name, sql, args, pattern) => {
  await db.exec(inTransaction ? 'savepoint expect_error' : 'begin');
  try {
    await db.query(sql, args);
    check(false, name, 'no error');
  } catch (error) {
    check(pattern.test(error.message), name, error.message);
  } finally {
    await db.exec(inTransaction ? 'rollback to savepoint expect_error' : 'rollback');
  }
};
const inRollback = async (run) => {
  await db.exec('savepoint scenario');
  try { await run(); } finally { await db.exec('rollback to savepoint scenario'); }
};

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role readonly;
    create table public.projects(id uuid primary key, client text, name text, status text,
      deadline text, launch_date text, contacts_obligation text, contacts_done text);
    create table public.project_periods(id uuid primary key default gen_random_uuid(),
      project_id uuid not null references public.projects on delete cascade, name text,
      status text not null default 'active', deadline date, contacts_done text);
  `);
  for (const name of [
    '20260820_0001_vertical_engine_v2_foundation.sql',
    '20260821_0001_vertical_engine_v2_runtime.sql',
    '20260824_0002_vertical_engine_v2_base_per_hypothesis.sql',
    '20260826_0001_vertical_engine_v2_fix_collecting_unique.sql',
    '20260828_0001_vertical_engine_v2_segmentation_audits.sql',
    '20260828_0003_vertical_engine_v2_launch_portfolio.sql',
    '20260831_0001_vertical_engine_v2_launch_preset_binding.sql',
    '20260902_0001_vertical_engine_v2_contact_delivery.sql',
    '20260903_0001_vertical_engine_v2_contact_supply.sql',
    '20260924_0010_ve_contact_delivery_without_period.sql',
    '20260924_0011_ve_project_deadline_card_formats.sql',
    '20260924_0013_ve_instantly_upload_capacity.sql',
  ]) {
    await db.exec(migration(name));
  }

  const USER = '00000000-0000-4000-8000-000000000001';
  const STAFF = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
  const PRESET = '77777777-7777-4777-8777-777777777777';
  const now = '2030-09-02T06:00:00Z'; // Monday, 09:00 Moscow; independent of the machine clock.
  const nextDay = '2030-09-03T06:00:00Z';
  await rows(`insert into public.projects values ($1,'Staff Line','Аутрич','В работе','2030-09-30','2030-08-30','4000','25905')`, [STAFF]);

  // ── Помощники ──
  const deadlineCases = JSON.parse(readFileSync(resolve(root, 'app/tests/helpers/projectDeadlineCases.json'), 'utf8'));
  for (const [raw, iso] of deadlineCases.accepted) {
    const parsed = (await one('select public.ve_try_iso_date($1)::text as d', [raw])).d;
    check(parsed === iso, `try_iso_date parses ${JSON.stringify(raw)}`, String(parsed));
  }
  for (const bad of [...deadlineCases.rejected, '', ' ', null]) {
    check((await one('select public.ve_try_iso_date($1) as d', [bad])).d === null, `try_iso_date rejects ${JSON.stringify(bad)}`);
  }
  const PERIOD_X = '11111111-1111-4111-8111-111111111111';
  check((await one(`select public.ve_contact_delivery_lock_key($1::uuid,$2::uuid)
      = pg_catalog.hashtextextended('ve-contact-delivery-period:' || $2::text, 0) as same`, [STAFF, PERIOD_X])).same === true,
  'period lock key is byte-identical to the historical key');
  const keys = await one(`select public.ve_contact_delivery_lock_key($1::uuid,null) as project,
      public.ve_contact_delivery_lock_key(null,null) as unbound,
      public.ve_contact_delivery_lock_key($1::uuid,$2::uuid) as period`, [STAFF, PERIOD_X]);
  check(keys.project !== null && keys.unbound !== null && keys.project !== keys.period, 'project lock key is never NULL and differs from the period key');
  let term = await one('select status, deadline::text as deadline, contacts_done from public.ve_contact_delivery_term($1,null,null)', [STAFF]);
  check(term?.status === 'active' && term.deadline === '2030-09-30' && term.contacts_done === '0',
    'term: project without periods is active, fact is not projects.contacts_done', JSON.stringify(term));

  // ── VE2-проект и запуск шаблона ──
  const VE = '22222222-2222-4222-8222-222222222222';
  const VERT = '33333333-3333-4333-8333-333333333333';
  const BASE = '44444444-4444-4444-8444-444444444444';
  const TPL = '55555555-5555-4555-8555-555555555555';
  const AUDIT = '66666666-6666-4666-8666-666666666666';
  const RES = '99999999-9999-4999-8999-999999999999';
  const insertVeProject = (id, name) => rows(`insert into public.ve_projects(id,created_by,name,website_url,launch_preset_id,
      launch_instantly_account_id,launch_preset_bound_at,launch_preset_bound_by)
    values($1,$2,$3,'https://example.org',$4,'main',$5,$2)`, [id, USER, name, PRESET, now]);
  await insertVeProject(VE, 'Staff Line VE');
  await rows(`insert into public.ve_verticals(id,project_id,name,potential_pct) values($1,$2,'HR',50)`, [VERT, VE]);
  await rows(`insert into public.ve_bases(id,project_id,vertical_id,columns,data,source,status)
    values($1,$2,$3,'["email"]','[]','auto','analyzed')`, [BASE, VE, VERT]);
  await rows(`insert into public.ve_templates(id,base_id,vertical_id,letters,status)
    values($1,$2,$3,'[{"subject":"s","body":"b"}]','ready')`, [TPL, BASE, VERT]);
  // Аудит уже держит резерв запуска, как после ve_reserve_final_template_launch.
  await rows(`insert into public.ve_segmentation_audits(id,project_id,template_id,base_id,requested_by,status,input_hash,summary,
      launch_status,launch_reservation_id)
    values($1,$2,$3,$4,$5,'ready',repeat('a',64),'{}','running',$6)`, [AUDIT, VE, TPL, BASE, USER, RES]);
  const bindSql = `select public.ve_bind_contact_delivery_plan($1,$2,$3,$4,'{1,2,3,4,5}'::smallint[],'Europe/Moscow',20,$5,$6::timestamptz) as r`;
  const bound = (await one(bindSql, [VE, STAFF, null, 4000, USER, now])).r;
  check(bound?.bound === true && bound.replayed === false && bound.delivery_plan.portal_period_id === null, 'bind without period', JSON.stringify(bound));
  check((await one(bindSql, [VE, STAFF, null, 4000, USER, now])).r?.replayed === true, 'bind replay without period');
  await expectError('bind with another target is rejected', bindSql, [VE, STAFF, null, 5000, USER, now], /different immutable contact delivery plan/);
  await expectError('binding is immutable', 'update public.ve_projects set target_contacts=10 where id=$1', [VE], /immutable/);
  const VE_SECOND = '88888888-8888-4888-8888-888888888888';
  await insertVeProject(VE_SECOND, 'Второй');
  await expectError('second VE2 plan on the same project without periods is rejected', bindSql, [VE_SECOND, STAFF, null, 100, USER, now],
    /without periods already belongs/);

  const launchInfo = {
    campaign_id: 'camp-1', campaign_name: 'C', campaign_url: 'u', leads_count: 0, preset_id: PRESET,
    instantly_account_id: 'main', mailbox_ids: ['sender@example.org'], portal_project_id: STAFF, portal_period_id: null,
    target_contacts: 4000, campaigns: [{ campaign_id: 'camp-1', campaign_name: 'C', campaign_url: 'u', segment: null, leads_count: 0 }],
  };
  const drip = Array.from({ length: 30 }, (_, i) => ({ campaign_id: 'camp-1', source_row_index: i, drip_order: i, lead_payload: { email: `lead${i}@example.org` } }));
  const finalizeSql = `select public.ve_finalize_template_contact_delivery($1,$2,$3,'succeeded',$4::jsonb,null,$5::timestamptz,$6::jsonb) as r`;
  const finalized = (await one(finalizeSql, [AUDIT, TPL, RES, JSON.stringify(launchInfo), now, JSON.stringify(drip)])).r;
  check(finalized?.finalized === true && finalized.delivery_rows_count === 30 && finalized.launch_info.portal_period_id === null,
    'finalize without period persists durable rows', JSON.stringify(finalized));
  const ITEM = finalized.queue_item.id;
  await rows(`update public.ve_launch_queue_items set status='active',ever_active_at=$2 where id=$1`, [ITEM, now]);

  // ── Суточный резерв: факт плана — первые контакты этого VE2-проекта ──
  await begin();
  const reserveSql = 'select public.ve_reserve_contact_delivery_day($1,$2::timestamptz,7) as r';
  const day = (await one(reserveSql, [VE, now])).r;
  check(day?.status === 'reserved' && day.portal_period_id === null && Number(day.actual_first_contacted) === 7 && day.remaining_contacts === 3993,
    'reserve day counts the observed VE2 fact, not projects.contacts_done', JSON.stringify(day));
  check(day?.effective_count === 20 && day.batches?.[0]?.row_ids?.length === 20, 'reserve day is capped by sender capacity');
  check((await one(reserveSql, [VE, now])).r?.run_id === day?.run_id, 'same-day replay returns the same run');
  term = await one('select status, contacts_done from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE]);
  check(term?.contacts_done === '7', 'term fact is the last run of this VE2 project', JSON.stringify(term));

  const activationSql = `select public.ve_reserve_contact_delivery_activation($1,'camp-1',$2,2,$3::timestamptz,$3::timestamptz) as a`;
  const activation = (await one(activationSql, [ITEM, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', now])).a;
  check(activation?.reason !== 'delivery_not_active', 'activation sees the project term as active', JSON.stringify(activation));
  const reconcileSql = 'select public.ve_reconcile_launch_campaign_statuses($1,$2::jsonb,$3::timestamptz) as r';
  const completed = JSON.stringify([{ campaign_id: 'camp-1', status: 3, status_observed_at: now }]);
  const kept = (await one(reconcileSql, [ITEM, completed, now])).r;
  check(kept?.item?.status === 'active' && kept.holds_slot === true, 'reconcile keeps the slot while the term authorizes delivery', JSON.stringify(kept?.item?.status));

  // ── Смена режима: менеджер создал период ──
  await inRollback(async () => {
    await rows(`insert into public.project_periods(project_id,name,status,deadline,contacts_done) values($1,'Октябрь','active','2030-10-31','0')`, [STAFF]);
    check((await one('select status from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE])).status === 'has_periods', 'term after a new period: has_periods');
    check((await one(activationSql, [ITEM, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', now])).a?.reason === 'delivery_not_active', 'activation stops after a period appears');
    await expectError('reserve stops after a period appears', reserveSql, [VE, nextDay], /without periods is not launchable/);
    // Как и у закрытого периода: если все кампании уже завершены, слот освобождается.
    check((await one(reconcileSql, [ITEM, completed, now])).r?.item?.status === 'released', 'reconcile releases the slot once the term stops authorizing delivery');
  });
  await inRollback(async () => {
    await rows(`insert into public.project_periods(project_id,name,status,deadline,contacts_done) values($1,'Старый','closed','2030-08-31','10')`, [STAFF]);
    check((await one('select status from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE])).status === 'has_periods', 'a closed period also ends the project term');
  });
  await inRollback(async () => {
    await rows(`update public.projects set status='Завершен' where id=$1`, [STAFF]);
    check((await one('select status from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE])).status === 'not_launchable', 'term: finished project is not launchable');
    await expectError('reserve stops for a finished project', reserveSql, [VE, nextDay], /not launchable/);
  });
  for (const status of ['Тестирование', 'Подготовка', 'На паузе']) {
    await inRollback(async () => {
      await rows('update public.projects set status=$2 where id=$1', [STAFF, status]);
      check((await one('select status from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE])).status === 'active', `term: status «${status}» is a working one`);
    });
  }
  // «Дедлайн» в формате подсказки карточки (ДД.ММ.ГГ) — обычный срок плана.
  await inRollback(async () => {
    await rows(`update public.projects set deadline='31.10.30' where id=$1`, [STAFF]);
    const cardTerm = await one('select status, deadline::text as deadline from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE]);
    check(cardTerm?.status === 'active' && cardTerm.deadline === '2030-10-31', 'term: a DD.MM.YY card deadline is the plan deadline', JSON.stringify(cardTerm));
    check((await one(activationSql, [ITEM, 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', now])).a?.reason !== 'delivery_not_active',
      'activation goes on with a DD.MM.YY card deadline');
  });
  // Пустой или не-дата «Дедлайн» — пауза, как прошедший дедлайн: слот не держится.
  for (const bad of ['05.18.2026', '31.02.30', '', null]) {
    await inRollback(async () => {
      await rows('update public.projects set deadline=$2 where id=$1', [STAFF, bad]);
      const badTerm = await one('select status, deadline from public.ve_contact_delivery_term($1,null,$2)', [STAFF, VE]);
      check(badTerm?.status === 'no_deadline' && badTerm.deadline === null, `term: deadline ${JSON.stringify(bad)} is no deadline`, JSON.stringify(badTerm));
      await expectError(`reserve stops without a valid deadline (${JSON.stringify(bad)})`, reserveSql, [VE, nextDay], /without periods is not launchable/);
      check((await one(activationSql, [ITEM, 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', now])).a?.reason === 'delivery_not_active',
        `activation stops without a valid deadline (${JSON.stringify(bad)})`);
      const released = (await one(reconcileSql, [ITEM, completed, now])).r;
      check(released?.item?.status === 'released' && released.holds_slot === false,
        `reconcile frees the slot without a valid deadline (${JSON.stringify(bad)})`, JSON.stringify(released?.item?.status));
    });
  }
  await expectError('reserve after the deadline with contacts remaining fails', reserveSql, [VE, '2030-10-02T06:00:00Z'], /deadline passed/);
  await inRollback(async () => {
    await rows(`update public.projects set deadline='2020-01-01' where id=$1`, [STAFF]);
    await expectError('mark attempt is blocked after the deadline passed',
      `select public.ve_mark_contact_delivery_attempt($1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','camp-1',$2::uuid[])`,
      [day.run_id, day.batches[0].row_ids.slice(0, 1)], /no longer in an active period/);
  });
  // Барьер перед отправкой пропускает действующий план без периода. mark берёт
  // pg_catalog.now(), поэтому день резерва переносится на сегодня по часам БД.
  await inRollback(async () => {
    await rows(`update public.projects set deadline='2099-12-31' where id=$1`, [STAFF]);
    await rows('update public.ve_contact_delivery_daily_runs set run_date=timezone(timezone, now())::date where id=$1', [day.run_id]);
    try {
      const marked = (await one(`select public.ve_mark_contact_delivery_attempt($1,'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0','camp-1',$2::uuid[]) as r`,
        [day.run_id, day.batches[0].row_ids.slice(0, 1)])).r;
      check(marked?.marked === true, 'mark attempt without period passes the pre-send barrier', JSON.stringify(marked));
    } catch (error) {
      check(false, 'mark attempt without period passes the pre-send barrier', error.message);
    }
  });
  // Capacity refusal, partial acceptance, restart, explicit retry and exact
  // idempotency are exercised against PostgreSQL, not migration text matching.
  await inRollback(async () => {
    await rows(`update public.projects set deadline='2099-12-31' where id=$1`, [STAFF]);
    await rows('update public.ve_contact_delivery_daily_runs set run_date=timezone(timezone, now())::date where id=$1', [day.run_id]);
    const dbNow = (await one('select now()::text as t')).t;
    const attempt = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7';
    const retryAttempt = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7';
    const ids = day.batches[0].row_ids.slice(0, 4);
    const markSql = `select public.ve_mark_contact_delivery_attempt($1,$2,'camp-1',$3::uuid[]) as r`;
    const blockSql = `select public.ve_finalize_contact_delivery_capacity($1,$2,'camp-1',$3::uuid[],$4::uuid[],$5::uuid[],$6::uuid[],'INSTANTLY_CONTACT_CAPACITY') as r`;
    const retrySql = `select public.ve_retry_contact_delivery_upload($1,$2,$3::timestamptz,$4,$5::timestamptz) as r`;
    check((await one(markSql, [day.run_id, attempt, ids])).r.marked, 'capacity: initial attempt fenced');
    const outcomes = [day.run_id, attempt, [ids[0]], [ids[1]], [ids[2]], [ids[3]]];
    await one(blockSql, outcomes);
    const blockedAt = (await one('select upload_blocked_at::text as t from public.ve_contact_delivery_daily_runs where id=$1', [day.run_id])).t;
    check(Boolean(blockedAt), 'capacity: pause and outcomes committed together');
    const blocked = (await one(reserveSql, [VE, dbNow])).r;
    check(blocked.status === 'capacity_blocked' && blocked.batches.length === 0, 'capacity: restart returns no provider work');
    check(!(await one(markSql, [day.run_id, retryAttempt, day.batches[0].row_ids.slice(4)])).r.marked,
      'capacity: stale worker snapshot cannot start sibling rows while blocked');
    await expectError('capacity: stale UI cannot resume a newer pause', retrySql,
      [VE, day.run_id, '2000-01-01T00:00:00Z', USER, dbNow], /Состояние загрузки изменилось/);
    const retryArgs = [VE, day.run_id, blockedAt, USER, dbNow];
    check((await one(retrySql, retryArgs)).r.ok, 'capacity: explicit retry accepted');
    check((await one(retrySql, retryArgs)).r.replayed, 'capacity: duplicate click is idempotent');
    // A timed-out finalization response may be replayed after the UI resumes.
    check((await one(blockSql, outcomes)).r.replayed, 'capacity: lost finalization response replays safely');
    check((await one('select upload_blocked_at from public.ve_contact_delivery_daily_runs where id=$1', [day.run_id])).upload_blocked_at === null,
      'capacity: finalization replay never recreates a cleared pause');
    const resumed = (await one(reserveSql, [VE, dbNow])).r;
    const retryIds = resumed.batches.flatMap((batch) => batch.row_ids);
    check(resumed.status === 'reserved' && retryIds.length === 17 && retryIds.includes(ids[3])
      && !retryIds.some((id) => ids.slice(0, 3).includes(id)), 'capacity: resume only released and untouched identities within frozen quota', JSON.stringify(resumed));
    check(resumed.effective_count === 20 && resumed.run_id === day.run_id, 'capacity: retry creates no extra daily allowance');
    check((await one(markSql, [day.run_id, retryAttempt, retryIds])).r.marked, 'capacity: resumed rows fenced exactly once');
    check(!(await one(markSql, [day.run_id, retryAttempt, retryIds])).r.marked, 'capacity: worker replay cannot repeat upload');
    await one(`select public.ve_finalize_contact_delivery_attempt($1,$2,'camp-1',$3::uuid[],'{}','{}','{}',null)`, [day.run_id, retryAttempt, retryIds]);
    const after = (await one(reserveSql, [VE, dbNow])).r;
    check(after.status === 'replayed' && after.batches.length === 0, 'capacity: completed retry cannot upload again');
    const totals = await one('select accepted_count,uncertain_count,skipped_count,reserved_count from public.ve_contact_delivery_daily_runs where id=$1', [day.run_id]);
    check(totals.accepted_count === 18 && totals.uncertain_count === 1 && totals.skipped_count === 1 && totals.reserved_count === 20,
      'capacity: accepted and uncertain counts survive retry without duplicates', JSON.stringify(totals));
    const nextMonday = (await one("select (date_trunc('week', now()) + interval '7 days 9 hours')::text as t")).t;
    const nextDaily = (await one(reserveSql, [VE, nextMonday])).r;
    check(nextDaily.status === 'reserved' && nextDaily.committed_count === 19 && nextDaily.ready_remaining === 10
      && nextDaily.effective_count > 0 && nextDaily.effective_count <= 10,
      'daily refill: blocklist skip is not counted as delivered and ready stock remains eligible', JSON.stringify(nextDaily));
    check(!nextDaily.batches.flatMap((batch) => batch.row_ids).some((id) => day.batches[0].row_ids.includes(id)),
      'daily refill: accepted, skipped and uncertain identities are never selected again');
  });
  await inRollback(async () => {
    // Next-day retry must go through the normal schedule/quota calculation.
    await rows(`update public.ve_contact_delivery_daily_runs set upload_blocked_at=$2 where id=$1`, [day.run_id, now]);
    check((await one(reserveSql, [VE, nextDay])).r.status === 'capacity_blocked', 'capacity: pause survives a day boundary');
    await one(`select public.ve_retry_contact_delivery_upload($1,$2,$3::timestamptz,$4,$5::timestamptz)`, [VE, day.run_id, now, USER, nextDay]);
    const next = (await one(reserveSql, [VE, nextDay])).r;
    check(next.status === 'reserved' && next.run_id !== day.run_id && next.effective_count === 20,
      'capacity: later retry uses a fresh ordinary daily quota', JSON.stringify(next));
    await rows(`update public.ve_contact_delivery_daily_runs set upload_blocked_at=$2 where id=$1`, [next.run_id, nextDay]);
    await rows(`update public.projects set status='Завершен' where id=$1`, [STAFF]);
    await expectError('capacity: retry cannot bypass a closed project',
      `select public.ve_retry_contact_delivery_upload($1,$2,$3::timestamptz,$4,$5::timestamptz)`,
      [VE, next.run_id, nextDay, USER, nextDay], /Срок проекта завершён/);
  });
  await expectError('project with a VE2 plan cannot be deleted', 'delete from public.projects where id=$1', [STAFF], /ve_projects_portal_project_fkey/);
  await commit();

  // ── Пополнение: согласование и актуальность без периода ──
  await begin();
  const HYP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const PLAN = 'f0000000-0000-4000-8000-000000000001';
  await rows(`insert into public.ve_hypotheses(id,project_id,vertical_id,tier,title) values($1,$2,$3,1,'H')`, [HYP, VE, VERT]);
  await rows('update public.ve_bases set hypothesis_id=$1 where id=$2', [HYP, BASE]);
  await rows('update public.ve_launch_queue_items set hypothesis_id=$1 where id=$2', [HYP, ITEM]);
  const snapshot = (await one(`select public.ve_contact_supply_rules_snapshot($1,$2,$3,null,4000,'main') as s`, [TPL, PRESET, STAFF])).s;
  await rows(`insert into public.ve_contact_supply_plans(id,project_id,hypothesis_id,template_id,item_id,status,approval_snapshot,
      preview_audit_id,preview_audit_hash,preview_revision,approved_by,approved_at)
    values($1,$2,$3,$4,$5,'active',$6,$7,'hash','rev',$8,$9)`, [PLAN, VE, HYP, TPL, ITEM, snapshot, AUDIT, USER, now]);
  check((await one('select public.ve_contact_supply_approval_current($1) as c', [PLAN])).c === true, 'approval_current: NULL period matches a NULL snapshot');
  const required = await one('select (public.ve_require_contact_supply_active($1,$2::timestamptz)).status as s', [PLAN, now]);
  check(required?.s === 'active', 'require_contact_supply_active passes for an active project term', JSON.stringify(required));
  const releaseItem = `update public.ve_launch_queue_items set status='released', release_reason='Все кампании завершены',
      released_at=$2, updated_at=$2 where id=$1 returning status`;
  await inRollback(async () => {
    const held = (await one(releaseItem, [ITEM, now]))?.status;
    check(held === 'active', 'hold slot keeps continuous supply of a plan without period', held);
  });
  await inRollback(async () => {
    await rows(`update public.projects set deadline='31.02.30' where id=$1`, [STAFF]);
    const released = (await one(releaseItem, [ITEM, now]))?.status;
    check(released === 'released', 'hold slot lets a plan without a valid deadline go', released);
  });
  await inRollback(async () => {
    // Пустой суточный запуск того же дня непрерывное пополнение открывает заново.
    const emptyRun = (await one(`insert into public.ve_contact_delivery_daily_runs(ve_project_id,portal_project_id,portal_period_id,run_date,
        reservation_status,status,target_contacts,actual_first_contacted,observed_ve_first_contacted,committed_count,outstanding_count,
        upload_headroom,deadline,schedule_days,timezone,sender_daily_capacity,remaining_contacts,remaining_workdays,required_daily,
        ready_remaining,effective_count)
      values($1,$2,null,'2030-09-03','no_ready_rows','completed',4000,7,7,0,0,0,'2030-09-30','{1,2,3,4,5}','Europe/Moscow',20,3993,20,200,0,0)
      returning id`, [VE, STAFF])).id;
    const reopened = (await one(reserveSql, [VE, nextDay])).r;
    const left = (await rows('select id from public.ve_contact_delivery_daily_runs where id=$1', [emptyRun])).length;
    check(reopened?.status === 'reserved' && reopened.run_id !== emptyRun && left === 0,
      'continuous supply reopens an empty same-day run without period', JSON.stringify({ status: reopened?.status, left }));
  });
  await inRollback(async () => {
    // Согласование пополнения на отдельном проекте без периода.
    const P2 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const VE2P = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
    const V2 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
    const B2 = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
    const T2 = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
    const A2 = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
    const H2 = 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8';
    await rows(`insert into public.projects values ($1,'Second','S','Тестирование','2030-09-30',null,'8000-16000','')`, [P2]);
    await insertVeProject(VE2P, 'Second VE');
    await rows(`insert into public.ve_verticals(id,project_id,name,potential_pct) values($1,$2,'HR',50)`, [V2, VE2P]);
    await rows(`insert into public.ve_hypotheses(id,project_id,vertical_id,tier,title) values($1,$2,$3,1,'H')`, [H2, VE2P, V2]);
    await rows(`insert into public.ve_bases(id,project_id,vertical_id,hypothesis_id,columns,data,source,status,collect_info)
      values($1,$2,$3,$4,'["email"]','[]','auto','analyzed','{"collection_mode":"preview","target_progress":{"status":"target_reached","ready_rows":5}}')`,
    [B2, VE2P, V2, H2]);
    await rows(`insert into public.ve_templates(id,base_id,vertical_id,letters,status) values($1,$2,$3,'[{"subject":"s","body":"b"}]','ready')`, [T2, B2, V2]);
    await rows(`insert into public.ve_segmentation_audits(id,project_id,template_id,base_id,requested_by,status,input_hash,summary)
      values($1,$2,$3,$4,$5,'ready',repeat('c',64),'{"unclassified_rows_total":0}')`, [A2, VE2P, T2, B2, USER]);
    const revision = (await one('select public.ve_contact_supply_preview_revision($1) as r', [T2])).r;
    const approveSql = `select public.ve_approve_contact_supply($1,$2,$3,$4,$5,null,4000,'main',$6,$7::timestamptz) as r`;
    await inRollback(async () => {
      await rows(`update public.projects set deadline='05.18.2026' where id=$1`, [P2]);
      await expectError('supply approval without a valid deadline is refused', approveSql, [T2, A2, revision, PRESET, P2, USER, now],
        /explicit active Portal period/);
    });
    try {
      const approved = (await one(approveSql, [T2, A2, revision, PRESET, P2, USER, now])).r;
      check(approved?.status === 'approved' && approved.approval_snapshot?.portal_project_id === P2
        && approved.approval_snapshot.portal_period_id === null, 'supply approval without period', JSON.stringify(approved));
    } catch (error) {
      check(false, 'supply approval without period', error.message);
    }
  });
  await inRollback(async () => {
    const foreign = (await one(`select public.ve_contact_supply_rules_snapshot($1,$2,$3,$4,4000,'main') as s`, [TPL, PRESET, STAFF, PERIOD_X])).s;
    await rows('update public.ve_contact_supply_plans set approval_snapshot=$1 where id=$2', [foreign, PLAN]);
    check((await one('select public.ve_contact_supply_approval_current($1) as c', [PLAN])).c === false, 'approval_current rejects a period snapshot against a binding without period');
  });
  await inRollback(async () => {
    await rows(`insert into public.project_periods(project_id,name,status,deadline,contacts_done) values($1,'Октябрь','active','2030-10-31','0')`, [STAFF]);
    await expectError('require_contact_supply_active stops after a period appears',
      'select public.ve_require_contact_supply_active($1,$2::timestamptz)', [PLAN, now], /unfulfilled period/);
  });
  await commit();

  // ── Режим с периодом не изменился ──
  const PP = 'abababab-abab-4bab-8bab-abababababab';
  const PERIOD = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const VEP = 'efefefef-efef-4fef-8fef-efefefefefef';
  await rows(`insert into public.projects values($1,'Периодный','P','В работе','2030-12-31',null,'1000','500')`, [PP]);
  await rows(`insert into public.project_periods(id,project_id,name,status,deadline,contacts_done) values($1,$2,'Сентябрь','active','2030-09-30','10')`, [PERIOD, PP]);
  check((await one('select contacts_done from public.ve_contact_delivery_term($1,$2,null)', [PP, PERIOD])).contacts_done === '10', 'term for a period returns that period row');
  check((await rows('select 1 from public.ve_contact_delivery_term($1,$2,null)', [STAFF, PERIOD])).length === 0, 'term never returns a period of another project');
  await insertVeProject(VEP, 'Период VE');
  check((await one(bindSql, [VEP, PP, PERIOD, 23, USER, now])).r?.delivery_plan?.portal_period_id === PERIOD, 'bind with a period still works');
  await expectError('bind with an unknown period is rejected', bindSql, [VE_SECOND, PP, PERIOD_X, 23, USER, now], /expected Portal project period is not active/);
  const VVERT = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
  const VBASE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
  const VTPL = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
  const VAUD = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
  const VRES = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e';
  await rows(`insert into public.ve_verticals(id,project_id,name,potential_pct) values($1,$2,'HR',50)`, [VVERT, VEP]);
  await rows(`insert into public.ve_bases(id,project_id,vertical_id,columns,data,source,status) values($1,$2,$3,'["email"]','[]','auto','analyzed')`, [VBASE, VEP, VVERT]);
  await rows(`insert into public.ve_templates(id,base_id,vertical_id,letters,status) values($1,$2,$3,'[{"subject":"s","body":"b"}]','ready')`, [VTPL, VBASE, VVERT]);
  await rows(`insert into public.ve_segmentation_audits(id,project_id,template_id,base_id,requested_by,status,input_hash,summary,
      launch_status,launch_reservation_id)
    values($1,$2,$3,$4,$5,'ready',repeat('b',64),'{}','running',$6)`, [VAUD, VEP, VTPL, VBASE, USER, VRES]);
  const periodInfo = { ...launchInfo, campaign_id: 'pcamp', campaigns: [{ ...launchInfo.campaigns[0], campaign_id: 'pcamp' }],
    portal_project_id: PP, portal_period_id: PERIOD, target_contacts: 23 };
  const periodDrip = drip.map((row) => ({ ...row, campaign_id: 'pcamp' }));
  const periodFinal = (await one(finalizeSql, [VAUD, VTPL, VRES, JSON.stringify(periodInfo), now, JSON.stringify(periodDrip)])).r;
  check(periodFinal?.finalized === true && periodFinal.launch_info.portal_period_id === PERIOD, 'period finalize still works');
  await rows(`update public.ve_launch_queue_items set status='active',ever_active_at=$2 where id=$1`, [periodFinal.queue_item.id, now]);
  await begin();
  const periodDay = (await one('select public.ve_reserve_contact_delivery_day($1,$2::timestamptz,3) as r', [VEP, now])).r;
  check(periodDay?.status === 'reserved' && Number(periodDay.actual_first_contacted) === 10 && periodDay.remaining_contacts === 13
    && periodDay.portal_period_id === PERIOD, 'period reserve day keeps the period fact formula', JSON.stringify(periodDay));
  await rows(`update public.project_periods set status='closed' where id=$1`, [PERIOD]);
  check((await one(`select public.ve_reserve_contact_delivery_activation($1,'pcamp',$2,2,$3::timestamptz,$3::timestamptz) as a`,
    [periodFinal.queue_item.id, '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b', now])).a?.reason === 'delivery_not_active', 'closed period still blocks activation');
  await commit();

  // ── Помощники не доступны ролям API ──
  await db.exec('set role service_role');
  await expectError('service_role cannot call the term helper', 'select * from public.ve_contact_delivery_term($1,null,null)', [STAFF], /permission denied/i);
  await db.exec('reset role');
} catch (error) {
  failures += 1;
  console.error(error.message, error.where || '', error.stack?.split('\n').slice(1, 3).join('\n') || '');
} finally {
  await db.close();
}
console.log(failures === 0 ? 'PASS contact delivery without period' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
