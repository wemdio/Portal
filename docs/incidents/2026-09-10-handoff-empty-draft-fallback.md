# Optional AI adaptation must not drop a lead handoff

## Observed failure

Read-only production checks for «Стальные решения» found 11 qualified leads
on September 7–9 (UTC+4). Four handoff outbox jobs ended in `skipped` with
`handoff draft is empty`; seven created handoff cards. The project had a ready
handoff legend, AI adaptation enabled and automatic sending disabled.

The generator could return an empty, truncated or wrong-language result on
its final attempt. The worker then treated an empty draft as a permanent skip.
The original provider responses were not retained, so the exact reason for
each empty completion (including a possible token limit) is not established.

## Change

- AI adaptation is optional: make one request with a 20-second deadline,
  covering response headers and body.
- An empty, explicitly unfinished or wrong-language result is a generation
  failure, including on the final attempt.
- If adaptation fails, or its API key is missing, use the project's configured
  ready legend with the existing name substitution. Do not invent a legend
  for an unconfigured project.
- Log a safe fallback reason, without provider response text or credentials.
- Keep ownership checks, deduplication, callback permissions and the
  `handoff_auto_send` setting unchanged. Manual projects still require a click;
  automatic projects retain their existing automatic behavior.

## Verification and rollout boundary

Existing worker scenarios exercise an empty completion in manual mode and a
provider failure while recovering an outbox job. They verify a pending handoff
containing the configured text and successful completion of the outbox job.
The existing manual-mode assertions also forbid outbound email before a click.

Additional offline checks exercise valid RU/EN drafts, missing credentials,
empty/malformed/incomplete output, language mismatch, HTTP errors, network
errors, header/body timeouts and a failing diagnostic callback. No paid model
requests or real emails are needed for these checks.

Deployment is separate. Previously skipped outbox jobs are **not** reset or
replayed by this patch. Restoring those old cards requires a separately
authorized, targeted operation; this change does not diagnose all other
possible causes of handoff queue delays.
