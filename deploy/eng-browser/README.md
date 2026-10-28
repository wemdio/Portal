# ENG browser service: preparation only

This compose file is separate from the existing production deployment and is **not enabled** by this change. Do not deploy or turn on a caller without an explicit release approval and Linux integration checks. The runner must have `network_mode: none`; `route` interception by itself does not prevent network access on redirects or other Chromium channels.

Set `ENG_BROWSER_URL=http://eng-browser-broker:4100` for callers on the same Docker network. The worker calls the broker over HTTP: `POST /render` with `Authorization: Bearer <ENG_BROWSER_TOKEN>` and JSON `{ "url": "https://...", "timeoutMs": 12000 }`. On success it returns `{ "url": "https://...", "html": "...", "source": "browser" }`. Callers must check that the returned final URL belongs to the same company and that the original HTTP result was a successful, genuinely empty page rather than a challenge. The broker returns bounded, non-sensitive error codes; `blocked` means a 401, 403, 407, 429, 451, or recognized challenge; other non-2xx responses below 500 are terminal `http_error`. `busy` rejects immediately rather than queuing. `not_ready` means the isolated runner was unavailable before any upstream read; `upstream_unavailable` means the initial read returned an HTTP 5xx. Unknown transport failures, deadlines, and unfinished requests are terminal. `GET /health` reports readiness only when the runner reports an isolated, non-root Linux process and a live sandboxed Chromium.

The broker follows redirects manually using the existing ENG URL guard and its DNS-checked direct dispatcher, reads only GET requests, and limits each resource to 1 MiB, each session to 5 MiB and 20 resources. The default session deadline is 12 seconds, capped at 20. The runner executes Chromium with its sandbox enabled and fulfills requests only through the broker's Unix socket. It blocks WebSocket, service workers and non-GET requests; image, media and font resources are skipped. Fresh browser contexts isolate sessions. There is one browser session at a time. After the document loads, the runner waits for a one-second network quiet period, up to eight seconds; requests still in flight yield terminal `incomplete` and no DOM. The broker independently refuses a result while any resource request is in flight. Only Access-Control-Allow-Origin, Access-Control-Allow-Methods and Access-Control-Expose-Headers response headers are forwarded; cookies and credentials are not. Since the request Origin header is not forwarded, sites that dynamically set CORS by Origin may not render completely.

Build images locally from the repository root (no production action):

```sh
docker build -f deploy/eng-browser/Dockerfile --target broker -t portal-eng-browser-broker:local .
docker build -f deploy/eng-browser/Dockerfile --target runner -t portal-eng-browser-runner:local .
```

A separately authorized deployment must supply image references, a strong 32-byte-or-longer `ENG_BROWSER_TOKEN` secret shared with callers, and the exact existing external Docker network name as `ENG_BROWSER_PORTAL_NETWORK`. The runner receives no Portal credentials or project mount; broker and runner share only a dedicated socket volume. Do not publish the broker port to the host or internet. The runner image's Playwright version is pinned to the app lockfile and must be updated with that lockfile. The seccomp profile is based on the official Playwright v1.59.1 profile from https://github.com/microsoft/playwright/blob/v1.59.1/utils/docker/seccomp_profile.json, with an explicit unconditional chroot syscall allowance for Chromium inside its own user namespace. No chroot capability is granted to the container: all container capabilities remain dropped. Re-evaluate this profile with upgrades and verify the actual kernel sandbox. Docker mounts the runner's private 256 MiB /dev/shm; host IPC is not shared.

## Local Linux validation, 29 October 2026

Both images were built and the compose was run inside a temporary ARM64 Ubuntu
VM on this Mac (Lima/VZ, rootless Docker), with no host-home mounts, Portal
secrets or customer data. Chromium started with its sandbox enabled, rendered
the public JavaScript demo `https://quotes.toscrape.com/js/`, and the runner had
only loopback interfaces. A direct TCP attempt returned `ENETUNREACH`.
Invalid authorization and private/metadata/own-server URLs were rejected;
real HTTP 403/429 replies were terminal. Three parallel render requests admitted
one and returned two `busy` replies; a new render succeeded after cancellation.

Separate local controlled checks cover redirect-to-private before the second
request, byte/resource limits, slow request bodies, source charset and CORS.
The public redirect fixture in the VM returned 403 before redirecting, so it
did not establish a real-network redirect test. These checks do not simulate
every hostile page, DNS rebind, Chromium exploit or production load.

Before enabling on the target host, verify its kernel/user-namespace/seccomp
compatibility, network/UID/filesystem isolation, unavailable-service behavior
and memory/CPU/pid limits with the released images. Do not add privileges,
disable the Chromium sandbox or attach the runner to a network to overcome a
startup failure. Missing isolation or sandbox support must fail closed.
