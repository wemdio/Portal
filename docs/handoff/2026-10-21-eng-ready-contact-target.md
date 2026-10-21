# ENG: ready contacts, reserve and ordinary company search

Date: 2026-10-21. Destination branch: Sergey. This document describes code
prepared locally, not a production collection result.

## User request and boundary

The user requested a first batch of 500 ready contacts, 2,000–5,000 contacts
in reserve, continued collection and ordinary company search, with the same
hard $5 limit per base. Only ENG is in scope. RU and VE2 are unchanged.
No collection, paid experiment, email generation, Instantly operation,
production write, merge or deployment was performed for this change.

## New collection contract

- Only newly enqueued, verified client ENG manual bases opt in. Historical
  bases, internal HE, RU, VE2 and the existing refill creation contract do not
  migrate or restart automatically.
- Default target: 500 unique ready addresses plus 2,000 real reserve addresses.
  The target contract permits a reserve of 2,000–5,000; there is no new UI
  setting to request 5,000. This is a collection target, not a guarantee of
  market availability or deliverability.
- Count only addresses from qualified companies in allowed countries that
  passed validation as OK or catch-all. OK ranks first. General company
  inboxes remain allowed. Preserve the frozen per-company contact cap
  (default five) across all waves, not five again in each wave.
- `he_bases.data` contains only the first 500. The private
  `collect_info.eng_collection_pool` contains the checked pool. It is excluded
  from the client projection; the client sees separate target counters.
- One base, one money ledger and one continuing job. Start at 100 candidate
  companies; subsequent waves adapt between 50 and 200 using actual accepted
  contacts. Save each wave, its source state, checked pool and seen companies
  together. Terminal replay returns the saved result without new work.
- Qualify companies before buying contact collection. Existing country,
  qualification, DNC and cross-base checks remain mandatory. Repeat DNC and
  cross-base checks at wave commit, including the reserve of other bases.
- Alternate useful catalogue slices and ordinary search. Suspend a weak slice
  after two sufficiently large waves below 5% accepted-contact yield. Do not
  label a weak slice as an exhausted market. Never widen countries or company
  size to reach the numeric target.
- Google Maps is not selected by the new adaptive scheduler: its separate
  child job does not yet inherit the same base money ledger. Legacy source
  plans and dispatchers are unchanged.
- Retain a truthful partial result at the money limit, exhausted sources,
  poor yield or a safety boundary. Limits also include 100 waves, 20,000
  candidates and 16 MiB of accumulated durable history before another wave.
- Build a factual base summary for free. Do not enqueue `base_analyze`, letter
  generation or campaign launch for this new path.

## Ordinary search and required configuration

`engCompanySearch.ts` uses Serper with deterministic queries derived from the
selected hypotheses and explicit countries. Queries interleave countries;
limits are 160 queries, three pages per query and ten hits per page.
Each request reserves money in the same $5 base ledger, has no transport retry,
and persists its in-flight marker before HTTP. Unknown charges keep their
reserve and stop work. Cursor and returned candidates are checkpointed together.

Search text, TLDs and query countries are not country evidence. Candidates need
an exact catalogue match or their own verified structured address. Explicit
company-size requirements still apply. Identity, country, size or fit that
cannot be confirmed remains a recorded exclusion, not automatic admission.

Production was read only for configuration on 2026-10-21:

- Serper API key is present in the HE worker (value was not printed).
- `HE_US_SERPER_USD_PER_1000` is absent/not positive.

The user then confirmed the actual package: **50,000 credits for $50**, or
**$1 per 1,000 credits**. The new ENG search adapter uses that explicit default
when the env override is absent. A supplied override must be positive and
valid; invalid configuration fails closed. Credit receipts are converted at
this tariff in the same base money ledger and recorded as estimated dollar
cost in provider telemetry. No production env change is needed for this new
adapter; legacy pricing functions were not changed. An unavailable search
source is reported as an error if remaining sources cannot fill the target.

## Using the reserve

`engCollectionReserve.ts` publishes only the actual reserve of finished new
ENG bases, lazily inside an already authorized campaign refill. It does not
create a refill or start a campaign. Refill uses that stock before buying new
collection. Failed reserve reads block new spending when prepared stock exists.

The existing carryover table is reused with a separate company-key namespace.
Claims are conditional; a fresh claim reads the current rows returned by the
update. Outcomes are stored per address: available, accepted, rejected,
unknown or filtered. Partial delivery retains untouched addresses. Unknown
outcomes cannot be replayed, and another worker's claim is not stolen.
Legacy carryover keeps its previous behaviour.

Claim, pre-dispatch manifest, recovery and settlement use a monotonic row
version. Recovery releases untouched stock only after confirming the previous
job is terminal; addresses in its unconfirmed dispatch remain unknown. An
active or unreadable owner keeps the reservation held.

Country/fit, DNC, campaign ownership, daily cap and provider acknowledgement
checks remain in the existing refill path. Prepared reserve retains the
existing seven-day freshness window (hiring can be shorter). The UI's
“Reserve collected” counter means originally prepared stock, not a live
remaining balance after later campaign use.

## Checkpoint size and diagnostic evidence

Only after a new adaptive wave is complete, compact its qualification audit:
retain exact quotes cited by the classifier/reviewer, all acceptance evidence,
country proofs, reasons, explanations, verdicts and paid history. Record the
original quote count and SHA-256 to identify compaction. Active prepared work,
proposals and in-flight requests are never compacted. Historical bases are
not rewritten.

On saved HST material with 594 decisions, the same memo shrank from 4,880,551
to 1,725,493 bytes (64.6%). This reduces repeated writes; it does not prove
unlimited scale. The explicit history-size stop prevents indefinite growth.

## Verification and limits of proof

All checks used local fixtures/mocked external services and cost $0. No new
repository test files were added. Temporary verification materials:

- `/private/tmp/portal-eng-target-contract-20261021/`: target, scheduler,
  free-summary and local-budget checks.
- `/private/tmp/portal-eng-company-search-20261021/`: search checkpoints,
  tariff/unknown-cost handling and country proof checks.
- `/private/tmp/portal-eng-adaptive-integration-20261021/`: actual collection
  stage with fake DB/providers; multiple waves, 500 + 2,000 checked addresses,
  crash/replay, budget stop, current-constructor salvage, fallback search,
  DNC/cross-base exclusions and no email jobs.
- `/private/tmp/portal-eng-target-ui-20261021/`: frontend state/render checks,
  desktop/mobile screenshots and reserve settlement/claim checks.
- Existing qualification checks and repository architecture/HE/isolation
  checks were also run. Core/API/pages TypeScript, ESLint and HE worker build
  are part of the final validation.

These checks prove state transitions and protections, not the real HST yield.
After the user deploys, an explicitly authorized new collection is needed to
measure suitable companies, OK/catch-all addresses,
ready/reserve counts and actual plus reserved cost. Do not restart an old base
or declare parity with RU based on offline fixtures.
