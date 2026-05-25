---
target: app/src/app/client/base-constructor/page.tsx
total_score: 26
p0_count: 0
p1_count: 1
timestamp: 2026-05-25T21-57-33Z
slug: app-src-app-client-base-constructor-page-tsx
---
# Re-Critique — `app/src/app/client/base-constructor/page.tsx`

**Baseline:** 2026-05-25T19-53-00Z — 23/40 OK (lower edge), 1 P0 + 2 P1 + 2 P2
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual; CLI detector unavailable)
**Changes shipped:** commits 6ec111ba (bridge #3 globals.css) + 07643df0 (structural fixes in BaseConstructorView)

## Design Health Score

| # | Heuristic | Was | Now | Δ | Key issue |
|---|---|---|---|---|---|
| 1 | Visibility | 3 | 3 | 0 | Cost preview added; preview row muted enough that some will miss it |
| 2 | Match Real World | 3 | 3 | 0 | RU fluent; «AI-вызовов» jargon для Olga |
| 3 | User Control | 2 | 2 | 0 | Cancel/reset/X-chip есть; clientMode 9-step lock без «why these?» disclosure |
| 4 | Consistency | 1 | **2** | **+1** | Bridge fixes most cross-aesthetic в .client-portal; admin shell shares `bg-white rounded-2xl shadow-sm` per-section; summary row uses rounded-md vs rest rounded-2xl |
| 5 | Error Prevention | 3 | 3 | 0 | unmappedRoles + taBriefMissing + autoAdds + file-size guard |
| 6 | Recognition | 3 | 3 | 0 | Icons + labels + cost badges. ta_scoring «оставляет 7-10» требует знать scale |
| 7 | Flexibility | 2 | 2 | 0 | Presets admin-only; clientMode zero presets, no "rerun last config" |
| 8 | Aesthetic | 1 | **3** | **+2** | **Major win post-distill** — 9 lock-cards gone в clientMode; text-violet-700 на «AI Обработка» pill leaks (bridge только text-violet-600) |
| 9 | Error Recovery | 3 | 3 | 0 | error/parseError/savedBriefError surfaced. Raw json.error read для submit fail |
| 10 | Help & Docs | 2 | 2 | 0 | clientHint для enrich_descriptions хороший. Cost preview math, 7-10 threshold, why 9 locked — не объяснены |
| **Total** | | **23/40** | **26/40** | **+3** | **OK band (mid)** |

## Anti-Patterns Verdict

**LLM assessment** — **no fresh slop от changes**. Editorial summary row honest, cost preview sober с `~` glyph, Lucide Lock swap correct. **Residual amplified slop**: summary sentence (L928-932) listing 9 steps inline с commas + final «и» («Очистка пустых, дедуп строк/email, разделение почт, очистка названий, проверка сайтов, поиск email, валидация и обогащение описаниями») reads compressed AI-generated. Borderline, not fatal — bullet list или chip tags would feel less prosed.

**Otherwise clean**: no gradients, no emoji, no hero metric, no glass.

**Deterministic scan** — CLI detector unavailable. Manual + sub-agent verified:
- ds-btn-primary uses `var(--cp-paper)` directly, `.bg-white` bridge cannot break it ✓
- Bridge (q) re-assert semantic dots declared LAST — cascade order correct
- BaseConstructorView itself doesn't use `bg-emerald-500/400` (the colors bridge (q) re-asserts) — (q) is defensive для other components in scope

## Overall Impression

**Real, honest move 23/40 → 26/40 OK band (mid)** (+3). Major wins: distill 9 cards (Aesthetic +2), bridge (Consistency +1). Не дошли до Good band потому что (a) bridges don't cover text-emerald/violet/amber/red 400-900 ramps, (b) 4-card stats grid внизу не distilled, (c) summary sentence inline-list feels welded.

**Path к Good (28+)**: extend bridge для colored text ramps + plain bg-emerald-50 (no slash) + distill stats grid (à la dashboard portfolio sentence pattern). Each +1-2.

## What's Working

1. **Distill landed cleanly** (L914-934, L935-939) — clientMode filter on CATEGORIES.map kills 9 disabled cards; eyebrow «автоматически» summary editorial-correct. Olga's first paint goes from «wall of locks» к «I see 2 things I control». **Highest-impact change in cycle.**
2. **Cost preview microcopy** (L1495-1528) right tone — `~5 мин · 8 320 строк в обработке · 41 600 AI-вызовов` honest about rough estimate, separated by mono pipes, AI-call count conditional. Tabular-nums via ds-mono. Maksim's «what am I committing to» answered без modal.
3. **Bridge (j)/(k)/(l)/(o)/(q) cascade structurally sound** — (j) sets bg-white once, (l) kills shadows globally, (o) handles `/` opacity-modifier escape problem через attribute-selectors. (q) declared LAST so semantic dots beat (j)/(o). ds-btn-primary at L1447 binds к `var(--cp-paper)` directly so `.bg-white` override at L2043 cannot reach it. Safe.

## Priority Issues (Post-Fix)

### Baseline verification
- **P0 Cross-aesthetic admin shell** — **PARTIALLY RESOLVED**. Bridge catches bg-white/gray-50/border-gray-200/opacity-modifiers/blue+emerald+amber+violet+rose washes/shadows. What slips:
  - `text-violet-700` (L105, L1671, L1678)
  - `text-emerald-600/700/800` в unmapped slots (L812, L1018, L1171, L1362-1366)
  - `text-amber-700/800/900` (L891, L1199, L1376, L1383)
  - `text-blue-900` (L1695-1719)
  - `text-red-400-700` (L878, L1151, L1181, L1472, L1546-1547, L1629-1632)
  - Plain `bg-emerald-50` без `/` (L811, L1361, L1376, L1397) — bridge (o) только `[class*="bg-emerald-50/"]`
  - Plain `bg-red-50` (L1547) — same gap
  - `bg-gray-900` черные диски на черном фоне (L1057, L1090) — invisible black-on-black
  
  In `.client-portal` dark scope `text-emerald-700` (#047857) на `cp-surface-rest` (#111213) reads as low-contrast greenish whisper. Not failing AA для short copy, но visually breaks editorial dark pact. **Downgrade к P1.**

- **P1 9-of-11 always-locked card grid** — **RESOLVED**. L935-939 filter + L914-934 summary.
- **P1 Submit без cost/time preview** — **RESOLVED**. L1495-1528.
- **P2 Five stacked white cards** — **RESOLVED structurally** (bridge flattens) but **persists architecturally** для results-stats grid (L1648-1689, 4 identical cards) и history list — still triggers identical-card-grid ban.
- **P2 Emoji 🔒** — **RESOLVED**. L1000, L1025, L1045, L1101 все Lock.

### NEW issues from changes
- **N1 (P2)** — clientMode CATEGORIES still iterates all 3 (L935), filter guards rendering. С только одной visible category, the colored AI category-pill (bg-violet-50 text-violet-700 border-violet-200) loses purpose. Drop category-pill в clientMode when only 1 category renders
- **N2 (P2)** — Cost preview math fictional/unverified. L1499-1505 hardcodes 0.5s/row для AI etc. For 10K-row file with 3 API + 2 AI = ~284 мин. If actual takes 30 мин — overshoots 9×. Calibrate против `wiki/log.md` worker timings или downgrade до «несколько минут»
- **N3 (P2)** — `totalMin` word agreement bug. L1511: `мин : мин : мин` ternary reduces к constant. Either should be «минута/минуты/минут» (Russian plural) или ternary leftover scaffolding. Currently lies about being thoughtful

### Persistent gaps NOT addressed
- **G1 (P1)** — stats cards (L1648-1689) — 4 identical-grid cards = hero-metric + identical-card-grid ban. Distill (à la dashboard portfolio sentence)
- **G2 (P1)** — preview tables (L844-867, L1764-1786) use `bg-gray-50/80` headers + `divide-gray-100` rows; bridges flatten but `text-gray-500` header too quiet для dark, hierarchy collapses
- **G3 (P2)** — segmented control L1312-1351 (Сохранённый/PDF/Текст) uses `bg-gray-100` container + `bg-white shadow-sm` active. Bridge flattens, но segmented switcher built on ds-pill/neu-pill would be more native

## Cognitive Load Check (5/8 PASS — was 4/8)

| # | Item | Result |
|---|---|---|
| 1 | Single primary action | ✅ PASS — «Запустить обработку» единственная black button |
| 2 | Status visible без scrolling | ❌ FAIL — cost preview ниже sticky submit, может scroll out of view |
| 3 | Numbers right-aligned / mono | ✅ PASS — cost preview ds-mono |
| 4 | ≤7 visible choices | ✅ PASS в clientMode (2 toggleable + ~3 settings) — was FAIL at baseline (11 cards), distill fixed |
| 5 | Progressive disclosure | ✅ PASS — mapping/settings appear when needed |
| 6 | Hierarchy via type/weight not color | ⚠️ PARTIAL — cost preview leans на 3 paper tones instead of weight |
| 7 | Reading order matches doing order | ✅ PASS — 1→2→3→4→Submit→Preview |
| 8 | No competing focal points | ❌ FAIL — completion stats grid still 4 cards (L1648-1689) |

## Persona Red Flags

**Olga (cold-outreach manager)** — 9-card collapse closes RED. **Major win.** Yellow: «AI-вызовов» foreign vocab; stats 2×4 grid still cognitively heavy

**Maksim (founder/buyer)** — GREEN on cost preview. Yellow: no $$ cost on AI calls

**Sergey (admin /tools/our-bases)** — GREEN — gated by clientMode, его page untouched, admin presets show (L887-902). Bridge sweep `.bg-white` is .client-portal-scoped — admin keeps light chrome

## Minor Observations

- L778-781 — dropzone hover `border-blue-300 bg-blue-50/50` — bridge maps both к cp-surface-rest, **no visible state difference** между idle и parsing. Loader2 spinner единственный signal
- L811, L1361, L1376, L1397 — plain `bg-emerald-50` (no `/`) NOT in bridge (o) attribute selector. Renders as Tailwind's emerald-50 (#ecfdf5) — **pale green tile on dark background**
- L1597 — `text-violet-700 border-violet-200` — bridge (p) only covers `text-violet-600`
- L1547 — `bg-red-50 text-red-600` for cancel button — plain bg-red-50 not in (o)
- L1090, L1057 — `bg-gray-900` chips/discs — invisible black-on-black corner badges
- L1232 — `text-violet-600 focus:ring-violet-400` radio — focus ring unmapped

## Questions to Consider

1. Should bridges (n)/(p) be extended to cover 4 colored TEXT ramps (text-emerald, text-violet, text-amber, text-red) 400-900 range, с explicit re-assert в (q) для ones that matter (red-600 для errors, emerald-600 для success microcopy)? Or first-party `.ds-text-success/warn/error` utilities replacing Tailwind classes в source?
2. Cost-preview math acceptable как «vibes-based» или wired к actual worker telemetry перед clients see it? 5 мин estimate becoming 45 мин erodes trust
3. 4-card stats grid (L1648-1689) distill-eligible (à la dashboard portfolio sentence) или clients explicitly want каждое число large?
4. Plain `bg-emerald-50` / `bg-amber-50` / `bg-red-50` (no slash) folded into bridge (o)? Currently (o) requires `/` presence; 4-5 plain-class call sites leak Tailwind pastels на dark
5. L928-932 summary sentence — chip-style tags («Очистка пустых» «Дедуп» «Проверка сайтов»...) more editorially honest than welded prose? Or prose feels intentionally compressed?
