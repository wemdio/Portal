---
target: app/src/app/client/launch/page.tsx
total_score: 21
p0_count: 2
p1_count: 3
timestamp: 2026-05-24T06-29-13Z
slug: app-src-app-client-launch-page-tsx
---
# Critique — `app/src/app/client/launch/page.tsx`

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules + impeccable absolute bans)
**Mode:** Assessment A (sub-agent design review) + Assessment B (manual anti-pattern scan; CLI detector unavailable)
**Run:** first formal critique for this target.
**Scale:** 1 721 lines — самая большая страница в /client.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Conditional sections появляются one-by-one, нет progress signal, нет «step 3 of 6», нет completion check |
| 2 | Match Real World | 3 | Russian copy sharp; «Первое письмо / Письмо 2» beats «Step 1»; «через N дн.» human. A/B/C «Вариант» tabs not framed as experiment |
| 3 | User Control & Freedom | **1** | **No save-draft, no leave-confirm, no restore on refresh.** Olga 40 минут draftит → misclick → потеряла всё |
| 4 | Consistency & Standards | 3 | Strong внутри page.tsx; drops до 2 для EmailBodyField modal (stale tokens, warm-stone classes) |
| 5 | Error Prevention | **1** | All validation post-submit и serialized (handleLaunch:397-442); no «about to email 12k people» confirm перед irreversible API call |
| 6 | Recognition vs Recall | 3 | VariableReference chips (1272-1337) и per-mapping CopyVariableBadge (1134-1155) — strongest pattern. Client никогда не recall'ит `{{first_name}}` |
| 7 | Flexibility & Efficiency | **1** | No template/clone-last-campaign для Maksim. No keyboard shortcut. Adding step всегда `wait_days: 3` |
| 8 | Aesthetic & Minimalist | 3 | Generally restrained. Loses half-point за chubby Step-1 dropzone (`p-8 sm:p-10` line 634) |
| 9 | Error Recovery | 2 | Network failure surfaces raw err.message (471); no retry button; no mid-launch progress |
| 10 | Help & Documentation | 2 | Brief-tip (824-852) хорош; subtitles на каждой Section хорошие. Но нет «что такое wait_days», нет docs link, нет template для first-timer |
| **Total** | | **21/40** | **Mixed (lower half)** |

## Anti-Patterns Verdict

**LLM assessment** — **page.tsx сам по себе НЕ slop**. Editorial numbering on каждой Section (1062-1088), STATUS_DOT semantic dictionary с настоящим комментом (115-124), reusable LaunchHeader (131-147), mapping row pairs select с one-click `{{variable}}` copy chip (1110-1130) — product thinking, не template thinking.

**Slop tell в `EmailBodyField.tsx:98-145`** — link-insert modal использует:
- **Stale tokens** `--cp-accent` (92), `--cp-text` (107), `--cp-text-m` (110, 130) — warm-stone era имена которые редизайн переименовал в `--cp-paper*`
- **Legacy classes** `neu-input` (123), `neu-pill` (129), `neu-btn` (138) — token-remapped к editorial flat, но naming/pattern остался warm-stone
- **bg-black/40 scrim** вместо `var(--cp-scrim)` который мы только что определили

Не AI — это компонент который пропустили в каскадном sweep'е. Senior увидит и спросит «почему эта часть отличается».

**Secondary milder tell**: wizard header (608-622) дублирует body of LaunchHeader inline (потому что нужен sibling `PresetBadge`) вместо взять `right` slot. Small but visible «wrote helper, then forgot to wire it» smell.

**Deterministic scan** — CLI detector unavailable. Manual scan:
- `page.tsx` сам: **0 hex literals, 0 linear-gradient, 0 bg-clip, 0 backdrop-blur, 0 side-stripe borders, 0 stale tokens** — mechanically чистый ✅
- `EmailBodyField.tsx`: 4 stale token references + 3 legacy class usages confirmed (file:line above)

**Visual overlays** — unavailable.

## Overall Impression

**21/40 Mixed lower half** — strong editorial bones, но три серьёзных гэпа: (1) off-doctrine modal в conversion-critical EmailBodyField (P0), (2) no save state (P0 архитектурный) ставит first-launch revenue под риск, (3) sequential post-submit validation бьёт первый раз тех кто только пробует продукт.

**Парадокс**: страница crafted thoughtfully (eyebrows, status dots, copy variable chips) но classic wizard antipatterns (no save, no progress, no confirm перед irreversible action, no clone) тянут вниз. Можно поднять до Good band (28-35) одним структурным batch'ем.

