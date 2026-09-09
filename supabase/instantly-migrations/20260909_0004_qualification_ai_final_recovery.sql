-- Preserve every existing input fingerprint and successful output. The normal
-- reserve RPC still stops at three; only this separate path may reserve four.
-- These are lifetime potentially-paid attempts, not a daily retry allowance.
begin;

alter table public.instantly_qualification_ai_budgets
  drop constraint if exists instantly_qualification_ai_budgets_attempts_check;
alter table public.instantly_qualification_ai_budgets
  add constraint instantly_qualification_ai_budgets_attempts_check
  check (attempts between 0 and 4);
alter table public.instantly_qualification_ai_checkpoints
  drop constraint if exists instantly_qualification_ai_checkpoints_attempts_check;
alter table public.instantly_qualification_ai_checkpoints
  add constraint instantly_qualification_ai_checkpoints_attempts_check
  check (attempts between 0 and 4);

create index if not exists idx_qualification_ai_active_budget
  on public.instantly_qualification_ai_checkpoints (budget_key)
  where lease_token is not null;

create or replace function public.reserve_instantly_qualification_ai_recovery(
  p_checkpoint_key text, p_budget_key text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_budget public.instantly_qualification_ai_budgets%rowtype;
  v_checkpoint public.instantly_qualification_ai_checkpoints%rowtype;
  v_token uuid;
begin
  if p_checkpoint_key is null or p_budget_key is null
     or p_checkpoint_key !~ '^[a-f0-9]{64}$' or p_budget_key !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid qualification checkpoint key';
  end if;
  -- Recovery cannot create a fresh budget or reset an exhausted one.
  select * into v_budget from public.instantly_qualification_ai_budgets
    where budget_key = p_budget_key for update;
  if not found then return jsonb_build_object('state', 'exhausted'); end if;
  insert into public.instantly_qualification_ai_checkpoints(checkpoint_key, budget_key)
    values(p_checkpoint_key, p_budget_key) on conflict do nothing;
  select * into strict v_checkpoint from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key for update;
  if v_checkpoint.budget_key <> p_budget_key then
    raise exception 'Qualification checkpoint budget mismatch';
  end if;
  if v_checkpoint.raw_response is not null then
    return jsonb_build_object('state', 'cached', 'raw_response', v_checkpoint.raw_response);
  end if;
  if v_budget.cooldown_until > clock_timestamp() or exists (
    select 1 from public.instantly_qualification_ai_checkpoints
    where budget_key = p_budget_key and lease_token is not null
      and lease_until > clock_timestamp()
  ) then
    return jsonb_build_object('state', 'busy');
  end if;
  if v_budget.attempts <> 3 then
    return jsonb_build_object('state', 'exhausted');
  end if;
  v_token := gen_random_uuid();
  update public.instantly_qualification_ai_budgets
    set attempts = attempts + 1, updated_at = clock_timestamp() where budget_key = p_budget_key;
  update public.instantly_qualification_ai_checkpoints
    set attempts = attempts + 1, lease_token = v_token,
        lease_until = clock_timestamp() + interval '2 minutes', updated_at = clock_timestamp()
    where checkpoint_key = p_checkpoint_key;
  -- Existing token-CAS finish/release persists output and refunds only explicit
  -- known no-output rejections. Crashes/timeouts/invalid output remain charged.
  return jsonb_build_object('state', 'reserved', 'lease_token', v_token);
end;
$$;

-- Only an unequivocal no-credit 412 body is assigned http_412_no_credit by the
-- worker. Other 412 responses remain potentially paid; no historical refunds.
create or replace function public.finish_instantly_qualification_ai(
  p_checkpoint_key text, p_lease_token uuid, p_raw_response text, p_error_code text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_budget_key text;
  v_checkpoint public.instantly_qualification_ai_checkpoints%rowtype;
  v_refund boolean;
begin
  if p_raw_response is not null and
     (length(p_raw_response) = 0 or octet_length(p_raw_response) > 65536) then
    raise exception 'Invalid qualification checkpoint response';
  end if;
  select budget_key into v_budget_key from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key;
  if v_budget_key is null then return jsonb_build_object('state', 'lease_lost'); end if;
  perform 1 from public.instantly_qualification_ai_budgets where budget_key = v_budget_key for update;
  select * into strict v_checkpoint from public.instantly_qualification_ai_checkpoints
    where checkpoint_key = p_checkpoint_key for update;
  if p_lease_token is null or v_checkpoint.lease_token is distinct from p_lease_token then
    return jsonb_build_object('state', 'lease_lost');
  end if;
  v_refund := p_raw_response is null and coalesce(
    p_error_code in ('http_402', 'http_429', 'http_412_no_credit'), false);
  if v_refund then
    update public.instantly_qualification_ai_budgets
      set attempts = attempts - 1,
          cooldown_until = greatest(cooldown_until,
            clock_timestamp() + case when p_error_code = 'http_429'
              then interval '1 minute' else interval '5 minutes' end),
          updated_at = clock_timestamp()
      where budget_key = v_budget_key;
  end if;
  update public.instantly_qualification_ai_checkpoints
    set raw_response = p_raw_response, lease_token = null, lease_until = null,
        attempts = attempts - case when v_refund then 1 else 0 end,
        last_error_code = case when p_raw_response is null then left(p_error_code, 80) else null end,
        updated_at = clock_timestamp()
    where checkpoint_key = p_checkpoint_key;
  return jsonb_build_object('state', case when p_raw_response is null then 'released' else 'saved' end);
end;
$$;

revoke all on function public.reserve_instantly_qualification_ai_recovery(text, text) from public;
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'instantly'] loop
    if exists(select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.reserve_instantly_qualification_ai_recovery(text, text) from %I', v_role);
      if v_role in ('service_role', 'instantly') then
        execute format('grant execute on function public.reserve_instantly_qualification_ai_recovery(text, text) to %I', v_role);
      end if;
    end if;
  end loop;
end;
$$;

-- Once-only scheduling repair for generated technical waits that were parked
-- under the former three-attempt cap. No source/verdict/attempt counter changes.
-- The marker makes a migration rerun a no-op for adopted rows; final exhaustion
-- uses ai_final_budget_exhausted and must never match this older failure kind.
-- Main-DB notification state is deliberately NOT inferred here: the worker's
-- recovery disposition check must still prove not-forwarded/not-notified before
-- claiming any row or making a paid call.
update public.instantly_lead_qualifications q
set recovery_failure_kind = 'ai_final_review_due',
    recovery_next_at = least(recovery_next_at, clock_timestamp() + interval '1 minute')
where q.status = 'pending' and q.ai_confidence = 0
  and q.recovery_failure_kind = 'ai_budget_exhausted'
  and q.error_message like '%AI paid attempt budget exhausted%'
  and (q.ai_reason like 'Автоматическая повторная квалификация:%'
    or q.ai_reason like 'Не удалось однозначно определить проект-владельца ответа:%')
  and q.instantly_email_id is not null and q.instantly_email_id not like 'webhook:%'
  and not exists (select 1 from public.client_forwarded_leads f where f.qualification_id = q.id)
  and not exists (select 1 from public.instantly_pending_handoffs h where h.qualification_id = q.id);

commit;
notify pgrst, 'reload schema';
