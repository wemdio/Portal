---
name: before-and-after
description: Capture and compare actual before/after Portal UI states with matching viewports. Use for visible interface changes or screenshot comparisons; keep images local unless the user authorizes sharing to a specific destination.
license: See LICENSE for the upstream PolyForm Shield 1.0.0 license.
---

# Before and after

Read `AGENTS.md`. Use browser/computer-use tools already available in the
current environment and follow their capture instructions.

1. Identify the actual baseline and changed state. Reuse images captured
   during reproduction. Do not label two screenshots of changed code as
   before/after. A missing baseline is a limitation to report; ask for a
   source only when necessary and unavailable from context.
2. Use the same route, test data, viewport, scroll position and interaction
   state for both captures. Include mobile/tablet when affected. Capture
   the relevant component or viewport, or a full page when it helps review.
3. Save `.artifacts/<task>/before.png` and `after.png`. Inspect both images
   and confirm the intended difference and any regressions.
4. Present a local Markdown comparison with absolute file paths. Explain
   the observed change and the revision represented by each image.

Use Markdown image embeds for actual files. Local paths do not work as
GitHub PR embeds; if publication is authorized, use the approved
destination's uploaded URLs and verify access there.

## Optional upstream CLI

If `@vercel/before-and-after` is already installed and appropriate, it can
capture two URLs locally:

```bash
before-and-after <before-url> <after-url> --output .artifacts/task-name
```

The package name is `@vercel/before-and-after`. Check its current help
before adding options. Do not install globally or modify app dependencies
as a routine prerequisite; built-in capture is sufficient.

The CLI's `--markdown` option uploads images, using a public host by
default. Do not use it just to format a local table. Obtain authorization
for the exact files and destination before an upload. Portal omits the
upstream public-upload adapters for this reason.

Never disable authentication or expose a protected deployment to obtain a
capture. Use the user's authorized session or a local fixture. Keep
credentials and customer data out of images. Creating/editing a PR remains
subject to `AGENTS.md`.
