---
target: app/src/app/client/campaigns/[id]/page.tsx
total_score: 22
p0_count: 1
p1_count: 3
timestamp: 2026-05-24T12-46-47Z
slug: app-src-app-client-campaigns-id-page-tsx
---
# Critique — `app/src/app/client/campaigns/[id]/page.tsx` (campaign detail)

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules + impeccable absolute bans)
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual scan; CLI detector unavailable)
**Run:** first formal critique for this target.
**Scale:** 876 lines.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Spinner + actionError shown; нет last-synced timestamp, нет «obtaining from Instantly» hint |
| 2 | Match Real World | 3 | «Цепочка / Обзор / Ответы» tabs clear; «Bounce» stays English (line 767) — Russian page violation |
| 3 | User Control & Freedom | 2 | Нет Resume from Overview когда paused mid-tab; no archive/clone; expanded reply нет keyboard close |
| 4 | Consistency & Standards | 3 | Tokens used throughout; minor: `var(--cp-text-l)` (line 470, 472) **undefined token** в этом CSS scope |
| 5 | Error Prevention | 2 | Pause/Resume fires immediately без confirm — irreversible mid-send risk; reply send без recipient preview |
| 6 | Recognition vs Recall | 2 | **6 metric tiles** force user читать labels; sequence tab strips waitDays formatting («5д» without «ждать»); no campaign-status label near header |
| 7 | Flexibility & Efficiency | 2 | No keyboard shortcuts, no jump-to-step from Overview table to Steps tab, no permalink to specific reply |
| 8 | Aesthetic & Minimalist | 2 | **Stat-card grid violates minimalism**; tab counter (N) is good (line 750-754) |
| 9 | Error Recovery | 2 | Errors shown as red-dot lines, **no retry button** в любом error block (lines 656-660, 733-738, 440-445, 117-122) |
| 10 | Help & Documentation | **1** | Zero contextual hints. New user lands на 6 numbers без «что это значит» |
| **Total** | | **22/40** | **Mixed (lower edge) — early-craft holdover** |

## Anti-Patterns Verdict

**LLM assessment** — **borderline**, leans clean но has two telltale moves:
- **MetricCard 6-tile grid** (line 761-768) — `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` of visually identical cards «Отправлено / Открытия / Ответы / Контактов / Лидов / Bounce». **Classic stat-card-soup pattern** = SaaS template. MetricCard (line 12-32) literally renders `label / big-mono-number / small-mono-sub` = hero-metric template shrunken и tiled. Six of them giveaway
- **actionPending button-state busywork** (line 700-729) — Pause/Resume conditional with internal spinner swap = boilerplate Claude generates verbatim

**Good news**: no gradients, no glassmorphism, no em-dashes, no side-stripes, status reserved to dots. Russian copy human («Загружаем тред…», «По вашему запросу ответов не найдено»).

**Deterministic scan** — CLI detector unavailable. Manual:
- ✅ 0 hex literals, 0 linear-gradient, 0 bg-clip, 0 backdrop-blur, 0 side-stripes
- ⚠️ **Line 457**: `rgba(180, 173, 164, 0.15)` — warm-stone tan literal, leftover from pre-cascade theme
- ⚠️ **Lines 470, 472**: `var(--cp-text-l)` — **undefined token** in .client-portal scope (silent visual bug — renders fallback)
- Both surfaced by Assessment A in minor obs + P2 — aligned

## Overall Impression

**22/40 Mixed (lower edge)** — самый низкий score после tariff baseline 17. Early-craft holdover: page стоит на correct token foundation, но structural patterns — pure warm-stone era. The 6-tile MetricCard grid IS the absolute-ban hero-metric template, multiplied — classic SaaS detail-page cliché. Plus 2 stale token bugs.

**Single biggest opportunity**: replace 6-tile grid с editorial ledger («Кампания отправила 12 400 писем, открыли 47%, ответили 12%» — one editorial sentence + quiet supporting ledger). **+4-6 points за shape pass**, путь от Mixed 22 до Good 28+.

## What's Working

