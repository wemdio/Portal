# VE2: kraud.ru research without readable website HTML

Date: 2026-10-06. Based on `origin/test` at `baed76d0c` (fast-forwarded the task
checkout); intended delivery branch: `Sergey`. Production was only inspected.

## Verified failure

Read-only production SQL at 13:07–13:10 UTC found project
`8eee328a-2c66-4df9-8dde-1d279bcf0fa5`, `kraud.ru`, in `failed` status.
The latest site_profile job `7e97bfbe-47b5-4916-b404-a057d47434a2` was created
today at 11:28:15 UTC and failed after three attempts at 11:30:39 UTC:
`Не удалось получить HTML с сайта`. This is a repeated failure, not merely a
stale card from September 29. The project has no hypotheses or bases yet.

The saved client brief contains 22 nonempty fields, including company and
product descriptions (330 and 521 characters). No client content or contact
details were printed or copied into this handoff.

## Cause and change

The previous site-profile fallback handled only `VeOperationTimeoutError` with
label `website extraction`. The shared website parser can instead fail earlier
with the explicit no-HTML error above. A useful saved brief was therefore
ignored and all three attempts repeated the same failure.

`verticalEngineV2/stages/siteProfile.ts` now accepts that exact parser failure
as another reason to use the existing saved-brief/manual-description path.
It records `site_fetch_error: 'unavailable'`, zero website text and `site_thin`;
it does not present the missing site as evidence, crawl extra pages or extract
new site cases. Existing site cases are preserved. A successful later site
read clears the failure marker through the normal path.

Cancellation, the DNS/public-address check and arbitrary errors still reject.
Without saved business facts, no model call or database mutation is made by
this fallback. No shared website parser, ENG code, UI, migration or production
row was changed.

## Verification

- Expanded the already authorized case in existing `llmRetry.test.ts`; no new
  test file or `it()` was added. RU and US, brief and manual description,
  timeout and no-HTML failure all exercise the fallback; absent facts, blocked
  addresses, cancellation and unknown errors remain failures. Healthy-site
  behavior and case preservation are checked. All eight tests passed.
- Fast branch runner: 36 suites, 289 passed, 2 skipped, 10.643 seconds.
- Full `typecheck:strict` passed. `typecheck:fast` could not start its compiler
  because the local shared node_modules lacks `typescript-7/bin/tsc`; used the
  documented TypeScript 5 fallback without changing shared dependencies.
- ESLint for both changed files, the VE2 worker bundle and `git diff --check`
  passed. Local logs/bundle: `/Users/cybermart/.codex/handoffs/ve2-kraud-site-20261006`.

## After deployment

Deploy the worker containing this fix through the normal release process;
there is no migration for this change. Then open kraud.ru and click
**«Попробовать снова»**. Its saved brief can be used without uploading it again.
Deployment alone does not resume the failed research. No paid research was
started in this diagnostic/fix task, and production success after resume still
needs verification.
