# Instantly qualification: real-reply evaluation, 2026-09-08

Status: 170 replies evaluated on both candidates; dedicated Requesty policy saved
with Vertex Gemini 3.8 Flash. Code wiring prepared; no production activation or
deployment performed.

## Scope and safeguards

This follow-up to [the modern-model pilot](./instantly-lead-model-evaluation-20260908.md)
compares the same explicit Vertex Gemini 3.8 Flash and Azure GPT-5.6 Luna routes on
real replies. It also repairs invalid response handling in the lead qualifier.
Shared `policy/gemini-flash` and unrelated tools are not changed.

The experiment imports only an isolated classifier. Database/Instantly imports
throw; no worker, notifications, status updates, recovery jobs, or migrations run.
Full source records, prompts, labels, responses and identifiers stay in private
local artifacts, never in Git. Candidate results are not used to construct labels.

## Dataset and limitations

- Read-only snapshot for September 1–7 in Europe/Samara: `2026-08-31T20:00Z`
  through `2026-09-07T20:00Z` (exclusive upper bound).
- Selection starts from operational qualifications, joined to analytics raw emails
  and the proven managed project's current brief/custom criteria. Previous bot
  statuses are used only for stratification, not as ground truth.
- Initial selection: 180 unique replies, 170 threads, 44 projects, 45 custom-criteria
  cases and 105 nonempty briefs. This is a stratified diagnostic sample, not a
  random estimate of production-wide accuracy or 180 independent conversations.
- Full raw replies and preceding messages are retained, not the 300-character
  qualification preview. The model receives the **existing production prompt**:
  brief/custom criteria up to 2,000 characters each; reply, last outgoing message
  and earlier substantive offer up to 3,000 characters each. This experiment does
  not silently expand production's context limits.
- Criteria/brief snapshots from the original qualification time do not exist.
  This is evaluation of real mail with current project settings, not exact replay
  of past production decisions. Some threads contain known regression examples.
- Labels are independently reviewed by AI agents against the agreed business
  policy before candidate calls. They are `policy_derived`, **not human-confirmed
  gold labels**. Ambiguous policy boundaries are unscored and reported separately.
- Context conflicts and potentially sensitive credentials are excluded before
  external calls; the original private snapshot remains unchanged for audit.

The frozen final set has **170 replies**, including **43 custom-criteria cases**
and **97 nonempty briefs**. All 97 briefs exceed the existing 2,000-character
prompt limit; 24 reply texts exceed 3,000 characters. No custom criterion exceeds
2,000 characters. Primary languages: RU 141, EN 24, NL 2, DA 1, CS 1, ZH 1.
Ten replies were excluded before paid calls: seven conflicting project/offer
contexts already present in stored raw payloads and three secret/capability-link
cases. These context conflicts are separate from model quality and remain an
ownership/data-quality investigation, not repaired by this model selection.

Of the final set, 157 are scored (47 leads, 105 non-leads, five review cases) and
13 remain ambiguous/unscored. Independent blind spot checks agreed on 24/24
scored cases, but do not make the labels human gold. `offer_seen` metadata is not
scored: adjudicators did not use a consistent independent definition for it.

Frozen at `2026-09-08T00:08:49.749Z`, before any candidate output:

- Fixture SHA256: `517993213d3c9fc0a30d0256e0f9822cb5b65436a9bb8714e59df51f0ca76145`.
- Classifier SHA256 during comparison: `644dc2d0b377ae5a4aaffc0af04ee532b372534006870997bdadc55e65842971`.
- Harness SHA256 during comparison: `990b691532de72ab5bef4d31e332c51d54cecb1c1fea2b4432c9b2c17b2c1322`.
- Request-profile SHA256: `3cac31f7bfa2a893e0dd1c6cf45667b1303c7ebf7211b6b7055c0acf1a5a9695`.

The classifier already included the strict response/timeout fix. Dedicated-policy
wiring and per-model probe preparation were added **after** the comparison;
prompts and qualification business rules were not changed to improve its score.

