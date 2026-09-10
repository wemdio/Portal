# Short mailbox notices and recovery stalls

## Observed behavior

Read-only diagnostics on 2026-09-10 found two separate failure modes:

- A June 15 reply consisting only of a new email address and a request to send
  **all correspondence** there was adopted from an old technical-error row on
  September 9 and requalified as a lead. This was new qualification of an old
  reply, not merely delayed Telegram delivery. Its original technical failure
  is not established by the retained diagnostics.
- Another reply was already recognized as technical noise, but the recovery
  writer failed with `42703: column instantly_lead_qualifications.ai_reason
  does not exist`. The physical column exists. The early-machine PATCH used
  an `ai_reason` OR filter while returning only `id`, unlike the general
  recovery claim's existing PostgREST projection workaround.

## Changes

1. Recognize a narrow RU/EN mailbox-change template before ownership/model
   work: new-address statement + all-correspondence instruction + real email,
   with no other authored substantive content. Quoted text does not qualify.
   A quote/price/call/interest request alongside the notice remains eligible
   for normal project-specific qualification. A normal human referral is not
   this template. The AI prompt independently covers the same distinction.
2. Include `ai_reason` in the early-machine writer's returned projection.
   Exact row identity, lease, state, ownership and delivery fences are retained.
   Storage failures still throw a technical deferral; they do not create a
   negative business verdict.
3. During durable recovery, use one model transport attempt per call instead
   of three consecutive timeouts. Semantic adjudication and the lifetime
   checkpoint budget remain unchanged. Bound recovery context search/fallback
   reads to 20 seconds each, including the response body, without an internal
   429 retry. Fresh qualification defaults and workspace rate limits stay put.

## Verification and limits

- Existing suite: 213 files / 2402 tests passed; strict typecheck, changed-file
  ESLint and the Instantly worker bundle passed. The suite still emits its
  existing listener/open-handle warnings.
- Offline checks: 62 mailbox/default/custom/mixed-human cases, 26 early-writer
  CAS cases, and recovery transport/context boundaries. The CAS harness models
  the observed projection error; it is not a live PostgREST integration test.
- No production writes, replay, archival, migrations or deployment were run.
  Verification that the production PATCH error stops requires deployment and
  subsequent read-only observation.
- The September 9 qualification cohort had 415 rows at the diagnostic
  snapshot: 72 leads, 318 non-leads, 8 terminal objections and 17 unresolved
  rows. Fourteen awaited ownership/provider/storage recovery; three were
  blocked after model failures and consumed attempt budgets. Counts describe
  the qualification table, not independently verified Instantly inbox coverage.
- These bounded fixes do **not** establish a 24-hour completion guarantee.
  The poller still uses a bounded recent-message window without a durable
  intake cursor. Complete daily intake/age monitoring and the remaining
  ownership/dependency/budget blockers need separate work. Old replies were
  not hidden, deleted or converted to non-leads merely because of their age.

## Follow-up: confirming the recipient is not buyer interest

The separately reported Legal Brain response “Рассказать можно мне” answered
an outbound question about who handles documents. The outbound described the
product, but the reply only identified its recipient. The project had no custom
lead criteria. This was a fresh reply (about 48 seconds to qualification), not
another old-message recovery.

The follow-up change adds a narrow default-only shortcut for a complete
self-recipient confirmation paired with a visible responsible-person question.
It does not use the outbound's length or the mere presence of a quote as a
positive signal. An extra human request/interest, a missing recipient question,
or a possible competing explanation/demo/call offer stays in semantic
assessment. Custom definitions bypass the shortcut. The same guard also runs
after model assessment, and both model passes get the clarified distinction.

Wrapped quote headers are recognized only when a bounded 2–3-line header has
a sender email and is followed by quoted text. Ordinary dates and live meeting
requests must remain authored content. Offline checks exercise the actual
qualification pipeline with mocked model responses, including optimistic and
cached verdicts, custom criteria and mixed human requests. They do not measure
live-model accuracy on every wording. No historical records or Telegram posts
are changed by this code commit; deployment remains a separate user action.
