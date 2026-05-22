---
target: app/src/app/client/dashboard/page.tsx
total_score: 29
p0_count: 0
p1_count: 1
timestamp: 2026-05-22T22-47-16Z
slug: app-src-app-client-dashboard-page-tsx
---
# Re-critique — /client/dashboard (editorial dark pivot)

**Target:** app/src/app/client/dashboard/page.tsx
**Mode:** Assessment A only (deterministic detector still missing — same install gap as baseline)
**Baseline:** 21/40 Mixed (2026-05-20T20-18-53Z)

## Design Health Score

| # | Heuristic | Score | Delta | Key issue |
|---|---|---|---|---|
| 1 | Visibility of System Status | 3 | 0 | Greeting branches; no portfolio-level activity signal |
| 2 | Match System / Real World | 4 | +1 | Fully RU, correct plurals |
| 3 | User Control & Freedom | 3 | +1 | Auto-collapse on complete; no dismiss for incomplete |
| 4 | Consistency & Standards | 3 | +1 | Single-slate chrome, but hardcoded hex evade token system |
| 5 | Error Prevention | 3 | +1 | Branched empty states |
| 6 | Recognition vs Recall | 3 | 0 | Reply-rate %, at-risk tint; no campaign-ID mono tag |
| 7 | Flexibility & Efficiency | 2 | +1 | No shortcuts; only "Все N" escape |
| 8 | Aesthetic & Minimalist | 4 | +2 | Pivot earned its 4 |
| 9 | Error Recovery | 3 | +1 | Retry on campaigns; replies degrade |
| 10 | Help & Documentation | 1 | 0 | No tooltips, same gap as baseline |
| **Total** | | **29/40** | **+8** | **Good band (28-35) reached** |

## Anti-Patterns Verdict

Largely cleared. Dashboard no longer reads AI-generated. Four loudest tells from baseline retired: gradient text wordmark, rainbow side-stripes, hero gradient panel, gradient checkmark pips.

Remaining manual pattern-match issues (deterministic scan unavailable):
- page.tsx:122,124 — #10B981 / #F59E0B literals (should be var(--cp-green) / var(--cp-amber))
- AutoPipelineSummary.tsx:108 — var(--cp-success, #4ade80) references undefined token

Visual overlays: unavailable.

## What's Improved Since Baseline

- P0 #1 (wrong question) — substantially solved. Lede renders "Сегодня требуют внимания" when totalUnread > 0
- P0 #2 (rainbow stripes) — deleted entirely
- P1 #1 (hero decoration) — deleted, replaced by single greeting paragraph
- P1 #2 (gradient text/pips) — zero linear-gradient or bg-clip in dashboard
- P2 #1 (data-poor language-mixed row) — campaign rows now full Russian with reply rate

## Priority Issues

### [P1] Onboarding next-step emphasis collapses in dark mode
- Evidence: OnboardingChecklist.tsx:220 (neu-inset on next row); globals.css:1257-1262 (resolves same as neu-card)
- Fix: surface-elev + 1px amber border, or explicit "Сделать сейчас" paper button
- Command: craft

### [P2] AutoPipelineSummary breaks editorial doctrine
- Evidence: AutoPipelineSummary.tsx:114-149 (no ds-eyebrow, no mono labels, plain text-xl numbers, undefined --cp-success)
- Fix: editorial eyebrow + list-row pattern + mono numbers + correct token
- Command: shape

### [P2] Hardcoded status hex bypasses token system
- Evidence: page.tsx:122,124 + AutoPipelineSummary.tsx:108
- Fix: replace literals with var(--cp-green/amber); define --cp-success alias
- Command: harden

### [P3] Dashboard answers what arrived, not what we're doing
- Evidence: page.tsx:253-254 (caught-up branch has no portfolio metric)
- Fix: one-line mono summary under greeting (sent today + queued campaigns)
- Command: distill

## Cognitive Load: 8/8 PASS

Single focus, chunking, grouping, hierarchy, one-thing-at-a-time, minimal choices, working memory, progressive disclosure — all pass.

## Strengths

1. Data-branched greeting (page.tsx:244-269) — typographic decision carrying product semantics
2. Lede block (page.tsx:286-382) — three rows, dot + name + company + subject + ago, right pattern for right job
3. Self-documenting docblock (page.tsx:3-16) — declares what page is NOT, cites prior critique findings

## Persona Red Flags

Olga: 3 cleared, 1 remains (no portfolio "all OK" signal in calm branch)
Maksim: 2 cleared, 1 remains (no "why this matters" copy) + 1 new (P1 next-step collapse)
Sergey: 1 partial, 1 remains (no UI surface for swallowed errors) + 1 new regression (friendly copy hides err.message from UI debug)

## Minor Observations

- page.tsx:306-308 — warm-stone rgba fallback for --cp-row-divider
- page.tsx:489 — reply-rate < 0.5 threshold is in absolute %, suspect unit bug
- OnboardingChecklist.tsx:244-246 — double done-state signal (weight + colour)
- page.tsx:399 — AutoPipelineSummary rendered without editorial eyebrow, breaks 01→/02→ rhythm
- OnboardingChecklist.tsx:241 — "01 → шаг" redundant (use names, not types)

## Questions to Consider

1. Auto-mode = 4th implicit branch; should AutoPipelineSummary be the lede there?
2. When only campaigns is visible, is "01 → Кампании" alone honest?
3. Should dashboard show what agency is doing right now, not just what arrived?
4. Should OnboardingChecklist position branch on completion progress?
5. Chrome is invisible — is anything OutreachOS-specific visible? Should it be?
