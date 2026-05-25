---
target: app/src/app/client/base-constructor/page.tsx
total_score: 23
p0_count: 1
p1_count: 2
timestamp: 2026-05-25T19-53-00Z
slug: app-src-app-client-base-constructor-page-tsx
---
# Critique — `app/src/app/client/base-constructor/page.tsx` + `BaseConstructorView.tsx`

**Mode:** A (sub-agent design review) + B (manual; CLI detector unavailable)
**Run:** first formal critique
**Scale:** 22-line wrapper + 1768-line shared admin/client component

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility | 3 | Per-step progress strong; no ETA / row-count during run |
| 2 | Match Real World | 3 | RU copy natural, но technical jargon «Дедуп», «Валидация Email», «SMTP-проверка» |
| 3 | User Control & Freedom | 2 | clientMode locks 9 of 11 steps без off-switch; user toggles только `personalization`/`ta_scoring` |
| 4 | Consistency | **1** | **Cross-aesthetic violation P0** — admin Tailwind (bg-white, rounded-2xl shadow-sm, gray-50/60 wash, bg-emerald-50/50 opacity not bridged) внутри editorial-dark scope |
| 5 | Error Prevention | 3 | Auto-detect mapping, autoAdds dependency, column warnings, brief gate — solid logic |
| 6 | Recognition vs Recall | 3 | Step labels + descriptions + icons + cost badges visible. Loses point на radio fieldsets (dense) |
| 7 | Flexibility | 2 | Preset buttons hidden в clientMode; нет save-as-template, reorder, reuse last config |
| 8 | Aesthetic | **1** | Card-on-card (5 white panels stacked на gray-50 wash), 9-cards identical-grid, pill-bouquet (6 colors). Antithetical к editorial dark |
| 9 | Error Recovery | 3 | Failed state с «Попробовать снова», cancel during run, TA-zero copy excellent |
| 10 | Help & Docs | 2 | Inline hints есть; no «Как это работает», нет link на brief guidance |
| **Total** | | **23/40** | **OK band (lower edge)** |

## Anti-Patterns Verdict

**LLM assessment** — **heavily AI-coded с surface-level human polish**:
- 11-step taxonomy + 3 categories + 4 cost tiers + COLUMN_ROLES — over-engineered taxonomies (line 86-149)
- Decorative section banners `═══════════════════════════════════════════` (line 23, 82, 115, 282, 290, 699) — pure AI signature
- Emoji-string lock `'🔒 ' + lockedReason` (line 1010, 1060) used как UI iconography
- Apologetic micro-copy всюду
- 9 disabled/always-on/locked-by-other states stacked на одной card (line 935-1018) — combinatorial state expansion typical AI iteration
- Tabular pluralization inlined `шаг/шага/шагов` (line 1444) вместо shared helper
- Manual placement admin-palette pills (bg-emerald-50 text-emerald-700 border-emerald-200 + 6 других palettes) **в файле что ships в editorial-dark client scope** — author не проверял bridge contract

**Deterministic scan** — CLI detector unavailable. Manual:
- BaseConstructorView uses `bg-white rounded-2xl border-gray-200 shadow-sm` для каждой section card (line 765, 884, 1097, 1150, 1455)
- `bg-gray-50/60` page wash (line 751)
- `bg-emerald-50/50` opacity-modifier (line 945) — NOT bridged
- `text-violet-600` radios (line 1177, 1193, 1220, 1236, 1252, 1395)
- Wrapper page.tsx clean (editorial dark h1 + subtitle)

## Priority Issues

### [P0] Cross-aesthetic admin shell inside editorial-dark client scope
- **Where**: BaseConstructorView.tsx:751-1767 — entire component Tailwind admin
- **Why**: Violates Invisible Accent, Status-as-Data, No-Warm-Tint, Hairline-Not-Shadow. Same-domain inconsistency: client switching between /client/parsers (bridged) и /client/base-constructor (partially bridged) видит разный aesthetic per tool
- **Fix**: Three paths:
  - (a) **clientMode shell branch** — fork render так что `clientMode` returns neu-card / ds-input / ds-btn-primary editorial markup directly (best, ~1 day)
  - (b) Extend bridge с `bg-emerald-50\/50`, `bg-amber-50\/50`, `bg-red-50\/50`, `text-violet-600` (cheap stopgap, ~30 мин)
  - (c) Split file: extract ClientBaseConstructorView что imports admin's data layer но renders editorial
- **Command**: `shape` (a) или `harden` (b)

### [P1] Identical-card-grid для 9-of-11 always-locked steps в clientMode
- **Where**: BaseConstructorView.tsx:912-1027 — 9 of 11 step cards `disabled cursor-default` always-on с identical chrome + Lock icon + «Будет выполнено» pill. Только `ta_scoring` и `personalization` interactive
- **Why**: Violates identical-card-grid warning. User scans 9 identical disabled cards чтобы найти 2 toggleable. Interactive surface buried at bottom
- **Fix**: Collapse always-on steps в editorial summary row («Авточистка + дедуп + поиск email + валидация — выполняется автоматически. Развернуть ↓») + elevate 2 AI step cards как только interactive controls. Reduces 9 cards → 1 summary + 2 actionable
- **Command**: `distill`

