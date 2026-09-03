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

  console.log(JSON.stringify({ mode, passed: testCount - failures.length, failed: failures.length, failures }));
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(error.message, error.cause?.detail ?? '', error.cause?.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
