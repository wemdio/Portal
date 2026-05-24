---
target: app/src/app/client/launch/page.tsx
total_score: 28
p0_count: 0
p1_count: 1
timestamp: 2026-05-24T08-13-38Z
slug: app-src-app-client-launch-page-tsx
---
# Re-Critique — `app/src/app/client/launch/page.tsx`

**Baseline:** 2026-05-24T06-29-13Z — 21/40 Mixed, 2 P0 + 3 P1 + 1 P2
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual scan; CLI detector unavailable)
**Batch fix shipped:** commit 1af56f52 (EmailBodyField inline rewrite + localStorage draft persistence)

## Design Health Score

| # | Heuristic | Before | Now | Δ | Key issue |
|---|---|---|---|---|---|
| 1 | Visibility of System Status | 2 | **4** | **+2** | Draft microcopy ds-mono paper-faint exactly right confidence signal |
| 2 | Match Real World | 3 | 3 | 0 | RU copy idiomatic |
| 3 | User Control & Freedom | 1 | **3** | **+2** | Draft restore + «начать с нуля» + Esc on link gives real escape hatches |
| 4 | Consistency & Standards | 3 | 3 | 0 | All ds-* utilities в EmailBodyField correct; LaunchHeader helper мёртв в wizard branch |
| 5 | Error Prevention | 1 | 1 | 0 | **Deferred** — handleLaunch fires synchronously, no confirm перед irreversible |
| 6 | Recognition vs Recall | 3 | **4** | **+1** | VariableReference chip rail с click-to-copy + green flash — excellent |
| 7 | Flexibility & Efficiency | 1 | **2** | **+1** | Deferred clone/template; variable chips help slightly |
| 8 | Aesthetic & Minimalist | 3 | 3 | 0 | Six identical Section cards stack heavy; em-dash violations |
| 9 | Error Recovery | 2 | 2 | 0 | launchError surfaces inline but no deep-link/scroll-to-field |
| 10 | Help & Documentation | 2 | **3** | **+1** | Brief tip контекстный; VariableReference doubles as docs |
| **Total** | | **21/40** | **28/40** | **+7** | **Good band (low end) — out of Mixed** |

## Anti-Patterns Verdict

**LLM assessment** — **page больше не reads AI-generated**. Page now has texture of hand-crafted ops console. Tells:
- EmailBodyField inline expansion (L114-165) — Esc closes, Enter inserts, autofocus via rAF (L63), selection preservation (L80-86) — kind of detail AI rarely earns
- Draft microcopy «восстановлен черновик от 14:32 · начать с нуля» (L740-754) — asymmetry of someone who has been Olga at 11pm. AI writes «Draft auto-saved», not this
- Versioned localStorage key `client.launch.draft.v1` (L71) — author anticipates schema migration

**Residual slop tell**: wizard still uses **6 full named Section cards** (number={1..6}) formatted identically с тем же eyebrow+title+subtitle (L763, 870, 957, 1037, 1047, 1057). Identical-card-grid ban rendered vertically. Confident author would collapse Behavior + Schedule + Launch в tighter trailing rail.

**Deterministic scan** — CLI detector still unavailable. Manual scan:
- **EmailBodyField.tsx**: 0 stale tokens, 0 legacy classes (только в docblock как «было до»), 0 fixed/inset/z-50, 0 bg-black/rgba scrim. ✅ Clean.
- **launch/page.tsx**: 0 hex literals, 0 linear-gradient, 0 bg-clip, 0 backdrop-blur, 0 side-stripes, 0 undefined token fallbacks
- Em-dash ban violations найдены: L983, L1262, L1437, L1456, L1670 (user-facing copy)

## Overall Impression

**Real, honest jump 21/40 Mixed → 28/40 Good** (+7 points). Both P0 absolute-ban / catastrophic-risk findings resolved cleanly. Cognitive load 8/8 PASS (was 6/8). EmailBodyField is exemplary — doctrinally clean, hand-tuned UX details.

**BUT** rewrite surfaced 4 new sub-issues + one **major persona gap**: file (CSV upload) is NOT persisted — Olga restores draft → видит Step 1 only → no microcopy объясняющего почему. UX cliff. Browser API limitation, но UX-wise treatable с conditional message.

