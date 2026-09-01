/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260901_0003_tech_calendar_cost_budget.sql'),
  'utf8',
);

describe('technician calendar company-cost budget migration', () => {
  it('freezes accepted technician-calendar charges in RUB and fails closed without FX', () => {
    expect(migration).toMatch(/alter table public\.tech_subscriptions[\s\S]*cost_amount_rub numeric\(12, 2\)/);
    expect(migration).toMatch(/create or replace function public\.freeze_tech_subscription_cost/);
    expect(migration).toMatch(/public\.email_subscription_amount_rub\([\s\S]*new\.amount[\s\S]*new\.currency[\s\S]*new\.next_billing_date/);
    expect(migration).toMatch(/if new\.status <> 'keep' then[\s\S]*new\.cost_amount_rub := null/);
    expect(migration).toMatch(/raise exception 'payment_request_cost_budget_incomplete'/);
    expect(migration).toMatch(/create trigger tech_subscriptions_freeze_cost/);
  });

  it('keeps an append-only paid ledger with one frozen charge per cycle', () => {
    expect(migration).toMatch(/create table if not exists public\.tech_subscription_cost_events/);
    expect(migration).toMatch(/subscription_id uuid not null/);
    expect(migration).not.toMatch(/subscription_id uuid[^,]*references public\.tech_subscriptions/);
    expect(migration).toMatch(/billing_date date not null/);
    expect(migration).toMatch(/service_name text not null/);
    expect(migration).toMatch(/amount_rub numeric\(12, 2\) not null/);
    expect(migration).toMatch(/paid_at timestamptz not null default now\(\)/);
    expect(migration).toMatch(/paid_by uuid references public\.profiles\(id\) on delete set null/);
    expect(migration).toMatch(/unique \(subscription_id, billing_date\)/);
    expect(migration).toMatch(/create or replace function public\.protect_tech_subscription_cost_events/);
    expect(migration).toMatch(/new\.paid_by is null[\s\S]*old\.paid_by is not null[\s\S]*to_jsonb\(new\) - 'paid_by'[\s\S]*return new/);
    expect(migration).toMatch(/raise exception 'tech_subscription_cost_events_append_only'/);
    expect(migration).toMatch(/before update or delete on public\.tech_subscription_cost_events/);
  });

  it('locks paid live cycles and rejects dates already archived in the ledger', () => {
    expect(migration).toMatch(/create or replace function public\.protect_tech_subscription_paid_cycle/);
    expect(migration).toMatch(/pg_catalog\.pg_trigger_depth\(\) > 1[\s\S]*new\.decision_by[\s\S]*new\.created_by[\s\S]*to_jsonb\(new\) - 'decision_by' - 'created_by'[\s\S]*return new/);
    expect(migration).toMatch(/old\.status = 'keep'[\s\S]*old\.next_billing_date <= v_today[\s\S]*not exists[\s\S]*tech_subscription_paid_cycle_locked/);
    expect(migration).toMatch(/new\.id[\s\S]*new\.next_billing_date[\s\S]*tech_subscription_cycle_already_archived/);
    expect(migration).toMatch(/create trigger tech_subscriptions_protect_paid_cycle[\s\S]*before insert or update or delete/);
  });

  it('adds only keep rows plus archived cycles to the other company-cost category', () => {
    expect(migration).toMatch(/create or replace function public\.payment_request_month_summary\(p_month date\)/);
    expect(migration).toMatch(/subscription\.status = 'keep'/);
    expect(migration).toMatch(/subscription\.next_billing_date <= v_today/);
    expect(migration).toMatch(/subscription\.next_billing_date > v_today/);
    expect(migration).toMatch(/from public\.tech_subscription_cost_events/);
    expect(migration).toMatch(/not exists \([\s\S]*event\.subscription_id = subscription\.id[\s\S]*event\.billing_date = subscription\.next_billing_date/);
    expect(migration).toMatch(/'techPaid', v_tech_paid/);
    expect(migration).toMatch(/'techReserved', v_tech_reserved/);
    expect(migration).toMatch(/'paidAll', v_paid_all \+ v_mail_paid \+ v_tech_paid/);
    expect(migration).toMatch(/select 'other', v_tech_paid, v_tech_reserved/);
    expect(migration).toMatch(/'dataComplete', v_missing_fx_count = 0/);
  });

  it('serializes and hard-caps both current rows and archived events', () => {
    expect(migration).toMatch(/create or replace function public\.enforce_tech_calendar_cost_budget/);
    expect(migration).toMatch(/perform public\.lock_payment_request_months\(v_lock_months\)/);
    expect(migration).toMatch(/create constraint trigger tech_subscriptions_cost_budget_guard/);
    expect(migration).toMatch(/create constraint trigger tech_subscription_cost_events_budget_guard/);
    expect(
      migration.match(/execute function public\.enforce_tech_calendar_cost_budget\(\)/g),
    ).toHaveLength(2);
    expect(migration).toMatch(/perform public\.assert_payment_cost_budget_month\(v_month\)/);
    expect(migration).toMatch(/event\.amount_rub - coalesce\(subscription\.cost_amount_rub, 0\)/);
    expect(migration).toMatch(/payment_request_cost_limit_exceeded/);
  });

  it('renews atomically, archives the old frozen cycle, and returns the new date', () => {
    const rpcStart = migration.indexOf(
      'create or replace function public.renew_tech_subscription_with_budget',
    );
    const rpcEnd = migration.indexOf('revoke all on function', rpcStart);
    const rpc = migration.slice(rpcStart, rpcEnd);
    const update = rpc.indexOf('update public.tech_subscriptions');
    const insert = rpc.indexOf('insert into public.tech_subscription_cost_events');

    expect(rpcStart).toBeGreaterThan(-1);
    expect(rpc).toMatch(/p_subscription_id uuid,[\s\S]*p_next_billing_date date,[\s\S]*p_next_amount numeric,[\s\S]*p_actor_id uuid,[\s\S]*p_expected_updated_at timestamptz/);
    expect(rpc).toMatch(/returns date/);
    expect(rpc).toMatch(/for update/);
    expect(rpc).toMatch(/tech_subscription_not_found/);
    expect(rpc).toMatch(/tech_subscription_conflict/);
    expect(rpc).toMatch(/payment_request_cost_budget_incomplete/);
    expect(rpc).toMatch(/payment_request_cost_limit_exceeded/);
    expect(update).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(insert);
    expect(rpc).toMatch(/v_subscription\.next_billing_date > v_today/);
    expect(rpc).toMatch(/status = 'active'/);
    expect(rpc).toMatch(/decision_by = null/);
    expect(rpc).toMatch(/return p_next_billing_date/);
  });

  it('exposes renewal only to the service role', () => {
    expect(migration).toMatch(/revoke all on function public\.renew_tech_subscription_with_budget[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.renew_tech_subscription_with_budget[\s\S]*to service_role/);
    expect(migration).not.toMatch(/grant execute on function public\.renew_tech_subscription_with_budget[\s\S]{0,250}to authenticated/);
  });
});
