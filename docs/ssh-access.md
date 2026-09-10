# SSH access from the project Mac

## Current verified access

Local public-key authentication was restored and a read-only connection returned
`SSH_OK` on **2026-09-10**. Do not start credential recovery or a Semaphore access
task before trying the existing local connection.

- Hostkey server ID: **33074**.
- SSH endpoint: **139.60.162.24**, port **22**.
- SSH user: **root**.
- Local private key: `/Users/cybermart/.ssh/portal_hostkey_mac_ed25519`.
- Matching public key: `/Users/cybermart/.ssh/portal_hostkey_mac_ed25519.pub`.
- Trusted ED25519 host fingerprint:
  `SHA256:dl0Kdm8qTiwQlu1DpBC3w77WIxjSPG0BhQJs2D/RW0o`.

The private key remains outside Git on this Mac (verified permissions `0600`).
This document contains connection metadata and paths, **not key contents**.

## Read-only connection check

Run in the terminal on this Mac:

```sh
ssh -i /Users/cybermart/.ssh/portal_hostkey_mac_ed25519 \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  root@139.60.162.24 'printf SSH_OK'
```

No SSH alias, password prompt, temporary control socket or environment file is
needed for this check. `StrictHostKeyChecking=yes` uses the existing local
trusted-host record; never bypass it to make a failing check succeed.

## Instructions for another agent

1. Read this file and `AGENTS.md` before looking elsewhere for SSH credentials.
2. Check that the key file exists without printing its contents.
3. Run the read-only command above, if the current task needs server access.
4. If successful, use the same explicit identity and host-verification options
   for authorized diagnostics.
5. If it fails, report the actual error. A timeout can be a network/VPN issue,
   not proof that the key needs replacement. Do not change firewall rules,
   passwords, SSH configuration, keys or CI secrets on your own.
6. If the server fingerprint differs or its trusted record is missing, stop
   and obtain independent verification. `ssh-keyscan` alone is not proof of
   server identity; do not auto-accept or overwrite `known_hosts`.

An agent running in a cloud sandbox, another computer or a restricted environment
may not have access to this path. Documentation does not transfer the key or
grant filesystem/network permissions. **Never ask the user to paste the private
key into a chat or copy it into the repository.**

The user uses different VPN connections. Do not assume one permanent client IP
or add an IP allowlist as an unsolicited fix.

## Historical addresses and scope

Earlier `AGENTS.md`, `CLAUDE.md`, worktrees and server configuration mention
`139.60.162.12`. The verified SSH target for this restored access is
`139.60.162.24`; the old address is not a reason to search for another key.

This establishes SSH reachability and authentication, **not a replacement map
of all database/MCP/service endpoints**. Verify the relevant service separately
before proposing endpoint changes. Do not silently rewrite environment or MCP
configuration to the SSH IP.

The older `docs/ssh-access-check.md` in the recovery branch describes the
historical CI diagnostic procedure, not a required step for everyday access.

## Authorization boundary

Possession of a root key is not permission to modify production. Read-only
diagnostics may be used for the user's current task. Deployments, migrations,
container recreation, service restarts, data changes and access-policy changes
require explicit approval for that action. Do not print secrets, full environment
files, private keys or credential-bearing connection strings into tool output.

## Keeping agents informed

`AGENTS.md` and `CLAUDE.md` link here so project agents can discover this setup.
Agents already running may need to reread those files. Separate worktrees retain
their own versioned documentation; if theirs predates this update, point them to
this current local copy:

`/Users/cybermart/Desktop/Portal-Mac-Transfer-2026-09-06-Updated/Portal/docs/ssh-access.md`.

Do not switch another agent's branch or overwrite its uncommitted changes to
refresh documentation.
