# Portal AI agent rules

## Release and production boundary (critical)

- For code changes, the default authorized stopping point is: create a focused commit and push it to the `Sergey` branch.
- After pushing to `Sergey`, stop and report the commit SHA and validation results. The user normally handles all further merges and deployment through Tasks.
- Do not create or merge pull requests into `test` or `main`, trigger or rerun release/deployment tasks, or mutate production unless the user explicitly authorizes that exact phase in the current conversation.
- Broad requests such as “fix it”, “чинить”, “сделай”, or “доведи до конца” authorize implementation and verification, but do not authorize promotion beyond `Sergey` or production deployment.
- Never copy code directly to production or run production mutation commands such as image pulls, container recreation, migrations, or service restarts without explicit approval immediately before that action.
- Read-only production diagnostics are allowed when needed to investigate or verify status, but they must not change services, data, images, branches, or deployment state.
- If a release or deployment would be useful, state the exact branch/environment/action and ask for confirmation. Do not infer permission from an earlier approval to write code.
- If an unintended production-changing action starts, stop it if safely possible, report exactly what occurred, and do not roll back or make additional changes without the user’s direction.
