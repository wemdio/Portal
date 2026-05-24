---
target: app/src/app/client/page.tsx
total_score: 24
p0_count: 1
p1_count: 3
timestamp: 2026-05-24T12-05-52Z
slug: app-src-app-client-page-tsx
---
# Critique — `app/src/app/client/page.tsx` (Кампании list)

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules + impeccable absolute bans)
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual scan; CLI detector unavailable)
**Run:** first formal critique for this target.
**Scale:** 473 lines. Landing route /client — second-highest traffic после dashboard.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | `обновлено DD.MM HH:MM` paper-faint top-right; loading state is loud/clear |
| 2 | Match Real World | 3 | Russian copy natural, но `Open %` / `Reply %` английские рядом с `Открытия` / `Ответы` (line 362, 364) — jar |
| 3 | User Control & Freedom | 2 | Нет refresh (только F5), нет filter, sort = единственный control. CTA «Создать кампанию» только в empty state (line 274-279) |
| 4 | Consistency & Standards | 3 | Strong internal: mono numbers, dot column, eyebrow header. EN/RU column labels mix; mobile card vs desktop row — разные hover idioms |
| 5 | Error Prevention | 3 | Sort non-destructive; no destructive actions here. N/A для most |
| 6 | Recognition vs Recall | **2** | Status dots без легенды — user должен запомнить green=active / amber=paused / grey=other. Doc comment line 31-32 для devs only |
| 7 | Flexibility & Efficiency | **1** | Нет keyboard shortcuts, column visibility, search, pagination, bulk select, density toggle. Maksim с 50+ кампаниями hit's brick wall |
| 8 | Aesthetic & Minimalist | **4** | Strongest dimension. Editorial summary line (line 286-299) well-judged. Hairline-only dividers, mono numbers, single eyebrow |
| 9 | Error Recovery | 2 | Error banner (line 242-254) без «Повторить» button. `load()` exists as useCallback но never re-exposed |
| 10 | Help & Documentation | **1** | Zero affordance: нет tooltip на Open%/Reply%, нет legend для dots, нет link на docs/glossary |
| **Total** | | **24/40** | **OK band (23-27)** |

## Anti-Patterns Verdict

**LLM assessment** — **page does NOT read AI slop**. Tells of human craft:
- Single editorial summary line (line 286-299) explicitly replaces 5-MetricCard choice с inline comment naming bans avoided
- Inflection-aware Russian plural (line 297: ответ/ответа/ответов) — AI almost never bothers
- SortIcon с active/inactive opacity на обоих arrows (line 48-55) — boring-but-correct affordance, не showy
- Sort default flips `desc` для numeric, `asc` для name (line 139) — real-product instinct
- Status dot tokens после recent fix (line 36-38) — clean

**One faint slop tell**: artificial 400ms / 20-step count-up animation (line 155-159) + forced 500ms «savor the moment» pause (line 164). 900ms fabricated wait на fast network = theatre-over-truth LLM mistake. Не flips verdict, но noticeable.

**Deterministic scan** — CLI detector unavailable. Manual:
- ✅ 0 hex literals, 0 linear-gradient, 0 bg-clip, 0 backdrop-blur, 0 side-stripes
- ✅ 0 stale tokens (--cp-accent/text/text-m/text-l/text-d)
- ✅ Mechanically clean

**Visual overlays** — unavailable.

## Overall Impression

**24/40 OK band** — genuinely well-crafted aesthetic surface (the editorial summary line is exemplary). Two acute functional gaps (no filter/search at scale, no error retry) + one acute decoding gap (no dot legend) pull score down. Aesthetic 4 is rare; Flexibility 1 + Help 1 carry the cellar.

**Single biggest opportunity**: pill row above table (`Все · Активные · Пауза · Завершённые`) + search input + retry button on error. **+5-7 points за один batch** — closes 3 P1's одновременно, путь от OK 24 в Good high 30-32.

## What's Working

1. **Editorial summary line** (page.tsx:286-299) — replaces 5-card hero-metric grid с одной mono line, holds far more info per pixel, inline Russian plural respects readers. **Single best decision on page.**
2. **Sort header treatment** (line 367-381) — paper-faint → paper-white on active, weight 500→600. Both arrow glyphs visible at 0.25 opacity inactive (line 49, 52). Quiet, complete, no extra chrome.
3. **Loading progress** (line 61-108) — paper-white bar on divider track, no gradients, no spinners. Indeterminate slides; determinate transitions to %. Doctrinally pure.

## Priority Issues

### [P0] No retry on error — page is dead-end
- **Where**: page.tsx:242-254 — error banner без retry
- **Why**: `load` is useCallback already, could be `onClick={() => void load()}`. Sergey debugging client account hits stale token → locked out. Olga sees scary text без recovery path
- **Fix**: Add «Повторить» `ds-btn-ghost` inside alert
- **Command**: `harden`

### [P1] Mixed EN/RU column labels
- **Where**: page.tsx:362 (`Open %`), 364 (`Reply %`) — sit рядом с `Открытия` / `Ответы` two columns earlier
- **Why**: Doctrine break (consistency) + jars after immaculate Russian copy elsewhere
- **Fix**: `% открытий` / `% ответов`, или rename pairs `Открытия / %` и `Ответы / %`
- **Command**: `clarify`

### [P1] No filter/search/pagination для power users
- **Where**: entire desktop table (line 354-466)
- **Why**: Maksim с 50+ кампаниями должен sort by name + visually scan. Нет status filter (active/paused/done), нет name search. **Single biggest functional gap.**
- **Fix**: Inline pill row above table (`Все · Активные · Пауза · Завершённые`) using `neu-pill` + `ds-input` search beside it. Wired в query params (matches /client/replies pattern)
- **Command**: `shape`