## What's Working

1. **Editorial Section component** (page.tsx:1051-1092) — Numbered «01 →» eyebrow, hairline border, surface-elev header band. Single, reusable, on-doctrine.

2. **VariableReference chips с sample previews** (1272-1337, 1339-1371) — Click to copy `{{first_name}}`, see «Иван» as sample inline. «Delight without ornament». Fallback-empty state (1287-1304) routes back to Step 2 instead of «nothing here».

3. **Custom-subject-on-follow-up warning** (1686-1697) — Inline amber dot + plain-English «why custom subject is destructive». UX-aware author at work; most builders let users break threads silently.

## Priority Issues

### [P0] Modal as first thought + off-doctrine в conversion path
- **Where**: `app/src/components/client/EmailBodyField.tsx:98-145` — «Вставить ссылку» открывает full-screen overlay с одним text input
- **Why**: (a) absolute-ban violation (modal as first thought), (b) stale tokens `--cp-accent` (92), `--cp-text` (107), `--cp-text-m` (110, 130) + legacy classes `neu-input` (123), `neu-pill` (129), `neu-btn` (138) — visibly off-style, (c) прерывает writer flow для one-field action
- **Fix**: Replace modal с inline expanding row под textarea. Render link input + Insert button как hairline-bordered row animating in on click, collapsing on insert. Kill scrim + stale tokens; use `var(--cp-paper)`, `var(--cp-paper-mute)`, `ds-input`, `ds-btn-primary`, `ds-btn-secondary`
- **Command**: `shape` then `craft`

### [P0] No progress / no save / no resume — Olga теряет 40 минут
- **Where**: page.tsx:149-484 — wizard has zero state persistence
- **Why**: First-launch это highest-stakes session клиента в продукте. Misclick на nav, refresh, closed tab — wipe ~30-60 минут typing включая email cadence. Это single failure mode который может cost весь account
- **Fix**: Persist `{campaignName, sequenceSteps, mapping, customVars, schedule, behavior}` в `localStorage` on every change (debounced), restore on mount, show «черновик · сохранено» mono microcopy под header. Add `beforeunload` guard при dirty draft
- **Command**: `harden`

### [P1] Validation post-submit, sequential, modal-feeling
- **Where**: `handleLaunch:397-442` — walks через 8 possible error conditions, sets one error at a time
- **Why**: First-launch friction = lost first campaign = lost first revenue. Olga не знает сколько проблем, каждая ошибка feels like last one
- **Fix**: Inline validation per Section (red dot in section header when invalid) + single pre-flight summary над launch button: «Готово к запуску» или «3 проблемы перед запуском» с clickable list. Keep post-submit guard but make it almost never fire
- **Command**: `clarify`

### [P1] No pre-launch confirmation для irreversible action
- **Where**: «Запустить кампанию» (948-959) fires immediately on click — no «about to email N people» beat
- **Why**: Instantly начнёт sending в момент return success. Olga не имеет opportunity spot «50 000 leads вместо 500». Maksim cloning appreciate скорость but Olga нужен gate
- **Fix**: First launch в account gets confirm step (inline expanding под button, **не modal**): «N лидов · M шагов · с PP:PP до RR:RR в дни X,Y,Z · аккаунты: 2. Запустить?» с двумя кнопками. Subsequent launches могут skip via «не показывать снова» pref
- **Command**: `onboard`

### [P1] No clone / template — Maksim's 51st launch не быстрее his first
- **Where**: History (980-1020) ссылается на кампанию but doesn't offer «запустить ещё одну такую же». `startNewLaunch:477-484` resets всё в empty
- **Why**: Maksim's stated need = speed + clone. Right now его 50th campaign takes as long as 1st
- **Fix**: «Дублировать» ghost button on каждой history row pre-filling sequenceSteps, schedule, behavior (everything except lead file). «Сохранить как шаблон» toggle на result screen
- **Command**: `adapt`

### [P2] Two duplicate header implementations
- **Where**: `LaunchHeader` (131-147) exists; wizard render (608-622) reimplements его body inline потому что нужен flex с PresetBadge
- **Fix**: Extend LaunchHeader to accept `right` slot + optional subtitle
- **Command**: `distill`

## Cognitive Load (6/8 PASS)

