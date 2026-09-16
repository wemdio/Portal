# VE2: remaining preview failures, 16 September 2026

## Read-only production audit

At 13:27 UTC the previously agreed set of 45 recent outreach preparations had
22 `ready`, 19 `error`, and 4 `collecting` records. The 91 older stopped
preparations remain outside the recovery scope. No production records, queues,
services, or deployments were changed during this follow-up.

`ready` means preparation finished, not that the 500-contact goal was met:
11 of those 22 bases had at least 500 rows; the other 11 had 1–292 rows.
This audit did not independently revalidate every ready recipient.

A final metadata-only check at 13:46 UTC showed 23 ready, 18 error, and 4
collecting in the same scope. Still only 11 ready bases had at least 500 rows;
12 were below the goal. This progress came from existing production work.

The 19 errors comprised nine malformed AI responses, two old Yandex parser
failures, three transient Serper failures, one old HH child timeout, one usage
journal failure, one company-name failure, and two completed empty bases.
The preceding catalog/output fixes are in `16806b215`; they were not deployed
by this audit. Historical terminal errors must not be reported as newly fixed
production results merely because code has changed.

Native read-only SQL projected metadata for eight bases, rather than loading
their full JSON through PostgREST. The usage-journal job failed at 02:08 UTC;
the inspected current worker log had no new `[ve-cost]` failure. Its existing
idempotent journal-write retry remains fail-closed.

## Additional fixes

### Company names

Base `054b4c43-6ae0-45b8-be9d-c3edd32224c7` retained two failed company names
alongside successful contacts. Whole-batch semantic validation could discard
every name if the model expanded or renamed just one brand.

The response now uses native structured output where supported. Index coverage
and uniqueness still validate the whole response; name fidelity validates each
company separately. An invented/expanded brand falls back only to the original
source words with normalized whitespace, as already permitted by the prompt.
No domain-derived brand or heuristic shortening is substituted. Unsafe/empty
names remain withheld. The canonical identity column is unchanged.

Successful names are checkpointed and reused. Malformed-output costs are
included, safe validation diagnostics are logged, and provider/configuration/
accounting failures stop further paid batches instead of cascading across them.

### Buyer scope versus proposed benefits

The empty metallurgy base had valid-email reserve rows whose reasons demanded
evidence of unified sample history or certificate software, both benefits of
the seller's offer. The refinery hypothesis likewise combined a real buyer
requirement (a refinery with a quality laboratory) with what LIMS would do.

Both independent classification stages now explicitly distinguish buyer
requirements from proposed benefits/pains. Actual required activities and
facilities remain evidence requirements: a reseller is not a manufacturer,
a single clinic is not a clinic network, and an external laboratory is not
proof of a refinery's own laboratory. No recipient is admitted without the
existing email, exact-evidence and independent-review gates.

Website policy revision 4 permits a bounded follow-up for unresolved saved
companies when an authorized preparation/review is running. It retains the
initial classification cache and already confirmed companies. A new website
review under the corrected policy has a distinct semantic-review key so an old
`insufficient` answer cannot mask the correction. This does not enqueue stopped
preparations or turn unapproved previews into daily supply.

### Continue after an accounting interruption

Base `7aada9ee-09e5-4254-9fb2-746ce5f02211` failed between rounds with a saved
source child and a `collecting` target checkpoint. It did not match existing
failed-preview recovery kinds, allowing an explicit continuation to create a
replacement base. Recovery now recognizes this exact journal error with a
coherent checkpoint and reuses the same base, children and cursors. It does not
recognize cancellations, supply runs, or inconsistent checkpoints.

## Validation and remaining work

- Full suite: 213 files, 2,405 tests passed in 56.679 seconds after integrating
  the separate Sergey commit `08dc013b4`; no new test files
  or `it()` cases. Existing retry/recovery assertions extended.
- TypeScript, changed-file ESLint, diff whitespace and VE2 worker bundle passed.
- Real Requesty probes: both failed production name inputs completed. Eight
  synthetic buyer-fit examples covered refineries, metallurgy and clinic
  networks: all three direct target examples matched; five adjacent or
  insufficient examples were withheld. One external-laboratory answer was
  `direct_conflict` rather than the probe's initial `insufficient` expectation;
  both withhold admission. These are bounded examples, not a quality benchmark.
- Probe cost total: USD 0.00594045, recorded locally; no production ledger or
  campaign writes.

Release and post-release recovery are still required. Recheck the fixed set of
45 recent preparations, including the 11 limited results and both empty bases;
do not revive old stopped runs or promise that every niche can yield 500
verified contacts. The other developer's shared company cache has not been
verified or integrated by this change.
