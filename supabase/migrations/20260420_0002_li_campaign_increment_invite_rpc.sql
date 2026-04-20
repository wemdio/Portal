-- LinkedIn Outreach: atomic daily-invite counter increment.
--
-- Why: the campaign runner used to do a read-modify-write on
-- `li_campaigns.invites_sent_today` from JS:
--   1) Load campaign at tick start (`select ... invites_sent_today`).
--   2) Optionally `update set invites_sent_today = 0` if a new day started.
--   3) For each successfully sent invite: `update set invites_sent_today = N+1`
--      using the value loaded in step 1.
--
-- Two latent bugs come out of this pattern:
--   - In a single tick that processes up to 20 leads, the in-memory copy of
--     `invites_sent_today` was never refreshed between leads, so multiple
--     leads inside one tick all logged the same `(N/30)` value, and worse —
--     each `update` overwrote the previous one with N+1 instead of N+k.
--   - Two parallel ticks (e.g. after a worker restart that cleared the
--     in-memory `lastTickAt` debounce) could both read N=18 and both write
--     N=19, losing one invite from the daily quota.
--
-- This RPC merges the new-day reset and the increment into one atomic
-- statement. Every successful Unipile `sendInvite` call that doesn't bail
-- out on `already_invited` should call this function and use the returned
-- value as the authoritative new counter (for both the next limit-check and
-- the user-visible log line).

create or replace function public.li_campaign_increment_invite(
  p_campaign_id uuid,
  p_today       date
)
returns integer
language plpgsql
as $$
declare
  new_value integer;
begin
  update public.li_campaigns
  set
    invites_sent_today =
      case
        when last_invite_date = p_today then invites_sent_today + 1
        else 1
      end,
    last_invite_date   = p_today,
    updated_at         = now()
  where id = p_campaign_id
  returning invites_sent_today into new_value;

  if new_value is null then
    raise exception 'li_campaign_increment_invite: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  return new_value;
end;
$$;

comment on function public.li_campaign_increment_invite(uuid, date) is
  'Atomically bumps li_campaigns.invites_sent_today for today (resetting on a new day). Returns the new counter value. Used by the LinkedIn outreach campaign runner to avoid lost updates from concurrent ticks and stale reads inside one tick.';