1. **Steps-as-table over Steps-as-cards** (line 770-800) — correctly avoids identical-card-grid для per-step stats; mono right-aligned numbers, eyebrow column heads. **Editorial-correct choice показывает real design thinking**.

2. **Sequence tab editorial numbering** (line 832-839) — `01 → subject` с arrow eyebrow exactly doctrine; waitDays as quiet `5д` (line 854) doesn't shout.

3. **Reply tab counter** (line 750-754) — `Ответы (12)` с mono paren-count = micro-win; doesn't double up as separate badge.

## Priority Issues

### [P0] Hero-metric template multiplied — 6-tile MetricCard grid (ABSOLUTE BAN)
- **Where**: page.tsx:761-768 (grid), 12-32 (MetricCard component)
- **Why**: 6 visually identical tiles в 2×3/3×2/1×6 grid = «MetricCard × N» SaaS template. MetricCard literally renders `label / big-mono-number / small-mono-sub` = hero-metric shrunken и tiled. Olga lands here, sees wall of numbers без hierarchy. Which one matters?
- **Fix**: Collapse to editorial ledger row — one prominent stat (Open rate или Reply rate as editorial focus, mono number inline в sentence), plus rest as compact key-value list. Или: one wide hairline-divided strip `Sent · Opened (47.2%) · Replied (12.1%) · Bounced` как single readable line. Drop MetricCard entirely
- **Command**: `distill` → `shape`

### [P1] No status semantics в header eyebrow
- **Where**: page.tsx:687-691 — `abc12345 · Активна` плоский text в eyebrow
- **Why**: Olga не может quickly tell paused-vs-active без чтения; Maksim debugging deliverability не видит «Paused 3h ago» at-a-glance. No status dot
- **Fix**: Add `ds-status-dot` colored by status (green=active, amber=paused, red=error) inline с title, plus relative-time «paused 3 hours ago» / «running since 12 May» в mono
- **Command**: `clarify` + `typeset`

### [P1] «Bounce» English label на Russian page
- **Where**: page.tsx:767 — single English word среди Russian column labels
- **Why**: Inconsistent с localization elsewhere («Отправлено», «Открытия», «Ответы»). Untrained Olga: «что такое Bounce?»
- **Fix**: «Отказы» или «Недоставлено» + `?` tooltip explaining (письма не дошли — некорректный адрес/спам-фильтр)
- **Command**: `clarify`

### [P1] Pause/Resume fires без confirmation
- **Where**: page.tsx:701-729 — instant action, no confirm step
- **Why**: Mid-send campaign paused by accident = small disaster, no undo. Sergey verifying client metric could nuke wrong campaign
- **Fix**: Two-step button: click → «Подтвердить пауза» inline (5s expiry), **not modal**. Add toast on success showing «5 820 писем в очереди → ждут возобновления»
- **Command**: `harden`

### [P2] Errors offer no recovery (4 places)
- **Where**: page.tsx:656-660, 440-445, 733-738, 117-122
- **Why**: All four error blocks read-only red dots. No retry button. Maksim debugging stuck
- **Fix**: Add ghost «Повторить» button to each error block calling same loader
- **Command**: `harden`

### [P2] `var(--cp-text-l)` undefined token
- **Where**: page.tsx:470, 472 — на chevron icons в expand/collapse
- **Why**: Token не defined в `.client-portal` scope (only --cp-paper/paper-mute/paper-faint). Likely renders fallback `currentColor` или browser default — silent visual bug. Confirmed by Assessment B manual scan
- **Fix**: Replace с `var(--cp-paper-mute)`
- **Command**: `polish`

### [P3] Default tab `overview` без URL sync
- **Where**: page.tsx:549 — useState инициализация
- **Why**: Maksim deep-linking «Ответы» для teammate не может. Browser back doesn't restore tab
- **Fix**: Use `?tab=replies` searchParam
- **Command**: `harden`

## Cognitive Load (4/8 PASS, 2 partial, 2 fail)

