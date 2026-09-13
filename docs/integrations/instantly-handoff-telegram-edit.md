# Editing a manual lead handoff in Telegram

Manual cards now show **Изменить ответ** alongside **Передать клиенту**.
The responsible specialist clicks Edit, then replies to the bot's ForceReply
prompt with the complete replacement text (plain text, up to 3000 characters).
The bot displays the complete replacement and Send / Edit again / Cancel.
No email is sent until Send is pressed. Reply `/cancel` to the prompt to cancel
before preview. The original draft and project legend remain unchanged on cancel.

Edits apply only to the selected handoff, not the project template. Automatic
handoff projects keep their current behavior and do not show editing buttons.
Sessions expire after 30 minutes; reopen from the original card to start again.
An expired session does not silently authorize sending the old draft.

## Safety

- The existing Telegram webhook secret is checked before processing callbacks
  or text. HMAC callbacks fit Telegram's 64-byte limit; actions cannot be swapped.
- Every action rechecks the responsible user's Telegram link, the stored chat,
  pending manual mode, archive state, and qualification status.
- Text must reply to the exact stored bot prompt. Other messages, attachments,
  bot messages and Telegram `edited_message` updates do not replace the draft.
- Session tokens rotate on replacement and new prompts. Confirmation binds to
  the current preview message. Compare-and-set updates reject replay/races.
- Manual send atomically claims the pending row before external requests and
  copies the confirmed text into its durable draft. Editing and the original
  Send button cannot race this claim; concurrent presses send at most once.
- A timeout/crash after claiming is deliberately not retried automatically:
  Instantly may already have accepted the message. Check provider state before
  any operator retry. Automatic-mode send behavior is not changed by this patch.
- Telegram display failures do not send an email. Reopen Edit from the original
  card if no usable prompt/preview appears. Text is shown without HTML parsing.

## Rollout

Migration `20260913_0001_handoff_telegram_edit.sql` adds nullable edit-session
metadata and a manual-send claim to the Instantly operational DB. Deploy this
migration with the app and worker through the normal user-owned release process.
No production migration, bot reconfiguration or real email send is performed
by the implementation/verification task.

The lead-alert bot webhook must point at `/api/telegram/handoff/webhook` with
the existing `LEAD_HANDOFF_WEBHOOK_SECRET`, and must allow both `message` and
`callback_query` updates. If Telegram currently filters to callbacks only,
redeploying code alone is insufficient: an authorized webhook update is needed.
Preserve URL, secret and other subscriptions; do not drop pending updates or
change another bot's webhook. Verify this during rollout before calling the
feature live.

Read-only `getWebhookInfo` check on September 13, 2026 confirmed the expected
handoff route and configured secret, but `allowed_updates=["callback_query"]`.
Therefore this installation needs the authorized subscription update after
deployment. Do not claim text editing is live merely because branch CI passes.

New manual cards acquire the Edit button. Already-posted old cards are not
bulk-edited by this migration and keep their existing Send button. Do not replay
old leads to retrofit buttons. A live smoke test requires explicit approval for
the target handoff/email recipient, not an arbitrary production lead.

Telegram references: [ForceReply](https://core.telegram.org/bots/api#forcereply),
[callback buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[setWebhook](https://core.telegram.org/bots/api#setwebhook).