### [P1] Submit button no preview of cost / time
- **Where**: BaseConstructorView.tsx:1428-1448 — «Запустить обработку (3 шага)» без estimated time, cost, quota delta
- **Why**: High-stakes action (worker takes минут для 10k rows; AI steps eat quota). User makes blind go/no-go decision
- **Fix**: Replace submit block с mini-summary: «3 шага · ~4 мин · ~120 AI-вызовов · останется 8 400 строк квоты» + button
- **Command**: `clarify`

### [P2] Five stacked white cards on gray wash
- **Where**: BaseConstructorView.tsx:765, 884, 1097, 1150, 1455 — Upload/Steps/Mapping/Settings/Progress каждый `bg-white rounded-2xl shadow-sm border-gray-200` внутри `bg-gray-50/60`
- **Why**: Violates Hairline-Not-Shadow + panel chrome competing с content
- **Fix**: Drop card chrome. Use editorial section pattern: `01 → Загрузка базы` eyebrow + hairline divider + content. Numeric `01 / 02 / 03` (rule #4) заменяет soft `1. / 2.` labels
- **Command**: `layout` + `typeset`

### [P2] Emoji lock string в production UI
- **Where**: BaseConstructorView.tsx:1010, 1060 — `🔒 {lockedReason}` Unicode emoji
- **Why**: Inconsistent (everywhere else Lucide Lock), renders differently per OS/font, violates Sharp-Type
- **Fix**: Replace `<Lock className="w-3 h-3"/>` как :990 already does
- **Command**: `polish`

## Cognitive Load (4/8 PASS)

✅ Hierarchy clear, ✅ icon-to-text ratio, ✅ empty/error states, ✅ no modals
❌ Single scannable spine — 5 competing card surfaces
❌ Numerical anchor not template-y — editorial `01/02/03` replaced с tiny `1./2./3./4.`
❌ Action density appropriate — 9 step cards + 2 preset buttons + brief tabs + 2 radio fieldsets + submit = 17+ controls
❌ Color carries meaning — emerald/amber/blue/violet/sky/red used decoratively

**High cognitive load page.**

## Persona Red Flags

**Olga (новичок, грузит файл первый раз)** — **RED**:
- Видит 9 emerald-bordered locked cards «Будет выполнено» → interprets как «system делает stuff I don't understand» + can't tell которые 2 cards её choice
- Нет estimate перед submit — клик «Запустить», stares at progress bar, wonders если broke
- Brief gate (line 988-1001) «Сначала заполните бриф» — leaves, returns, has to re-upload file (`fileData` lives только в React state, no draft persistence)

**Maksim (опытный)** — **YELLOW**:
- Loses preset buttons в clientMode (line 887)
- Can't favorite step config
- History (line 1713-1764) показывает past jobs но нет «повторить этот» action

**Sergey (debugging client's failed run)** — **RED** для one specific case:
- При `total_rows === 0` + `ta_scoring_filtered_out > 0` пользователь видит helpful copy (line 1635-1641), но Sergey debugging from history has no access к underlying AI scores. `keepAllScored` checkbox (line 1392-1402) помогает но buried в brief settings

## Minor Observations

- File-input `e.target.value = ''` reset (line 803, 566) — pattern duplicated, could be shared `<FileInput>`
- Pluralization helper inlined (line 1444) — extract в shared util
- Auto-correct effects (line 734-743) rely на `findEmailsTarget !== 'separate'` — fragile
- `process.env.NEXT_PUBLIC_BRIEF_STORAGE_BUCKET ?? 'briefs'` (line 549) read inside component body на каждый render — hoist
- History row `cursor: pointer` (line 1722) но нет keyboard activation — a11y miss
- `w-4.5 h-4.5` (line 956) non-standard Tailwind size
- `«Открыть в базах»` button (line 1657-1664) correctly hidden in clientMode, но flex row 3→2 без re-align

## Questions to Consider

1. **clientMode contract**: если 9 of 11 steps always locked, нужен ли step picker UI вообще? Could clientMode show «files will be cleaned and emails found» + single «Расширенные настройки» disclosure для 2 toggles?
2. **Bridge vs fork**: /client/parsers-style bridge — long-term answer для shared admin tools, или every tool growed ClientView editorial twin? At what tool-count does bridge break?
3. **Cost surfacing**: should client see estimated AI cost в рублях перед submit, или только consumed-quota delta?
4. **History recovery**: should clicking failed/cancelled job в history re-populate form (file + steps + brief) так user can edit and retry без re-uploading?
5. **Always-on emerald в clientMode**: bright-green «Будет выполнено» wash intentional accent для «free to you», или accidental admin-palette leak? If accent — violates Status-as-Data