| Check | Result | Note |
|---|---|---|
| One scan path / clear step progression | ❌ **FAIL** | Steps appear conditionally, no progress affordance |
| One color per region | ✅ | Color amber/red/green/paper only |
| Numbers mono, body sans | ✅ | validLeadsCount, dates, counts all ds-mono (706, 944, 999) |
| ≤2 weights per region | ✅ | Inter regular + semibold only |
| Hairline dividers | ✅ | All 1px solid var(--cp-divider) |
| Status as dots | ✅ | STATUS_DOT (118-124), history uses dot+label (982-1008) |
| Editorial numbering | ✅ | 01 → consistently (136, 611, 1072) |
| Empty/loading/error single CTA | ❌ **FAIL** | Result screen shows two CTAs side-by-side (583-599) без primary/secondary hierarchy |

## Persona Red Flags

**Olga (first launch, scared)**
- No progress signal (626) — не знает «step 3 of 6», когда «готова»
- No save state (149-484) — tab crashes → 40 минут gone → не возвращается в продукт
- Sequential post-submit errors (425-442) — first click reveals one problem, fix → second reveals next, three rounds → questioning whether product works
- Brief-tip (824-852) хорош но easy to miss (mid-Step-3 inside section)
- Subject-on-follow-up warning (1686-1697) **excellent** для неё — exactly «you might break something» which first-launchers need

**Maksim (51st launch, wants speed)**
- No clone/duplicate from history (980-1020) — каждая кампания from scratch, biggest miss
- No template/preset для sequences — keeps в Notion doc, pastes
- Brief tip (824-852) noise для него; conditional gating ОК но «не показывать» dismiss helped
- PresetBadge (1027-1049) ссылается на `/client/launch` — i.e. себя. Должна link на где preset configured

**Sergey (debugging stuck state)**
- History row's error_message concatenated raw в meta line (1000) — no copy-id, no «last attempt at HH:MM», no link на server log
- `launch.id` generated server-side but never surfaced в UI — only instantly_campaign_id. Нужен launch row id чтобы find в DB
- `presetError` (497-514) shows raw message — fine для него, terrifying для Olga

## Minor Observations

- page.tsx:619 subtitle «Загрузите базу, напишите цепочку и запустите» ends without period, three imperatives — choppy rhythm
- page.tsx:946 — `sequenceSteps.length === 1 ? 'шаг' : 'шага'` — Russian pluralization 3-form, не 2. «11 шагов», «21 шаг», «22 шага» — breaks at >4 steps. Use plural helper
- page.tsx:1604-1619 — wait_days defaults to 3 on addStep (318) but to 0 on initial state (170). Inconsistency
- page.tsx:1660-1668 — «+ Вариант» button same ds-btn-ghost weight as tab buttons next to it. Hard to scan как affordance vs tabs
- page.tsx:1334 — «Если переменной нет у конкретного лида, Instantly подставит пустую строку.» — text-[10px] below system minimum readable size
- page.tsx:706 — «X строк · Y колонок · валидных email: Z.» — three different separators (·, ·, :). Pick one
- page.tsx:982 — history rows use `neu-sm` (different surface treatment from wizard Section cards). Defensible (denser data) but worth confirming
- page.tsx:170 — initial step `wait_days: 0` semantically odd; ideally step 1 wouldn't have wait_days at all
- page.tsx:1027 PresetBadge as `<Link>` to its own page — broken nav

## Questions to Consider

1. **Wizard или single long form pretending to be one?** Sections appear progressively, но нет «next» — user scrolls. If form — embrace it (kill conditional gating, validate inline, let users skip around). If wizard — give rail + «next» button per step. Current hybrid neither
2. **«Save my work» для Olga vs Maksim?** Maksim wants templates («save these 5 emails as reusable sequence»). Olga wants drafts («don't lose what I typed»). Same feature two UIs, или two features?
3. **Should launch ever be irreversible?** Right now «Запустить» creates campaign в Instantly immediately. Could ship «scheduled launch» (создать сейчас, активировать в 09:00 завтра) — 12-hour undo window. Eliminates most anxiety
4. **Why is Step 1's dropzone the only block styled as hero?** (p-8 sm:p-10, line 634) — every other Section uniform. Visual weight earned, или мы кричим «upload here»?
5. **Variant tabs at 1633-1677 quietly enable A/B/C testing с footnote: «Instantly случайно выберет один вариант для каждого лида.»** Serious experimental feature buried в one-line caption. Should A/B testing be deliberate step или buried-feature treatment intentional?
