# Instantly: durable recovery without repeated paid classification

Status: implemented locally; migrations and production rollout require separate approval.

## Why the backlog could repeat

Technical retries retained the qualification id but not the successful raw AI
assessment, its paid-attempt count, or the page cursor used to prove ownership.
A restart or a later recovery pass could start expensive work again. Reply
discovery also discarded earlier successful pages when a later page failed.
An unconditional provider-campaign mismatch deferral could prevent a stable
mailbox mapping from ever reaching the existing ownership proof.

## Changes

- Successful raw AI responses are saved before downstream guards/writes and
  reparsed with current rules on replay. Keys bind the exact reply/account/owner,
  request text, both semantic-pass prompts and requested model/inference profile.
- The initial pass and adjudication share three potentially paid HTTP attempts
  per identical input, atomically reserved before dispatch. Process crashes and
  uncertain network outcomes consume a reservation. Explicit 402/429 responses
  release it and install a durable five-minute/one-minute cooldown. This is an
  application accounting safeguard, not a reconciliation with Requesty billing.
- Recovery saves both ownership search cursors and evidence after every page.
  A partial cross-owner scan is never proof of ownership. Completed evidence is
  reused for six hours; changed reply/mailbox/account/owner scope starts a new
  proof. Productive page progress resets the unchanged-failure backoff.
- `GET /emails` uses one atomic main-DB rolling budget per configured Instantly
  account: 18/min total, at most 6/min recovery. Cooldown after 429 is shared.
  Missing budget storage fails closed. The recovery cap reserves capacity for
  fresh work, but does not guarantee a minimum recovery quota under fresh load.
- Discovery processes successfully fetched inbound pages even if a later page
  is deferred. It does not treat partial discovery as complete ownership proof.
- Fresh retries (created within two hours) run before backlog, once per minute,
  with a two-minute initial per-row delay. Older active/page-budget work and
  cold rows are separate lanes. Due deadlines and attempt counters survive
  restarts. Page-budget retry delay falls from six hours to fifteen minutes.
  Cold backlog gets up to two attempts every five minutes, with a thirty-minute
  initial per-row delay, still under the shared recovery quota. Unchanged
  failures back off further; productive saved pages do not inflate that backoff.
- A provider email 404 is remembered. Only an actual saved inbound with body,
  timestamp, sender, receiving mailbox and original To/CC can replace that GET.
  All ordinary owner/recipient guards still run. Legacy body-only rows cannot
  bypass those guards; absent source data stays a technical wait with no AI call
  and no repeated GET of the same missing id.

Final lead/not-lead records, already alerted qualifications and handled handoffs
are not reopened by this change. No historical rows are bulk-reclassified and
no business verdict is manufactured to reduce the pending count.

## Rollout boundary

Apply only after separate production approval, with a verified current host and
backup/change plan. Do not run against a historical/rollback database endpoint.

1. Main Portal DB: `supabase/migrations/20260909_0001_instantly_email_read_budget.sql`.
2. Each operational Instantly DB serving a qualification worker, in order:
   - `supabase/instantly-migrations/20260909_0001_qualification_ai_checkpoints.sql`;
   - `supabase/instantly-migrations/20260909_0002_ownership_evidence_progress.sql`;
   - `supabase/instantly-migrations/20260909_0003_qualification_retry_state.sql`.
3. Verify RPC visibility and service-role permissions, then roll out the reviewed
   application/worker code through the normal approved release process.
4. Ensure standalone dataset email readers use the same main-DB budget/account
   identity. Independent API keys for the same workspace must not use separate
   budget identities. External unmanaged readers can still consume provider quota.
5. Read-only postdeploy verification: fresh reply age/oldest unresolved age,
   qualification transitions, persisted page progress, per-account 429 frequency,
   unchanged-input paid reservations/cache hits, 404 source waits, and duplicate
   notification counts. Check old backlog and fresh arrivals separately.

Deploying this code before its migrations intentionally defers provider/AI work;
it must not silently fall back to the former unbounded behavior. This patch
does not deploy anything or drain the live backlog by itself.

## Limitations that must remain visible

An external outage, absent original source, unresolved owner, or three uncertain
paid attempts can still leave a technical wait. It is not manual qualification
and not a negative verdict. Unchanged-input budget exhaustion cannot safely be
turned into a lead/not-lead result or reset every day. A separately evaluated
fallback inside an approved total budget is a possible follow-up.

Queue <= 5 and age <= 2 hours are operational targets, not guarantees when
provider data is unavailable. Alert on violations; never hide rows to meet them.

References: [Instantly list email limit](https://developer.instantly.ai/api-reference/email/list-email),
[workspace rate limits](https://developer.instantly.ai/getting-started/rate-limit),
[get email](https://developer.instantly.ai/api-reference/email/get-email).
