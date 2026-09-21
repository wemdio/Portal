# PostgreSQL cgroup OOM interrupted Base Constructor checkpoints

## Verified incident (UTC)

At **2026-09-21 10:41:47**, the kernel killed a PostgreSQL process inside
`main-postgres`: `CONSTRAINT_MEMCG`, memory usage and limit both
`12582912kB` (12 GiB). The cgroup matched the container ID. The killed
process had approximately 2 GiB anonymous RSS; that alone does not identify
the query or account for all container memory.

PostgreSQL entered internal crash recovery and terminated client connections.
PostgREST returned connection/schema-cache failures and Kong returned invalid
upstream responses. Connectivity/schema cache recovered around **10:42:20**.
This was **not a host reboot or Docker restart**: uptime exceeded 17 days,
the PostgreSQL postmaster started on September 6, Docker RestartCount was zero.

Two `validate_emails` jobs exhausted three checkpoint PATCH attempts before
the database recovered and became `failed` at 10:42:31–33:

| Job prefix | Last durable data | Recovery implication |
| --- | --- | --- |
| `5aed20f2` | 15,619 rows; 13,039 rows with nonempty validation state | Resume from stored per-row state; displayed 86% is not a durable-row count. |
| `6dc6a5cd` | 475 rows after dedup; no validation state column | Earlier steps are saved; validation may repeat from its beginning. |

No contact payloads were exported. Jobs were not reset or resumed during this
investigation. Source evidence: kernel journal, container identity/settings,
PostgreSQL/PostgREST/worker logs, read-only job metadata and checkpoint counts.

At 10:58–11:00, public health reported database/auth OK, PostgreSQL accepted
connections and was not in recovery; 5 jobs were processing and none pending.
Both affected jobs still had failed status. Host MemAvailable was 43,436 MiB
and PostgreSQL used approximately 3.54 GiB of its 12 GiB limit after recovery.
These are snapshots, not proof that another memory spike cannot occur.

## Code correction (prepared for Sergey, not deployed)

`updateJobWithRetry` now distinguishes temporary database/gateway/network
failures from ordinary errors. Temporary failures receive at most 10 attempts
within **120 seconds total, including HTTP time**, with exponential backoff
and jitter. An AbortSignal bounds the remaining request time and is cleaned up
after every attempt. Ordinary/invalid-payload errors retain the old three-attempt
limit. There is no global Supabase retry-policy change.

Each retry sends the same data snapshot and retains the existing job-ID,
run-token and optional cancellation-status predicates. The caller still awaits
durable persistence before moving past the checkpoint. Failed persistence
still stops the pipeline instead of publishing false completion. If ownership
changes, the old token cannot overwrite the replacement runner's state.

This change applies to Base Constructor checkpoint/step/final saves regardless
of whether a specialist or an automation created the job. It does not change
validation, AI prompts/models, queue priority, worker concurrency, job schemas,
or integrations' input/output formats.

Existing tests were extended without new test files or `it()` blocks: simulated
35-second recovery (502, 503, PostgREST schema-cache and PostgreSQL recovery),
unchanged payload/fences on every retry, non-transient three-attempt failure,
persistent network failure, hanging-request timeout and timer cleanup.
The old implementation failed the recovery/deadline checks before the fix.

Validation: all 233 suites / 2,531 tests passed in 59.3 seconds; TypeScript
`tsc --noEmit`, ESLint on changed TypeScript files, focused worker esbuild and
`git diff --check` passed. Existing tests include ownership/resume, validation
checkpoints and automation consumers. No real production outage was induced.

## Not yet fixed / next production phase

This is **incident tolerance, not an OOM cure**. The exact peak-memory query is
not established. Production `log_min_messages=fatal` suppresses useful recovery
context. Do not blame these two jobs, the host hardware, or the number of
workers without additional evidence. Current settings include shared_buffers
3 GiB, work_mem 16 MiB per plan operation, maintenance_work_mem 1 GiB and
max_connections 100; their interaction with query payloads/concurrency requires
measurement, not merely multiplying one setting by connections.

After explicit approval of the exact production actions:

1. Recheck host/container memory and cgroup OOM counters. Consider a measured
   increase from 12 to 16 GiB for PostgreSQL while retaining sufficient host
   headroom and bounded total memory+swap. Keep deployment configuration in
   sync so the limit survives recreation. No limit/config change is included
   in this patch; it must not silently restart PostgreSQL.
2. Deploy the worker fix through the normal release procedure with graceful
   handoff. Do not restart healthy workloads just to inspect them.
3. Inspect the two exact failed jobs and their parents again. Resume through
   the supported recovery path, preserving checkpoints and ownership tokens;
   do not blindly reset progress/data or launch duplicate jobs. Parent
   automations may also require supported reconciliation.
4. Verify subsequent checkpoint writes, parent status, health and memory under
   real load. Investigate large-query/payload allocation and improve bounded,
   privacy-conscious incident logging; extra memory alone is not a guarantee.

No production service, database row, memory limit, image or deployment was
changed while preparing this code correction.
