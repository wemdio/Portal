# VE2 final letter editor, 2026-10-09

Scope: links and optional UTM, editable sequence length, true A/B/C body tests. Branch `codex/ve2-letter-editor` starts from refreshed `origin/test` at `6394add35`. The held search pilot is in a different checkout and is not included.

Review and delivery: at the user's explicit request, only the editor commit was transferred onto `origin/Sergey` at `6407ea5e4` in the same managed checkout (`codex/ve2-editor-sergey-review`). No unrelated `test` changes or held search changes were transferred. The reviewed commit is intended for a fast-forward push to `Sergey`; release remains user-controlled.

## Behavior

- Final letters support 1–6 emails. Add/remove emails locally, then save the whole revision. Removing the first email transfers its subject choices to the next; the new first wait is zero.
- A/B/C buttons browse drafts. The separate “Отправлять” choice selects one body or a body test. Selecting a body test retains one common first-email subject. The existing subject test still supports up to six subjects with a single body.
- The body editor displays clickable links and stores the existing `[label](https://...)` format understood by `clientLaunch`. It accepts plain text on paste and has a small link form with optional editable UTM. Query parameters/fragments are preserved; URL parentheses are encoded. No new rich HTML is accepted.
- `selected_variant` remains the default for existing templates; optional `selected_variants` explicitly selects bodies for testing. Materialization is shared by recipient preview and Instantly handoff, including follow-ups. Existing segment-specific text still overrides the common body and test for that segment; the editor labels this exception.
- Saved letters remain behind the existing optimistic revision and transactional launch/audit lock. No migrations. Already launched/checking templates remain read-only. There are no new model calls, sending actions, or tracking-setting changes.
- Manual uploaded-base launch also accepts C. ENG/HE code and the shared campaign adapter are unchanged.

## Validation

- Branch selector from `6394add35`: 56 suites, 520 passed, 2 existing skipped, about 24 seconds.
- Existing generation-to-handoff case extended without new test files or `it()` cases: 1/6/7 length limits, ABC and single C, preview, follow-up threading, segment override, six legacy subjects, link and UTM round-trip, HTML payload and disabled tracking, invalid links and missing selections.
- TypeScript core/tests and ESLint passed locally. git diff --check passed. The final focused test rerun after fixture typing cleanup also passed (21 cases).
- Real editor + recipient preview bundled into an isolated local browser fixture with stubbed API boundaries and external fetch disabled. Checked initial clean state, browsing B without changing selection, ABC selection/save, clickable UTM links after save and in preview, 6-email cap, first-email deletion/subject transfer, 360px width, light/dark and read-only mode.
- Browser verification found and fixed initial dirty state from `setEditable` emission and link removal caused by `unsetLink` after insertion. Only stored marks are now cleared after inserting a link.
- Second review on the Sergey base: all 56 suites / 520 cases passed (2 existing skips, 25.4 seconds); core/tests TypeScript, changed-file ESLint, diff check, and the VE2 worker bundle passed.
- Fixed malformed pasted links throwing during editor serialization: they remain editable text and save validation rejects them. A label edited to contain `]` retains its exact text and a visible URL instead of losing characters. Added assertions to the existing generation/handoff case.
- The body is temporarily read-only while its link form is open, keeping the insertion range stable. Browser check confirmed invalid-paste recovery, validation without lost text, preserved custom UTM, editing restored after insertion, ABC save, correct recipient preview including C, and no browser errors.

Fixture and local evidence: `/Users/cybermart/.codex/handoffs/ve2-letter-editor-20261009`. No production writes or live Instantly campaign creation were performed. Production deployment is a separate user-controlled phase.
