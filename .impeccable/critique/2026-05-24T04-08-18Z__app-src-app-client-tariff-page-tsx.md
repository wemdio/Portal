---
target: app/src/app/client/tariff/page.tsx
total_score: 23
p0_count: 0
p1_count: 1
timestamp: 2026-05-24T04-08-18Z
slug: app-src-app-client-tariff-page-tsx
---
# Re-Critique — `app/src/app/client/tariff/page.tsx`

**Baseline:** 2026-05-24T02-05-53Z — 17/40 Mixed, 3 P0 + 2 P1
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual scan; CLI detector still unavailable)
**Batch fix applied:** commit ef676598 (shape + clarify + harden + quieter + distill + polish)

## Design Health Score

| # | Heuristic | Before | Now | Δ | Key issue |
|---|---|---|---|---|---|
| 1 | Visibility of System Status | 3 | 3 | 0 | Loading shows shell + line; no «last refreshed» timestamp |
| 2 | Match Real World | 1 | **3** | +2 | Faux «единиц» killed; «ближайший: <label> %» honest |
| 3 | User Control & Freedom | 2 | 2 | 0 | Refresh + retry есть; нет invoice download, history, dismiss locked |
| 4 | Consistency & Standards | 2 | **3** | +1 | Eyebrow casing unified lowercase, status pattern unified |
| 5 | Error Prevention | 2 | 2 | 0 | `limit=0` shows «не задан»; still no confirm-sum before pay |
| 6 | Recognition vs Recall | 2 | 2 | 0 | Ledger лучше recognition; даты заставляют считать дни |
| 7 | Flexibility & Efficiency | 1 | 1 | 0 | Тот же gap — no burn rate, daily delta, compare-prior, shortcuts, export |
| 8 | Aesthetic & Minimalist | 1 | **3** | +2 | 3 cards → ledger, Lock icon gone, status pill → dot |
| 9 | Error Recovery | 2 | **3** | +1 | Inline retry в banner; soft-error quiet mono line |
| 10 | Help & Documentation | 1 | 1 | 0 | Zero тултипов, FAQ, upgrade flow link still missing |
| **Total** | | **17/40** | **23/40** | **+6** | **OK band (23-27) — out of Mixed** |

## Anti-Patterns Verdict

**LLM assessment** — visceral slop tells **gone**. The 3 identical hero-cards, multiplied hero-metric template, и faux «60 020 единиц» — все retired. Voice consistent across sections.

Residual mild tells (mostly carryover):
- **02c → автопродление** paragraph (line 532-536) still 4-line с nested parenthetical hedge «обычно в течение нескольких дней до этой даты (как только подключается сохранённый способ оплаты после первой оплаты)» — classic LLM over-explaining
- **payment_locked** section три branch'а (invoice/paid_at/default) построены same `<h3> + <p>` skeleton — не slop yet, но pattern-coded prose, не direct address

**Deterministic scan** — CLI detector still unavailable. Manual scan показал **0 regressions**:
- 0 hex литералов
- 0 linear-gradient
- 0 bg-clip-text
- 0 backdrop-blur
- 0 side-stripe borders
- 0 undefined tokens with fallbacks (new code)
- 0 Tailwind palette leaks
- Same `rgba(0,0,0,0.6)` modal scrim literal (baseline carryover, не addressed — нужен `--cp-scrim` token)

**Visual overlays** — unavailable.

## Overall Impression

**Real, honest move 17/40 → 23/40** — Mixed lower edge → OK band. All 3 baseline P0 killed cleanly, both baseline P1 resolved, P2/P3 swept. Не Good band потому что Flexibility=1 (Maksim не может пейсить) и Help & Docs=1 (нет тултипов) тянут вниз — это honest gaps, не fix-batch artifacts.

The page is now editorially calm и читается как contract sheet, не как dashboard. Cognitive load прыгнул 3/8 → 7/8 PASS.

**Next-tier opportunity (+5 to reach Good)**: distill autopay section density (P1-NEW), resolve payment_locked + ledger дублирующиеся signals (P2-NEW), add burn rate / projected end date для Maksim (closes Flexibility heuristic).

## What's Working

1. **Ledger pattern landed clean** (page.tsx:735-801) — `LimitRow` это exactly editorial-table shape: label + used/limit row 1, hint sublabel, data row (progress | mono % | mono «N осталось»). First row flush, subsequent `border-t` hairline. No card chrome per row, no nested tiles. **Это один change resolved both P0 #1 и P0 #2**.

2. **`stressedLimit` derivation** (page.tsx:201-213) — honest interaction design. Replaces misleading «60 020 единиц» с one-line ответом на Olga's question. Color of pct echoes row color → eye finds matching ledger row instantly.

3. **Error state co-locates retry** (page.tsx:278-300, 303-313) — hard-error banner inline «Повторить» button; soft-error quiet mono line с underlined retry. Two distinct severities, each appropriate. `harden` done с discipline.

## Priority Issues (Post-Fix)

### Baseline P0 / P1 — all resolved
- ✅ P0 #1 Identical card grid → single `neu-card` + LimitRow.map() (line 632-645)
- ✅ P0 #2 Hero-metric template multiplied → no nested 3-tile stat blocks; inline progress + % + remaining
- ✅ P0 #3 «единиц» faux total → deleted; replaced with `stressedLimit` hint (618-626)
- ✅ P1 Status-as-pill → inline dot + colored label (331-342)
- ✅ P1 Anemic loading/error → loading shell + inline retry
- ✅ P2 Lock-card cacophony → Lock icon removed (389-391)
- ✅ P3 Eyebrow case → all lowercase (5 sections)

