# VE2 cost reduction without relaxing admission checks

The user requested lower collection costs while preserving base quality.
Baseline: [today's spend audit](2026-09-16-ve2-spend-audit.md). No paid API
probes or production changes were made in this follow-up.

## Shared search implementation and production evidence

Fetching current remote refs located Dmitry Kulaga's `6a8e5ad0c` in `main`
and `test`, but not Sergey. Its search-cache module, reader integration and
unchanged migration `20260916_0003_ve_search_cache.sql` were brought into
Sergey as the foundation of this change. The separate concurrency/retry-policy
changes in that commit are outside this cost optimization's scope.

A read-only production query confirmed `ve_search_cache` already exists:
1,798 entries, 149 recorded hits, first write 14:00:33 UTC and last write
15:43:12 UTC on 16 September. Thus the earlier audit's statement that the
other developer's cache had not been verified is now superseded by this
bounded observation. It does not establish a full production version match.
The current hit increment is best-effort and can race; it is not a reconciled
count of saved credits.

The cache contains Serper discovery results only. Website identity, actual
business relevance, independent evidence review and email validation still
run under their existing rules. Results are shared across projects; a
company's fit verdict is not shared across hypotheses.

Hardening added here:

- Concurrent identical searches in one worker share one pending operation,
  including its cache read. Completed results use the existing database cache
  across jobs, projects and redeploys. Simultaneous misses in different worker
  processes are not distributed-locked by this change.
- Cancelling one base removes only its waiter. Other bases retain the request;
  if every waiter leaves, the request is cancelled and its slot is released.
  Callers receive separate result objects.
- Positive discovery expires after 24 hours; successful empty discovery after
  one hour, replacing the original common 30-day lifetime. Future timestamps
  and malformed stored arrays are misses. Provider failures are not cached.
- Cache failure retains the ordinary paid-search fallback. The website reader
  still fetches current pages and checks identity before accepting evidence.

## Defer fit work until an email can be used

Previously `checkCollectedRelevance` sent every constructor output company
through paid fit checks even when none of its addresses passed validation.
It now selects companies with at least one single-address `ok`/`catch_all`
row. All observations of those companies remain classifier input, including
facts carried by an invalid sibling address. Neither useful source evidence
nor eligible recipients are removed.

Other companies are retained in the reserve with an explicit deferred marker,
not admitted and not classified as irrelevant. The reserve summary places
them under unfinished email validation. If email recovery later succeeds,
the normal fit and independent-review gates still run before admission;
the deferred marker is then cleared. Existing retry/source caps remain.
Coverage counts describe companies eligible for the paid gate in that pass;
deferred email rows remain visible separately in the reserve.

No model, prompt, relevance threshold, email status policy, target of 500,
collection concurrency, daily-supply eligibility or campaign setting changed.
No arbitrary monetary cap or low-yield cutoff was introduced.

## Verification

Existing regression scenarios were extended; no new test file or `it()` was
added. Offline checks verify:

- Thirteen concurrent identical requests make one underlying search;
  cancelling one waiter preserves the other twelve. Later calls reuse the
  saved result. All-waiter cancellation releases the operation for a retry.
- Successful empty results are reusable; provider errors, expired entries,
  future timestamps and malformed records are not. Mutating one caller's
  result cannot modify the next caller's result.
- A mixed constructor batch checks only the company with a usable email,
  retaining its invalid sibling's facts. Unknown/invalid-only companies stay
  reserved. A later recovered email undergoes the fit check and enters the
  ready projection only afterwards. Supply continuation still reaches its
  original target without rechecking already committed recipients.

Targeted suite: 29 checks passed. Full suite: 213 files / 2,405 tests passed
in 56.358 seconds. TypeScript, changed-file ESLint, diff whitespace and VE2
worker bundle passed. No production spend reduction percentage is claimed
before a post-release measurement on comparable workloads.
