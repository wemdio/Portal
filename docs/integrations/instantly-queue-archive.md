# Administrative retirement of an Instantly qualification backlog

This is an explicit operator action, not a classifier verdict and not a daily
cleanup job. Retiring a backlog can suppress notifications about real leads
that were not yet recognized. Obtain approval for that consequence and freeze
the exact scope before applying it. Do not archive new replies automatically.

## Data and processing contract

- `queue_archived_at` and `queue_archive_batch_id` remove a qualification from
  automatic processing. Its original status, email/source IDs, reply body,
  ownership evidence, AI checkpoints and attempt counters are retained.
- The qualification remains in place for intake/webhook deduplication. Deleting
  it, resetting discovery cursors, or relabeling it `not_lead` is not equivalent.
- The worker excludes archived rows **before pagination/limits**, before paid
  classification and before notification/handoff actions. Manual API and stale
  Telegram actions are also blocked. Archived history remains readable.
- A database trigger fences writes/deletes to archived qualifications, including
  attempts by older code to overwrite them. Only the audited archive/restore
  RPCs can change the archive markers.
- An immutable batch ledger stores the exact IDs, original operational metadata
  and each `archived`/`skipped` result. Original message bodies remain in the
  protected qualification, not duplicated in the ledger.
- The RPC skips missing/locked, processing, terminal and delivery-protected
  rows. It never interrupts an already running job or cancels an external
  request that has already started. A successful operation need not produce an
  empty queue: report actual archived/skipped/remaining counts.

The API `/api/instantly/qualified-leads` supports
`queue_state=active|archived|all`. Recovery-status filters and counts default to
active rows; the historical business feed retains original verdicts and archive
markers. `counts.archived` is separate from the active backlog.

## Rollout boundary

1. Commit/push the implementation to the user-approved branch. This is not a
   production rollout.
2. The user deploys the app and Instantly worker through the normal release
   process. Migration
   `20260912_0001_qualification_queue_archive.sql` belongs to the **Instantly
   operational database**, not the main Portal DB or analytics dataset.
   The migration installs schema/functions only: it archives no records.
3. Verify the migration and the running application/worker builds. New code
   requires the archive columns; do not deploy it without the migration. An old
   worker may still spend API/AI calls even though the SQL trigger prevents its
   final write, so installing only the migration is not sufficient.
4. Only then perform the separately approved archive operation against the
   frozen manifest. Do not deploy, restart, migrate or apply from a monitor.

## Local CLI

Read `docs/ssh-access.md` first. The administrative CLI uses this Mac's existing
key and verified server, checks host identity and does not print credentials.
It never calls Requesty or the Instantly email API, sends mail, or deletes rows.
Status and snapshot use read-only database transactions.

```sh
node app/scripts/instantly-queue-admin.mjs --mode status
node app/scripts/instantly-queue-admin.mjs --mode snapshot \
  --cutoff APPROVED_ISO_TIMESTAMP --out /absolute/private/path/manifest.json
```

Snapshot accepts at most 5000 exact pending/review/error qualification UUIDs,
excludes existing archives and known specialist deliveries, validates a digest,
and creates the private file with mode `0600`/exclusive creation. Do not commit
manifests or put them in shared report directories. A changed queue does not
authorize widening the frozen scope.

After rollout verification and explicit approval for production archiving:

```sh
node app/scripts/instantly-queue-admin.mjs --mode apply \
  --manifest /absolute/private/path/manifest.json \
  --confirm-batch-id EXACT_MANIFEST_BATCH_UUID --expect-count EXACT_MANIFEST_COUNT \
  --confirm-deployed --confirm-archive
```

`apply` checks the deployed dedicated worker, bounded Next server bundle markers,
and the legacy `portal-worker` monolith if present. Unknown layouts fail closed;
these probes complement, not replace, verification of the deployed revision and
all actual entrypoints/containers. It also checks the migration and rechecks main
Portal specialist-delivery logs. If a manifest row acquired a delivery, it stops
for review instead of silently rewriting the manifest. Instantly-side delivery
protection and status/row locks are rechecked inside the archive transaction.
The two databases and external sends do not form one atomic transaction.

`apply` prints its receipt and current manifest counts to stdout. It does not
accept `--out`, avoiding a local file-write error after a successful commit.
If SSH drops after a mutation starts, the transaction outcome can be uncertain:
inspect the batch ledger first and retry **only the same manifest and batch ID**.
A matching repeat returns the stored receipt, without archiving more replies.
Never create a new batch just to retry an uncertain operation.

The live-state recheck is separate from the historical receipt. An old receipt
can still say `archived` after an explicit restore; use `archived_now` and current
status metrics to establish the present state. A recheck failure after COMMIT is
reported as such, not as proof that nothing changed.

## Restore and rollback

`restore_instantly_qualification_queue(batch_id, exact_uuid_subset, reason)` is
the audited, explicitly authorized reversal. It validates membership and removes
only archive markers. It does not reset AI counters, invent a verdict, overwrite
the original reply, or automatically retry skipped records. Restored work can
be processed and notified again; obtain approval before restoring it.

Do not drop the migration as an operational rollback: archived history and its
fence must remain. Rolling the worker back to an older version can restore wasteful
retries despite the database fence. Verify runtime compatibility first.

## Monitoring

Read-only monitoring must track active qualifications, intake and discovery for
**both accounts**, plus Telegram outcomes. Empty intake is not proof of a healthy
discovery scan. Archived old rows must be counted separately from new work.

Useful alert conditions: more than 5 active entries for two consecutive 15-minute
samples, a fresh reply waiting over 2 hours, stopped discovery, new delivery
failures, or evidence of archived work being processed again. Alert on recovery
from a reported incident, but stay quiet for unchanged/healthy state. These are
observation thresholds, not a guarantee that external services cannot fail.

The thread's local heartbeat requires this Mac and the application to be running.
Loss of SSH is loss of visibility, not a zero backlog. It must never apply an
archive, restore, deploy, migrate, resend or perform a paid classification.

## September 12 operation status at preparation

Read-only capture froze **2413** candidates at cutoff
`2026-09-12T13:32:46.368Z`. The preceding live count was 2416; three entries left
the eligible queue before freezing and are not part of the manifest. No known
specialist-delivered candidates remained in the frozen snapshot.

At preparation, production did not yet have either the new archive guards or
the prior durable-intake payload fix. **No archive was applied.** The private
manifest/baseline and current operation handoff are stored on the Mac outside
Git; consult them and fresh production status rather than treating this document
as proof of a later successful rollout or archive.
