# VE2: DNS contention and queued parser timeouts, 2026-09-16

## Observed production failure

After the scheduled deployment of `8b7291c43`, the fixed recent scope contained
45 preparations. At 02:06 UTC: 4 ready, 38 collecting, 3 errors. At 02:26 UTC:
4 ready, 24 collecting, 17 errors. At 02:38 UTC: 4 ready, 18 collecting,
23 errors. The 91 older preparations remained cancelled with no active VE jobs.
These snapshots do not authorize restarting old work or launching campaigns.

Fresh VE worker logs showed bursts of `UND_ERR_CONNECT_TIMEOUT` on Supabase GET
and PATCH requests, checkpoint save failures, and terminal provider accounting
failures. A new Node process inside the same container reached the configured
DB API in 191/12/11 ms at 02:27 UTC. The worker used about 1 GiB of its 8 GiB
limit. PostgreSQL had no observed blocking waits; conntrack and file descriptor
limits were not exhausted. These samples rule out neither transient network
trouble nor all forms of resource pressure.

The site evidence reader performed **two OS DNS lookups per hop**: the shared
demo SSRF precheck and an IPv4 lookup for pinning. Its five-second page timeout
discarded late answers but could not cancel those lookups. In the live worker,
two libuv worker threads were waiting on DNS sockets to Docker's resolver.
OS DNS lookups share a worker pool with hostname resolution for DB/provider
connections. Slow sites can therefore delay unrelated connections. This is a
verified code defect and the leading explanation for the process-dependent
timeouts; elimination of the production incident still requires verification
after deployment. Do not claim every provider failure had this cause.

Node documents the distinction between OS `lookup()` and asynchronous
`resolve*()` in its [DNS documentation](https://nodejs.org/api/dns.html#implementation-considerations).
A local Node 22 experiment with an occupied worker pool completed asynchronous
DNS in 5 ms versus OS lookup in 260 ms; this demonstrates the shared-pool
dependency, not a reproduction of every production error.

## Fix

- The VE evidence reader uses an independent asynchronous Resolver per read,
  with bounded DNS attempts and cancellation on the page/job abort. It does not
  occupy the OS lookup pool or leave unbounded background DNS work.
- Every hop still checks its URL and all IPv4 answers. The HTTP connection is
  pinned to a checked public address, keeps TLS hostname verification, and
  cannot follow redirects to private addresses. Contact relevance and email
  validation gates are unchanged. Shared ENG/demo code is unchanged.
- Parser timeout is checked **after reading actual child status**, measured from
  `started_at`. Pending tasks do not expire merely because they queued three
  hours ago; completed old tasks are harvested. Running tasks retain a bounded
  timeout, with dispatch-time fallback for historical rows lacking started_at.
- An explicit failed-preview continuation restores polling of the same child
  when its saved error is the old queue-age timeout. It does not insert another
  parser job or drop saved rows.
- Exhausted accounting persistence retries now log a sanitized failure code,
  event and job ID. Raw errors, credentials, URLs and row data are not logged.
  Stable journal IDs and the prohibition on replaying paid work are preserved.

## Validation and release boundary

Node 22.23.2: 213 suites / 2405 tests passed in 55.232 seconds. Existing cases
were extended; no test files or `it()` cases were added. Coverage includes
resolver cancellation/isolation, mixed private/public DNS answers, queued and
newly started children after long queue waits, same-child recovery, and journal
retry deduplication/redaction. TypeScript, focused ESLint, worker bundling and
`git diff --check` passed.

No production service restart, deployment or retry was performed while preparing
this fix. Release through the normal branch/deployment workflow, verify the
actual worker version, and then continue only eligible failed preparations in
the fixed recent scope. Do not use whole-project preparation on mixed projects:
it can revive explicitly cancelled old hypotheses. Preserve base IDs, children,
checkpoints, approvals and provider attempt accounting. Proxy failures and empty
results require their own diagnosis and must not be presented as fixed by DNS.

Local evidence and the exact recovery candidates are in
`~/.codex/handoffs/ve2-masha-live-20260916/`: `incident-pre-fix-status.json`,
`incident-recovery-candidates.json`, `worker-monitor-0228-timed.log`, and
`recent-scope-plan.json`. These contain operational metadata and remain local.
