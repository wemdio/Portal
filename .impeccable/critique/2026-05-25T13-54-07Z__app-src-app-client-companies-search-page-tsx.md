---
target: app/src/app/client/companies-search/page.tsx
total_score: 15
p0_count: 2
p1_count: 2
timestamp: 2026-05-25T13-54-07Z
slug: app-src-app-client-companies-search-page-tsx
---
# Critique — `app/src/app/client/companies-search/page.tsx`

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules + impeccable absolute bans)
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual scan; CLI detector unavailable)
**Run:** first formal critique для этого target
**Scale:** 925 lines, плюс зависимости в shared components/

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Calc button показывает «Считаем…» но нет skeleton/progress на result block; export показывает «Формируем…» только на clicked card |
| 2 | Match Real World | 3 | RU copy natural, но «ОКВЭД» / «ЭДО» / «ЕГАИС» / «ИП» — zero gloss (line 466, 475) |
| 3 | User Control & Freedom | **1** | Нет reset/clear-all-filters, нет save-as-preset, нет recall last search, нет URL state — close tab = lose 12 filter selections |
| 4 | Consistency & Standards | **1** | Cross-aesthetic OkvedTreeModal (bg-white + blue checkboxes); Switch primitive blue iOS pills × 7; два разных «from/to» range layouts |
| 5 | Error Prevention | 2 | INN parser silently drops invalid via regex (line 87) — 3 typos из 50 INN'ов нет feedback; нет max sanity check |
| 6 | Recognition vs Recall | 2 | Selected regions/OKVEDs collapse в «выбрано: 17» — для recall reopen модалки. Нет chip strip с actual choices |
| 7 | Flexibility & Efficiency | **1** | Нет keyboard shortcut «calculate», нет saved searches, нет template presets, нет clone-from-last |
| 8 | Aesthetic & Minimalist | 2 | Page restrained, но Switch + OkvedTreeModal break; export-cards block decorative weight (could be 2 ghost buttons) |
| 9 | Error Recovery | **1** | Errors render как red-dot + raw string (line 594-603, 693-702) — нет retry, нет «edit filters and try again» affordance |
| 10 | Help & Documentation | **0** | Zero help. ЭДО/ЕГАИС/ОКВЭД/ИП assumed knowledge; «стоимость организации, руб.» (line 518) ambiguous и unexplained |
| **Total** | | **15/40** | **Bad band (0-15) — borderline Mixed lower** |

**Самый низкий score в сессии.** Honest read: migration looks complete from distance, но modal + switch + missing affordances drag hard.

## Anti-Patterns Verdict

**LLM assessment** — **partial AI-slop с outright cross-aesthetic collision**:

- **P0 #1 — OkvedTreeModal entirely different design system** (`OkvedTreeModal.tsx:262-300`):
  - `bg-black/40 backdrop-blur-sm` scrim (line 263)
  - `bg-white rounded-2xl shadow-2xl` modal (line 264)
  - `accent-blue-600` on checkboxes (line 107, 178)
  - `focus:ring-blue-500/20 focus:border-blue-400` (line 289)
  - `border-gray-200 bg-white text-gray-700` buttons (line 324)
  - **Classic «AI batch-migrated parent file, left child alone» signature**
- **P0 #2 — Switch primitive imports wrong design system** (`Switch.tsx`):
  - `bg-blue-600` when checked, `bg-gray-200` when unchecked
  - `focus:ring-blue-600 focus:ring-offset-2`
  - `text-gray-700` default text
  - **Used 7 times** на странице (page.tsx:375, 384, 452, 461, 470, 559) — blue iOS pills везде
- **Two of three sections wrapped в identical `.neu-card p-5 sm:p-6`** (line 223, 364, 554) — checklist «section = card» rather than composition decision
- **Two top «selector» buttons** (Regions, ОКВЭД at line 250-294, 296-341) + **two export cards** (XLSX, CSV at line 637-691) — picture-frame layouts repeated twice within one page

**Deterministic scan** — CLI detector unavailable. Manual:
- ⚠️ Confirmed: OkvedTreeModal uses `bg-black/40 backdrop-blur-sm` (line 263), `bg-white rounded-2xl shadow-2xl` (264), `accent-blue-600` (107, 178), `focus:ring-blue-500/20` (289)
- ⚠️ Confirmed: Switch uses `bg-blue-600 / bg-gray-200`, `focus:ring-blue-600`, `text-gray-700`
- ⚠️ Bridge layer в `.client-portal` теоретически catches `bg-blue/bg-white/text-gray-*`, но `accent-blue-600` (native checkbox accent) bridge не покрывает — поэтому checkboxes остаются blue
- ✅ page.tsx сам по себе нет hex literals, gradients, side-stripes, ban-violations

