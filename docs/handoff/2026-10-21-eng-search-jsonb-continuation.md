# ENG ordinary search: continue a saved plan after JSONB round-trip

Date: 2026-10-21. Destination branch: Sergey. Follow-up to
[initial budget compatibility](2026-10-21-eng-initial-budget-compatibility.md).

## Verified production state

After the user's deployment and explicit continuation, the same previously
unpaid collection was recovered once at 18:16:59 UTC. Main
`ab023d38dee3f3e66bcbea3614dcaf2602957c73` contains the initial budget fix
`e3f0979ef`. That fix is verified in the installed SQL function and HE bundle.
Do not repeat the old recovery or enqueue.

The current run completed three waves: 10 PDL candidates, 40 ordinary-search
candidates, then one PDL candidate. The fourth wave tried to continue ordinary
search and failed with `ENG company search plan is invalid.` At 18:36:57 UTC
the existing job became failed after three attempts. No automatic restart or
production mutation was performed during this diagnosis.

Saved partial result: one company, two OK addresses, zero catch-all and zero
reserve. The requested 500 ready + 2,000 reserve target has not been reached.
All ten countries remain in the base. Autopilot is false; there are no active
letter jobs, launch intents or automatic launches.

The complete variable-provider cost is **$0.009800** in the base ledger,
reserved **$0**, hold absent, cap **$5**. All 12 requests are settled: seven
Requesty requests total 4,800 micro-USD after conservative rounding, and five
Serper requests total 5,000 micro-USD at the approved $1/1,000-credit tariff.
Serper `cost_usd=null` in the older usage journal is its credit-based reporting
contract, not an unknown charge in this base ledger. Job cost alone omits the
Serper amount and must not be presented as the full cost.

## Cause and correction

The original plan fingerprint hashed `JSON.stringify(tasks)`. New tasks were
created with keys in the order `id, query, country, gl`. PostgreSQL JSONB
returns these object keys in another order. On the next worker context, hashing
the loaded objects therefore produced a different string despite identical
task contents. The first five searches succeeded in one context; the next wave
reloaded the plan and failed before another paid request.

The fix changes only `engCompanySearch.ts`: both creation and validation use
one fingerprint function that explicitly projects each task in the original
v1 field order. Existing fingerprints, task ordering, paid page cursors and
request history remain valid. Unsupported/missing fields and invalid types are
rejected rather than silently omitted from the comparison. Actual changes to
queries, countries, IDs or task ordering still invalidate the plan.

No migration, budget reset, broad acceptance rule, RU or VE2 change is needed.
Unrelated incoming commits `28d5e378d` and `30701c94a` were preserved before
this fix; they are not changes authored by this task.

## Local verification

- 129 assertions with real PGlite JSONB serialization reproduced the old bug
  and verified continuation of the saved 80-task plan from calls 5 to 6–11.
  Earlier pages were preserved; every later request used the next task/page.
- Tampered queries/countries/IDs/order, extra/missing keys, malformed values,
  foreign checkpoints, in-flight requests and budget exhaustion remain refused.
- The existing 82-check search harness passed, plus core TypeScript, scoped
  ESLint and HE worker compilation. No new repository test files were added.
- All provider calls in these checks were mocked. Additional development cost
  and production writes were both zero.

Temporary verification: `/private/tmp/portal-eng-search-jsonb-20261021/`
(`build.cjs`, `check.cjs`, `result.json`). These checks prove continuation and
accounting behavior, not HST yield or parity with RU collection.

## Yield and remaining uncertainty

The saved evidence covers only the first 51 candidates. Of 40 ordinary-search
candidates, 36 did not reach service qualification: 22 lacked country proof,
13 had unavailable website evidence, and one lacked size proof. These are
unconfirmed cases, not proof of unsuitable companies or an exhausted market.

Fifteen companies reached service qualification across the three waves. Two
were admitted; remaining outcomes were eight `site_unavailable_exhausted`,
two `website_redirect_unverified`, and three `hypothesis_unconfirmed`.
Two companies entered contact extraction. Constructor diagnostics record eight
unique addresses: two OK, five unknown and one invalid. The unknown reasons
were two SMTP policy refusals, two timeouts and one greylisting response.
The final two OK addresses belong to one company. Do not use this small sample
to claim that the full 500 + 2,000 target is achievable.

Saved official materials support the Fund Services fit of Morgan Stanley and
Stone Coast. However, all 15 confirmed countries in this sample came from PDL;
the new search has not yet demonstrated admission outside that catalogue. One
of the two final OK inboxes appears to be for media contacts. General inboxes
are allowed by the user, but validation does not establish that either inbox
belongs specifically to the fund-services team. Do not describe the two OK
addresses as two verified fund-services decision makers.

## Next action and private receipts

The search continuation fix is not deployed. The user handles deployment.
After deployment, a separately approved recovery must reuse the same base and
job and preserve **all** collection metadata, pool, decisions, search cursor,
money journal, costs, tokens and attempts. Unlike the earlier unpaid recovery,
this run now has paid work and two saved contacts. Never apply the pristine
metadata recovery SQL, reset its ledger, or create a replacement collection.

Read current state and verify the deployed fix before preparing the guarded
same-job continuation. Production remains read-only until that approval.
Letters and Instantly remain off. Pause the monitor while awaiting this action.

Private run identifiers and receipts:
`/private/tmp/portal-eng-target-resume-20261021/README.txt`;
`heartbeat-1849.jsonl`, `heartbeat-1849-snapshot.private.jsonl`, and
`wave-audit-1849.json`. The lightweight status query is
`/private/tmp/portal-eng-target-run-20261021/status.sql`.
