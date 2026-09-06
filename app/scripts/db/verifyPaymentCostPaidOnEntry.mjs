// Optional local-only behavior check: no network, credentials, or production DB.
// Tested with @electric-sql/pglite 0.5.8 in a temporary npm prefix. Run:
// node app/scripts/db/verifyPaymentCostPaidOnEntry.mjs --pglite <prefix>/node_modules/@electric-sql/pglite/dist/index.js
// --baseline applies only the pre-change migrations to reproduce the regressions.
// This executes the real functions/triggers but is single-session: concurrent
// advisory-lock behavior still requires a separate multi-connection PostgreSQL check.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleFlag = process.argv.indexOf('--pglite');
const modulePath = moduleFlag >= 0 ? process.argv[moduleFlag + 1] : null;
const { PGlite } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : '@electric-sql/pglite');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mode = process.argv.includes('--baseline') ? 'baseline' : 'latest';
const migrationDir = join(root, 'supabase/migrations');
const db = new PGlite();
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const confirmer = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const confirmedBackfill = '20260903_0002_payment_costs_confirmed_paid_backfill';
const confirmedCosts = [
  ['7b296854-38ef-4aac-9ef5-74968cba00d5', 21457, '2026-09-01', 'instantly'],
  ['f0c99996-109a-4913-8c84-f290c5207cfa', 850, '2026-09-02', 'domains'],
  ['7c580e2b-dda6-433e-b2d9-2e01c29504f9', 71673, '2026-09-02', 'instantly'],
  ['efc5c8b5-9d2e-4e11-a327-be98e7278ba4', 4511, '2026-09-02', 'other'],
  ['9ad21d74-529e-4d8a-993b-77ebd3fa5123', 6983, '2026-09-02', 'instantly'],
  ['1f8f2445-46ba-4735-aa09-32d646daaae8', 1654, '2026-09-03', 'domains'],
];
const migrations = [
  '20260214_create_email_subscriptions.sql',
  '20260218_0002_create_payment_requests.sql',
  '20260813_0003_tech_subscriptions.sql',
  '20260818_0002_payment_request_control.sql',
  '20260901_0001_payment_cost_budget.sql',
  '20260901_0003_tech_calendar_cost_budget.sql',
];
const updates = mode === 'baseline' ? [] : readdirSync(migrationDir)
  .filter(name => /^20260902.*(?:paid_on_entry|mail_cost_paid_history_guard).*\.sql$/.test(name))
  .sort();
const failures = [];
const generalMigration = '20260904_0006_payment_automatic_fact.sql';
const giftsMigration = '20260904_0007_payment_confirmed_gifts.sql';
const alina = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const gifts = [
  ['348e88ae-dba8-4e6b-b27c-ede5502f0b4c', 401, '2026-09-04'],
  ['65045cf0-a74e-4911-a023-5f7352a215c3', 1615, '2026-09-03'],
];
let today;
let tomorrow;
let nextMonth;
let month;
let testCount = 0;

