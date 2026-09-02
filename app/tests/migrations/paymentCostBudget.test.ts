/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260901_0001_payment_cost_budget.sql'),
  'utf8',
);
const billingCalendarView = readFileSync(
  resolve(process.cwd(), 'src/app/billing-calendar/BillingCalendarView.tsx'),
  'utf8',
);

describe('payment cost budget migration', () => {
  it('keeps the 650,000 RUB cost budget independent from the legacy one-time limit', () => {
    expect(migration).toMatch(/payment_request_cost_month_limit/);
    expect(migration).toMatch(/select 650000::numeric/);
    expect(migration).toMatch(/budget_scope = 'general'[\s\S]*expense_type = 'one_time'/);
    expect(migration).toMatch(/budget_scope = 'costs'/);
  });

  it('uses only calendar rows marked keep and moves them from reserve to fact by billing date', () => {
    expect(migration).toMatch(/subscription\.status = 'keep'/);
    expect(migration).toMatch(/next_billing_date <= v_today/);
    expect(migration).toMatch(/next_billing_date > v_today/);
    expect(migration).toMatch(/'mailPaid', v_mail_paid/);
    expect(migration).toMatch(/'mailReserved', v_mail_reserved/);
  });

  it('converts foreign calendar costs with a historical rate and fails closed when it is absent', () => {
    expect(migration).toMatch(/rate\.rate_date <= p_billing_date/);
    expect(migration).toMatch(/round\(p_amount \* v_rate, 2\)/);
    expect(migration).toMatch(/if p_amount = 0 then\s+return 0/);
    expect(migration).toMatch(/cost_amount_rub numeric/);
    expect(migration).toMatch(/create or replace function public\.freeze_email_subscription_cost/);
    expect(migration).toMatch(/subscription\.cost_amount_rub as amount_rub/);
    expect(migration).not.toMatch(/coalesce\(\s*subscription\.cost_amount_rub,/);
    expect(migration).toMatch(/payment_request_cost_budget_incomplete/);
    expect(migration).toMatch(/'dataComplete', v_missing_fx_count = 0/);
  });

  it('serializes submissions before checking the remaining cost budget', () => {
    const lock = migration.indexOf('perform public.lock_payment_request_months(array[v_month])');
    const summary = migration.indexOf('v_summary := public.payment_request_month_summary(v_month)', lock);
    const insert = migration.indexOf('insert into public.payment_requests', summary);

    expect(lock).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(summary);
    expect(migration).toMatch(/payment_request_cost_limit_exceeded/);
  });

  it('rechecks a cost when its real payment date moves it into another month', () => {
    expect(migration).toMatch(/create or replace function public\.enforce_payment_request_cost_budget/);
    expect(migration).toMatch(/create constraint trigger payment_requests_cost_budget_guard/);
    expect(migration).toMatch(/old_row\.budget_scope = 'costs'/);
    expect(migration).toMatch(/new_row\.budget_scope = 'costs'/);
    expect(migration).toMatch(/payment_request_cost_limit_exceeded/);
    expect(migration).toMatch(/payment_request_cost_budget_incomplete/);
  });

  it('guards Calendar writes with the same month lock and a role-based ACL', () => {
    expect(migration).toMatch(/constraint email_subscriptions_billing_amount_nonnegative/);
    expect(migration).toMatch(/billing_amount >= 0/);
    expect(migration).toMatch(/create or replace function public\.enforce_email_subscription_cost_budget/);
    expect(migration).toMatch(/perform public\.lock_payment_request_months\(v_lock_months\)/);
    expect(migration).toMatch(/create constraint trigger email_subscriptions_cost_budget_guard/);
    expect(migration).toMatch(/actor\.role in \('technician', 'lead', 'director', 'admin'\)/);
    expect(migration).toMatch(/coalesce\(actor\.is_demo, false\) = false/);
    expect(migration).toMatch(/create or replace function public\.can_manage_email_subscriptions/);
    expect(migration).toMatch(/create or replace function public\.can_decide_email_subscriptions/);
    expect(migration).toMatch(/create policy email_subscriptions_insert[\s\S]{0,160}public\.can_manage_email_subscriptions/);
    expect(migration).toMatch(/create policy email_subscriptions_delete[\s\S]{0,360}actor\.role = 'admin'/);
    expect(migration).toMatch(/old\.status not in \('active', 'pending_review'\)/);
    expect(migration).toMatch(/old\.lead_decision is not null/);
    expect(migration).not.toMatch(/create policy email_subscriptions_(?:select|insert|update|delete)[\s\S]{0,180}(?:using|with check) \(true\)/i);
  });

  it('runs pay-today and lead-decision calendar workflows atomically in database RPCs', () => {
    expect(migration).toMatch(/create or replace function public\.record_email_subscription_payment_today/);
    expect(migration).toMatch(/drop function if exists public\.decide_email_subscription\(uuid, text, text\)/);
    expect(migration).toMatch(/create or replace function public\.decide_email_subscription\(\s*p_subscription_id uuid,\s*p_decision text,\s*p_notes text,\s*p_expected_updated_at timestamptz/);
    expect(migration).toMatch(/perform pg_catalog\.pg_advisory_xact_lock/);
    expect(migration).toMatch(/grant execute on function public\.record_email_subscription_payment_today/);
    expect(migration).toMatch(/grant execute on function public\.decide_email_subscription/);

    expect(billingCalendarView).toMatch(/\.rpc\(\s*'record_email_subscription_payment_today'/);
    expect(billingCalendarView).toMatch(/\.rpc\(\s*'decide_email_subscription'/);
    expect(billingCalendarView).toMatch(/p_expected_updated_at:\s*editingItem\.updated_at/);
  });

  it('advances recurring calendar rows by their actual billing cycle and never revives expired rows', () => {
    expect(migration).toMatch(/email_subscription_next_billing_date\(\s*p_date date,\s*p_billing_cycle text\s*\)/);
    expect(migration).toMatch(/when 'monthly' then 1/);
    expect(migration).toMatch(/when 'quarterly' then 3/);
    expect(migration).toMatch(/when 'yearly' then 12/);
    expect(migration).toMatch(/email_subscription_next_billing_date\(\s*v_today,\s*p_billing_cycle\s*\)/);
    expect(migration).toMatch(/email_subscription_next_billing_date\(\s*v_snapshot\.next_billing_date,\s*v_snapshot\.billing_cycle/);
    expect(migration).toMatch(/v_subscription\.status = 'expired'/);
  });

  it('takes the project advisory lock before row locks in lead decisions', () => {
    const start = migration.indexOf('create or replace function public.decide_email_subscription');
    const end = migration.indexOf('create or replace function public.payment_request_api_record', start);
    const decideFunction = migration.slice(start, end);
    const advisoryLock = decideFunction.indexOf('perform public.lock_email_subscription_project_dates');
    const rowLock = decideFunction.indexOf('for update');

    expect(advisoryLock).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(advisoryLock);
    expect(decideFunction).toMatch(/email_subscription_changed_retry/);
    expect(decideFunction).toMatch(/v_subscription\.updated_at is distinct from p_expected_updated_at/);
    expect(migration).toMatch(/'email_subscriptions:project:' \|\| lower\(btrim\(p_project_name\)\)/);
  });

  it('exposes only guarded RPCs to authenticated users', () => {
    expect(migration).toMatch(/revoke all on function public\.list_payment_requests_with_budget[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.list_payment_requests_with_budget\(date\) to authenticated/);
    expect(migration).toMatch(/revoke all on function public\.submit_payment_request_with_budget[\s\S]*from public, anon, authenticated/);
  });
});
