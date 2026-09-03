# Vertical Engine v2: preview and continuous supply

Status: implementation in Sergey; not a production deployment record.

## Approved product contract

The specialist prepares a preview with a fixed target of 1,000 validated,
hypothesis-relevant contacts per selected hypothesis. Raw candidates are not the
target. Additional bounded collection rounds fill losses after validation. A
protective candidate/work limit is reported as a limit, never as source exhaustion.
Validated surplus from the last round is retained in the ready reserve; the
customer preview contains at most 1,000 contacts.

The specialist records customer approval of the preview, hypothesis, letters and
segmentation rules before launch. Approval does not activate sending. Existing
seasonality, queue, client/preset, period and activation gates remain mandatory.
Changing approved inputs invalidates approval instead of silently changing the
audience of a running campaign.

After launch, the worker prepares small replenishment batches for active bundles.
Every batch passes the same email/relevance checks and a complete segmentation
audit. An atomic append adds unique contacts to the original campaign reserve.
Campaign creation is not part of replenishment. The existing daily delivery runner
loads weekday portions according to the bound contact obligation, deadline,
sender capacity, already uploaded backlog and hypothesis priority.

## Invariants

- VE2 only: no writes to `he_*` or changes to the ENG backend.
- One durable supply plan per approved template; batches have stable identities.
- No approval, stale approval, paused supply or closed period: no new collection.
- A batch never bypasses the audit or changes its destination campaign bundle.
- Project-wide normalized email deduplication includes previous batches.
- Provider attempts retain their existing replay/uncertainty fences.
- An empty reserve today can be replenished today only before any provider attempt
  freezes that day's delivery decision.
- A temporarily completed campaign does not release its portfolio slot while
  approved supply can still replenish it.
- Exact ready stock and uploaded/first-contacted facts are separate from estimated
  future supply. Unknown market remainder is not zero. Runway is measured in
  working days at the displayed current pace, not promised delivery dates.

## Implementation and verification checklist

- [x] Compact backend regressions before implementation.
- [x] Ready-target collection rounds and resumable source exclusions.
- [x] Approval, batches, atomic append and lifecycle migration.
- [x] Continuous-supply sweep through existing validation/audit/delivery paths.
- [x] Preview, approval/pause controls and honest stock/runway UI.
- [x] Local executable SQL smoke, targeted/full tests, strict types and builds.
- [x] Changes scoped to Sergey; production migration and deployment excluded.

Verification on 2026-09-03, after fast-forward to `c0becbdc8`: full suite 213 files /
2,344 tests passed in 45 seconds; strict route/project typecheck, Next build and VE2
worker bundle passed. Scoped ESLint has no errors; three existing set-state-in-effect
warnings remain in ProjectDetail/Step4. The new supply panel has no lint warnings.
The full suite retains unrelated teardown/listener warnings; the build retains
the known transcription/NFT tracing and Next deprecation warnings. Local `UI_ONLY`
builds do not have production Supabase credentials.

Real Step4 and approval/supply components were exercised in an offline browser
fixture: hypothesis selection, 1,000-ready target vs candidates, unfinished CSV
disabled, protective limit, explicit approval gate, stock/pace, pause/resume and no
horizontal overflow at a 1,280-pixel viewport. Provider/DB responses in this fixture
are simulated; this is not a production end-to-end launch test.

Final review added regressions for long-running supply histories displacing the
original preview at a PostgREST page cap, leaking collector checkpoints through
collect retries, and generic audit endpoints bypassing supply lifecycle checks.
Public lists now filter before pagination; worker-only templates cannot enter the
normal template/audit endpoints.

## Operating limits

Preview collection is bounded to five rounds and 10,000 candidate rows per run.
This limits work, not promised ready output. Low yield, source errors and exhausted
sources are distinct outcomes. Continuous supply targets a small working-day
buffer rather than collecting the whole market upfront. Uncountable external
sources cannot produce a trustworthy exact remaining-audience count.

The buffer covers two planned working days. A sweep enqueues at most one new
batch, targeting no more than 1,000 ready recipients, and finishes existing work
before purchasing another batch. Collection/audit jobs recheck eligibility before
paid work; weekends, a pause or a closed period hold them without discarding their
checkpoint. The collector preserves all observed company/INN/email exclusions
between rounds, including rejected candidates, to avoid repeatedly buying the same
unusable rows.

Pause means **pause replenishment**, not pause Instantly sending: an unchanged,
already approved ready reserve can still be delivered. A stale approval blocks
both new collection and new delivery. Resuming a released/cancelled portfolio item
requires explicit portfolio activation; supply controls cannot silently reclaim a
slot or bypass seasonality. A failed audit may retry the existing validated batch
without purchasing it again. A new segment without an original campaign stops
replenishment for review; the worker never invents another campaign.

The initial remaining-audience scenario is available only for an exact single
directory slice, at least 100 fully checked candidates, positive observed yield and
no previous exclusions. It is explicitly low confidence: remaining raw population
multiplied by observed yield, not a promise. Mixed/parser sources, continuation and
already used slices show "unknown" rather than reusing a stale number. Exact ready
stock and its working-day runway remain visible in all cases with valid metrics.

Each selected hypothesis has its own preview. The UI lets the specialist switch
bases and approve/launch each separately; internal replenishment bases/templates
do not replace that selection. Existing non-preview bases/jobs keep their legacy
launch behavior. New API collection requests always use the ready-target preview
contract even if an old client sends a candidate limit.

## Release boundary

The additive migration is
`20260903_0001_vertical_engine_v2_contact_supply.sql`; it depends on the preceding
contact-delivery/portfolio migrations. The SQL smoke script executes the real
dependency migrations in local PGlite, then checks approval, stale inputs,
transactional append/replay, campaign reuse, empty-day recovery and slot retention.
It is not a production migration runner.

This task does not apply migrations, create campaigns, upload contacts or deploy
app/worker in production. A separately approved release must apply migrations in
order, deploy both app and VE2 worker, and verify an isolated approved client case
through preview, activation, one daily batch, replay and pause.
