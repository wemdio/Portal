# VE2: permission for the worker supply eligibility RPC

Date: 2026-10-05. Task checkout: `codex/ve2-preview-recovery-scale`, based on
`origin/test` at `d3f3f4b5b`; delivery branch requested by the user: `Sergey`.
Scope: local implementation and verification. No production writes or deployment.

## Production evidence

Read-only snapshot at 08:56 UTC, saved locally in
`/Users/cybermart/.codex/handoffs/ve2-staffline-status-20261005`:

- StaffLine VE project `523affe8-01fe-4b1e-a584-b4f6415c33f3`, campaign
  `ba5b0ce7-e336-4c15-b458-474a49d108ef`.
- The deployed billing-preflight fix worked: 359 contacts accepted today,
  1 skipped, no uncertain result or capacity block. Lifetime accepted: 409;
  ready reserve: 364. These are upload counts, not first-contacted counts.
- Supply correctly requested another 356 contacts when the reserve fell below
  its 720-contact buffer, but the batch failed before collection with
  `supply eligibility check: permission denied for function ve_require_contact_supply_active`.
- `has_function_privilege` confirmed that `service_role` lacked EXECUTE on
  `public.ve_require_contact_supply_active(uuid,timestamptz)`. The function is
  owned by postgres and SECURITY DEFINER. Only one supply plan had this exact
  error in the snapshot.

## Cause and fix

The original supply migration revoked access to private helpers, including this
guard, without granting it back to `service_role`. Later code invokes it directly
through `supabase.rpc` in `contactSupplyEligibility.ts`. Subsequent
`CREATE OR REPLACE` statements preserved the ACL. Existing SQL smoke checks ran
as the migration owner and missed the permission failure.

Migration `20261005_0062_ve_supply_eligibility_rpc_grant.sql` grants EXECUTE only
to `service_role` and explicitly keeps PUBLIC, anon and authenticated excluded.
It changes neither the function body/owner nor any supply or delivery data.

The existing executable smoke now applies the migration twice and checks the
actual worker role: explicit resume of an errored plan, eligibility after a past
planning deadline, browser-role denial, specialist pause, stale approval, and a
closed Portal project. The delivery ledger identities and states are unchanged
by resume. Existing private-helper denial checks remain in place.

## Validation

- PGlite: `contact-delivery-without-period-sql-smoke.mjs` passed, including the
  new worker-role checks. Log:
  `/Users/cybermart/.codex/handoffs/ve2-supply-grant-20261005/sql.log`.
- Updated fast branch runner from test: 33 suites, 255 passed, 2 skipped,
  9.444 seconds. Log: `ve2-staffline-status-20261005/branch-tests-fix.log`.
- `node --check` for the smoke and `git diff --check` passed.

## After normal deployment

The deployment must apply migration 0062; deploying only application images
cannot repair a database function ACL. The errored StaffLine plan is not silently
resumed by the migration. On StaffLine's Results screen, use **«Повторить поиск»**
(the base supply panel labels the same resume action **«Возобновить пополнение»**).
No additional «Дозалить» action is required for this supply error.

The resume route calls `ve_set_contact_supply_status`. This non-name-cleanup
failure does not reopen a name recovery job; the runner skips the recorded old
failed batch and schedules according to the current deficit. Existing delivery
rows are preserved. Verify the next batch and resulting stock after the user
deploys and resumes; successful production collection is not yet confirmed.
