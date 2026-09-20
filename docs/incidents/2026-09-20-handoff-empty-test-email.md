# Empty body in the Instantly handoff fallback

## Confirmed cause and scope

On 2026-09-20 a neutral email to the owner's explicitly approved test address
reproduced an empty handoff message. The request to `POST /api/v2/emails/test`
contained nonempty escaped HTML (`text<br>\ntext`); Instantly returned HTTP 200
with `status: success`. Gmail's **Show original** showed an empty plain-text
part and only break elements in the HTML body. This was not Gmail hiding text
or a Telegram edit losing the saved draft.

The test endpoint drops loose top-level text in this format. One `<div>` around
the same fragment preserved the text in the next delivered email. That test
also exposed doubled spacing: the provider converts literal newlines to break
elements, in addition to the `<br>` already present.

## Fix

`sendTestEmail` in `app/src/lib/instantly/client.ts` encloses its HTML fragment
in one `<div>` and removes the formatting newline immediately following each
existing `<br>`. This boundary covers both the Telegram handoff fallback and
the client-cabinet reply fallback, including their quoted history. Existing
escaping, saved draft, recipient list, account selection and request options
are preserved. Normal `/emails/reply` and `/emails/forward` are unchanged.

## Verification

- Baseline `HANDOFF-20260920T180954Z`: nonempty request, empty received MIME.
- Wrapper probe `HANDOFF-WRAPPED-20260920T183718Z`: delivered text and quote;
  MIME exposed doubled breaks from `<br>\n`.
- Final probe `HANDOFF-FIXED-20260920T184022Z`: payload produced by the real
  patched handoff sender/client in a local harness with synthetic DB rows and
  mocked original-email/reply calls, then sent exactly once through the real
  `/emails/test` endpoint. Only the approved owner address was a recipient.
  Received HTML, after normalizing `<br />` to `<br>`, matched the complete
  500-character fragment, including all 16 breaks, Cyrillic, `& < >`, edited
  text, separate paragraphs and a nested synthetic quote. The plain-text MIME
  part was also nonempty. No actual client data was included.
- One approved regression in the existing `clientListLeads.test.ts` exercises
  real client serialization for plain reply and blockquote fragments, verifies
  unchanged recipients/input and leaves the normal reply payload unchanged.
- Four targeted Jest suites: 180 tests passed. A local real-sender harness also
  checked that the confirmed edit replaces the old draft before serialization.
- ESLint, `git diff --check` and targeted strict TypeScript checking of the
  client, its dependencies and regression test passed. The whole-project
  TypeScript run was stopped after approximately six minutes without a result;
  it is not reported as a successful full-project check.

The live verification is for this sender/test endpoint and approved recipient,
not a blanket deliverability guarantee for every provider or every mailbox.
No real handoff rows, clients, Telegram messages or old queues were replayed.
No deployment or production data changes were made; deploying the code remains
the owner's separate release step. The only live writes were the authorized
neutral test sends.

## Existing fallback limitation

The fallback creates no Unibox email entity and supports a combined `To` list,
not actual CC/BCC. That explains why the affected outgoing email was absent
from Instantly. This patch does not change those endpoint limitations or
retroactively repair already-delivered blank messages. Never automatically
resend such historical messages: that needs a separate explicit decision.

Reference: [Instantly send-test-email API](https://developer.instantly.ai/api-reference/email/send-a-test-email).