**Next opportunity to Good high end (32-35)**: fix preset/draft race (N1), fix microcopy staleness after first keystroke (N3), add file-gone hint, address deferred P1 (validation + clone + confirm). Each +1-2 points.

## What's Working (post-fix specifics)

1. **EmailBodyField doctrinally clean** (EmailBodyField.tsx:114-165) — `mt-2 rounded-md p-3` inline panel on surface-rest + 1px divider. Zero fixed positioning, zero z-50, zero bg-black/40 scrim. ds-input + ds-btn-primary + ds-btn-ghost only. Enter/Esc handlers (L148-151) + autofocus via rAF (L63) = crafted.

2. **Draft persistence plumbing thoughtful** (page.tsx:71-304) — versioned key `client.launch.draft.v1` (anticipates schema migration). `isEmpty` guard (L253-259) prevents writing junk on first paint. beforeunload guard scoped to `hasDirtyDraft && !result` (L292-304). Each effect single clear job.

3. **Microcopy с двумя состояниями** (page.tsx:740-754) — «черновик сохранён HH:MM» / «восстановлен черновик от HH:MM · начать с нуля». ds-mono, paper-faint, sits под subtitle без pulling focus. Underline-link к startNewLaunch = right out — no modal, no toast.

## Priority Issues (Post-Fix)

### Baseline P0 ×2 — RESOLVED ✅
- ✅ EmailBodyField modal: killed; no fixed/inset/z-50, no scrim, no stale tokens (verified by grep)
- ✅ Wizard zero persistence: full plumbing (restore L225-248, save L252-279, clear-on-result L282-289, beforeunload L292-304, startNewLaunch wipe L597-599)

### NEW issues introduced by rewrite

#### [P2-NEW] N1 — Preset/draft race может clobber restored schedule/behavior
- **Where**: `useEffect` save dependency at L279 includes `schedule` и `behavior`; те же поля written by `loadPreset` effect (L313-326)
- **Why**: Race condition. Если loadPreset резолвится slow и restore-from-localStorage effect уже сработал → preset write silently overwrites restored draft's schedule/behavior → save effect persists preset values. Olga's «Tuesdays only, 14:00-18:00» custom draft clobbered «Mon-Fri 09:00-18:00» preset defaults. Both effects fire on mount без ordering guarantee
- **Fix**: Gate preset hydration behind `!draftRestored` — если draft restored, не applying preset defaults. Или: applyPreset только когда schedule все ещё дефолтное
- **Command**: `harden`

#### [P2-NEW] N2 — Restore microcopy too quiet для restore moment
- **Where**: page.tsx:740-754 — paper-faint at 11px, easily missed at top of page
- **Why**: «восстановлен» — это момент когда Olga most needs reassurance («ah, всё на месте!»). Сейчас signal whisper-quiet
- **Fix**: При `draftRestored=true` (first render after restore), либо bump opacity/weight, либо show inline banner-like card на 3 секунды затем degrade в quiet microcopy. Или: animate-in (fade) для одного restore signal
- **Command**: `animate` или `bolder` для restore moment only

#### [P3-NEW] N3 — Microcopy staleness — «восстановлен» остаётся после first keystroke
- **Where**: page.tsx:740-754 — after restore, `draftRestored=true` stays true until startNewLaunch. After first keystroke save effect fires → `setDraftSavedAt(new Date())` → но copy всё ещё «восстановлен черновик от 14:32» — confusing (это уже не restored, fresh save)
- **Fix**: In save effect (L266-278), call `setDraftRestored(false)` after first successful save
- **Command**: `polish`

#### [P3-NEW] N4 — EmailBodyField close-X focus shuffle
- **Where**: EmailBodyField.tsx:66-70 — closeInline calls `requestAnimationFrame(() => textareaRef.current?.focus())` regardless of how user closed
- **Why**: Esc-close → focus return correct (keyboard flow). X-click (mouse) → focus return may feel intrusive — user wasn't in keyboard flow
- **Fix**: Pass close-cause to closeInline: «esc» (keyboard) → restore focus, «x» or «insert» → don't restore
- **Command**: `polish`

### MAJOR PERSONA GAP surfaced

