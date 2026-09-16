---
name: greploop-apps
description: Continue an authorized Greptile review of an existing Portal PR when the normal trigger explicitly rejects its file count. Use the apps trigger with the same branch, authorization, freshness and iteration checks as greploop.
license: MIT
metadata:
  author: greptileai
---

# Greptile apps fallback

Read and follow [greploop](../greploop/SKILL.md). All its authorization,
branch, test, iteration and stop rules apply. This variant does not start
an independent loop or reset the iteration budget.

Use `@greptile-apps review` instead of `@greptile review` only after a
confirmed file-count rejection, or when specifically requested. Verify
that this repository's integration supports it.

If no check appears, inspect the bot's summary comment, which may be
edited in place. Require an update in the current cycle and explicit
evidence that it covers the current head SHA. A newer timestamp alone
does not prove that the right code was reviewed. If freshness cannot be
established, report that limitation and stop at the shared timeout.

Do not promise that this trigger bypasses every repository's limits.
No fresh review means unavailable verification, not a passing result.
