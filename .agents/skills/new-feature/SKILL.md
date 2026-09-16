---
name: new-feature
description: Prepare an isolated Portal worktree for a new coding task, or verify the worktree already assigned to the task. Use before implementing a feature or fix; preserve the selected branch and base for ongoing work.
---

# Start a Portal task

Read the repository's `AGENTS.md` first. The Portal adaptation and check
commands are in [software-factory.md](../../../docs/software-factory.md).

1. Inspect `git status --short --branch`, `git worktree list`, and
   `git log -1 --oneline`. Identify the checkout and branch assigned to this
   task. Leave other worktrees and uncommitted changes alone.
2. Continue in an existing task worktree, including one created by Codex,
   Claude Code or Cursor. Do not create a nested worktree on every follow-up.
3. If isolation is needed, use the user's requested base. Otherwise branch
   from the current `HEAD` and report that choice. Portal has active work
   outside `main`; do not silently change the base to `origin/main`, `test`
   or another developer's branch. Fetch the relevant ref only when needed.
4. Choose a unique `codex/<task-name>` branch and an absolute worktree path
   outside the checkout, or an already ignored directory. After choosing
   the real path and name:

   ```bash
   git worktree add /absolute/path/to/task -b codex/task-name HEAD
   ```

   A collision means choose another name, never force or reuse. Enter that
   directory and verify the branch before editing. Do not stash, reset,
   switch or commit somebody else's work.
5. If GitHub access is available, inspect open PRs touching the intended
   files. Overlap alone is not a reason to stop: keep edits focused and
   identify the conflict. Ask only if ownership or intended behavior
   cannot be determined from the task. An unavailable optional scope check
   does not block isolated local work.
6. Install dependencies only when required. Follow the project guide's
   commands and environment cautions. Never copy or link production `.env`
   files into a new worktree or start workers as routine setup. Worktrees
   do not isolate databases, ports or queues.

Before trusting a local server, verify its port, process and working
directory. Keep the worktree for review after committing and pushing this
task's branch. Do not auto-rebase, force-push, open a PR, merge, deploy or
delete the worktree as part of this skill. Those are separate actions
subject to the repository's release boundary and the current request.
