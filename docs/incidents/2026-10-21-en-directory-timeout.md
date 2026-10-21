# EN autofill: directory timeout presented as nginx 404

Read-only investigation on 2026-10-21, approximately 06:05–06:14 UTC.

## Incident

Job `467fad62-53f1-4b12-8195-564c655cc4c3` started at 06:00:55 UTC and
failed at 06:02:44, before candidate processing. Found/ready were both zero
and there were no LLM calls or spend. The configured target was 1000.
The error notification was now correctly visible, but contained nginx HTML.
The general parser monitor also mislabelled the same job as HH / ENG Hiring.

## Confirmed cause

At 06:02:43 UTC, `main-kong` logged an upstream timeout for the directory
request with size `11-50`, the EN country/IT filters, offset 12504, limit 1000,
and `order=id.asc`. This is a directory read failure before SMTP checks.

The active portal nginx config handles 502/503/504 via `/50x.html`, rooted
at `/var/www/html`. That file is absent on the host, so the timeout is masked
by an nginx 404 page. The directory/table itself is available: a minimal
authenticated GET from the same worker returned 200 and a row. No endpoint,
credentials or permission settings were changed.

An EXPLAIN without execution under a read-only session showed the old request
using a parallel primary-key scan on the 19.5M-row table with filtering.
The exact failed request was retried read-only from the EN container and did
not finish within the diagnostic's 45-second limit.

## Local correction

The directory feed now orders by `country, industry, id`. This preserves a
unique, stable page order, the existing random initial offset, page size,
industry/size priorities and domain deduplication. Its plan uses the existing
country/size filter index with incremental sorting rather than the table-wide
primary-key scan. No migration or new index is needed.
The country/industry order within the selected filters changes which companies
appear first; this does not promise the same candidate sample as the old order.

The same filtered page, offset and limit with the new order returned HTTP 200
and 1000 directory rows in 12.149 seconds from the live EN container. This
checks the read shape, not preparation of 1000 qualified outreach companies.
Other offsets/load conditions were not benchmarked exhaustively.

Directory read errors now use the existing `PdlCompanyReadError`: the public
message is readable and raw diagnostic text remains attached to the Error.
There is no automatic conversion of a directory failure into an empty source.

The health monitor now reads `parser_type` for parser jobs and selects the
EN/RU label and `portal-worker-polza-outreach` log hint per row. Both failed
and stalled-job alerts use this presentation. Other parser labels, registry
entries, alert claim keys and daily aggregates remain unchanged.

## Verification and release boundary

- Seven offline directory scenarios passed: page continuity, stable order,
  random offset fallback, duplicates/exclusions, friendly gateway errors,
  permanent errors, and preserving the cursor after failure.
- Offline monitor checks passed for EN, RU and HH in failed/stalled paths,
  including actual query selection of `parser_type` and unknown-type fallback.
- Existing health monitor suite: 26 tests passed.
- Related PDL helper/API tests: 2 suites, 9 assertions passed.
- Core TypeScript, changed-file ESLint and diff whitespace checks passed.
- Branch selection: 30/34 suites passed in 58 seconds; 258 assertions passed,
  19 failed and 2 skipped. The same four unchanged Windows baseline suites
  failed (EPERM cleanup, CRLF SQL comparisons, Unix esbuild executable path).

No production code, nginx configuration, database data or job state was
changed. The failed job remains failed. Releasing the code and starting a
replacement collection are separate production actions requiring approval.
The missing nginx error page remains a separately documented infrastructure
issue; this change does not create or replace server files.
