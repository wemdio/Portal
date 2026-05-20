---
target: app/src/app/client/dashboard/page.tsx
total_score: 21
p0_count: 2
p1_count: 2
timestamp: 2026-05-20T20-18-53Z
slug: app-src-app-client-dashboard-page-tsx
---
# Impeccable Critique — /client/dashboard

**Target:** app/src/app/client/dashboard/page.tsx
**Assessment independence:** degraded — Assessment B (deterministic detector) unavailable (detect.mjs bundled module missing in npx skills add install). Browser inspection unavailable (auth-gated route, no dev server). Findings rest on isolated A + manual source pattern-match.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Spinner + copy correct; campaign-health signal entirely absent. |
| 2 | Match System / Real World | 3 | RU-first, but row at page.tsx:248 mixes "Активна · 1234 sent · 3 reply". |
| 3 | User Control & Freedom | 2 | Checklist can't be dismissed/collapsed before completion. |
| 4 | Consistency & Standards | 2 | 5 ad-hoc accents on one screen violate Single Slate Rule. |
| 5 | Error Prevention | 2 | primary:true CTA elevated even when prerequisites unmet. |
| 6 | Recognition vs Recall | 3 | formatStatus returns colourless strings. |
| 7 | Flexibility & Efficiency | 1 | Zero shortcuts, no compact mode, no recent-items. |
| 8 | Aesthetic & Minimalist | 2 | Hero gradient + wallpaper icon + 4-colour stripes + gradient checkmarks = decoration. |
| 9 | Error Recovery | 2 | Raw err.message, no retry, OnboardingChecklist swallows errors silently. |
| 10 | Help & Documentation | 1 | No tooltips, no inline docs. |
| **Total** | | **21/40** | **Mixed (Acceptable)** |

## Anti-Patterns Verdict

Yes — partially AI-generated. Material is honest, chrome is slop.

**Manual pattern-match (deterministic scan unavailable):**
- Gradient text (Don't #1): 3 instances — layout.tsx:88-95, OnboardingChecklist.tsx:93, OnboardingChecklist.tsx:178-181
- Side-stripe borders (Don't #2): 4 instances — page.tsx:143 (borderLeft 3px × 4 quick-actions)
- Rainbow chromatic accents (Don't #3): 5 colours per screen — page.tsx:42,49,56,63 + OnboardingChecklist.tsx:115,180
- Gradient button fills (Don't #4): 2 — OnboardingChecklist.tsx:93, page.tsx:109
- Decoration-only material (The Material Rule): page.tsx:111-114 (h-32 wallpaper icon)

Visual overlays: unavailable (no live server, auth-gated route).

## Overall Impression

The dashboard is two screens stacked into one: a first-run onboarding flow and a returning-customer command center. Neither does its job. The single biggest opportunity: branch the entire dashboard on onboarding.complete. Pre-launch users get a focused "next step" screen; post-launch users get a campaign-health screen with reply-needing-attention as the lede.

## What's Working

1. Neumorphic material is honest (globals.css:1192-1206 follows Light-from-Upper-Left).
2. Empty-state pattern is canonical (page.tsx:213-228).
3. "Next step" tag on onboarding (OnboardingChecklist.tsx:131-138, 196-202).

## Priority Issues

### [P0] Dashboard answers wrong question for repeat visitors
- Evidence: page.tsx:104-176 (onboarding consumes above-the-fold); page.tsx:178-257 (campaigns demoted).
- Fix: Branch on onboarding.complete. Returning users see "3 ответа лида ждут вас" as lede.
- Suggested command: shape

### [P0] Rainbow side-stripe quick-actions violate Don'ts #2 + #3
- Evidence: page.tsx:36-69, page.tsx:143, page.tsx:145-150
- Fix: Drop color+bg. Single walnut-soft icon, slate-tide for primary. Delete side-stripes.
- Suggested command: quieter

### [P1] Hero panel is decoration without information
- Evidence: page.tsx:107-122 (gradient, wallpaper icon, restated copy)
- Fix: Delete gradient + icon. Hero copy carries status.
- Suggested command: distill

### [P1] Gradient text + pips violate DESIGN.md Don't list explicitly
- Evidence: layout.tsx:88-97, OnboardingChecklist.tsx:93, 178-181, page.tsx:109
- Fix: Solid colours via design tokens.
- Suggested command: craft

### [P2] Recent-campaigns row is data-poor and language-mixed
- Evidence: page.tsx:247-249, page.tsx:72-79
- Fix: Localise nouns; add reply rate; status colour-dot.
- Suggested command: clarify + layout

## Persona Red Flags

**Olga (B2B founder, 1-3 visits/week):** Hero greets her with "Здесь начинается" on visit 7. Primary CTA pushes "Создать кампанию" she doesn't want. Recent-row gives no health signal.

**Maksim (sales-lead, just signed up):** Two competing primaries (hero vs checklist vs left CTA). Step ids leak as dev jargon. No "why this matters" copy.

**Sergey (internal manager debugging):** No timestamps. Raw err.message. Silent swallow of fetch errors.

## Minor Observations

- Two icons for "Create campaign" (Send + Rocket).
- page.tsx:149 uses h-4.5 (non-default Tailwind).
- "Все кампании" links to /client not /client/campaigns.
- Strikethrough on done items adds noise.
- Inline borderTop colour should be CSS var.
- Right-column 320-420px squeezes quick-actions on 1280px laptop.

## Questions to Consider

1. Is the dashboard one screen or two?
2. What is the one signal a paying B2B client should see in the first half-second?
3. Why does the dashboard have a hero at all?
4. What does Quick Actions do that the sidebar doesn't?
5. If you deleted every colour except slate-tide and walnut — what's left?
