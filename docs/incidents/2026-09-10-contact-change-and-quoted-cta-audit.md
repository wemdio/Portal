# Instantly: contact-change notices and quoted-sender leakage

## Read-only audit, 2026-09-10

Reviewed 40 successful specialist notification records from 00:00 to 16:22
Europe/Samara, their complete retained reply bodies, available outbound context,
and current project criteria. Sources: Portal notification log/projects and the
Instantly operational qualification table, not the analytics dataset.

Assessment: 33 acceptable under the configured rules, 6 clear false positives,
and 1 unsupported/probable false positive. This is an audit of delivered alerts;
it does not prove complete intake or absence of missed leads. Current custom
criteria are not historical snapshots of settings at the time of qualification.

The false-positive classes were:

- Administrative email/contact-detail changes, including a custom contact-rule
  project. A generic notice updating correspondence details is not a deliberate
  referral responding to an outreach question.
- Quoted outbound CTA treated as recipient intent: an unrecognized Rambler
  numeric-date/duplicated-mailto sender header, and a Russian month-first dated
  sender header. One response was a neutral business-type clarification; another
  had only the sender's earlier messages.
- Recipient confirmation following a request for the responsible person, and
  permission to introduce the company after a contact-only opener.
- A future employee start date was interpreted as a request to resume the
  commercial discussion, although the recipient made no such request.

Five alerts concerned replies from June/July, including a real commercial
request for an August delivery. This patch does not change their age or fix
historical recovery delivery. Among the 35 current-day replies already delivered,
the median timestamp gap was 62.659 seconds, 28 were under two minutes, and the
maximum was 685.179 seconds. Notification timestamps are claimed-at/attempt
timestamps, not independently observed Telegram delivery times.

The running worker was created at 08:15:58 UTC and contained the previous
mailbox/self-recipient guard symbols. Its image had no revision label; symbol
presence is not verification of an exact Git SHA. Some failing alerts preceded
this container, but the newly observed quote/header/contact-change gaps also
reproduced in the current local code.

## Changes

1. Recognize a complete administrative contact-details-change + generic address
   routing notice, alongside the prior new-address/all-correspondence template.
   Require an email and exclusively administrative authored segments. Ordinary
   referrals and mixed price/quote/call/interest requests remain eligible.
2. Resolve contradictory model instructions: custom criteria are authoritative
   for human responses; fully administrative/machine notifications are excluded
   first. Both semantic passes receive the same distinction.
3. Recognize complete structured sender headers rather than broad date/contact
   fragments. Quoted sender CTAs cannot drive deterministic buyer-interest
   promotion in the observed Rambler and month-first Russian formats.
4. Return a pre-AI non-lead only for provably quoted-only input: explicitly quoted
   lines, or complete blocks matching known pre-reply outbound messages after
   whitespace normalization. An empty prefix alone is insufficient; unmatched
   unprefixed/bottom/inline content remains for semantic assessment.
5. Clarify semantic instructions: staff availability dates do not establish a
   request to return; permission to introduce a company after contact discovery
   is not a scheduled call/demo or evidence of a received offer. Real deferred
   requests after an understood offer and self-contained commercial CTAs remain
   valid. These prompt changes are not deterministic keyword bans.

## Validation and release boundary

- Existing suite: 213 suites / 2402 tests passed (30.83 seconds), including the
  latest unrelated upstream changes already present in Sergey.
- Strict typecheck, changed-file ESLint, Instantly worker bundle and diff checks
  passed. Existing listener/test-worker teardown warnings remain.
- Private offline fixtures cover the new headers, quoted-only and bottom/inline
  replies, administrative variants, custom contact rules and mixed buyer intent.
  Model/network responses are mocked: this is not a live model accuracy score.
- No permanent test cases added under the repository test-budget rule.
- No production data/configuration changes, replay, migration, deployment,
  model/policy change or paid model calls. Prior Reelscut opt-out was untouched.
- The oldest recovery backlog and a complete daily intake guarantee remain
  unresolved by this focused classification change. Historical alerts were not
  deleted, hidden or automatically relabelled.

