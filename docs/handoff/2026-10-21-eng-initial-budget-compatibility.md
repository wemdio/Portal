# ENG: initial adaptive collection budget compatibility

Date: 2026-10-21. Destination branch: Sergey. Follow-up to
[the ready-contact target change](2026-10-21-eng-ready-contact-target.md).

## Production observation

The user deployed main `6646114fc2fb0039782206c5df0e460bae948bc1`
(including `1a35b5c58`) and explicitly approved one new Fund service providers
collection: 500 ready addresses, 2,000 reserve, the existing countries and
restrictions, five addresses per company and one $5 allowance. No letters.

Exactly one new base/job was created at 13:17:43 UTC. It stopped at 13:18:12
before the collection stage or any provider call. Observed state: base failed,
job incorrectly done, zero rows, zero tokens, zero cost, no budget ledger and
no spend reservations. Autopilot stayed false; no email jobs or launch intents
were created. Old bases were preserved.

Private operator receipts and the exact base/job identifiers are in
`/private/tmp/portal-eng-target-run-20261021/`. Do not rerun its enqueue script:
the one approved enqueue was already executed.

## Cause and correction

New manual ENG enqueue writes three initial objects in `collect_info`:
`eng_collection_target`, `eng_collection_work`, and `eng_collection_pool`.
The existing SQL `he_eng_base_budget_begin` only allowed the older initial
keys, so it returned `missing_history` before creating the money ledger.
The stage wrapper then mistakenly handled this initial refusal like a budget
stop during a collection, manufactured an empty completed wave and returned
success to the worker. This also hid the original diagnostic.

The original mocked stage checks did not exercise the real SQL initializer.
They were insufficient to prove application/migration compatibility. This
release **requires the new migration as well as the HE worker code**.

- `20261021_0003_he_eng_initial_collection_budget.sql` changes only the budget
  initializer. It accepts the exact initial target/work/pool objects produced
  by enqueue: no rows, no previous waves, no active work, no extra keys.
  Reserve targets must be integers from 2,000 through 5,000; the frozen company
  cap must match the pool. Legacy initial metadata is still supported.
- Partial/progressed objects, historical work, paid/terminal jobs, analysis,
  templates, pre-policy bases and wrong owners remain refused. Existing
  ledgers, reservations, policy timestamp and the fixed $5 limit are unchanged.
  Replacing the function preserves its owner, ACL and security settings.
- The stage wrapper distinguishes failure to open a budget from a failure
  after dispatch. Initial `missing_history`, invalid accounting and unavailable
  RPCs propagate to the ordinary failure path with their original safe error.
  They do not modify the collection round/pool. A later tick may still preserve
  checked contacts at a real budget stop, after confirming the existing ledger
  and unresolved reservation where applicable.

RU and VE2 are unchanged. No new repository test files were created.

## Verification

All checks were local; no paid providers or additional production writes:

- 294 assertions with actual old/new SQL functions in PGlite (PostgreSQL 18.6
  WASM): reproduction of the original failure, 110 metadata fixtures, real
  application enqueue output at four company caps, ownership/history guards,
  ACL preservation, reserve/settle/replay, unknown charges, the $5 limit and
  idempotent migration. This is not a test against production PostgreSQL.
  Script: `/private/tmp/portal-eng-target-run-20261021/pg-check/check.cjs`.
- 43 wrapper scenarios / 140 assertions with the real stage wrapper and budget
  transport; external stages are mocked. Initial refusal, preserved diagnostics,
  invalid/empty/foreign ledgers, read failure and legitimate saved-contact stops.
- Existing adaptive stage harness: 155 assertions; repository isolation/chain
  suites: 47 tests. Core TypeScript, scoped ESLint and HE worker bundle checked.
- Independent review found no blocking issue in the migration or wrapper.

These checks establish the fix's state/accounting behavior, not HST contact
yield. No real target of 500 + 2,000 has been achieved by this stopped run.

## Required next steps and recovery boundary

This fix is not yet deployed. The current failed base is deliberately untouched.
The user handles merge/deployment. Verify the new migration and worker on
production after deployment before any recovery.

Deployment alone will not resume this base: its previous bad completion wrote
terminal job state and synthetic progressed metadata. A separate explicitly
approved recovery must reuse this same base/job, not create a replacement or
reset an existing money journal. Before that transaction:

1. Save the full current base/job privately and compare exact identifiers and
   unchanged expected terminal state.
2. Reconfirm zero cost/tokens, no ledger, no spend requests, no provider calls,
   no constructor job, no rows/analysis, no conflicting active collection,
   autopilot false and no letters/launch intents.
3. Restore only its original initial collection metadata and requeue the same
   job with guarded updates. Preserve original restrictions, created-at times,
   selected hypotheses, company cap and $5 enrollment version. Never delete a
   ledger/reservation or lower recorded costs; any new evidence cancels recovery.
4. Verify exactly one active job and actual stage progress, opened $5 ledger,
   unchanged restrictions and no letters. Monitor the result separately.

The earlier permission covered the one enqueue already performed. It does not
authorize this further production recovery or another collection.