async function q(sql, args = []) {
  return (await db.query(sql, args)).rows;
}
async function asActor(id = actor) {
  await q("select set_config('request.jwt.claim.sub', $1, false)", [id]);
}
async function submit({ key = randomUUID(), amount = 100, scope = 'costs', category = 'other', date = today, type = 'one_time' } = {}) {
  const [row] = await q(`select public.submit_payment_request_with_budget(
    $1::uuid, 'outreach', 'DB behavioral fixture', $2::numeric, null, null,
    $3, $4, $5, $6::date, 'normal', null
  ) as result`, [key, amount, type, scope, scope === 'costs' ? category : null, date]);
  return row.result;
}
async function summary(date = today) {
  return (await q('select public.payment_request_month_summary($1::date) as result', [date]))[0].result;
}
async function test(name, fn) {
  testCount += 1;
  await db.exec('begin');
  try {
    await asActor();
    await fn();
    console.log('PASS', name);
  } catch (error) {
    failures.push(name);
    console.error('FAIL', name, error.message);
  } finally {
    await db.exec('rollback');
  }
}
async function rejected(fn, message) {
  await db.exec('savepoint expected_rejection');
  await assert.rejects(fn, new RegExp(message));
  await db.exec('rollback to expected_rejection');
}
async function applyUpdates() {
  for (const file of updates) {
    await db.exec(readFileSync(join(migrationDir, file), 'utf8'));
  }
}
async function applyConfirmedBackfill() {
  await db.exec(readFileSync(join(migrationDir, `${confirmedBackfill}.sql`), 'utf8'));
}
async function seedConfirmedCosts() {
  await asActor('');
  await q("insert into public.profiles(id, full_name, role) values ($1, 'Сергей', 'admin')", [confirmer]);
  for (const [id, amount, date, category] of confirmedCosts) {
    await q(`insert into public.payment_requests(
      id, user_id, requester_user_id, requester_name, department, description, amount,
      expense_type, budget_scope, cost_category, expected_payment_on, status,
      idempotency_key, submission_fingerprint
    ) values ($1, $2, $2, 'Сергей', 'outreach', 'Confirmed historical cost', $3,
      'one_time', 'costs', $4, $5::date, 'approved', $6, $7)`,
    [id, confirmer, amount, category, date, randomUUID(), '0'.repeat(64)]);
  }
}
async function requestSnapshot() {
  return q('select to_jsonb(request) as row from public.payment_requests request order by id');
}

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.profiles(id uuid primary key, full_name text, email text, role text, is_demo boolean default false);
    create table public.projects(id uuid primary key, client text, name text);
    create table public.notifications(id uuid primary key, type text, entity_type text);
    create table public.fx_rates(currency text, rate_date date, rate numeric);
    create function public.set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at := now(); return new; end;
    $$;
    insert into public.profiles values ('${actor}', 'Ordinary specialist', 'fixture@example.invalid', 'technician', false);
  `);
  for (const file of migrations) {
    try {
      await db.exec(readFileSync(join(migrationDir, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file}: ${error.message}`, { cause: error });
    }
  }
  const [dates] = await q(`select
    ((now() at time zone 'Europe/Moscow')::date)::text as today,
    ((now() at time zone 'Europe/Moscow')::date + 1)::text as tomorrow,
    date_trunc('month', now() at time zone 'Europe/Moscow')::date::text as month,
    (date_trunc('month', now() at time zone 'Europe/Moscow') + interval '1 month')::date::text as next_month`);
  ({ today, tomorrow, month, next_month: nextMonth } = dates);

  await test('migrations and retries do not reclassify existing approved costs or legacy/general rows', async () => {
    const key = randomUUID();
    const futureKey = randomUUID();
    const approved = await submit({ key });
    assert.equal(approved.request.status, 'approved');
    const futureApproved = await submit({ key: futureKey, date: tomorrow });
    assert.equal(futureApproved.request.status, 'approved');
    await submit({ scope: 'general', type: 'planned' });
    const general = await submit({ scope: 'general' });
    await q(`update public.payment_requests
      set status = 'paid', expense_type = 'legacy_unclassified', paid_on = $1::date, paid_on_source = 'legacy_created_at'
      where id = $2`, [today, general.request.id]);
    const before = await q('select to_jsonb(request) as row from public.payment_requests request order by id');
    await applyUpdates();
    assert.deepEqual(await q('select to_jsonb(request) as row from public.payment_requests request order by id'), before);
    const retry = await submit({ key });
    assert.equal(retry.outcome, 'auto_approved');
    assert.deepEqual(retry.request, approved.request);
    const futureRetry = await submit({ key: futureKey, date: tomorrow });
    assert.equal(futureRetry.outcome, 'auto_approved');
    assert.deepEqual(futureRetry.request, futureApproved.request);
    assert.deepEqual(await q('select to_jsonb(request) as row from public.payment_requests request order by id'), before);
    assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 4);
  });

  await applyUpdates();
  for (const file of updates) console.log('APPLIED', file);

  await test('cost categories record fact immediately with immutable entry audit; retry adds nothing', async () => {
    let latest;
    for (const [index, category] of ['instantly', 'email', 'bases', 'domains', 'other'].entries()) {
      const key = randomUUID();
      latest = await submit({ key, category, type: index % 2 ? 'planned' : 'one_time' });
      assert.equal(latest.outcome, 'recorded_paid');
      assert.equal(latest.request.status, 'paid');
      assert.equal(latest.request.paid_on, today);
      assert.equal(latest.request.paid_on_source, 'entered');
      assert.equal(latest.request.paid_by, actor);
      assert.ok(latest.request.paid_at);
      assert.equal(latest.request.decided_by, null);
      const again = await submit({ key, category, type: index % 2 ? 'planned' : 'one_time' });
      assert.deepEqual(again, latest);
      const [event] = await q('select * from public.payment_request_events where payment_request_id = $1', [latest.request.id]);
      assert.equal(event.event_type, 'submitted_paid');
      assert.equal(event.to_status, 'paid');
      assert.equal(event.metadata.paid_on, today);
      assert.equal(event.metadata.paid_on_source, 'entered');
      await rejected(() => submit({ key, category, amount: 101, type: index % 2 ? 'planned' : 'one_time' }), 'payment_request_idempotency_conflict');
    }
    assert.equal(latest.summary.costBudget.paid, 500);
    assert.equal(latest.summary.costBudget.reserved, 0);
    assert.equal(latest.summary.costBudget.remaining, 649500);
    assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 5);
  });

  await test('cost actual date rejects the future; general future dates and approval workflows stay unchanged', async () => {
    await rejected(() => submit({ date: tomorrow }), 'payment_request_invalid_paid_date');
    const ordinary = await submit({ scope: 'general', date: tomorrow });
    assert.equal(ordinary.outcome, 'auto_approved');
    assert.equal(ordinary.request.status, 'approved');
    assert.equal(ordinary.request.paid_on, null);
    const planned = await submit({ scope: 'general', type: 'planned' });
    assert.equal(planned.outcome, 'approval_required');
    assert.equal(planned.request.status, 'pending');
    assert.equal(planned.request.approval_reason, 'planned');
    const over = await submit({ scope: 'general', amount: 75001 });
    assert.equal(over.request.status, 'pending');
    assert.equal(over.request.approval_reason, 'limit_exceeded');
  });

  await test('a backdated cost is fact only in its actual month', async () => {
    const [dates] = await q("select ($1::date - interval '1 month')::date::text as previous", [month]);
    const result = await submit({ amount: 600, date: dates.previous });
    assert.equal(result.request.paid_on, dates.previous);
    assert.equal(result.summary.costBudget.paid, 600);
    assert.equal((await summary(today)).costBudget.paid, 0);
  });

  await test('mail + technical accepted cycles share the cap as reserve before date and fact on date', async () => {
    // On the last day of a month all accepted current-month cycles are due.
    const hasFutureDay = tomorrow.slice(0, 7) === today.slice(0, 7);
    const reserveDate = hasFutureDay ? tomorrow : today;
    await asActor('');
    await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status)
      values ('mail-reserved', $1::date, 200000, 'RUB', 'keep'), ('mail-paid', $2::date, 50000, 'RUB', 'keep')`, [reserveDate, today]);
    await q(`insert into public.tech_subscriptions(service_name, next_billing_date, amount, currency, status)
      values ('tech-reserved', $1::date, 100000, 'RUB', 'keep'), ('tech-paid', $2::date, 50000, 'RUB', 'keep')`, [reserveDate, today]);
    await asActor();
    const before = await summary();
    assert.equal(before.costBudget.mailReserved, hasFutureDay ? 200000 : 0);
    assert.equal(before.costBudget.mailPaid, hasFutureDay ? 50000 : 250000);
    assert.equal(before.costBudget.techReserved, hasFutureDay ? 100000 : 0);
    assert.equal(before.costBudget.techPaid, hasFutureDay ? 50000 : 150000);
    const atCap = await submit({ amount: 250000 });
    assert.equal(atCap.summary.costBudget.paid, hasFutureDay ? 350000 : 650000);
    assert.equal(atCap.summary.costBudget.reserved, hasFutureDay ? 300000 : 0);
    assert.equal(atCap.summary.costBudget.remaining, 0);
    await rejected(() => submit({ amount: 0.01 }), 'payment_request_cost_limit_exceeded');
    assert.equal((await q('select count(*)::int as n from public.payment_requests'))[0].n, 1);
  });

  await test('legacy missing FX fails closed, then permits only trusted repair and safe FK cleanup', async () => {
    await asActor('');
    // Model an imported legacy keep cycle whose historical FX was absent at migration time.
    async function legacyCycle(project = null, author = null) {
      await db.exec('alter table public.email_subscriptions disable trigger user');
      const [row] = await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status, cost_amount_rub, project_id, lead_decision_by, created_by)
        values ('legacy-missing-fx', $1::date, 100, 'USD', 'keep', null, $2, $3, $3) returning id`, [today, project, author]);
      await db.exec('alter table public.email_subscriptions enable trigger user');
      return row.id;
    }
    const legacy = await legacyCycle();
    await asActor();
    assert.equal((await summary()).costBudget.dataComplete, false);
    await rejected(() => submit(), 'payment_request_cost_budget_incomplete');
    assert.equal((await q('select count(*)::int as n from public.payment_requests'))[0].n, 0);

    // The existing freezer, not the caller's bogus amount, supplies historical RUB.
    await asActor('');
    await q("insert into public.fx_rates(currency, rate_date, rate) values ('USD', $1::date, 90)", [today]);
    await q('update public.email_subscriptions set cost_amount_rub = 1 where id = $1', [legacy]);
    assert.equal((await q('select cost_amount_rub::int as amount from public.email_subscriptions where id = $1', [legacy]))[0].amount, 9000);
    assert.equal((await summary()).costBudget.dataComplete, true);
    assert.equal((await summary()).costBudget.mailPaid, 9000);
    await rejected(() => q('update public.email_subscriptions set cost_amount_rub = 2 where id = $1', [legacy]), 'email_subscription_paid_cycle_locked');
    await rejected(() => q('update public.email_subscriptions set billing_amount = 1 where id = $1', [legacy]), 'email_subscription_paid_cycle_locked');

    // A nested FK clear can simultaneously fill previously unknown FX. Process
    // one missing cycle at a time, since other unknown charges must fail closed.
    for (const parent of ['project', 'profile']) {
      const project = randomUUID();
      const author = randomUUID();
      await q("insert into public.projects(id, client) values ($1, 'Legacy FX fixture')", [project]);
      await q("insert into public.profiles(id, role) values ($1, 'technician')", [author]);
      const id = await legacyCycle(project, author);
      await rejected(() => q('update public.email_subscriptions set project_id = null where id = $1', [id]), 'email_subscription_paid_cycle_locked');
      await q(`delete from public.${parent === 'project' ? 'projects' : 'profiles'} where id = $1`, [parent === 'project' ? project : author]);
      const [repaired] = await q('select cost_amount_rub::int as amount, project_id, lead_decision_by, created_by from public.email_subscriptions where id = $1', [id]);
      assert.equal(repaired.amount, 9000);
      if (parent === 'project') assert.equal(repaired.project_id, null);
      else {
        assert.equal(repaired.lead_decision_by, null);
        assert.equal(repaired.created_by, null);
      }
    }
    assert.equal((await summary()).costBudget.dataComplete, true);
    assert.equal((await summary()).costBudget.mailPaid, 27000);
  });

  await test('non-team and demo users cannot submit; unauthenticated direct RPC is forbidden', async () => {
    await q("update public.profiles set is_demo = true where id = $1", [actor]);
    await rejected(() => submit(), 'payment_request_forbidden');
    await q("update public.profiles set is_demo = false, role = 'client' where id = $1", [actor]);
    await rejected(() => submit(), 'payment_request_forbidden');
    await asActor('');
    await rejected(() => submit(), 'payment_request_forbidden');
  });

  await test('mail paid history survives rejected cancel/edit/delete while future cancellation stays allowed', async () => {
    await q("update public.profiles set role = 'admin' where id = $1", [actor]);
    const project = randomUUID();
    const author = randomUUID();
    await q("insert into public.projects(id, client) values ($1, 'Mail paid fixture')", [project]);
    await q("insert into public.profiles(id, role) values ($1, 'technician')", [author]);
    const [paid] = await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status, lead_decision, project_id, lead_decision_by, created_by)
      values ('paid-mail-history', $1::date, 321, 'RUB', 'keep', 'keep', $2, $3, $3) returning id, updated_at`, [today, project, author]);
    await rejected(() => q('select public.decide_email_subscription($1::uuid, $2, null, $3::timestamptz)', [paid.id, 'cancel', paid.updated_at]), 'email_subscription_paid_cycle_locked');
    await rejected(() => q('update public.email_subscriptions set billing_amount = 1 where id = $1', [paid.id]), 'email_subscription_paid_cycle_locked');
    await rejected(() => q('update public.email_subscriptions set next_billing_date = $1::date where id = $2', [nextMonth, paid.id]), 'email_subscription_paid_cycle_locked');
    await rejected(() => q('update public.email_subscriptions set project_id = null where id = $1', [paid.id]), 'email_subscription_paid_cycle_locked');
    await rejected(() => q('delete from public.email_subscriptions where id = $1', [paid.id]), 'email_subscription_paid_cycle_locked');
    assert.equal((await summary()).costBudget.mailPaid, 321);
    await q('delete from public.projects where id = $1', [project]);
    await q('delete from public.profiles where id = $1', [author]);
    const [afterDeletion] = await q('select project_id, lead_decision_by, created_by, project_name from public.email_subscriptions where id = $1', [paid.id]);
    assert.deepEqual(afterDeletion, { project_id: null, lead_decision_by: null, created_by: null, project_name: 'paid-mail-history' });
    assert.equal((await summary()).costBudget.mailPaid, 321);
    const [future] = await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status, lead_decision)
      values ('future-mail-history', $1::date, 123, 'RUB', 'keep', 'keep') returning id, updated_at`, [nextMonth]);
    assert.equal((await summary(nextMonth)).costBudget.mailReserved, 123);
    await q('select public.decide_email_subscription($1::uuid, $2, null, $3::timestamptz)', [future.id, 'cancel', future.updated_at]);
    assert.equal((await summary(nextMonth)).costBudget.mailReserved, 0);
    assert.equal((await summary()).costBudget.mailPaid, 321);
  });

  await test('technical paid history cannot be cancelled or deleted; future cancellation releases reserve', async () => {
    await asActor('');
    const [paid] = await q(`insert into public.tech_subscriptions(service_name, next_billing_date, amount, currency, status)
      values ('paid-tech-history', $1::date, 789, 'RUB', 'keep') returning id`, [today]);
    const [future] = await q(`insert into public.tech_subscriptions(service_name, next_billing_date, amount, currency, status)
      values ('future-tech-history', $1::date, 123, 'RUB', 'keep') returning id`, [nextMonth]);
    assert.equal((await summary()).costBudget.techPaid, 789);
    assert.equal((await summary(nextMonth)).costBudget.techReserved, 123);
    await rejected(() => q("update public.tech_subscriptions set status = 'cancel' where id = $1", [paid.id]), 'tech_subscription_paid_cycle_locked');
    await rejected(() => q('update public.tech_subscriptions set amount = 1 where id = $1', [paid.id]), 'tech_subscription_paid_cycle_locked');
    await rejected(() => q('delete from public.tech_subscriptions where id = $1', [paid.id]), 'tech_subscription_paid_cycle_locked');
    await q("update public.tech_subscriptions set status = 'cancel' where id = $1", [future.id]);
    assert.equal((await summary(nextMonth)).costBudget.techReserved, 0);
    assert.equal((await summary()).costBudget.techPaid, 789);
  });

  // This one-shot, explicitly confirmed data correction is intentionally separate
  // from applyUpdates(): the earlier migration must still leave legacy rows alone.
  if (mode !== 'baseline') {
    await test('confirmed six-cost backfill moves exactly 107128 from reserve to fact and audits once', async () => {
      await seedConfirmedCosts();
      await q(`insert into public.payment_requests(user_id, requester_user_id, requester_name, department,
        description, amount, expense_type, budget_scope, cost_category, expected_payment_on, status)
        values ($1, $1, 'Other requester', 'outreach', 'Unrelated cost', 5000, 'one_time', 'costs', 'other', '2026-09-01', 'approved'),
               ($1, $1, 'Other requester', 'outreach', 'General request', 1000, 'one_time', 'general', null, '2026-09-01', 'approved')`, [actor]);
      await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status)
        values ('Untouched mail', '2026-09-04', 300, 'RUB', 'keep')`);
      await q(`insert into public.tech_subscriptions(service_name, next_billing_date, amount, currency, status)
        values ('Untouched tech', '2026-09-04', 700, 'RUB', 'keep')`);
      const beforeRows = await requestSnapshot();
      const beforeCalendars = await q('select to_jsonb(subscription) as row from public.email_subscriptions subscription union all select to_jsonb(subscription) from public.tech_subscriptions subscription');
      const before = await summary('2026-09-01');
      await applyConfirmedBackfill();
      const after = await summary('2026-09-01');
      assert.equal(after.costBudget.paid - before.costBudget.paid, 107128);
      assert.equal(before.costBudget.reserved - after.costBudget.reserved, 107128);
      for (const key of ['used', 'remaining', 'limit', 'dataComplete', 'mailPaid', 'mailReserved', 'techPaid', 'techReserved']) {
        assert.equal(after.costBudget[key], before.costBudget[key]);
      }
      assert.equal(after.paidOneTime, before.paidOneTime);
      assert.equal(after.reservedOneTime, before.reservedOneTime);
      assert.deepEqual(await q('select to_jsonb(subscription) as row from public.email_subscriptions subscription union all select to_jsonb(subscription) from public.tech_subscriptions subscription'), beforeCalendars);
      const afterRows = await requestSnapshot();
      for (const { row: original } of beforeRows) {
        const updated = afterRows.find(({ row }) => row.id === original.id).row;
        const target = confirmedCosts.find(([id]) => id === original.id);
        if (!target) {
          assert.deepEqual(updated, original);
          continue;
        }
        assert.equal(updated.status, 'paid');
        assert.equal(updated.paid_on, target[2]);
        assert.equal(updated.paid_on_source, 'entered');
        assert.equal(updated.paid_by, confirmer);
        assert.ok(updated.paid_at);
        const lifecycle = new Set(['status', 'paid_on', 'paid_on_source', 'paid_by', 'paid_at', 'updated_at']);
        for (const key of Object.keys(original).filter(key => !lifecycle.has(key))) assert.deepEqual(updated[key], original[key]);
      }
      const events = await q('select * from public.payment_request_events order by payment_request_id');
      assert.equal(events.length, 6);
      for (const event of events) {
        const target = confirmedCosts.find(([id]) => id === event.payment_request_id);
        assert.equal(event.event_type, 'mark_paid');
        assert.equal(event.actor_user_id, confirmer);
        assert.equal(event.actor_name, 'Сергей');
        assert.equal(event.from_status, 'approved');
        assert.equal(event.to_status, 'paid');
        assert.equal(event.metadata.source, confirmedBackfill);
        assert.equal(event.metadata.confirmed_by, confirmer);
        assert.equal(event.metadata.confirmed_on, '2026-09-03');
        assert.equal(event.metadata.old_paid_on, null);
        assert.equal(event.metadata.new_paid_on, target[2]);
        assert.equal(event.metadata.amount, target[1]);
        assert.equal(event.metadata.budget_scope, 'costs');
        assert.equal(event.metadata.cost_category, target[3]);
      }
      await applyConfirmedBackfill();
      assert.deepEqual(await requestSnapshot(), afterRows);
      assert.deepEqual(await q('select * from public.payment_request_events order by payment_request_id'), events);
    });

    await test('confirmed backfill skips missing actor/rows and financial or lifecycle drift without overwriting', async () => {
      await asActor('');
      await applyConfirmedBackfill();
      assert.equal((await requestSnapshot()).length, 0);
      await q("insert into public.profiles(id, full_name, role) values ($1, 'Сергей', 'admin')", [confirmer]);
      await applyConfirmedBackfill();
      assert.equal((await requestSnapshot()).length, 0);
      assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 0);
      await q('delete from public.profiles where id = $1', [confirmer]);
      const driftCases = [
        ['amount', 'amount = amount + 1'],
        ['scope', "budget_scope = 'general', cost_category = null"],
        ['type', "expense_type = 'planned'"],
        ['category', "cost_category = 'other'"],
        ['date', "expected_payment_on = '2026-09-04'"],
        ['project', "project_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'"],
        ['owner', `user_id = '${actor}'`],
        ['requester', `requester_user_id = '${actor}'`],
        ['status', "status = 'pending'"],
        ['paid metadata', `paid_by = '${actor}', paid_at = now()`],
        ['already paid', `status = 'paid', paid_on = expected_payment_on, paid_on_source = 'entered', paid_by = '${actor}', paid_at = now()`],
        ['missing row', null],
        ['missing confirmer', null],
      ];
      for (const [label, change] of driftCases) {
        await db.exec('savepoint drift_case');
        await seedConfirmedCosts();
        await q("insert into public.projects(id, client) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Drift fixture')");
        const id = confirmedCosts[0][0];
        if (label === 'missing row') await q('delete from public.payment_requests where id = $1', [id]);
        else if (label === 'missing confirmer') await q('delete from public.profiles where id = $1', [confirmer]);
        else await q(`update public.payment_requests set ${change} where id = $1`, [id]);
        const before = await requestSnapshot();
        await applyConfirmedBackfill();
        const after = await requestSnapshot();
        const skipped = before.find(({ row }) => row.id === id);
        if (label === 'missing confirmer') assert.deepEqual(after, before);
        else if (skipped) assert.deepEqual(after.find(({ row }) => row.id === id), skipped, label);
        assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, label === 'missing confirmer' ? 0 : 5, label);
        await db.exec('rollback to drift_case');
      }
    });

    await test('same-month confirmed backfill does not increase over-limit or incomplete budgets', async () => {
      for (const issue of ['over_limit', 'missing_fx']) {
        await db.exec('savepoint budget_case');
        await seedConfirmedCosts();
        if (issue === 'over_limit') {
          await db.exec('alter table public.payment_requests disable trigger user');
          await q(`insert into public.payment_requests(user_id, requester_user_id, requester_name, department,
            description, amount, expense_type, budget_scope, cost_category, expected_payment_on, status)
            values ($1, $1, 'Other requester', 'outreach', 'Legacy over-cap fixture', 550000,
              'one_time', 'costs', 'other', '2026-09-01', 'approved')`, [actor]);
          await db.exec('alter table public.payment_requests enable trigger user');
        } else {
          await db.exec('alter table public.email_subscriptions disable trigger user');
          await q(`insert into public.email_subscriptions(project_name, next_billing_date, billing_amount, currency, status)
            values ('Legacy missing FX', '2026-09-01', 100, 'USD', 'keep')`);
          await db.exec('alter table public.email_subscriptions enable trigger user');
        }
        const before = await summary('2026-09-01');
        if (issue === 'over_limit') assert.ok(before.costBudget.used > before.costBudget.limit);
        else assert.equal(before.costBudget.dataComplete, false);
        await applyConfirmedBackfill();
        const after = await summary('2026-09-01');
        assert.equal(after.costBudget.paid - before.costBudget.paid, 107128);
        assert.equal(before.costBudget.reserved - after.costBudget.reserved, 107128);
        for (const key of ['used', 'remaining', 'dataComplete']) assert.equal(after.costBudget[key], before.costBudget[key]);
        await db.exec('rollback to budget_case');
      }
    });
  }

  // Approved extension: exercise the actual SQL locally, without adding CI work.
  if (mode !== 'baseline') {
    if (!process.argv.includes('--before-general')) {
      await db.exec(readFileSync(join(migrationDir, generalMigration), 'utf8'));
    }
    async function manage(request, action = 'approve', comment = null) {
      return (await q(`select public.transition_payment_request($1::uuid, $2, $3::timestamptz, $4) as result`,
        [request.id, action, request.updated_at, comment]))[0].result;
    }
    async function allowManager() {
      await q('insert into public.payment_request_managers(user_id) values ($1) on conflict do nothing', [actor]);
    }
    await test('general entries record paid fact within cap, preserve old approvals, and require planned/excess approval', async () => {
      const key = randomUUID();
      const result = await submit({ key, scope: 'general', amount: 401 });
      assert.equal(result.request.status, 'paid');
      assert.equal(result.request.paid_on, today);
      assert.equal(result.outcome, 'recorded_paid');
      assert.equal(result.summary.paidOneTime, 401);
      assert.equal(result.summary.reservedOneTime, 0);
      assert.deepEqual(await submit({ key, scope: 'general', amount: 401 }), result);
      assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 1);
      const planned = await submit({ scope: 'general', type: 'planned' });
      const over = await submit({ scope: 'general', amount: 75001 });
      assert.equal(planned.request.status, 'pending');
      assert.equal(over.request.status, 'pending');
      assert.equal(planned.request.approval_reason, 'planned');
      assert.equal(over.request.approval_reason, 'limit_exceeded');
      await rejected(() => manage(planned.request), 'payment_request_forbidden');
      const [old] = await q(`insert into public.payment_requests(user_id, requester_user_id, requester_name,
        department, description, amount, expense_type, budget_scope, expected_payment_on, status)
        values ($1, $1, 'Old author', 'outreach', 'Untouched old approval', 500, 'one_time', 'general', $2, 'approved') returning id`, [actor, today]);
      const before = await requestSnapshot();
      await db.exec(readFileSync(join(migrationDir, generalMigration), 'utf8'));
      assert.deepEqual(await requestSnapshot(), before);
      assert.equal((await q('select public.payment_request_api_record($1) as r', [old.id]))[0].r.status, 'approved');
      const legacyKey = randomUUID();
      const legacyArgs = [legacyKey, today];
      const legacySql = `select public.submit_payment_request($1::uuid, 'outreach', 'Legacy endpoint', 10,
        null, null, 'one_time', $2::date, 'normal', null) as result`;
      const legacyResult = (await q(legacySql, legacyArgs))[0].result;
      assert.equal(legacyResult.request.status, 'paid');
      assert.deepEqual((await q(legacySql, legacyArgs))[0].result, legacyResult);
      // The old RPC hashed a payload without scope/category; keep that contract.
      const [fingerprint] = await q(`select submission_fingerprint = encode(sha256(convert_to(jsonb_build_object(
        'department', 'outreach', 'description', 'Legacy endpoint', 'amount', '10.00', 'project_id', null,
        'comment', null, 'expense_type', 'one_time', 'expected_payment_on', $2::date, 'urgency', 'normal',
        'document_url', null)::text, 'utf8')), 'hex') as unchanged
        from public.payment_requests where id = $1`, [legacyResult.request.id, today]);
      assert.equal(fingerprint.unchanged, true);
      const [acl] = await q(`select
        has_function_privilege('authenticated', 'public.payment_requests_read_model(date)', 'execute') as team_read,
        has_function_privilege('anon', 'public.payment_requests_read_model(date)', 'execute') as anon_read,
        has_function_privilege('authenticated', 'public.payment_request_today()', 'execute') as clock,
        has_function_privilege('authenticated', 'public.payment_request_effective(public.payment_requests)', 'execute') as helper`);
      assert.deepEqual(acl, { team_read: true, anon_read: false, clock: false, helper: false });
      await asActor('');
      await rejected(() => q('select public.payment_requests_read_model($1::date)', [month]), 'payment_request_forbidden');
    });
    await test('Anya approval records fact with its entered date, preserves decision audit and rejects stale actions', async () => {
      await allowManager();
      for (const input of [{ scope: 'general', type: 'planned' }, { scope: 'general', amount: 75001 }]) {
        const pending = await submit(input);
        const result = await manage(pending.request);
        assert.equal(result.outcome, 'paid');
        assert.equal(result.request.status, 'paid');
        assert.equal(result.request.paid_on, today);
        assert.equal(result.request.decided_by, actor);
        assert.equal(result.request.paid_by, actor);
        const [event] = await q("select * from public.payment_request_events where payment_request_id = $1 and event_type = 'approve'", [result.request.id]);
        assert.equal(event.to_status, 'paid');
        assert.equal(event.metadata.new_paid_on, today);
        await rejected(() => manage(result.request, 'reject', 'Too late'), 'payment_request_invalid_transition');
      }
      const [dates] = await q("select ($1::date - interval '1 month')::date::text as previous", [month]);
      const past = await submit({ scope: 'general', date: dates.previous, amount: 321 });
      assert.equal(past.request.paid_on, dates.previous);
      assert.equal(past.summary.paidOneTime, 321);
    });
    await test('future automatic payments switch reserve to fact on Moscow date across every reader without writes or duplicate accounting', async () => {
      await allowManager();
      const key = randomUUID();
      const future = await submit({ key, scope: 'general', date: nextMonth, amount: 5000 });
      const planned = await submit({ scope: 'general', type: 'planned', date: nextMonth, amount: 300 });
      const decision = await manage(planned.request);
      assert.equal(future.request.status, 'approved');
      assert.equal(future.request.auto_payment_on, nextMonth);
      assert.equal(decision.request.status, 'approved');
      assert.equal(decision.request.auto_payment_on, nextMonth);
      const before = await summary(nextMonth);
      assert.equal(before.reservedOneTime, 5000);
      assert.equal(before.paidAll, 0);
      assert.equal(before.approvedCount, 2);
      const snapshot = await requestSnapshot();
      const events = await q('select to_jsonb(e) as row from public.payment_request_events e order by id');
      // Advance only the private clock inside this rolled-back local transaction.
      await db.exec(`create or replace function public.payment_request_today() returns date language sql stable as $$ select '${nextMonth}'::date $$`);
      const after = await summary(nextMonth);
      assert.equal(after.paidOneTime, 5000);
      assert.equal(after.reservedOneTime, 0);
      assert.equal(after.paidAll, 5300);
      assert.equal(after.approvedCount, 0);
      assert.equal(after.remaining, before.remaining);
      assert.equal((await summary(month)).paidAll, 0);
      for (const rpc of ['list_payment_requests', 'list_payment_requests_with_budget']) {
        const rows = await q(`select * from public.${rpc}($1::date)`, [nextMonth]);
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.status, 'paid');
          assert.equal(row.paid_on instanceof Date ? row.paid_on.toISOString().slice(0, 10) : row.paid_on, nextMonth);
        }
      }
      const [read] = await q('select public.payment_requests_read_model($1::date) as r', [nextMonth]);
      assert.equal(read.r.asOf, nextMonth);
      assert.equal(read.r.summary.paidAll, 5300);
      assert.equal(read.r.requests.filter(r => r.status === 'paid').length, 2);
      const retry = await submit({ key, scope: 'general', date: nextMonth, amount: 5000 });
      assert.equal(retry.request.status, 'paid');
      assert.equal(retry.outcome, 'recorded_paid');
      await rejected(() => manage(future.request, 'reject', 'Stale future row'), 'payment_request_invalid_transition');
      assert.deepEqual(await requestSnapshot(), snapshot);
      assert.deepEqual(await q('select to_jsonb(e) as row from public.payment_request_events e order by id'), events);
      const cost = await submit({ amount: 100 });
      assert.equal(cost.request.status, 'paid');
      assert.equal(cost.summary.costBudget.paid, 100);
      assert.equal(cost.summary.costBudget.reserved, 0);
      assert.equal(cost.summary.paidOneTime, 0);
    });
    await test('confirmed Alina gifts move only 2016 from reserve to fact, preserve dates and retry safely', async () => {
      await asActor('');
      await q("insert into public.profiles(id, full_name, role) values ($1, 'Алина', 'admin'), ($2, 'Сергей', 'admin')", [alina, confirmer]);
      for (const [id, amount, date] of gifts) {
        await q(`insert into public.payment_requests(id, user_id, requester_user_id, requester_name, department,
          description, amount, expense_type, budget_scope, expected_payment_on, status)
          values ($1, $2, $2, 'Алина', 'outreach', 'Confirmed gift', $3, 'one_time', 'general', $4, 'approved')`, [id, alina, amount, date]);
      }
      await q(`insert into public.payment_requests(user_id, requester_user_id, requester_name, department,
        description, amount, expense_type, budget_scope, expected_payment_on, status)
        values ($1, $1, 'Алина', 'outreach', 'Future prize', 5000, 'one_time', 'general', '2026-09-30', 'approved')`, [alina]);
      const beforeRows = await requestSnapshot();
      const before = await summary('2026-09-01');
      await db.exec(readFileSync(join(migrationDir, giftsMigration), 'utf8'));
      const after = await summary('2026-09-01');
      assert.equal(after.paidOneTime - before.paidOneTime, 2016);
      assert.equal(before.reservedOneTime - after.reservedOneTime, 2016);
      assert.equal(after.remaining, before.remaining);
      const afterRows = await requestSnapshot();
      for (const { row } of afterRows) {
        const gift = gifts.find(([id]) => id === row.id);
        if (gift) {
          assert.equal(row.status, 'paid');
          assert.equal(row.paid_on, gift[2]);
          assert.equal(row.paid_by, confirmer);
        } else assert.deepEqual(row, beforeRows.find(r => r.row.id === row.id).row);
      }
      assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 2);
      await db.exec(readFileSync(join(migrationDir, giftsMigration), 'utf8'));
      assert.deepEqual(await requestSnapshot(), afterRows);
      assert.equal((await q('select count(*)::int as n from public.payment_request_events'))[0].n, 2);
      // A changed amount must never be silently corrected into a paid fact.
      await q("update public.payment_requests set status = 'approved', paid_on = null, paid_on_source = null, paid_by = null, paid_at = null, amount = amount + 1 where id = $1", [gifts[0][0]]);
      const drifted = await requestSnapshot();
      await db.exec(readFileSync(join(migrationDir, giftsMigration), 'utf8'));
      assert.deepEqual(await requestSnapshot(), drifted);
    });
  }

  console.log(JSON.stringify({ mode, passed: testCount - failures.length, failed: failures.length, failures }));
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(error.message, error.cause?.detail ?? '', error.cause?.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
