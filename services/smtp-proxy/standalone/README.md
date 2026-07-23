# smtp-proxy (standalone / no-Node variant)

`smtp_proxy.py` is a **dependency-free Python 3 port** of the Node proxy in
[`../src/smtp.ts`](../src/smtp.ts) + [`../src/server.ts`](../src/server.ts).
Same HTTP contract, same SMTP-probe behaviour, same response shape.

## Why this exists

The primary probe proxies (on the utility/former DB host `144.31.54.166`, ports `3100`/`3101`)
run the **Node** version via Docker. Some probe hosts have **no Node and no
Docker** — e.g. the Timeweb RU probe IP `89.19.209.252` (a small telephony VPS).
This script gives us a 3rd egress IP there using only the box's stock `python3`
(stdlib only — `http.server` + `socket`), so it can run under `systemd` without
installing anything.

The validator uses all proxies behind **failover** (see
`app/src/lib/emailValidation/validator.ts` → `smtpVerifyViaProxy` /
`isInconclusiveTransport`): a probe that a given egress IP can't complete falls
through to the next IP, so complementary IPs widen coverage and no "couldn't
reach" ever becomes a wrong verdict.

## ⚠️ Parity requirement

This file MUST stay behaviour-identical to `../src/smtp.ts`. The worker keys on:
- verdict fields `{code, exists, isCatchAll, greylist, smtpText}`;
- transport-error **strings** (`isInconclusiveTransport` matches
  `timeout|econnrefused|...|unexpected greeting|ehlo/helo rejected|mail from rejected`)
  to decide whether to fail over to the next IP.

If you change the probe semantics in `src/smtp.ts` (codes, catch-all logic,
fresh-connection retry, error strings), mirror the change here. Verify with a
parity run: same `{email, mxHost, checkCatchAll}` against this proxy and a Node
proxy must return the same `exists`/`isCatchAll`/`greylist`.

## Contract

```
POST /smtp-check   Authorization: Bearer $SMTP_PROXY_API_KEY
  body: {email, mxHost, heloDomain?, heloFrom?, checkCatchAll?, timeout?}
  ->   {code, exists, isCatchAll, greylist, smtpText?, error?}
GET  /health -> {"status":"ok"}
```

Env: `SMTP_PROXY_API_KEY` (required), `PORT` (default 3100),
`EMAIL_VALIDATION_HELO_DOMAIN` (HELO name — must have valid FCrDNS on the probe
IP), `EMAIL_VALIDATION_MAIL_FROM` (default `<>` null sender),
`SMTP_PROBE_LOCAL_ADDRESS` (optional egress bind), `SMTP_PROBE_PORT` (default 25).

## Deploy (systemd, as done for 89.19.209.252)

1. `mkdir -p /opt/smtp-proxy` and copy `smtp_proxy.py` there.
2. Create `/opt/smtp-proxy/proxy.env` (chmod 600) — NOT committed, holds the secret:
   ```
   SMTP_PROXY_API_KEY=<same key as the other proxies>
   PORT=3100
   EMAIL_VALIDATION_HELO_DOMAIN=<FCrDNS name for this IP, e.g. mx2.polza-agency.online>
   ```
3. Install `smtp-proxy.service` (sample in this dir) → `systemctl daemon-reload && systemctl enable --now smtp-proxy`.
4. The unit's `ExecStartPre` firewalls `:PORT` to the app host (`139.60.162.12`) + loopback.
5. FCrDNS: set an A record `<helo> -> <ip>` and the IP's PTR `<ip> -> <helo>` (both must match).
6. Wire in: append `http://<ip>:<port>` to `SMTP_PROXY_URLS` in prod `.env` on 139
   and recreate the probing workers.

Set up 2026-07-05; runs on `89.19.209.252` (Timeweb, hostname `fra-1-vm-73sg`),
HELO `mx2.polza-agency.online`.