## Overall Impression

**15/40 Bad band** — это самая weak page из критикованных. Парадокс: page wrapper looks editorial dark от первого взгляда (eyebrows, ds-eyebrow, neu-card, ds-nav-item tabs), но внутри **два shared admin компонента** (OkvedTreeModal, Switch) breaking aesthetic decisively + структурные missing affordances (no save, no clear, no presets, no URL state) для conversion-impact tool.

**Single biggest opportunity**: port OkvedTreeModal + Switch внутрь editorial dark = closes both P0 immediately. Это **+8-12 points за один architectural batch** — путь из Bad 15 в OK 25-27.

После того — URL state + saved searches + chip strip = ещё +5-7 в Good band.

## What's Working

1. **Clean editorial header** (page.tsx:202-220) — eyebrow + Building2 icon + tight subtitle, no hero-metric template. Restraint.
2. **Mode toggle as ds-nav-item** (page.tsx:225-241) — uses established tab pattern instead of inventing pill-switcher. Doctrine-correct.
3. **Smart compact summaries inside selector buttons** (page.tsx:275-281, 320-327) — «выбрано: 17 (5 групп)» с reduce-to-top-codes math — useful information density, mono, paper-faint. Separates competent от formulaic.

## Priority Issues

### [P0] OkvedTreeModal — different design system entirely
- **Where**: `OkvedTreeModal.tsx:262-300` (через весь file)
- **Why**: Click «Виды деятельности» → white, rounded-2xl, blue-checkbox, backdrop-blurred modal launches над editorial-dark page. Absolute-ban «two-aesthetics» failure + exact «AI made this» smoking gun
- **Fix**: Port OkvedTreeModal к chrome RegionsModal (page.tsx:780-923):
  - `var(--cp-surface-elev)` background
  - `var(--cp-divider-strong)` border
  - `var(--cp-scrim)` scrim
  - `ds-input` для search
  - `ds-mono` для codes
  - `ds-btn-primary/secondary` для footer
  - `accent-color: var(--cp-paper)` для native checkboxes
- **Command**: `harden` (cross-aesthetic violation, blocks visual coherence)

### [P0] Switch primitive imports wrong design system
- **Where**: `Switch.tsx:29-37` used at page.tsx:375, 384, 452, 461, 470, 559 (7 times)
- **Why**: Seven blue iOS pills на dark page. Status-as-Data fails: blue не semantic, это chrome. «Invisible Accent» (paper-white IS accent) contradicted на каждой form interaction
- **Fix**: Two options:
  - (a) Repaint Switch с `--cp-paper` track + `--cp-surface-rest` off-state + hairline border (preserve API)
  - (b) Replace switches с editorial checkboxes (`accent-color: var(--cp-paper)`) — toggles на parser форме overkill, это filter inclusion flags не on/off device settings
- **Command**: `quieter` then `harden`

### [P1] No saved searches / clone / URL state / reset
- **Where**: page.tsx:41-79 (state) + 200-220 (header area)
- **Why**: Maksim builds base, gets 12 400 results, exports, comes back tomorrow → 12 filter selections gone. Нет «last query», нет «повторить», нет preset library. Page brief explicitly calls this out
- **Fix**:
  - (a) Persist filter state to localStorage on every change; restore on mount с «Восстановлено из последнего поиска» eyebrow hint + «Очистить» ghost button
  - (b) Header-right «недавние запросы» ghost button revealing 3-5 last calculations (date + count + 1-line summary)
  - (c) «Очистить фильтры» link near calculate button
- **Command**: `shape`

### [P1] Selected regions/OKVEDs opaque after modal closes
- **Where**: page.tsx:275-281, 320-327
- **Why**: «выбрано: 17» gives count not content. Для recall reopen modal — high cost when iterating. Recognition vs Recall fail
- **Fix**: Под каждой selector button render chip strip с first 4-6 selected items (region names / OKVED codes) + «ещё 11» overflow, each chip clickable to deselect inline. Hairline border, paper-faint text
- **Command**: `clarify`

