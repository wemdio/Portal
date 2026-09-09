# One-time SSH access check through Semaphore

This is a **read-only preparation step**, not SSH key installation or deployment.
It uses the existing `portal_secrets` SSH credentials inside the CI runner. No API
token is required, regenerated, exported or committed. No private key is uploaded.

## Target and boundary

- Hostkey server **33074**, verified address **139.60.162.24**, SSH user `root`.
- ED25519 host fingerprint: `SHA256:dl0Kdm8qTiwQlu1DpBC3w77WIxjSPG0BhQJs2D/RW0o`.
- Verified from the authenticated Hostkey panel and the previously trusted SSH
  fingerprint on 2026-09-09; the pinned public key was checked again that day.
- Older `AGENTS.md`, `CLAUDE.md` and local server configuration still refer to
  `139.60.162.12`. Do not use those values for this recovery or silently override
  conflicting CI secrets. If `HOST` or `USER` differs, the check refuses to connect.
- This does not update the production infrastructure map or prove database
  endpoints; those require a separate verification.

Only the new standalone pipeline and its diagnostic script are used. The normal
push/deploy pipelines, app, workers, databases and routing policies are untouched.
Pushing these files to `Sergey` can run the existing cheap CI shell checks, but
does **not** run this SSH task or a deployment. Do not merge to `test`/`main` for
this operation, add promotions, edit the scheduled deployment task, or schedule it.

## Manual run (separate approval required)

After the owner approves the one-time diagnostic execution:

1. Open the Portal project in `kuladmeds.semaphoreci.com`, **Tasks → New task**.
2. Name it `SSH access check — read only`. Select branch `Sergey` and pipeline
   `.semaphore/ssh-access-check.yml`; confirm the reviewed commit is present.
3. Add the required parameter `SSH_ACCESS_CHECK_CONFIRM`, without a default value;
   its only allowed value is `CHECK_ONLY_33074`.
4. Select **Unscheduled**, not a cron schedule. Create the task.
5. Choose **Run now**, recheck branch and pipeline, explicitly supply the parameter,
   and run once. Do not rerun deployment workflows or reset an API token.
6. Read only this job's diagnostic output. Do not dump `portal_secrets`, environment
   variables, private keys or the contents of `authorized_keys` into logs/artifacts.

Semaphore documents this workflow in [Tasks](https://docs.semaphore.io/using-semaphore/tasks).
For **Run now**, the scheduler sets `MANUAL_RUN`, not `SCHEDULE`: see the
[scheduler implementation](https://github.com/semaphoreio/semaphore/blob/main/periodic_scheduler/scheduler/lib/scheduler/actions/schedule_wf_impl.ex).
The general environment-variable documentation describes Tasks too broadly; our
first run on 2026-09-09 stopped at the old SCHEDULE guard, before any SSH connection.
The script now requires `SEMAPHORE_WORKFLOW_TRIGGERED_BY_MANUAL_RUN=true`, rejecting
the cron path. It is an accidental-trigger guard, **not** proof of Task identity or
authorization to write. The explicit confirmation, branch and pinned server checks
remain mandatory; this script has no write mode.

## Interpreting the result

The script pins the server key and makes at most one password authentication
attempt, with a 75-second timeout and forced termination after another 5 seconds
if necessary. A mismatch fails closed before credentials
are transmitted to an unverified server. There are no retry loops or paid AI calls.
The runner may install `sshpass` on its disposable CI machine, never on production.

`CHECK_COMPLETE` means only that CI access works and diagnostics were read. It does
**not** mean Mac SSH access has been restored. The server can still record normal
SSH/PAM/audit logs; “read-only” means no requested change to its files or services.

The printed `sshd -T` values describe the default on-disk configuration for the
CI source address. Review actual daemon arguments (`-f`/`-o`), config includes and
`Match` rules before treating these as live settings. Mac source-IP rules and the
effective authorized-key path must be checked separately; `/root/.ssh/authorized_keys`
is reported only as a conventional candidate. A successful deploy in the past is
not proof that these current credentials work.

Stop on failure; do not change passwords, host pins, firewall settings, services
or access policy to make the check pass. If access works, prepare the smallest
idempotent append of the already generated Mac **public** key to the verified key
file and obtain explicit approval immediately before that production write. Do
not replace existing keys, grant permissions to every key, or restart sshd.

Keep the task unscheduled to preserve its audit history. Deleting a Semaphore Task
also deletes its execution history; do not delete it as routine cleanup. Temporary
runner `known_hosts` is removed on normal completion; the script saves no password
file, and the Mac private key never leaves the Mac.