| Check | Result | Note |
|---|---|---|
| One scan path top→bottom | ⚠️ PARTIAL | Header → action → tabs → grid OK, но 2×3 → 3×2 → 4-col grid creates horizontal scan что competes |
| One color per region | ✅ | Paper-white dominant, status dots only для amber/red |
| Numbers mono, body sans | ✅ | (line 17, 24, 788-793, 836, 853) |
| ≤2 weights per region | ✅ | Regular + semibold only |
| Hairline dividers | ✅ | 1px var(--cp-divider) везде |
| Status as dots, not pills | ⚠️ PARTIAL | Dot для errors (good), но NEW reply uses ds-status-tag с text «NEW» (lines 479-483) = tag/pill hybrid |
| Editorial numbering | ❌ FAIL | PASS в Steps tab (832 `01 → ...`); FAIL на stat-card grid (no numbering) |
| Empty/loading/error single CTA | ❌ FAIL | Error blocks (656-660, 440-445) no CTA; empty replies (447-454) no CTA |

## Persona Red Flags

**Olga (новичок, first campaign view)** — lands на 6 identical mini-tiles. No «что сейчас происходит» sentence. Header eyebrow says raw status text she may not have memorized. No onboarding «вот так читается эта страница». Likely to ask support what each tile means.

**Maksim (опытный, debugging open-rate drop)** — can see per-step table (good), но cannot sort, compare to previous week, no sparkline per step, no last-sent timestamp на step row. Has to mentally diff `unique_opened` vs `opened` columns — actually table только shows one of them (line 792 `s.unique_opened ?? s.opened`) — нельзя see both at once.

**Sergey (агент админ verifying reported metric)** — Reply count tab badge (750-754) helps cross-check client claim quickly. Но: no «exported CSV / API timestamp» stamp showing когда analytics last synced from Instantly. Если client says «my open rate is 30%, dashboard shows 18%» — нет way знать staleness issue.

## Minor Observations

- page.tsx:739 — `<div className="mb-4 sm:mb-6" />` — empty div as spacer. Use margin on next element
- page.tsx:686 & 692 — `header.mb-1` then immediate flex inside — mb-1 dead because inner flex provides own spacing
- page.tsx:457 — hardcoded `rgba(180,173,164,0.15)` — warm-stone leftover; use `var(--cp-divider)`
- page.tsx:442 & similar — `marginTop: '5px'` inline-style hack для vertical center 6px dot. Should be `align-items: center` или true baseline-aligned dot utility
- page.tsx:458-515 — Reply row toggle button is whole-row width — but ExpandedThread renders OUTSIDE button (506-512) at pl-7, clicking expanded body doesn't collapse (только chevron). Inconsistent
- page.tsx:826 — Empty-state «Цепочка не настроена» без CTA to set one up. Dead-end
- page.tsx:670 — `bouncedCount` computed but never displayed с percentage context (just raw number в 6-tile)
- page.tsx:671-672 — `openRate` и `replyRate` mono-numeric strings в MetricCard.sub (763, 764) — но sub slot tiny and faint. **Most actionable percentage on page is whispered**
- page.tsx:421-429 — Search input на Replies has good shape, но no «Enter to search» hint и no recent-searches memory
- page.tsx:199, 491 — `formatReplyDate` returns «24 мая, 14:32» — но `toLocaleDateString` с hour/minute options quirky. Should be `toLocaleString`

## Questions to Consider

1. **Should 6-tile grid become editorial «this campaign in one line» sentence at top** («Кампания отправила 12 400 писем, открыли 47%, ответили 12%») с rest as quiet ledger below? Hero-metric-grid = single biggest violation
2. **Should Overview tab merge с Steps**? Per-step table is page's strongest signal; pushing it below metric-tile-soup buries it. Editorial detail page would lead с table
3. **Is Replies tab pulling its weight, or duplicates /client/replies**? If duplicate, this tab should be «X новых ответов → открыть в /client/replies?campaign=...» callout, not full mini-Replies app rebuilt inline
4. **Where's campaign metadata** — created date, owner, leads list count, sending schedule (M-F 09:00-17:00 МСК), step interval? None on page. Maksim debugging delivery has to leave view
5. **Should Pause/Resume show consequences before firing** — «Сейчас в очереди 5 820 писем; после паузы они зависнут до возобновления»? Currently one-click destructive without preview