#### [P1-NEW] File restore impossible — Olga gets Step 1 only without explanation
- **Where**: page.tsx:225-248 restore effect doesn't (can't) persist `fileRows/fileHeaders/fileName`. Browsers don't allow programmatic File restoration.
- **Why**: Restore brings back copy + mapping + sequence → но mapping points at headers что не существуют. Wizard renders Step 2-6 ONLY когда `fileHeaders.length > 0` (L869, 957, 1036, 1047, 1057). Olga refreshes mid-Step-4 → sees только Step 1 (file upload) → её copy/sequence «висит» в state но invisible → confusion («где моя цепочка?»)
- **Fix**: Conditional microcopy при `draftRestored && fileRows.length === 0`:
  «Цепочка восстановлена, но файл базы нужно загрузить заново — браузеры не сохраняют файлы между сессиями.»
  Или показывать saved values как read-only preview под Step 1 («Восстановлено: цепочка 4 шага · кампания "Орбита 12"»)
- **Command**: `clarify`

### Deferred (NOT regressions, intentionally not in batch 1)
- P1 validation post-submit/sequential — still all-at-once (L504-551)
- P1 no pre-launch confirmation — handleLaunch fires directly (L1085)
- P1 no clone/template для Maksim — history rows только «open» link (L1115-1156)
- P2 LaunchHeader duplicate — actually now mostly dead code (wizard branch inlines own header)

## Cognitive Load Check (8/8 PASS)

✅ Scan path (numbered 01→06), ✅ one color per region, ✅ mono numbers, ✅ ≤2 weights, ✅ hairlines, ✅ status dots, ✅ editorial numbering, ✅ empty/loading single CTA.

Cognitive scaffolding never broke. Same as baseline.

## Persona Red Flags

**Olga (40-min draft survivor)** — **survives refresh: yes, with major caveat**:
- Restore covers campaign+sequence+mapping+vars+schedule+behavior ✓
- BUT file NOT persisted — gets Step 1 only after refresh без объяснения (P1-NEW above)
- Confidence signal correct intent (microcopy) но whisper-quiet for restore moment (N2)
- After first keystroke: copy reads «восстановлен» когда technically fresh save — confusing (N3)

**Maksim (5+ launches, wants clone)** — **same gap, deferred**. History (L1115-1156) только open-link.

**Sergey (engineer, wants debug)** — **same gap, no new debug surface**. Нет request IDs, нет copy-error-with-context button. `setLaunchError(err.message)` показывает message но без correlation ID.

## Minor Observations

- page.tsx:983 «AI-инструменты … сработают точнее» — em-dash в body copy (ban violation)
- page.tsx:1262 `<option value="">— не использовать —</option>` — em-dashes as visual separators (ban)
- page.tsx:1437, 1456, 1670 — more em-dashes в user copy
- page.tsx:1810 «Instantly случайно выберет один вариант» — «случайно» near Send button reads ambiguously («accidentally»). Better: «Instantly будет случайным образом чередовать варианты»
- EmailBodyField.tsx:140 hardcodes `https://polzaagency.ru/?utm_source=email&utm_campaign=...` example — leaks brand if white-labelled. Use neutral example
- page.tsx:1117 — `neu-sm` class — verify не stale token
- page.tsx:1100-1156 — history rows full-width identical cards. С 5+ launches становится slop-y stack. Editorial = table rows с hairline separators
- N3 (above) — small enough для polish batch but noticeable UX bug

## Questions to Consider

1. **File-not-persisted gap**: should restore microcopy include «загрузите файл заново» hint когда `draftRestored && fileRows.length === 0`? Right now Olga silently in weird state
2. **Preset vs draft race** (N1): which wins for schedule/behavior — last saved draft или always-fresh preset defaults? Worth deciding explicitly rather than letting effect ordering decide
3. **Pre-launch confirm**: given persona ships 1-5 launches lifetime, is two-tap confirm cheap insurance, или unnecessary friction? Read: cheap insurance for irreversible Instantly write
4. **History as table not cards**: six Section + history-cards stack pushes total page height past 4 viewports. Worth pulling history into tighter table-with-hairlines presentation?
5. **Auto-save toast vs microcopy-only**: should *first* successful save get one-time slide-in confirmation then fall back to quiet microcopy? Right now Olga has no moment of «ah, it saved» — just static text she may not notice
