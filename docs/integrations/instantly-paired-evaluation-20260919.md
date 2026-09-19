# Paired classifier evaluation — 2026-09-19

## Status: prepared, live comparison blocked

The user approved comparing the latest fixed Portal classifier with frozen Jev
v2.6. No production writes, deployment, notifications or qualification changes
were authorized or performed. The latest classifier under test is from Sergey
commit `5ebce8727`, not the historical saved classifications.

There are **no new paired accuracy results** yet. The pilot made three requests,
all rejected by Requesty with HTTP 412 before returning a model response:

> This API key, user or group has reached its monthly spend limit.

The runner stopped after its existing three-consecutive-failures threshold. It
now treats 412 as a terminal provider limit and stops after the first response.
The pilot's `$0.1505745` ledger entry is a conservative reservation on failed
requests, **not evidence of actual billed inference**. No inference usage was
returned. Do not repeat these calls automatically or switch credentials to evade
the budget restriction.

Authenticated UI observation at approximately 2026-09-19 18:30 UTC:

- Organization balance: approximately $20.96; a positive balance does not lift a
  key/user/group monthly cap.
- The key named `Razmetka otvetov dla dataseta` showed $20.13 / $20.00.
- `OPENROUTER_INSTANTLY_LEAD_API_KEY` showed approximately $28.60 / $30.00.
- The exact mapping between the local `REQUESTY_API_KEY` and the UI key name was
  **not confirmed**. The error proves a limit on the credential used, not which
  key/user/group setting caused it. No limits or credentials were changed.

## Frozen selection and limitations

Private artifacts on this Mac, outside Git:
`~/.local/share/portal-evaluations/paired-frozen-20260919/`.

- Source: the frozen weekly-v2 export, replies received September 12–18, UTC+4.
- 300 replies from 300 separate conversation groups, deterministic hash selection
  with seed `paired-frozen-v1-20260919`.
- Start with original holdout rows having no recorded context/policy coverage
  warnings. Exclude previously tuned/reviewed/control groups, conservative v1
  disagreement families, and further previously inspected v2 examples.
- 277 explicitly exposed groups excluded; eligible pool is 471 rows / 419 groups.
- Historical strata in the selected sample: 273 not_lead, 19 objection, 8 lead.
  These are **not reference labels** and are not sent as model input.
- This coverage-filtered, exposure-filtered sample is not a representative random
  sample of all weekly mail. In particular, exclusion of earlier disagreement
  families can make it easier. Report it separately from the known hard examples.
- Few positive cases may prevent meaningful recall/superiority estimates even
  after all 300 are evaluated. Do not interpret a high overall accuracy as proof
  of reliable lead detection.

Reference annotation is incomplete. Fifty inputs have been read blind; draft
notes are in the private artifact's `analysis/review-progress.json`. Next unread
index is 51. These are assistant-proposed labels, **not independent human gold**.
Two of those fifty were left ambiguous. Finish the input-only review before
inspecting predictions; report ambiguity separately, not as an automatic negative.

## Input contract and frozen systems

Use `fixtures-v1.private.json`. The earlier `fixtures.private.json` is a rejected
preflight mapping (string message types); it was never sent to the model.
The corrected mapping preserves headers and chronological history:
`sent → 1`, `lead_reply → 2`, `our_reply → 3`; address objects use `.address`.
Only archive messages strictly before the target reply are included.

Both pipelines start from the same weekly latest-reply/history/project snapshot.
They retain their own context preparation, redaction, prompts and post-processing.
This is a **comparison of complete classifiers**, not a controlled model-only swap.
Historical project-policy snapshots and original historical prompt payloads are
unavailable; do not describe this as an exact reconstruction of past production.

Frozen classifier source SHA-256:
`74e9eb8418ad931e0c1547b66157693bf942316abeb69b42c14228735a551af4`.

Frozen Jev adapter SHA-256:
`ffb32fa93b917936f64afe44c2d61e099aab15dc11f47988a9a80c63c64d6b41`.

All 300 prepared Jev primary request hashes match completed v2.6 cached records
under `jev-v26-weekly-20260919/`. Final cached results, including bounded notice
checks where present, can be reused without new Jev charges. Only hashes and
completion status were inspected during this preparation, not their predictions.

## Requesty configuration checked read-only

The worker has `INSTANTLY_LEAD_QUAL_MODEL=policy/portal-instantly-lead-qualification`
and `INSTANTLY_LEAD_QUAL_MAX_TOKENS=8000`. The frozen classifier code overrides
that generic cap for this exact policy: `reasoning_effort=low`, `max_tokens=4096`.

The Requesty policy UI currently contains `vertex/gemini-3.8-flash` with **five
attempts**, contrary to the older one-attempt note. The evaluation therefore uses
that same model directly through Requesty with an explicit matching inference
profile, not the mutable production policy. No policy was edited.

Authenticated model catalog rates: $0.75 / million input tokens and $3.75 /
million output tokens. The catalog also exposes a discount field; these are
conservative list-rate estimates, not a final billing statement.

Offline comparison of all 300 generated requests confirms exact payload equality
between dedicated-policy and direct-model requests **except the model identifier**.
This removes policy-level retry behavior from the experiment; observed latency
will not represent production retries. The harness permits one initial request
and at most one separately accounted semantic adjudication, no transport retry.
It also probes AI on prefiltered cases; report such extra evaluation cost separately.

Prepared client-side budget ceiling: $5, including failed-call reservations.
This is not a provider-enforced spending cap and does not authorize changing
account/key limits. No batch is running or scheduled.

## Harness changes and verification

- Current response schema no longer requires `objection_handleable` or
  `objection_draft`; optional legacy fields are validated only when present.
- HTTP 412 immediately stops the live runner, alongside auth/credit/rate errors.
- 13 temporary offline assertions passed: current/legacy response contracts,
  malformed fields, immediate 412 stop with no second transport call, valid 200.
- Both 300-case dry runs completed without network calls or production imports.
- 300 unique conversation groups and 300 Jev cache matches verified.
- 300 direct-vs-policy payload equivalence checks passed.
- Script syntax and `git diff --check` passed.

No new permanent test file or production classifier change was added.

## Resume

First identify/authorize the correct test-key budget in Requesty. Do not consume
the production lead-processing key's remaining budget to bypass the limit.
Keep the frozen fixture and classifier hashes. Complete blind annotation, then
run disjoint batches using the existing evaluator with the saved profiles/prices.
Use new private output directories; never overwrite the pilot. No automatic retry
of failed calls. Prior reservations count toward the overall experiment ceiling.

The secure launcher reads only the named Requesty key into process
memory: the private artifact's `analysis/requesty.mjs`. It prints no credentials.
If missing on another machine, recreate that behavior; never put keys in command lines,
reports, fixtures or Git.

Report false-positive leads, missed leads, unresolved/transport failures and
paired disagreement counts before overall accuracy. Use paired uncertainty
intervals/exact McNemar only on explicitly described provisional labels; they
cannot turn assistant annotations or a selected sample into human-verified
production accuracy. Report costs and latency with the retry/cache limitations.
