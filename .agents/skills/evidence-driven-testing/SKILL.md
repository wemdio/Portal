---
name: evidence-driven-testing
description: Verify a Portal change with reproducible evidence from relevant tests, live UI checks or measured outputs. Use for behavior changes and bug fixes; record what passed, failed or could not be tested without publishing artifacts automatically.
metadata:
  upstream-version: "1.2"
---

# Prove a Portal change

Read `AGENTS.md` and the checks in
[software-factory.md](../../../docs/software-factory.md). Use existing
tests and local artifacts in proportion to the change. A documentation
edit needs link and instruction checks, not a video.

## Establish the baseline

- Turn the requested behavior into observable acceptance criteria.
- For a fix, reproduce the failure before editing when feasible. Save
  the command, inputs and output, or an actual screenshot. If a baseline
  cannot be obtained, state why; never manufacture a "before" result.
- Record branch, commit, any uncommitted changes, environment and fixture
  assumptions. Confirm that a server belongs to this worktree before
  trusting results from its port.
- Store logs, screenshots and recordings under `.artifacts/<task>/`,
  which is ignored by Git. Use synthetic or redacted data. Do not copy
  customer data, secrets or full transcripts into reports or commits.

## Run and record relevant checks

Choose the existing checks that exercise the changed behavior. Capture
exit codes as well as output. Successful compilation alone does not prove
that a workflow works. Do not silently replace a blocked integration test
with a mock and claim the integration passed.

For UI changes, drive the available browser/computer-use tool, inspect
actual states, and save screenshots at meaningful assertions. Follow that
tool's own instructions. A Playwright script is also suitable when its
dependencies are available in this checkout. Label scripted/headless
capture accurately. `app` already declares Playwright; do not install an
unrelated global browser package just to take a screenshot.

Use [before-and-after](../before-and-after/SKILL.md) for a visible change.
Backend changes can use a failing/passing regression, output pair, API
response or measured numbers. Reversible wording changes need only direct
inspection, not new tests that match the implementation's wording.

In `.artifacts/<task>/report.md`, record the exact revision/environment,
each relevant command or interaction and its result (passed, failed or
untested with a reason), before/after paths, and remaining limitations.
Distinguish mocked dependencies and existing failures outside the change.

## Optional annotated video

The unchanged upstream recorder is [scripts/evidence.py](scripts/evidence.py).
It needs Python 3, FFmpeg/ffprobe, libx264 and the ASS filter. Check first:

```bash
python3 .agents/skills/evidence-driven-testing/scripts/evidence.py doctor --json
```

Inspect both `ready` and `capture_ready`. FFmpeg availability alone does
not establish permission to record the screen. If capture is unavailable,
use screenshots and command evidence and report the limitation.

On a clean test screen with no private information visible, run `start`
with `--output .artifacts/task-name`, a descriptive `--title`, the actual
`--commit` and `--branch`, and `--environment` describing the local fixture
and uncommitted changes. Use the returned session path for later commands:

```bash
python3 .agents/skills/evidence-driven-testing/scripts/evidence.py annotate /absolute/session/path --type test_start --message "It should save the draft"
python3 .agents/skills/evidence-driven-testing/scripts/evidence.py annotate /absolute/session/path --type assertion --result passed --message "Draft remains after reload"
python3 .agents/skills/evidence-driven-testing/scripts/evidence.py stop /absolute/session/path
```

Choose `passed` only after observing the result; messages must be under
80 characters. Stop your recording even when testing fails. Review the
generated `evidence.mp4`, `report.md` and `manifest.json` and fill the report's
caveats. `verified: true` validates the video file, not the assertions.
`--source test` generates a synthetic pattern for recorder smoke tests and
must never be described as Portal UI evidence.

## Deliver

Give the user local artifact links and a concise result. Uploading media,
posting PR/tracker comments and editing PR descriptions are separate
external actions requiring authorization for that destination. Do not
upload to a public image host by default. The normal Portal endpoint is a
focused commit and push of the current task branch, followed by a report.
