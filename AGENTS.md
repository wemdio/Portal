# Portal AI agent rules

## Production infrastructure map (critical, current since 2026-07-22)

- The current production host is `139.60.162.12`. It runs the Portal app and workers, the main Portal Supabase/Postgres stack, the Instantly operational Postgres instances, and the analytics database `instantly_dataset`.
- The former DB host `144.31.54.166` is retained only for rollback copies and explicitly documented utility services. Do not use it as a current production database endpoint unless the user explicitly requests rollback verification or rollback work.
- Documented utility services on `144.31.54.166` include the email-validation SMTP probe proxies (`smtp-proxy` :3100, `smtp-proxy-b` :3101, Docker compose in `/opt/smtp-proxy`); a third probe runs as Python/systemd on `89.19.209.252` (Timeweb, `/opt/smtp-proxy/smtp_proxy.py`). Workers reach them via `SMTP_PROXY_URLS`. Note: on 2026-07-24 the hoster's DNS resolver (`169.254.2.3`) on `144.31.54.166` died and killed all probes with `EAI_AGAIN` despite green `/health` — public resolvers were added to `/etc/resolv.conf`, but `dhclient` may revert it; see `docs/incidents/2026-07-24-smtp-proxy-hoster-dns-outage.md`.
- `portal-db` means the main operational Portal database (projects, tasks, clients, invoices, CRM and related application data), normally through read-only access.
- `instantly-dataset` means the separate analytics/outreach dataset (`instantly_dataset`). Do not confuse it with the main Portal database or the Instantly operational databases.
- Connection strings and credentials remain local secrets in environment/MCP configuration and must never be committed. This map provides context; it does not grant access.
- If an MCP server, environment file, script, or SSH profile still points a production database connection at `144.31.54.166`, treat it as stale configuration and report it instead of silently using it. Historical migration documents and explicit rollback sources are the exception.

## Vertical Engine v2 / ENG boundary (critical, approved target)

- Read [`docs/design/2026-08-20-vertical-engine-v2-isolation.md`](./docs/design/2026-08-20-vertical-engine-v2-isolation.md) before changing the Hypothesis Engine, ENG outreach, or the internal Vertical Engine.
- The existing `app/src/lib/hypothesisEngine`, `app/worker/hypothesisEngine.ts`, `he_*` tables, and `HE_MODEL_*` configuration are the production backend of `/client/eng`. The current internal `/tools/hypothesis-engine` is only a legacy client of that shared backend.
- Do not implement a redesign of the internal tool inside the existing Hypothesis Engine. Build the internal Vertical Engine v2 beside it with separate `verticalEngineV2` code, `ve_*` tables/queue, worker, API, and `VE_MODEL_*` settings.
- Do not hide the legacy internal UI until v2 is usable and exposes verified internal legacy runs through a read-only archive. At cutover, normal specialists should see only v2; the legacy UI becomes admin-only/read-only, while its backend remains live for ENG.
- Do not infer whether an old `he_projects` row is internal or ENG from `market`/`autopilot`. Use a reviewed v2-side legacy mapping. New v2 runs must never write to `he_*`.
- The phase-1 v2 foundation may exist in code without being migrated or deployed. Check the actual migration/deploy state before assuming it is live. Until the cutover, any shared Hypothesis Engine change can affect both the internal tool and ENG and therefore requires both paths to be tested.

## Portal DB MCP guide

- Before answering questions through the `portal-db` MCP (schema, Polza terminology, Sales AI tables, SQL templates), read `docs/portal-db-mcp-guide.md` — the full usage guide for that database. Keep it updated when the schema, Sales AI pipeline, or sync workers change.

## Release and production boundary (critical)

- For code or documentation changes, the default authorized stopping point is: create a focused commit and push it to the current working branch for that task.
- Never switch to, commit to, or push to another developer's named branch unless the user explicitly requests that exact branch action.
- After pushing the current working branch, stop and report the branch, commit SHA, and validation results. The user normally handles all further merges and deployment through Tasks.
- Do not create or merge pull requests into `test` or `main`, trigger or rerun release/deployment tasks, or mutate production unless the user explicitly authorizes that exact phase in the current conversation.
- Broad requests such as "fix it", "чинить", "сделай", or "доведи до конца" authorize implementation and verification, but do not authorize promotion beyond the current working branch or production deployment.
- Never copy code directly to production or run production mutation commands such as image pulls, container recreation, migrations, or service restarts without explicit approval immediately before that action.
- Read-only production diagnostics are allowed when needed to investigate or verify status, but they must not change services, data, images, branches, or deployment state.
- If a release or deployment would be useful, state the exact branch/environment/action and ask for confirmation. Do not infer permission from an earlier approval to write code.
- If an unintended production-changing action starts, stop it if safely possible, report exactly what occurred, and do not roll back or make additional changes without the user’s direction.
