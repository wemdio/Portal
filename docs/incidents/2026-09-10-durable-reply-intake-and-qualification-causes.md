# Durable reply intake and qualification error attribution

## Scope and release boundary

Requested on 2026-09-10: collect/process replies promptly without repeatedly
revisiting just the recent pages, and investigate recurring false positives.
This change is code plus an Instantly operational database migration. No
production migration, deployment, restart, replay, relabel, or Telegram message
is performed as part of development. The release target is `Sergey`.

Existing client notification preferences, including the explicit Reelscut
disable, are not changed. There is no model/policy switch or paid evaluation.

## Processing defects

The old synchronous poll fetched a bounded set of recent pages with a cursor
local to that invocation. It then collapsed multiple new replies from one
lead/campaign to the newest reply, qualified sequentially, and awaited recovery,
delivery reconciliation and handoff work before polling again. A successful
tick therefore did not prove coverage of all replies during that day. This is
a code-level failure mode, not proof of the exact history of every old alert.

The dedicated worker now separates discovery, inbox qualification, recovery,
and delivery into independent loops. The general worker uses the same durable
inbox instead of running a second recent-pages qualification path.

- Each discovered eligible reply has an account-scoped inbox identity; different
  replies from the same lead are not collapsed.
- A page's inbox writes and cursor progress are atomic. A failed write cannot
  advance progress. Missing migration/RPC access fails closed, not back to the
  old poller.
- Provider discovery uses explicit creation-time windows, descending order,
  full bodies and all replies rather than latest-per-thread. Instantly documents
  these controls in its [List email API](https://developer.instantly.ai/api-reference/email/list-email).
  Creation time and original email time are distinct; the latter can be old
  after an import.
- A fresh front-page lane and a resumable bounded-window sweep share the existing
  LIST admission gate. Completion requires provider EOF, not an assumed cutoff
  based on a short or old-looking page.
- Bootstrap is a fixed **48-hour source lookback at first initialization**.
  Older newly imported email is not a new historical notification campaign.
  Existing qualifications/recovery rows remain untouched, including older ones.
- Only the next two inbox replies are leased for concurrent qualification.
  ACK requires a qualification row in the database; a normal function return
  without a saved result is insufficient. A pending qualification means the
  existing recovery mechanism owns further work, not that it is a finished lead.
- Existing completed qualifications are not reclassified. Missing saved inbound
  recovery sources can be repaired without reopening completed verdicts.
- Active and cold recovery scheduling defaults become one minute (previously
  two and five minutes). Per-row failure backoffs, provider admission/cooldowns,
  ownership proof, delivery deduplication and lifetime paid AI budgets remain.

This removes collection/AI coupling and lost progress. It is not a promise of
instant processing during provider, billing, ownership-evidence or DB outages.
Technical inability to classify must not silently become `not_lead`. Operational
verification after deployment must measure both inbox progress and pending
qualification recovery, not just the number of sent Telegram notifications.

## Qualification defects: separate layers

The earlier 40-notification audit identified six clear false positives and one
probable false positive. Those are audit labels, not a fresh model benchmark.
Full customer correspondence remains in private audit artifacts, not Git.

1. **Post-model promotion from quoted outbound.** An offline replay with an
   intentionally negative model result reproduced two false promotions on
   `b5e8359a9`: our own quoted call-to-action was treated as recipient intent.
   The current `bf486ddea` guards stop those promotions. Those fixes were already
   committed before this intake change.
2. **Administrative contact updates overriding custom intent.** A global
   change-of-address notice is not a personal referral. The existing preceding
   fix makes administrative/machine exclusions run before custom contact rules.
3. **Unsupported semantic inference.** Two other audited replies preserve a
   positive or negative supplied AI verdict without deterministic promotion.
   Staff availability is not necessarily deferred buying interest; permission
   to introduce a company after a contact-only opener is not necessarily
   interest in an understood offer. The exact historical raw flags were not
   recovered, so these are not attributed to a particular model response field.
4. **Insufficient evidence contract and observability.** The current model
   contract returns flags and a free-form reason, not a required exact authored
   evidence span plus the relevant custom rule/offer source. Qualification rows
   retain a short outbound preview, not the complete historical classifier input.
   Raw AI checkpoints exist but their hashed keys are not a direct reply-ID join.
5. **Evaluation drift.** The opt-in evaluator had stopped loading current
   classifier dependencies and did not replay the separate automatic
   adjudication prompt. Its repair evaluates raw AI, parsed decisions, guards
   and final status separately. A required second semantic request is explicitly
   counted against both call and monetary limits; transport retries and paid
   final recovery remain disabled in evaluation.

There is no evidence that a stale cache alone caused these cases: fingerprints
include the current request/prompt/model and cached raw responses still pass
through current guards. Unit tests with supplied AI flags are not evidence of
live model understanding.

## Follow-up quality measurement

Use a fixed, independently labelled set of real replies with their complete
pre-reply outbound context, actual custom criteria and brief. Score raw AI and
final decisions separately, including administrative notices, quoted-only
threads, human referrals, deferred interest, purchase/price requests and
contact-only openers. Short synthetic examples alone are insufficient.

The next semantic-contract improvement should require traceable evidence for
positive decisions: authored recipient text, the matching custom criterion,
and (where required) an actual prior offer. Missing or contradictory evidence
should invoke the existing bounded **automatic** adjudication, not require
someone to inspect a manual review inbox. Evidence provenance alone is not a
semantic guarantee; live quality still needs measurement.

## Validation

Existing suite: 213 suites / 2402 checks pass; repeat full run 27.8 seconds.
No new test files or assertions were added to that suite; its existing scheduler
clock was adjusted to the new one-minute cadence. Private offline integration
checks exercise concurrency, deduplication, durable ACK, failed persistence,
campaign surface failure and discovery without an AI key.

Completed additional validation:

- 47 private checks executing the actual intake module and migration/RPCs in
  an isolated PGlite database, including transaction rollback, lease expiry,
  one-page alternation, scoped ACK, wrong sender and repeat migration execution.
- 39 private checks of the worker integration and its failure paths.
- Existing migration grant/transaction checks pass (5 assertions).
- Strict project/route types and the dedicated worker bundle pass.
- Changed library files and the dedicated worker pass ESLint. Explicitly
  linting the normally ignored general worker exposes two pre-existing
  `prefer-as-const` errors in unrelated code; those lines were not changed.
- The repaired evaluator passes 200 offline replays and its normal 200-row
  dry-run with zero provider calls. Private mocked CLI runs cover success,
  missing budget for adjudication, second-pass HTTP 402 and invalid output.

Existing test-runner open-handle/MaxListeners warnings are separate from this
change. This is not a warning-free run or a live model-accuracy measurement.

After a separately authorized deployment, check `instantly_reply_discovery`
for advancing `last_completed_at`/cursor, and `instantly_reply_intake` for the
oldest pending/processing row and `last_error_code`. Also inspect generated
pending rows in `instantly_lead_qualifications`: an accepted intake row has
been handed to that mechanism and must not disappear from processing-latency
statistics merely because it left the intake queue.
