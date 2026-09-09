# Restore this Mac's SSH key through Semaphore

## Current evidence and scope

The [read-only check](https://kuladmeds.semaphoreci.com/jobs/5bb2c0cc-ea8f-4fa6-8e43-deefcfb34325)
on 2026-09-09 successfully connected to `root@139.60.162.24`, hostname
`33074.example.us` (Hostkey server 33074). It confirmed an existing root-owned
`/root/.ssh/authorized_keys` (regular file, one hard link, mode 600) inside
root-owned mode-700 `/root` and `/root/.ssh`. The daemon accepts public keys and
uses `.ssh/authorized_keys` and `.ssh/authorized_keys2` in the inspected config.
Older infrastructure notes using `.12` must not override this verified target.

This new **separate** task appends one fixed, public Mac key to the existing
`/root/.ssh/authorized_keys`. It grants the holder of the matching private key
root SSH access: this is a security-sensitive change, not another read-only check.
It must be confirmed by the owner immediately before the final **Run** action.
This runbook/commit is not proof that installation has happened.

Approved key identity:

- Algorithm: ED25519.
- Fingerprint: `SHA256:h3sRVPnsNrd+/HAQcvY8CwP6wVkn2PCGcDN2HMk+23s`.
- Comment: `Portal Mac Hostkey 2026-09-09`.
- Local private key: `/Users/cybermart/.ssh/portal_hostkey_mac_ed25519`.
- The fixed public key is in the remote program. Public keys and host identity
  pins are not secrets. The private key must **never** be committed, uploaded to
  CI/Hostkey or shown in output. No password/API token is changed or exported.

## Manual procedure

1. Confirm that the local `.pub` file has the fingerprint above and the matching
   private key is still present with mode 600. Do not print private key contents.
2. Obtain the Mac's current public **IPv4** with the same network/VPN route that
   will be used for the subsequent `ssh -4` verification. Do not reuse an old IP.
3. In Portal's Semaphore **Tasks**, create a separate **Unscheduled** task named
   `Install approved Mac SSH key`, branch `Sergey`, pipeline
   `.semaphore/ssh-key-install.yml`. Reuse `portal_secrets` only inside the runner.
   Do not edit the read-only task, default push pipeline, deployment task, secrets,
   promotions, `test` or `main`. Do not give this task a cron schedule.
4. Define required parameters, both **without default values**:
   - `SSH_KEY_INSTALL_CONFIRM`: only allowed option `INSTALL_MAC_KEY_33074`.
   - `SSH_MAC_PUBLIC_IP`: the freshly verified public IPv4 from step 2.
5. **Stop for explicit approval immediately before Run.** State the host, root
   access, key fingerprint and append-only change. An earlier approval to prepare
   code is not approval to grant access. If approval is refused, do not run it.
6. Run once from the reviewed `Sergey` commit, with those parameters. The runner
   authenticates using its existing password; it does not obtain the Mac private
   key. SSH host checking is pinned and never disabled. There is one connection,
   no retry, a 75-second timeout and forced termination after another 5 seconds.
7. Read the result, then make a fresh **key-only** SSH connection from the Mac
   (fixed host pin, `-4`, `IdentitiesOnly=yes`, `IdentityAgent=none`,
   `BatchMode=yes`, `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`,
   `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, no reused control connection).
   Check only `id -u` and hostname. Do not run a deployment or mutate services.
8. Keep the task **Unscheduled**; do not delete its execution history as cleanup.

## Safety checks and limits

The remote program uses only existing Python standard-library facilities and runs
as `/usr/bin/python3 -I -S -B -`: no site hooks, bytecode, dependencies, on-disk
script, temporary server files, service commands or database calls. Only the CI
runner may install `sshpass`. The existing read-only pipeline remains unchanged.

Before any append it requires the verified hostname/SSH endpoint/root home, the
observed default sshd listener command, and acceptable `sshd -T -C` results for
both CI and Mac source IPs. Unexpected custom config paths, key sources, forced
commands, revoked-key files or user/group filters cause failure; it does not fix
or disable these protections. An on-disk config check is not proof of the loaded
daemon state; only the subsequent fresh Mac login proves that access works.

Directory/file descriptors use `O_NOFOLLOW`, with ownership/mode/type/inode checks,
nonblocking locks and a 1 MiB bound. Both effective key files are checked for an
existing key, including an options-restricted copy, before adding anything.
An existing occurrence returns `KEY_ALREADY_PRESENT` without changing restrictions;
it does not prove the Mac can log in. Missing/unsafe files are never created or fixed.

The only intended production write is **one append** of the fixed public-key line
(plus a separating newline if needed). Existing bytes, ownership, mode, inode and
key options are preserved, then the file is flushed and verified. There is no
truncation, rename, chmod, chown, restart, backup file, or automatic rollback.

`KEY_INSTALLED` confirms that the append and local verification completed; it is
not a substitute for Mac authentication. A short write, fsync failure, path/content
race, timeout or lost connection is **uncertain**, not proof of no change. Do not
rerun automatically: inspect read-only first. Locks are advisory and cannot stop
another root process that ignores them; detected races fail and never trigger a
destructive rollback. Keep other SSH-key maintenance paused during the operation.

To revoke this access later, obtain separate approval and remove only this exact
key after confirming another working login remains. Never replace the whole file.