### New / Remaining

#### [P1-NEW] Autopay section densest part of the page
- **Where**: page.tsx:507-610 — single section имеет CreditCard + heading + 4-line paragraph + 2-row `<dl>` + conditional error tile + conditional 2-button stack
- **Why**: 5+ things visible в одной card; reads dense после airy ledger. 4-line paragraph (525-536) — heaviest text block
- **Fix**: `distill` pass — drop parenthetical clause; move `<dl>` в 2-column inline rows; error tile → banner only when present
- **Command**: `distill`

#### [P2-NEW] Header date «tiles» fight ledger aesthetic
- **Where**: page.tsx:344-375 — two `rounded-md` boxes с `border: 1px solid var(--cp-divider)` визуально micro-cards inside card
- **Why**: Page just earned ledger pattern в section 03; header re-introduces «tile» shape that contradicts. Risk возвращения к identical-card grid pattern на smaller scale
- **Fix**: Render as single hairline-separated row: `период с <date>  ·  оплачен до <date>` editorial run вместо grid
- **Command**: `distill`

#### [P2-NEW] `payment_locked` и ledger оба рендерятся одновременно
- **Where**: page.tsx:384 (locked section) + 613 (ledger)
- **Why**: Baseline question 4 не resolved. Если доступ locked — ledger это «remaining limits you can't use», conflicting signal
- **Fix**: When `payment_locked` либо hide ledger, либо render muted (50% opacity) с caption «лимиты доступны после оплаты»
- **Command**: `shape` (architectural decision needed)

#### [P2-NEW] Modal scrim literal `rgba(0,0,0,0.6)` (carryover)
- **Where**: page.tsx:656
- **Why**: Token discipline gap
- **Fix**: Define `--cp-scrim` in globals.css, use `var(--cp-scrim)`
- **Command**: `polish` (5 minutes)

#### [P3-NEW] `useEffect` initial fetch duplicates `load()` body
- **Where**: page.tsx:179-195 reimplements `load()` body inline
- **Why**: Invites drift между init и refresh
- **Fix**: Initial useEffect → `void load()` 
- **Command**: `polish`

## Cognitive Load Check (7/8 PASS — was 3/8)

| Check | Before | Now | Note |
|---|---|---|---|
| One scan path top→bottom | ✅ | ✅ | Header → status → (locked?) → (autopay?) → ledger |
| One color carries meaning per region | ❌ | **✅** | Each region теперь single color system |
| Numbers mono, body sans | ✅ | ✅ | ds-mono throughout |
| ≤2 weights per region | ✅ | ✅ | semibold + bold + default |
| Hairline dividers | ✅ | ✅ | `border-t` cp-divider; 0 box-shadow |
| Status as dots, not pills | ❌ | **✅** | ds-status-tag removed |
| Editorial numbering | ⚠️ | **✅** | All 5 sections: 01, 02, 02b, 02c, 03 |
| Empty states single CTA | ❌ | ⚠️ | Loading skeleton 0 CTAs (correct), но still mostly text — нет grayed structure shell |

**Progress: 3/8 → 7/8.**

## Persona Red Flags

**Olga (раз/мес, "ok?")** — **massively improved**. `ближайший: Контакты Instantly 36%` answers her question pre-attentively. Ledger format с inline progress + remaining = one-glance scan. Still no «days left in period» (нужно сравнивать `период с` и `оплачен до` mentally).

**Maksim (опытный, pacing)** — **no real change**. Still no burn rate, trajectory, daily delta, compare-prior. `stressedLimit` helps Olga, не Maksim. Открывает калькулятор. Flexibility heuristic stays at 1.

**Sergey (агент админ debugging)** — **no change**. Still no tariff_id, client_id, ISO timestamps, raw paid_until, last refresh. Открывает Postman.

## Minor Observations

- page.tsx:33 — `max_domains`, `max_emails` still in `LimitKey` но absent from `LIMITS` (dead surface unchanged)
- page.tsx:93-104 — `setup` и `inactive` both → amber, 1 bit info lost
- page.tsx:394, 579 — inline `marginTop: '8px'` / `'5px'` magic numbers для dot vertical alignment; нужен `ds-status-dot--baseline` utility
- page.tsx:533 — «обычно в течение нескольких дней до этой даты» единственный hedge phrase; либо «за 1-3 дня до» (specific), либо drop entirely
- page.tsx:736-738 — `isFirst` boolean prop fine, но CSS `:first-child` selector idiomatically чище
- page.tsx:756 — `font-semibold` label + `font-bold` h2 above — region 2 weights, passes rule, но tighter pass = one weight per text role
- page.tsx:632 — `aria-live="polite"` на ledger correct ✓

## Questions to Consider

1. **Autopay section нужно быть card at all?** Densest part of page и only one с 5+ children. Could be horizontal info strip + inline button row, no card chrome
2. **When `payment_locked=true`, should ledger render at all?** Currently fully renders even when access locked — invites user читать numbers они can't act on
3. **`setup` и `inactive` status states — distinct colors/labels?** Collapsing в amber loses info; если разные remediation paths нужны — distinct visuals prevent help-desk tickets
4. **Is «ближайший: <label> <pct>%» right reading?** Одна из cleaner one-line summaries; но «хватит до ~14.06» (calendar projection) could beat «% used» для Maksim — flexibility gap partially closes
5. **Page called «Тариф» но renders usage too — should this be `/client/usage`?** Baseline question 1 still open. Split → calm 3-section contract view + burn-rate tool
