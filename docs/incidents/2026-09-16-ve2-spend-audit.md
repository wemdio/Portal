# VE2 spend audit, 16 September 2026

## Scope and accounting

Read-only production snapshot: 15:13 UTC / 19:13 Astrakhan. No production
records, queues or services were changed, and this audit made no paid API
probes. Source: `application_logs`, source `ve_provider_usage`, provider
`finished` events deduplicated by `attemptId`. Use `reportedCostUsd`, not the
stage's estimated `ve_jobs.cost_usd`. No duplicate finished attempt IDs were
observed in this period.

The local-day boundary is 15 September 20:00 UTC. Known VE2 Requesty charges
since that boundary total **$49.390314**. Since 16 September 00:00 UTC they
total **$41.660150**, close to the user's approximate $40. The timezone and
scope of the user's Requesty dashboard have not been confirmed.

| Local-day work | Known Requesty charges |
| --- | ---: |
| Contact collection and verification | $28.059248 |
| Research, evidence and hypotheses | $16.665961 |
| Base analysis and final letters | $4.665105 |
| Total | $49.390314 |

Serper separately returned **46,996 successful credits**, including 46,180
for collection. At the user's stated price of $50 per 49,999 credits this is
about **$47.00**, or **$96.39 combined** with the known local-day AI subtotal.
These are consumption costs, not necessarily cash purchases made today.

This is not a full account invoice: other tools/keys are outside this journal.
There were also 330 finished Requesty attempts without a known charge and
1,519 finished Serper attempts without known credits (mostly ambiguous
transport outcomes), plus in-flight/missing completion events. Unknown cost
must not be treated as free. The journal lacks query fingerprints and precise
collection sub-operation labels, so it cannot quantify the wasted fraction.

## What was running

Paid attempts touched 19 projects and 155 distinct base IDs over the local
day. This is not a count of completed bases or concurrently active tasks.
At the snapshot, 30 preview collection jobs were active (27 pending, three
running), alongside one evidence job. `ve_contact_supply_plans` was empty:
there was **no configured VE2 daily supply**.

There were 21 new preview bases around 16:07–16:11 Astrakhan (13 for Эво
Стикер, eight for Яндекс). Two older bases also had new collection jobs
created that afternoon. This audit did not establish their initiating actor;
their presence must not be described as proven automatic resurrection.
No old stopped preparations were resumed or cancelled by this audit.

Code behavior: each selected hypothesis has a preview goal of 500 launchable
contacts. Reaching it stops new acquisition; already dispatched batches are
drained, so the result may exceed 500. A preview can stop below 500 because
of source limits, no confirmed continuation, technical errors or collection
caps. A completed preview is reused. Daily collection requires the separate
approved/launched supply workflow. Preparation status `ready` alone does
not prove that the 500-contact goal was reached.

## Inefficiencies and one confirmed fix

Some low-yield sources were expensive even without daily collection:

| Base | Ready contacts at audit | Candidate passes | Local-day AI + Serper |
| --- | ---: | ---: | ---: |
| rhizome-flow.com — Лизинг автоимпорта | 6 | 4,552 | ~$4.89 |
| Прион — Девелоперы жилья | 40 | 3,052 | ~$4.19 |
| Прион — Сервис промышленного оборудования | 593 | 840 | ~$1.05 |

These are today's known expenses versus the currently accumulated result,
not lifetime acquisition prices. Candidate passes and reserve rows are not
necessarily unique companies. The first base's missing-site recovery found
42 sites from 2,006 checks; the second found 72 from 1,362. Neither passing
email validation nor a successful search guarantees buyer relevance.

Confirmed code defect: source-site discovery selected missing-site rows
before applying exclusions for companies already represented in another
base of the project. It could buy searches for rows that were then removed.
The fix applies that exclusion before discovery and before deciding whether
unresolved discovery requires another collection round. Same-base recovery
of previously seen rows is preserved. Recipient quality gates are unchanged.
The exact historic cost of this defect is not measurable from this journal.

Remaining economic gaps: no per-preview monetary budget or adaptive
low-yield spending policy; discovery and later relevance search have separate
base-local state and can repeat discovery queries. The other developer's
shared company cache has not been verified or integrated by this task.
Do not infer that independent semantic review is redundant, downgrade
quality gates, or stop requested bases solely to reduce the reported bill.

## Verification and release

An existing regression scenario now covers 16 excluded companies followed by
one fresh company: only the fresh company incurs a site lookup and reaches
the constructor. Its existing same-base recovery scenario still passes.
No new test file or test case was added.

Full suite: 213 files / 2,405 tests, 58.12 seconds. TypeScript, changed-file
ESLint and VE2 worker bundle passed. Release of this fix is separate from
these read-only production findings; no deployment was performed here.

Local audit SQL and aggregate snapshots are retained under
`~/.codex/handoffs/ve2-spend-audit-20260916/` on this Mac.