Read-only access required resolving stale local endpoints. Canonical application
DNS resolved to `139.60.162.24`; its ED25519 SSH fingerprint exactly matched the
locally pinned production key. The recorded `.12` endpoints timed out. No local
connection configuration was changed; the obsolete rollback host was not used.
Direct read-only database access worked on the verified host, while saved SSH
authentication did not. No production query-log INSERT was made under the
read-only boundary.

## Invalid-response and latency protection

`parseAIResult` requires a complete, typed qualification object. Empty objects,
missing flags, string booleans, invalid enum values and malformed JSON cannot
become a negative decision. Existing markdown/control-character recovery remains,
but recovered JSON must pass the same contract.

Every HTTP response must finish with `stop` and contain a nonempty string without
a refusal. `length` is rejected even on the last attempt and even if its JSON looks
complete. There are at most two immediate retries (three total calls). Each call
has a 45-second abort deadline covering headers and response body, so three stalled
calls plus retry delays take approximately 139.5 seconds, not an unbounded wait.

Exhausted responses throw the existing worker-recognized `failed after retries`
error. Existing durable recovery records `needs_review`, backs off and eventually
leaves a visible technical error after its seven-day horizon. This change does not
introduce a new queue or mean only two attempts over a reply's entire lifetime.

The evaluation runner retains paid HTTP responses, usage, finish reasons and
errors even when strict classification rejects them. Missing decisions are `null`,
not `not_lead`; failed attempts remain in scored denominators. A deterministic
machine-reply prefilter can independently produce a valid negative result, but
that does not count as successful AI output.

## Completed comparison

Exactly **340 paid requests**, one per reply/candidate, without fallback or retries.
Both candidates returned HTTP 200, `finish_reason=stop`, and complete strict JSON
in all 170 cases. No `length`, timeout, refusal, missing verdict, or schema failure
occurred. The first request per model was a preflight included in the 170, not an
extra/repeated sample. Inputs and prompts were identical across candidates;
inference parameters match the previously recorded modern-model profiles.

| Metric | Vertex Gemini 3.8 Flash | Azure GPT-5.6 Luna eastus2 |
|---|---:|---:|
| Raw model verdict matches frozen label | 153/157 | 150/157 |
| Final verdict after existing rules | 152/157 | 149/157 |
| Leads found | 47/47 | 45/47 |
| False lead notifications | 2 | 2 |
| Custom-criteria verdicts, raw/final | 40/42 | 39/42 |
| Positive custom-criteria cases found | 10/10 | 8/10 |
| Technical/machine/service replies correctly rejected | 65/65 | 65/65 |
| HTTP latency p50 / p95 | 2.018 / 2.770 seconds | 2.962 / 7.125 seconds |
| Sum of reported `usage.cost` | $0.68642850 | $0.11922962 |
| Uncached token estimate at explicit route rates | $0.68642850 | $0.19114520 |
| Conservative budget reservation, not spend | $6.22360800 | $1.37130880 |

Latency uses nearest-rank quantiles over all 170 attempts, including preflight;
it is API latency, not end-to-end notification delay. All six replies that the
production prefilter would skip were deliberately sent to each candidate for
defense-in-depth measurement. The table does not claim those extra calls would
be charged in normal operation.

The observed cost total is **$0.80565812**, not a reconciled Requesty invoice.
The $7.5949168 reservation stayed below the combined $8 client-side cap. Luna's
lower reported cost includes caching; without caching, the estimate is about
$1.12 per 1,000 replies of this sample's size, versus Gemini's $4.04. These are
sample-based estimates, not a fixed price per lead. Gemini omits reasoning-token
usage (unknown, not zero); Luna reports 7,750 reasoning tokens despite requesting
`none`. They are already included in completion-token cost, not added twice.

On the 13 unscored ambiguous cases, final labels were 8 lead / 3 review / 2
non-lead for Gemini and 5 / 5 / 3 for Luna. These are disagreements to adjudicate,
not additional correct/incorrect decisions.

### Error review and remaining limitations

All mismatches were inspected against the actual transmitted prompts. No frozen
labels were retuned after seeing candidate outputs.

