# EN autofill: email verification stop at 20 companies

Checked on 2026-10-20, approximately 19:17–19:24 UTC (22:17–22:24 Moscow).
All production actions were read-only diagnostics and SMTP recipient probes;
no mail was sent, services restarted, settings changed, or collection resumed.

## What stopped the run

EN autofill job `dbe42f89-c672-4165-82d3-26cb100e712f` failed at
19:07:45 UTC after 500 candidates and 20 ready companies. Its error records
15 consecutive inconclusive company-email results. LLM spend was $0.8224 of
$15. The October 17 job `643d316b-5eda-40b0-8f4d-e88eff62d47a` reached
1000 ready companies from 23810 candidates with the same collection settings.

An `unverified` company result does not establish that the proxy is down.
It also covers DNS failures, recipient policy refusals, greylisting, inability
to determine catch-all, and the company-wide verification deadline.

## Verified proxy state

The live EN worker has all three configured endpoints:

| Endpoint | Outbound IP | Control probe from the EN worker |
|---|---|---|
| `144.31.54.166:3100` | `144.31.54.166` | Gmail recipient accepted, SMTP 250 |
| `144.31.54.166:3101` | `31.76.79.220` | Gmail recipient accepted, SMTP 250 |
| `89.19.209.252:3100` | Timeweb | Gmail recipient accepted, SMTP 250 |

Both containers on 144 were running without OOM/restarts since 17:49 UTC.
Their retained logs for 18:00–19:10 recorded 2280 and 2064 HTTP 200 responses,
respectively. HTTP 200 alone says nothing about the SMTP verdict in the body.
Their host had public DNS resolvers configured and ample free memory.

## Failures reproduced on addresses from the stopped run

1. **Recipient rejects one outbound IP.** The Microsoft MX for `ieleads.com`
   returned `550 5.7.1` identifying `144.31.54.166` as blocked using Spamhaus.
   The same recipient was accepted with SMTP 250 and catch-all=false via
   `144.31.54.166:3101` and Timeweb. The Microsoft MX for `spurtest.com`
   returned the same Spamhaus refusal via port 3100, but via the other two
   egresses returned 451 with a recipient-tenant configuration error.
   The deployed validator fails over transport failures and selected 4xx
   egress refusals, but returns this 550 immediately; it subsequently becomes
   an inconclusive policy result instead of trying a working alternative.

2. **Web subdomains treated as potential mail hosts.** Of the 15 most recently
   saved `unverified` addresses, 13 domains returned no explicit MX in a new
   DNS lookup from the EN worker. Several are web/application/documentation
   subdomains. For `dashboard.sendblue.com`, its A records point to Cloudflare;
   the implicit-MX fallback probes that web endpoint on SMTP port 25. Both
   144 proxies returned HTTP 200 with `SMTP connect timeout` after about
   8 seconds. The Timeweb request reached the diagnostic's 24-second limit.
   This is a recipient endpoint problem, not evidence of a dead proxy.

This is a small targeted sample, not an estimate for the whole source pool.
The EN rows do not retain per-address validator details, so exact historical
reasons for all 98 inconclusive rows cannot be reconstructed from those rows.
These probes establish current reproducible failure paths, not the historical
verdict of every address.

## Notification correction

`outreachAutofill/check.ts` previously included the job error only when zero
companies had been uploaded. Partial success hid the error behind the ordinary
shortfall message and promised a future refill. The correction always reports
failed-job reasons and partial counts, preserves simultaneous delivery errors,
and excludes failed collection/delivery from the source-exhaustion streak.
Ordinary shortfalls state the next scheduled check rather than promise success.
The EN runner's stop text now describes inconclusive company checks without
claiming the proxies are unresponsive. The breaker threshold and validation
policy are unchanged.

## Validation and remaining work

- Ten offline scenarios exercised the actual notification tick with mocked
  database, sender and notification dependencies, including partial/zero/full
  failure, missing reason, simultaneous delivery failure, transient retry,
  success, and repeated normal shortfalls. No permanent tests were added.
- Core TypeScript and ESLint for both changed files passed.
- The branch test selection ran 34 suites in 70 seconds: 30 passed; 4 failed
  with 19 failures in unchanged files. These reproduce the Windows limitations
  already recorded in memory session `2026-10-20-f73b661f8c75`: temporary-folder
  EPERM cleanup, CRLF-sensitive SQL comparisons, and the Unix esbuild executable
  path. There were 258 passing and 2 skipped assertions.

Before changing SMTP behavior, separately address policy-specific 5xx failover
and distinguish recipient/domain failures from proxy transport failures in the
breaker. Preserve definitive mailbox rejections and do not mark unknown
addresses ready. Review suspicious extracted subdomain addresses with their
source context. Infrastructure changes, deployment and a production rerun are
not authorized by this diagnostic request.
