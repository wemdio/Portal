# Instantly specialist cards: paired Telegram delivery

The current single portal-worker-instantly-leads process prepares notifications
and handoff drafts concurrently. Transport pairs by chat + qualification ID, then
serializes ready sends per chat: lead followed by handoff. A different ready lead
may overtake a still-preparing pair; readiness order, not reply timestamp order.

Only configured handoffs wait (maximum 10 seconds before entering the send queue).
This waiting does not occupy the chat send queue. If preparation is late, the lead
is sent with a status note; a subsequent outbox retry uses the persisted specialist
alert message ID as Telegram Reply. The ready pair also uses Reply for navigation.
Failed lead sends suppress the corresponding handoff send; existing durable
notification recovery and handoff outbox retry policy remain authoritative.

The order queue is process-local, not a durable/distributed replacement for the
outbox. Deployment must retain a single Instantly lead worker; before introducing
replicas or another producer for these cards, add distributed per-chat dispatch.
Unrelated bots/users may still post between the two Telegram API requests; Telegram
does not provide an atomic transaction for two text messages.

No generation runs under the send lock. HTTP sends retain their 15-second timeout.
Queue errors release the next item. No historical replay or production mutation
is part of this change. No migration is needed.

Validation: existing 2402 tests; private transport harness covering pair adjacency,
handoff-first preparation, slow preparation, late parent linking, failed parent
suppression, orphan timeout and queue recovery. Existing worker assertion now checks
qualification pairing rather than mocked preparation call order.
