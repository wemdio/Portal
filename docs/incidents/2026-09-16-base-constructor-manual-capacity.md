# Manual constructor capacity, 2026-09-16

Automatic pipeline children used their owner's six-active-job quota. All twelve
constructor workers could also be occupied by automation, blocking manual uploads.

The API now counts only manual or unclassified pending/processing jobs. The UI
receives the full count, independently of its twenty-row history window. Producers
write a trusted `workload_origin`; authenticated clients cannot change it. Names
and user-provided step configuration are not classification signals.

Replicas 2 and 3 reserve one slot each exclusively for manual uploads, including
stale-job recovery. They never borrow automatic jobs. The other ten replicas keep
the shared queue and bounded preview slots. Container memory limits are unchanged.
This reserves two execution slots, not provider capacity or zero waiting time when
other manual jobs occupy them.

## Release and compatibility

Apply both `20260916_0001` and `20260916_0002` migrations before starting the new
application/workers. The metadata change and historical backfill are separate
transactions. Backfill uses durable VE2/HE/OutreachOS parent references; remaining
historical jobs count as manual. Old-version writers can still insert NULL during
rollout; these jobs use only the shared pool until a trusted parent repairs them.
New GIS automation is tagged; unknown historical origins are not guessed.

After deployment verify migration ledger, actual `BASE_CONSTRUCTOR_QUEUE` values
(two manual, ten shared), fresh worker heartbeats and that manual replicas do not
claim automatic children. Do not launch a paid artificial job just to test capacity.

## Validation

213 suites / 2405 tests passed in 57 seconds. Existing regression cases cover quota
isolation, pending/stale selection, unknown origins, read failures and all twelve
compose replicas. Type checking and all five affected worker bundles passed.
An isolated PostgreSQL/PGlite fixture executed both migrations and checked six
parent-reference paths, ignored filenames, client spoofing protection, old-writer
NULL compatibility and service-role repair. Production verification follows release.
