# Portal AI agent rules

## Production infrastructure map (critical, current since 2026-07-22)

- The current production host is `139.60.162.12`. It runs the Portal app and workers, the main Portal Supabase/Postgres stack, the Instantly operational Postgres instances, and the analytics database `instantly_dataset`.
- The former DB host `144.31.54.166` is retained only for rollback copies and explicitly documented utility services. Do not use it as a current production database endpoint unless the user explicitly requests rollback verification or rollback work.
- `portal-db` means the main operational Portal database (projects, tasks, clients, invoices, CRM and related application data), normally through read-only access.
- `instantly-dataset` means the separate analytics/outreach dataset (`instantly_dataset`). Do not confuse it with the main Portal database or the Instantly operational databases.
- Connection strings and credentials remain local secrets in environment/MCP configuration and must never be committed. This map provides context; it does not grant access.
- If an MCP server, environment file, script, or SSH profile still points a production database connection at `144.31.54.166`, treat it as stale configuration and report it instead of silently using it. Historical migration documents and explicit rollback sources are the exception.

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
