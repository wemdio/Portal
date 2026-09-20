# Reply intake Unicode failure and automatic-processing window

## Scope and evidence

On 2026-09-20 a read-only post-deploy check found repeated PostgreSQL `22P05`
errors (`\u0000 cannot be converted to text`) in the main Instantly account's
discovery RPC. One malformed email could reject a whole page; failure preceded
the redeploy. The observed qualification backlog was 45 pending rows, 43 older
than 24 hours, with up to 307 recovery attempts. This is a dated operational
snapshot, not a claim about the queue after these code changes.

The user explicitly requested a fix **without processing historical replies or
tagging specialists over the weekend**. This change is for `Sergey` only. No
production write, migration, deploy, queue replay, paid model call or Telegram
message was performed during development.

## Changes

- Sanitize NUL and unpaired UTF-16 surrogates before encoding/compressing intake
  payloads and at the Instantly database JSON request boundary. Valid emoji,
  line breaks and literal escape text remain intact. Hosted Supabase keeps its
  existing authorization, URL and timeout behavior.
- `20260920_0001_reply_automation_window.sql` creates a singleton cutoff at its
  **first application**. `ON CONFLICT DO NOTHING` preserves it on reapplication;
  runtime roles can read, not move it. Worker restarts/redeploys do not change it.
- Automatic classification and notification require a reply at/after that
  cutoff and within 24 hours. Source timestamp and durable row creation time
  are both considered; changing `updated_at` cannot renew the window. Missing
  provider timestamps alone do not prove a reply is old; durable creation time
  still bounds retries. Missing policy/migration fails closed.
- Intake withdrawals use an account- and lease-checked RPC before decoding the
  payload. `accepted` plus `last_error_code=historical_processing_disabled`
  denotes an intentional skip, **not successful AI classification**. The source
  payload remains available. New historical discoveries are not staged, while
  durable discovery/cursor progression still works.
- Expired generated qualification retries use the existing audited archive
  RPC, preserving status, evidence, owner and attempt counters. Sweep runs
  independently of AI/provider cooldown; no provider/context/model read is
  needed. Concurrent processing or protected delivery records are not forced
  into the archive, but automatic paths still obey the time fence.
- Polling, Others, webhook drain, direct qualification, missing-source refresh,
  legacy adoption, retries, specialist/client delivery and handoff preparation
  respect the same policy. Historical semantic/error records are not reopened.
  Existing manual specialist actions and client notification preferences are
  unchanged. This is **not a general weekend mute** for genuinely new replies.
- Russian ownership-retry reasons retain the ownership backoff class rather
  than being misclassified as dependency failures. Pending attempts no longer
  produce a misleading `completed_or_replaced` retry log.

This supersedes earlier unlimited cold-history recovery behavior for automatic
processing. It does not manufacture a negative business verdict when evidence
or a provider is unavailable. It does not change the classifier model/prompt.

## Validation

- Two user-approved regressions in the existing worker test file; no new test
  file/dependency in the repository. Both local and hosted database requests
  tested using a fake fetch. Old replies cause zero provider/AI/Telegram calls;
  a fresh reply still classifies and delivers through mocked services.
- 292 checks in seven existing suites passed, including qualification,
  ownership, Others, read-admission and migration grants.
- 59 one-off checks executed actual SQL in ephemeral PGlite: repeated migration,
  cutoff stability, role permissions, lease/account fences, fresh versus old
  intake, archive idempotency, protected delivery/processing, unchanged business
  status and attempt count, PostgreSQL JSON rejection and Unicode sanitization.
- Changed TypeScript files pass ESLint; dedicated worker bundles successfully.
- Full project `tsc --noEmit` passed with an 8 GiB Node heap. The initial run
  with the default 4 GiB heap exhausted memory; increasing the local check's
  heap was sufficient. No repository/production memory setting was changed.

## Release / verification boundary

Normal deployment's `app/scripts/db/ensureDatabase.js` applies the Instantly
migration when `INSTANTLY_DATABASE_URL` is configured. Apply migration before
running the new worker. Do not manually replay old rows after rollout. A code
push alone does not stop the already running production version.

After a separately requested deployment/check, use read-only diagnostics:
confirm the singleton exists and stays unchanged, discovery no longer reports
`22P05`, fresh intake progresses, old rows show explicit withdrawal metadata,
and no old-reply AI/delivery occurs. Do not silently restore archives, backdate
the cutoff, restart services or trigger notifications as a verification step.
