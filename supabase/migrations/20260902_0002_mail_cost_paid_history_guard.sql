-- Each mail calendar row is one billing cycle. Once an accepted cycle is due,
-- the cost summary reports that row as paid; it must no longer be rewritten.
-- Future accepted cycles remain cancellable and release their reservation.

create or replace function public.protect_email_subscription_paid_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_fills_missing_fx boolean := false;
begin
  if old.status <> 'keep' or old.next_billing_date > v_today then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Legacy accepted cycles may have no frozen amount until historical FX is
  -- available. Filling that single missing field restores known fact, without
  -- changing any payment inputs. The earlier freeze trigger ignores the caller's
  -- amount; verify the trusted conversion again before allowing the one-time fill.
  if tg_op = 'UPDATE'
     and old.cost_amount_rub is null
     and new.cost_amount_rub is not null
  then
    v_fills_missing_fx := new.cost_amount_rub = public.email_subscription_amount_rub(
       old.billing_amount, old.currency, old.next_billing_date
    );
  end if;

  if v_fills_missing_fx
     and (to_jsonb(new) - 'cost_amount_rub')
       is not distinct from (to_jsonb(old) - 'cost_amount_rub')
  then
    return new;
  end if;

  -- Keep the existing ON DELETE SET NULL project/profile FKs usable. Only a
  -- nested FK action may clear these references, with all other data intact.
  -- That same update can also fill missing FX through the trusted rule above.
  -- Direct admin/service-role writes must not use this exception to edit fact.
  if tg_op = 'UPDATE'
     and pg_catalog.pg_trigger_depth() > 1
     and (
       new.project_id is not distinct from old.project_id
       or (old.project_id is not null and new.project_id is null)
     )
     and (
       new.lead_decision_by is not distinct from old.lead_decision_by
       or (old.lead_decision_by is not null and new.lead_decision_by is null)
     )
     and (
       new.created_by is not distinct from old.created_by
       or (old.created_by is not null and new.created_by is null)
     )
     and (
       new.project_id is distinct from old.project_id
       or new.lead_decision_by is distinct from old.lead_decision_by
       or new.created_by is distinct from old.created_by
     )
     and (
       new.cost_amount_rub is not distinct from old.cost_amount_rub
       or v_fills_missing_fx
     )
     and (to_jsonb(new) - 'project_id' - 'lead_decision_by' - 'created_by' - 'cost_amount_rub')
       is not distinct from (to_jsonb(old) - 'project_id' - 'lead_decision_by' - 'created_by' - 'cost_amount_rub')
  then
    return new;
  end if;

  raise exception 'email_subscription_paid_cycle_locked' using errcode = '55000';
end;
$$;

drop trigger if exists email_subscriptions_protect_paid_cycle
  on public.email_subscriptions;
create trigger email_subscriptions_protect_paid_cycle
  before update or delete on public.email_subscriptions
  for each row
  execute function public.protect_email_subscription_paid_cycle();

revoke all on function public.protect_email_subscription_paid_cycle()
  from public, anon, authenticated;

comment on function public.protect_email_subscription_paid_cycle() is
  'Preserves accepted mail calendar cycles as immutable paid history from their Moscow billing date; future cycles remain editable/cancellable.';
