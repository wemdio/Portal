# Instantly: September 11 intake and qualification follow-up

## Observed, not yet repaired in production

Read-only audit covered September 11, 2026, through 19:17 Samara (UTC+4).
The main workspace discovery sweep was still on its first page, with repeated
`invalid reply discovery page` database failures. The operational RPC limits
are 1 MiB per email payload and 16 MiB per page. A stored example contained
about 17 MiB of HTML/embedded images but only about 36 KiB of plain text.
The audit found 1,811 pending/processing qualifications, 792 dormant semantic
reviews and three older error rows. Intake had no waiting rows, but that did
**not** mean discovery or qualification was complete.

These are audit-time counts, not a post-deployment verification. No production
data, notifications, migrations or services were changed for this patch.

## Changes

- Intake omits binary inline raster-image rendering data from HTML while
  preserving authored/quoted text, metadata and ordinary links. Larger text
  uses a bounded, lossless gzip envelope. Decoding validates size, digest and
  email identity before handing the email to qualification.
- Pages are persisted in byte-bounded chunks. Only the final successful chunk
  advances the sweep cursor; replay after a crash deduplicates saved replies.
  A payload that cannot fit remains an explicit error, not a dropped email or
  an invented negative verdict. Healthy replies on that page are still saved.
- Recovery snapshots use the same bounded encoding so an accepted large reply
  remains recoverable even if Instantly later returns 404. Existing raw
  snapshots remain readable. Normal owner and recipient checks are unchanged.
- A valid saved inbound is used before an unnecessary provider GET. Source-
  sensitive failures periodically refresh the inbound metadata, including
  after the capped backoff counter reaches 30.
- The bounded legacy semantic drain defaults on; an explicit false value in
  `INSTANTLY_LEAD_QUAL_LEGACY_SEMANTIC_DRAIN_ENABLED` still pauses it. Only
  unresolved `needs_review` rows enter this lane, never final `objection`,
  `not_lead` or `lead` verdicts. Existing CAS, delivery deduplication and AI
  attempt limits remain in force.
- Default qualification no longer extracts a commercial CTA from a pure
  clarification such as “What is your enquiry? You may write here or call…”.
  Custom contact criteria and separate price/proposal/personal-call requests
  keep their existing handling.
- A structurally recognized helpdesk conversation is evaluated using its
  latest message, not an old automatic acknowledgement in its history.
  The envelope/name alone proves neither human interest nor automation.
- Model instructions distinguish a technical question about an already
  described solution from asking what is being offered after a contact-only
  opener. This is a semantic instruction, not a forced positive keyword rule.
- In the no-mailbox-mapping fallback, a legacy `auto-text` project link alone
  cannot authorize notification without a matching outbound parent or a period
  link. Established links and the unique exact-mailbox-owner path retain their
  existing behavior. This does not invent a replacement project for a bad link.

## Boundaries and rollout checks

No schema change or paid model evaluation is required by this patch. The user
controls promotion and deployment. Do not mark the historical queue cleared
because local tests pass or because intake waiting count is zero.

After an authorized deployment, verify both workspaces: successful cursor
movement and sweep completion, intake oldest waiting age, fresh reply delay,
qualification counts/age by failure kind, and Telegram delivery deduplication.
Recheck the flagged project links against independent ownership evidence before
changing any production mapping. An absent/deleted or ambiguous campaign
catalog can still prevent safe recovery; this patch does not guess the owner.
Another existing edge remains: after a confirmed provider 404, a complete but
stale saved source is local-only. Normal ingestion currently refreshes such rows
only for `source_missing`, not subsequent ownership/evidence failures. These
cases need a separate safe source-refresh change, not a claim of zero backlog.

Previously unresolved old replies that now become proven leads may produce a
specialist notification once. Existing historical-replay suppression of client
reply-bot messages and explicit project notification opt-outs remain active.
The existing 3 normal + 1 final AI attempt budget is per logical input scope
(including project, model, prompt and context), not a lifetime cap across changed
inputs. Source GET avoidance does not eliminate necessary ownership lookups.

Size limits are bounded: up to 64 MiB expanded and 768 KiB stored per envelope.
Unsupported/incompressible larger content remains visible as an intake error;
there is no promise that arbitrary-size emails can always be processed.
