# ENG website fallback

## Reading order and integration

The ENG company qualification reader (`market: us`, company evidence opt-in)
and ENG contact-first email crawl now support this order:

1. Existing HTTP reader.
2. Own isolated Chromium service, for successful empty/JavaScript-shell HTML.
3. Optional TinyFish Fetch when that browser attempt is empty, the service
   explicitly reports busy/not-ready, or a confirmed upstream 5xx was observed.

The optional readers are disabled by default. Set `ENG_BROWSER_ENABLED=1`,
`ENG_BROWSER_URL=http://eng-browser-broker:4100` and a matching
`ENG_BROWSER_TOKEN` only after the service is independently released and
verified. The isolated browser service, build commands and Linux acceptance
requirements are in [deploy/eng-browser/README.md](../deploy/eng-browser/README.md).
The existing production compose is not modified.

Browser fallback adds at most 20 seconds to an enabled company-evidence page
read. The contact crawler keeps its original 30-second company deadline and
returns collected results when it expires. Fallback failure preserves the
original response; a failed TinyFish attempt preserves an already rendered
browser response. No mailbox is inferred, generated or SMTP-checked by this
change. Email extraction uses literal addresses in returned HTML.

Successful pages keep their actual final HTTPS URL. `readMethod: browser` or
`readMethod: tinyfish` is retained in qualification checkpoints/audit quotes
and constructor website evidence. Contact diagnostics record the reader in
`route`. String-only page caches are not used to disguise fallback HTML as a
direct response. Ordinary RU readers and callers without the ENG opt-in keep
their existing behavior.

When the ENG browser feature is enabled, the ENG readers also stop their old
proxy retry on HTTP 403/429; the contact crawl stops on an initial access wall.
A foreign-domain redirect is checked against the original requested company
boundary before either fallback is called. Unknown/lost service replies,
timeouts and unfinished browser requests are terminal rather than an excuse
to escalate to the external provider.

HTTP 403/429, recognizable challenges, unsafe destinations and invalid service
responses do not progress to another fallback reader. The service has one
session at a time across workers; excess requests fail immediately, preserving
the original HTTP result. Service-side limits bound each resource to 1 MiB,
each session to 20 resources / 5 MiB and 12 seconds by default.
The runner waits for started requests to finish before returning DOM; unfinished
requests are a terminal refusal. If context cleanup stalls for two seconds, the
runner exits so the container can restart instead of remaining busy forever.

## Optional TinyFish Fetch

TinyFish Fetch is disabled by default. It is attempted only after an HTTPS page
returned a successful but empty/JS-shell response and a browser attempt either
returned another empty page or explicitly reported a safe availability failure
(busy/not-ready or an observed upstream 5xx). HTTP 403/429, challenges,
unsafe/ambiguous addresses and login walls must never be reclassified as empty.
It is not a retry or bypass for a blocked site.

Enabling it requires `ENG_TINYFISH_ENABLED=1`, `TINYFISH_API_KEY`, a stable
`ENG_TINYFISH_ACCOUNT_ID` used by every Portal worker for that account, and
all three explicit operator attestations:

- `ENG_TINYFISH_DEDICATED_ACCOUNT_ATTESTED=1`: the account is dedicated to this
  gate, with no Playground, other keys, or external clients consuming its quota.
- `ENG_TINYFISH_NO_ANTIBOT_ATTESTED=1`: the provider has confirmed that the
  selected Fetch service does not bypass access controls or use prohibited
  stealth/proxy handling. The current public Fetch documentation does not
  establish that guarantee; do not enable before it is confirmed.
- `ENG_TINYFISH_NO_PAID_USAGE_ATTESTED=1`: the operator has confirmed that the
  configured account cannot incur paid Fetch overage. TinyFish's pricing page
  and Fetch documentation disagree on the behavior beyond the free allowance;
  do not enable on the basis of the application counter alone.

Deploy the matching `eng_tinyfish_budget` migration through the normal release
process before enabling. Its transactional Postgres gate reserves one URL per
attempt and limits this Portal account identifier to 800 URLs per rolling 24h
and 120 per rolling minute, below published limits. Reservations are not
refunded on failures or unknown outcomes. Missing credentials, migration, DB,
invalid account configuration, budget exhaustion or timeouts all fail closed.
These counters cannot enforce an account-wide limit against clients outside the
gate or prevent the provider from changing its billing rules.

Fetch receives the public site URL. It returns provider-extracted HTML with
`include_selectors: ["body"]`; the provider documents selected content as
verbatim but removes scripts/styles and serializes HTML. Its origin is marked
`tinyfish`; it is not the original response body. Request/final URLs must be
HTTPS, resolve publicly, pass the existing ENG address guard and stay on the
same company-site boundary. TinyFish documents blocking private destinations,
but its remote DNS and redirect resolution are outside Portal's direct control.
HTTP calls have a bounded time and body size and no retries. A provider error or
limit does not fail the original collection or convert a refusal into evidence.

## Search comparison, 29 October 2026

Five exploratory public queries about the English-language insurance market
were submitted once to each Search API with the same US/en settings used by
ENG. Both providers succeeded on every query. Common domains among the first
results were 5, 2, 10, 10 and 8; TinyFish returned 9 results for the last query,
otherwise both returned 10. The last three queries had identical first five
domains in the same order.

This sample does not measure company eligibility, incremental contacts or
search quality at scale. Serper remains the configured production provider;
the comparison does not justify replacing it. Timing was collected from
different machines/networks and is not a reliable speed comparison. The five
Serper searches consumed search credits; TinyFish was within its published free
Search allowance. Raw public results are retained locally outside the repository.

Provider references checked on that date:
[Fetch overview](https://docs.tinyfish.ai/fetch-api),
[Fetch reference](https://docs.tinyfish.ai/fetch-api/reference),
[pricing](https://www.tinyfish.ai/pricing).
