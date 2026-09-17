# VE2: paid search only after existing contact stock

## User requirement

Reduce Requesty and Serper cost without weakening recipient quality. Serper
should be used for a ready-contact deficit, after existing company data has
been tried. Three simultaneous collections cannot serve the intended workload
of 15 projects with 10 hypotheses each. Implementation is on the Sergey task
branch; production release is separate.

## Read-only cost and runtime observations

The Requesty screenshot shows $64.51 for September 16 across several models.
It is not a collection-only invoice. Its reporting timezone and all API-key
consumers have not been reconciled with the Portal journal.

For September 16 in Astrakhan (2026-09-15 20:00 through 2026-09-16 20:00 UTC),
deduplicated `ve_provider_usage` finished events report these known AI charges:

| Work | Reported USD |
| --- | ---: |
| Collection / relevance checks / collection plans | 32.452221 |
| Research, evidence, hypotheses and clustering | 19.922699 |
| Base analysis and final letters | 4.800639 |
| Total known VE2 Requesty charges | 57.175559 |

Unknown/ambiguous charges are not zero. Serper is separate. The 112 bases in
the GPT-4o-mini success bucket are not the total number of affected bases and
not a count of finished previews. The union including ambiguous collection
attempts touched 136 bases. At 20:09 UTC, only 11 of those were analyzed with
`target_reached` (6,360 cumulative ready rows); 15 other analyzed bases had
1,082 cumulative ready rows, 21 were collecting, and 89 were failed. One failed
base had at least 500 rows; it must not be counted as a completed preparation.
These are current cumulative counters, not today's new contacts or a lifetime
cost per contact. Expensive unsuccessful work is a real concern.

Runtime inspection of the VE2 worker confirmed: shared Serper cache present;
the b7b4cf29b email-before-paid-fit and pending-search sharing changes absent.
Runtime limits were general pool 16 / collection 3. Neither concurrency variable
was explicitly set in `/home/Portal/prod/.env`; the collection value came from
the deployed Compose default. No services or production rows were changed.
The old `enrich_descriptions` constructor step reads websites, rather than
buying LLM descriptions; removing it would not explain Requesty savings.

## Implementation

- Preview and supply checkpoints distinguish existing-data and paid-search
  phases. Directory reads prioritize website-bearing records, then email-bearing
  records, retaining the original audience filters and project exclusions.
- Known-site reads and cached discovery are allowed in the existing-data phase.
  A search-cache miss produces a durable deferred decision, not a provider
  failure, completed website check, rejection, or admitted recipient.
- Missing-site source rows remain in worker state while usable stock advances.
  If the verified goal is reached, no new search begins. Otherwise, after the
  usable stock and in-flight batches are drained, the worker enables bounded
  search for the remaining deficit. Source exhaustion in a restricted directory
  lane does not incorrectly exhaust the full audience.
- If the acquisition safety cap is reached, saved validated-email candidates
  can still receive their deferred evidence checks; this does not buy new
  candidates beyond the existing 10,000-candidate cap.
- Source discovery runs only with no immediately usable rows and no active
  constructor batch; it buys at most 16 lookups per pass, also bounded by the
  remaining contact target. Website follow-up likewise respects the deficit.
- Existing recipients, completed model verdicts, email checks and constructor
  inputs remain checkpointed. Deferred searches resume without buying the
  initial classification again. Legacy non-target collection is unchanged.
- The default collection cap returns to 16 within the existing general pool.
  Project/base locks, manual-constructor capacity protection, Serper's separate
  eight-request capacity and circuit breaker remain. An explicit lower
  operational override is still supported. Sixteen is not 150, and no unmeasured
  overnight throughput guarantee is made.

No model downgrade, weakened relevance evidence, relaxed email policy,
unapproved daily supply, or new production collection was introduced. The prior
email-before-fit optimization still needs release. A threefold Requesty saving
is a measurement target, not a proven outcome of these offline changes.

## Verification / release

Existing regression cases cover the zero-search 500-contact goal, preserving
deferred source rows, durable transition after empty filtered directory lanes,
cache-only lookup, deferred evidence recovery, independent semantic review,
unchanged exclusions, constructor inputs and configurable concurrency. No test
file or test case was added.

After integrating the concurrent Sergey commit `035ca9f6a`, full Jest passed:
225 suites / 2,473 tests in 62.144 seconds. TypeScript
`--noEmit --incremental false`, changed-file ESLint, VE2 worker bundle and
diff whitespace checks passed. All provider adapters in regression scenarios
were offline; no paid trial, production mutation or deployment was made.

After the authorized release, measure new provider charges against newly ready
unique recipients on comparable hypotheses. Separate research/letters from
collection and retain unknown charges. Production release must recreate the
VE2 container to pick up the Compose default of 16; merely restarting the old
container preserves its current value of 3.