### [P1] Dots без легенды — user can't decode
- **Where**: page.tsx:319, 403 — status dots colored, but nowhere does UI explain green/amber/grey
- **Why**: Doc comment (line 31-32) для devs only. Olga sees dot → doesn't know what it means → reassurance ↓
- **Fix**: Tiny inline legend right of summary line: `· активные ●  пауза ●  завершённые ●` в `ds-mono` `--cp-paper-faint`. Или `title=""` tooltips на каждой точке
- **Command**: `clarify`

### [P2] No persistent «Создать кампанию» CTA when list non-empty
- **Where**: CTA only at line 274-279 (empty state only)
- **Why**: Page = landing route; primary action invisible для returning user с N≥1 campaigns
- **Fix**: `ds-btn-secondary` «+ Создать» в header next to `обновлено …` (line 217)
- **Command**: `shape`

### [P2] 900ms fabricated loading theatre
- **Where**: page.tsx:155-159 (20-step count-up over 400ms), 164 (forced 500ms «savor the moment» pause)
- **Why**: Runs even when API returns в 80ms. Maksim returning 30x/day pays 30 × 900ms = 27 seconds/day artificial wait
- **Fix**: Show progress UI только after 300ms grace period; skip savor-pause entirely
- **Command**: `quieter`

## Cognitive Load (7/8 PASS)

| Check | Result | Note |
|---|---|---|
| One scan path | ✅ | Eyebrow → H1 → summary → table top-bottom |
| One color per region | ✅ | Paper/mute/faint, semantic dots only color |
| Numbers mono, body sans | ✅ | ds-mono на каждой numeric cell (416, 425, 434, 444, 453) |
| ≤2 weights per region | ✅ | Regular + semibold (376, 438, 458) |
| Hairline dividers | ✅ | 1px var(--cp-divider) rows (390); 2px progress track (80) |
| Status as dots, not pills | ✅ | ds-status-dot (319, 403) |
| Editorial numbering | ✅ | «01 → Мониторинг» (219-221) |
| Empty/loading/error single CTA | ❌ | Empty has CTA (274), loading none (acceptable), **error НЕТ retry** (242-254) |

## Persona Red Flags

**Olga (1-3 кампаний, wants reassurance)**
- Status dots без значения (319, 403) — видит цветную точку, не знает что значит
- Empty state copy (271-273) — warm, good

**Maksim (50+ кампаний, wants speed + density)**
- **Missing search/filter** (354-466) — должен ctrl-F браузера или scroll. Major red flag
- Row padding `px-5 py-3` (397) — на 50+ rows leisurely; нужен `compact` toggle
- **900ms loading theatre** — feels slow on fast connection
- **No sort persistence** (129-130) — every visit resets к name asc. Он всегда sorts by Reply % → resorts every time

**Sergey (agent admin debugging)**
- **Campaign id not displayed** (11, 308) — row показывает только name; ID живёт в Link href но invisible. Чтобы copy ID должен hover-and-right-click
- **Error state без retry** (242-254) — debugging hits errors a lot. F5 теряет scroll
- **`обновлено` timestamp** (237) — present, но только один for whole list. `analytics_synced_at` per-row exists в типе (line 19) но never displayed — wasted column

## Minor Observations

- `void col;` (page.tsx:46) — prop unused но kept в signature. Просто remove `col` from props
- `idx > 0` row-border conditional (389-390) — clever (no top border first row), но harder to reason than uniform `borderBottom` на каждой row minus last через `:last-child`. Equivalent visual, simpler model
- Mobile pluralization dropped (333-338 shows `отв`, `откр` truncations), desktop summary has full plurals. Mobile gets shorter forms — fine, но `откр` feels jagged. Consider `%` only
- `hasCampaigns` (211) derived но `total` tracked. Если API возвращает `total: 5` но `campaigns: []` due to filter, empty state fires — сейчас impossible но latent fragility
- **OnboardingBanner uses Sparkles в --cp-amber** (OnboardingBanner.tsx:67-68) — **Status-as-Data rule says color reserved для semantic dots**. Amber sparkle для «marketing reassurance» = doctrine drift. Should be --cp-paper или --cp-paper-mute
- Mobile card uses `ds-card-pressable` (310), desktop uses `neu-row` (394) — две hover idioms для same data type. Pick one
- Mono summary line plural (297) handles 1, 2-4, 5+ но not 11-14 exception (11 should use 5+ form). Russian-natural: `11 ответов`, not `11 ответа`

## Questions to Consider

1. If this is THE landing page (second-highest traffic), why is there no way to *do* anything except open one campaign? Where's Maksim's «clone this» affordance? Where's «pause all» для on-call agent?
2. `analytics_synced_at` per-row exists (line 19) но silently discarded — would per-row staleness indicator (`°` next to dot when sync >24h old) catch real client-side problems global timestamp hides?
3. Empty state reassuring but isolated. What does *one-row* state look like для Olga? She has 1 campaign — does single row в 6-col table feel proportionate, или broken? Should N=1 get card variant?
4. Page tops out at «first ~20 rows fit». What happens at N=200? N=500? Is virtualization launch concern или Q3 concern? How do you know?
5. Sort default is `name asc` — но *meaningful* default для returning user scanning portfolio health probably «most recently active» or «by Reply %». Whose mental model does `name asc` actually serve?
