# VE2: Joynio checkpoint recovery and bounded fintech collection

Scope: `codex/ve2-editor-sergey-review` → `Sergey`, based on `ea389cb58`.
Production was read only. No resumes, deployments, migrations, paid API calls or campaign changes were performed.

## Observed production state (15 October, approximately 20:00 UTC)

- Joynio / banking and non-core assets: base `d98be6c2-af9e-4f02-8c05-a9181c2a96a1`, job `8bf82eb1-8ed9-4e1d-8537-f7a140b9681b`. Failed at 16:09 UTC after a gateway error saving the preview checkpoint. 261 saved contacts, round 36, 976 candidates. The last constructor completed with 26 validated rows before the failed save; its output must be reused.
- Profit Gateway / broad fintech and payment providers: base `97d61c53-dd02-4ac4-ab1e-47277095a105`, hypothesis `4b690ec3-fc5f-45b9-a3ba-158829725069`. 338 saved addresses / 185 companies; 290 count toward the 500 target under the existing per-company rule. Stopped at 100 rounds and only 1,554 candidates. Maps supplied 95 batches with a median of 11 candidates (range 3–29); its source was not exhausted. The last 20 batches still produced 38 addresses.
- The maps source includes many terminal/cash-desk locations. A manual check of 20 saved company descriptions found 13 apparent matches, 6 ambiguous cases and one clear ski-resort false positive. This is diagnostic sampling, not a full quality certification.
- The narrow terminal/ATM evidence guard affects exactly 2 of the 338 saved rows. The other 336 are unaffected, not independently reverified. At 20:22 UTC this base had no launch items, outreach runs, campaigns, supply batches or delivery rows.

## Changes

1. Preview checkpoint persistence retries only the same immutable CAS payload, at most three times. A UUID, expected status and revision distinguish our committed write from a competing writer; readback also checks the current job claim. Pauses and cancellation stop recovery. Unknown outcomes do not trigger a second snapshot that could overwrite a newer checkpoint. Recognized gateway failures and exhausted DB timeouts retain normal recovery through the same base and completed child.
2. Existing-contact-only maps collection counts usable rows when filling a batch. It reuses saved source receipts and company facts, preserves excluded/deferred observations and commits cursor/harvest/deferred state together. The existing four-page bound now survives restarts and applies to the whole batch: a partial batch proceeds after four pages. There is no unbounded loop waiting for 100 usable companies. Ordinary paid discovery, candidate/round limits and economic source holds are unchanged.
3. Bare payment-terminal/ATM category evidence cannot establish the venue owner's business. Such admissions are kept uncertain, including saved decisions; automatic or manual review does not repurchase the same unsupported evidence. Actual new activity facts from the same company can pass the reserve selector and normal review, including after an earlier no-progress signature. An exhausted website receipt cannot overwrite this guard. PSP, bank and terminal-manufacturer positive controls remain supported. Paid receipts and relevance context hashes are preserved; only the continuation UI cache version changes.

More useful companies can enter the already permitted paid checks. No new paid source or higher cap is introduced, but total future spend is not guaranteed to equal the prematurely stopped run.

## Validation

- CI branch selector against `ea389cb58`: 75 suites passed, 669 tests passed, 2 skipped.
- Strict TypeScript 5 core and tests, focused ESLint, worker bundle and diff check passed. Local TypeScript 7 package is unavailable; no dependency installation or lockfile change was made.
- Existing tests cover lost replies before/after commit, unknown outcomes, competing revision, cancellation, claim replacement, permanent errors and idempotent continuation; maps partial pages, resume, deduplication, cached site recovery, exclusions, widened cost policy and empty-source bounds; new/saved relevance guards and genuine providers.
- No new test file or `it()` block was added.

## After deployment

1. Confirm the running worker contains this release before resuming anything. Production resumes require explicit authorization for that phase.
2. Continue the existing Joynio base, retaining its completed constructor and saved contacts; verify checkpoint progress, preparation state and no duplicate child.
3. Continue the existing broad fintech base from its saved source position. Record the initial snapshot, batch sizes, ready/contact-goal counts, rejection reasons and existing usage ledger. Do not reset cursors or promise 500 contacts: source quality and actual market coverage remain constraints.
4. Saved `row_count` and target statistics update on worker recalculation. The evidence guard protects normal exports/new launch and supply preparation; it does not retroactively clean immutable delivery payloads from previously created campaigns. This fintech base has none. Do not generalize the two-row guard into a claim that all 338 rows were audited.

Local sanitized SQL/snapshots: `/Users/cybermart/.codex/handoffs/ve2-joynio-fintech-20261015/`.