- Gemini `real-085`: falsely accepts an email-only referral where the custom
  rule requires **name AND contact**. Inferring a name from an email local part
  is not explicit delivery of a name under the frozen interpretation; this
  boundary still merits human confirmation.
- Both `real-154`: mistake the recipient offering to execute **our** task and
  requesting **our** specification/call for buyer interest. Seller/buyer
  direction is wrong despite an explicit instruction already in the prompt.
- Both `real-097`: unnecessary review for a self-identification with contact
  information only in the signature, rather than a lead.
- Both `real-139`: classify a clarification as an actionable objection instead
  of review. Worker status is `objection`, not a missed positive lead.
- Both `real-121`: model correctly returns review, then an existing routing
  regex mistakes a question about contacting someone for actual redirection and
  overwrites it to non-lead. This is a **postfilter defect**, not model failure.
- Luna `real-048`, `real-070`: misses custom email-referral leads. `real-055`
  falsely qualifies an already-existing relationship update; `real-169` sends
  a seller pitch to unnecessary review.

The important reply/custom-criterion text in these mismatches was not clipped;
their cause is not `length`. Business-rule, role-direction and context-linking
defects remain explicit follow-up work, not silently declared solved by routing.

## Dedicated policy and activation boundary

**Selected candidate: Vertex Gemini 3.8 Flash**, prioritizing lead recall and
latency over Luna's lower cost on this diagnostic set. This is a relative choice,
not proof of zero errors or production-wide accuracy.

Saved and reopened in Requesty on September 8:
`policy/portal-instantly-lead-qualification` (policy UUID
`a53b59ec-5a1d-428c-930c-66f8e86c5f35`) contains only
`vertex/gemini-3.8-flash`, one provider attempt. No untested model fallback is
retained. App-level retries remain bounded as described above. Shared
`policy/gemini-flash`, API keys and other tool policies were not edited.

Only the exact dedicated policy ID receives `reasoning_effort=low`,
`max_tokens=4096`, omitted `temperature`, and the existing `json_object` response
format. Other explicit model IDs/shared policies retain the legacy payload and
`INSTANTLY_LEAD_QUAL_MAX_TOKENS` behavior. The worker trims its model env and
preserves the legacy default for missing/blank values: installing this code alone
does not silently change a shared routing policy. Changing the dedicated policy's
model in future requires evaluating its parameter profile again; Luna's tested
profile is different and is not an implicit compatible fallback.

A separate **one-request policy canary**, outside the 170-case comparison, used
the existing synthetic `custom-shared-email` fixture and the production policy
payload without an external profile override. It returned `gemini-3.8-flash`,
HTTP 200 / `stop` / strict schema, raw and final `lead`, in 2.210 seconds.
Reported cost: $0.00329625; conservative reservation: $0.033432. Including this
canary: **341 calls**, $0.80895437 reported cost, $7.6283488 reservation, still
within the original $8 cap. No real qualification or notification was created.

Final local validation:

- 229 existing classifier/parser/worker tests pass; no new CI test cases added.
- 132 private offline contract, retry and header/body-timeout assertions pass.
- 44 private scoped-profile/worker-env checks pass.
- 560 dry payloads verify per-model capture, reversed candidate order, legacy
  env-token overrides and equivalence to frozen candidate payloads; six output
  cap validation probes pass. These are offline requests, not extra paid calls.
- Full `npm run typecheck:strict`, touched-file ESLint, runner syntax and
  `git diff --check` pass. The standalone `instantlyLeads` worker bundles with
  esbuild for Node 22; the resulting bundle was not executed.

Activation still requires the separately authorized production phase:

1. Release the reviewed commit through the user's normal branch/deploy workflow.
2. Set the standalone worker's runtime
   `INSTANTLY_LEAD_QUAL_MODEL=policy/portal-instantly-lead-qualification`.
3. Recreate/deploy that worker using the approved release, then read-only verify
   its exact env, actual Requesty model, qualification errors and notification age.

Neither production env nor containers were changed here. An application env-file
save/reload does not restart the standalone worker. Saved SSH authentication needs
reconnection before agent-operated activation; local database endpoint records are
stale as described above. No database migrations, status rewrites, mail sends or
Telegram replay was performed.