### [P2] Two range-input layouts inside one section
- **Where**: page.tsx:414-446 (employees 2-col grid) vs 486-513, 520-548 (revenue/cost single flex row)
- **Why**: Same semantic («range from X to Y») expressed two ways within Section 02. Inconsistency
- **Fix**: Pick one. Single-row flex denser, reads as range. Apply to employees. Bonus: unit suffix («млн ₽» toggle so users aren't typing 10000000)
- **Command**: `typeset`

### [P2] Action zone lacks hierarchy / result block reads decorative
- **Where**: page.tsx:582-705
- **Why**: Centered button + centered result + centered card-with-two-cards. XLSX/CSV picker (line 632-704) — 2-card mini-grid (identical-card pattern again) для binary choice
- **Fix**: Inline export как два ghost buttons next to «Найдено компаний: 12 400» — «↓ XLSX» / «↓ CSV». Strip picker card entirely. Result = single sentence with two actions, not section
- **Command**: `distill`

## Cognitive Load Check (5/8 PASS)

✅ Scan path, ✅ mono numbers, ✅ ≤2 weights, ✅ hairline dividers, ✅ editorial numbering
❌ One color per region — blue switches + red errors + paper-white = 3 colors per section
❌ Status as dots — blue Switch de facto status color half страницы (technically PASS for inline errors но de facto FAIL)
❌ Empty/loading/error single CTA — error states нет CTA вообще (594-603); loading state no skeleton; нет empty-filter state

## Persona Red Flags

**Olga (новичок)** — sees ОКВЭД / ЭДО / ЕГАИС / ИП без tooltips или info icons (line 318, 466, 475, 557). «Стоимость организации, руб.» (line 518) — нет mental model what to type. Whole page assumes Sergey-level domain literacy.

**Maksim (опытный)** — builds same «e-commerce in MSK, 50-500 employees, with email» base each Monday. Page offers **zero** memory — no saved presets, no URL share, no recall. Каждый понедельник = 90 seconds re-clicking through 138-region modal. Hack around с browser bookmark и resent the tool.

**Sergey (агент админ)** — client says «парсер вернул мусор». No way to see what filters client actually used, no last-query log, no run history. Ask client screenshot их filters или rebuild from memory. Page debug-hostile.

## Minor Observations

- page.tsx:280 — `t(\`выбрано: ${selectedRegionsCount}\`, ...)` interpolation inside `t` first arg — Russian copy lives в JS string, won't be translation-cached
- page.tsx:357 — placeholder uses `&#10;` для newlines — hand-stuffed JSX tell
- page.tsx:599, 698 — error dot has `marginTop: '7px'` magic number for baseline align
- page.tsx:201 — `max-w-6xl` (1152px) wide для form-only page; results table will need but form alone sparse on 1440 monitor
- page.tsx:188 — export filename `companies_2026-05-25.csv` doesn't encode filter context. Sergey downloads 3 exports/day, can't tell apart
- page.tsx:213-219 — subtitle promises «Экспорт в CSV/XLSX» upfront, before user has done anything. Information without action
- page.tsx:613 vs 621 — `Math.max(0, calcResult.remaining - calcResult.count)` silently clamps quota overflow к 0 without warning. Surface as amber dot + message
- page.tsx:559 — Section 03 has one toggle plus help paragraph. Не «section». Fold into Section 02 as one more switch
- RegionsModal footer (page.tsx:888-921) — three primary-weight actions: Clear / All / Done. «All» and «Clear» should be ghost, only «Done» primary

## Questions to Consider

1. **Where do results actually display?** Page filter-only — clicking «Собрать базу» returns count + offers export, never previews single row. Intentional (download-only flow) или results table on separate route? If latter, page contract should hint at it («Превью первых 20 →»)
2. **Why is OKVED tree separate component but RegionsModal inline в page.tsx?** Both filter-tree-pickers. Either both primitives в /components/, or both inline. Current split = reason OKVED was missed in migration
3. **Has anyone modeled «first 30 seconds» для Olga?** Brand-new client doesn't know what ОКВЭД is. 1-minute onboarding tooltip on first visit would lower cliff
4. **Should calculate step disappear once filters valid?** «Сначала посчитать, потом скачать» = two clicks for what could be one («Скачать (≈12 400 компаний)»)
5. **What's contract with tariff?** `calcResult.remaining` rendered as raw text — but if user about to bust quota, this page should warn BEFORE calculate, not after, link к tariff page. Currently passive footnote
