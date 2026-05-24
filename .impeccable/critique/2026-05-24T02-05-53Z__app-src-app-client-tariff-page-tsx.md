---
target: app/src/app/client/tariff/page.tsx
total_score: 17
p0_count: 3
p1_count: 2
timestamp: 2026-05-24T02-05-53Z
slug: app-src-app-client-tariff-page-tsx
---
# Critique — `app/src/app/client/tariff/page.tsx`

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules + impeccable absolute bans)
**Mode:** Assessment A (design review, sub-agent) + Assessment B (manual anti-pattern scan; CLI detector still unavailable)
**Run:** first formal critique for this target.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Status dot+tag+dates clear; "Обновить" имеет спиннер. Loading state — голый спиннер без скелета. |
| 2 | Match Real World | **1** | «12 754 из 60 020 единиц» суммирует контакты + запросы + цепочки писем как одну величину — category error. |
| 3 | User Control & Freedom | 2 | «Обновить» есть, в модалке отмена. Нет: скачать счёт, посмотреть историю, dismissить lock card. |
| 4 | Consistency & Standards | 2 | Eyebrow casing разная («Биллинг» Cap vs «текущий тариф» lower). Tile shape для дат header vs тайлов limits — разные. |
| 5 | Error Prevention | 2 | Unlink модалка есть, copy отличная. Но «Оплатить подписку» без подтверждения суммы; `limit=0` молча показывает «0%» вместо «лимит не задан». |
| 6 | Recognition vs Recall | 2 | «период с» + «оплачен до» заставляют считать «сколько осталось дней» в уме. Те же 3 тайла per card требуют арифметики «сколько в день». |
| 7 | Flexibility & Efficiency | **1** | Нет keyboard shortcut, нет сравнения с прошлым периодом, нет экспорта, нет burn rate. Maksim не может пейсить usage. |
| 8 | Aesthetic & Minimalist | **1** | Page = «icon + heading + 3 stats + progress + hint» отштампован 3×. Maximalist-minimalism anti-pattern. |
| 9 | Error Recovery | 2 | Error banner есть, last_renewal_error поднят. Но на /tariff fetch failure кроме спиннера error banner ничего нет — нет retry внутри банера. |
| 10 | Help & Documentation | **1** | Нет тултипов, FAQ, «что считается контактом?». Inline-help нет. Линка на upgrade flow нет — несмотря что это страница билинговой decision. |
| **Total** | | **17/40** | **Mixed (нижний край) — близко к Bad band 0-15** |

## Anti-Patterns Verdict

**LLM assessment** — **выглядит AI-generated**, но не от плохих токенов (они чистые), а от **компонентного pattern'а**:

- **Три идентичных карточки** (page.tsx:561-663) из `LIMITS.map()`: icon + title + subtitle + percent + progress bar + 3 nested tiles + redundant «осталось N» строка. Тот же warm-stone era pattern, который мы только что убрали из `AutoPipelineSummary`.
- **Каждая карточка САМА — hero-metric template**: большая % сверху-справа, цветной progress, три supporting stats. Умножено на три = три SaaS-cliché героя сложенных стопкой.
- **Дублирование одного числа**: `usage.remaining` рендерится дважды per card — в тайле «осталось» (650) и в текстовой строке внизу (658). Classic LLM-padding.
- **Faux total «60 020 единиц»** — Object.values().reduce() сум разных сущностей.
- **Lucide soup**: 11 разных иконок (Users, Database, Sparkles, CreditCard, Lock, Zap, Unlink, CheckCircle2, Clock, ExternalLink, Loader2, RefreshCw). Sparkles для «Цепочки писем» = чистая декорация.
- **40+ inline `style={{ color: 'var(--cp-paper)' }}`** где utility-классы бы это несли.

**Deterministic scan** — CLI detector unavailable (`Error: bundled detector not found`, прежний гэп). Manual scan:

- ✅ **0 absolute-ban нарушений mechanically**: 0 hex литералов, 0 gradients, 0 bg-clip-text, 0 side-stripes, 0 backdrop-blur, 0 undefined token fallbacks, 0 Tailwind palette leaks.
- ⚠️ **Identical-card-grid risk** counted: 3 limit cards × 3 stat tiles = **9 одинаковых micro-cards** на одном экране, плюс 2 в header = 11. Structurally идентичная mini-card шапка везде. Это и есть absolute ban в действии, просто **mechanical scan его видит как «9 одинаковых tile-структур»**, а design-judgment — как «3 identical hero cards».
- ⚠️ `rgba(0, 0, 0, 0.6)` literal на line 671 (modal scrim) — заменить на `var(--cp-scrim)` (определить токен).
- ⚠️ `neu-inset` на error banner (line 246) — warm-stone leftover в editorial layout.

**Visual overlays** — unavailable (нет browser automation).

## Overall Impression

**Это, вероятно, самая «слабая» страница в /client из тех что мы трогали** — 17/40, Mixed нижний край, три P0 absolute-ban нарушения. Парадокс: токены идеально чистые (я крафтил в batch 5 — token swap прошёл), но **структурный pattern остался warm-stone эра**. То же самое было с `AutoPipelineSummary` до P2 shape'а.

**Single biggest opportunity**: переписать **layout с нуля** через `shape` — вместо 3-cards-grid editorial ledger (одна строка на лимит с inline progress + mono числа), удалить fake «единиц» сводку, выкинуть hint text. **Это шаг с 17/40 до ~28-30/40 за один shape+craft.**

## What's Working

1. **Token discipline** (page.tsx по всей длине, e.g. 252, 289, 304, 600) — все цвета через `var(--cp-*)`, никаких hardcoded hex. Rule #3 (No-Warm-Tint) соблюдено на уровне tokens.
2. **Semantic progress color** через `usageDot()` (page.tsx:103-107) — threshold green→amber→red это Status-as-Data done right.
3. **Unlink modal copy** (page.tsx:688-697) — «Оплаченный доступ до {date} сохраняется» — отлично снимает тревогу перед destructive action. Лучше 95% SaaS confirmations.

## Priority Issues

### [P0] Identical-card grid (ABSOLUTE BAN)
- **Where**: page.tsx:561-663 — three `<article className="neu-card p-5">` из `LIMITS.map()`, каждая carrying тот же icon+title+hint+pct+bar+(3 tiles)+hint shape.
- **Why**: Listed in impeccable absolute bans. То же самое мы уже починили в AutoPipelineSummary. Forces пользователя сканировать тот же template три раза чтоб прочитать три числа.
- **Fix**: Collapse to **editorial ledger table**: rows `Контакты Instantly | 3 630 / 10 000 | ▓▓▓░░ 36% | 6 370 осталось`. Одна строка на лимит. Icon может умереть; hint → tooltip; «осталось N» сноска delete.
- **Command**: `shape` (нужно обсудить final form перед кодом)

### [P0] Hero-metric template, multiplied (ABSOLUTE BAN)
- **Where**: page.tsx:567-660 (per card) — каждая карточка ЕСТЬ cliche: big number/percent top-right (591-596), colored "accent" progress bar (598-606), three supporting nested stats (607-653). Три из них.
- **Why**: Brief calls this by name as SaaS cliché. То что accent не gradient не спасает — это композиция, не цвет, triggers slop read.
- **Fix**: То же что и P0 #1 — ledger вместо cards. Если "headline" нужен — пусть **02 → текущий тариф** earn его одной honest строкой.
- **Command**: `shape` (same shape pass, две P0 закрываются за раз)

### [P0] «12 754 из 60 020 единиц» сум разных units (Match Real World violation)
- **Where**: page.tsx:192-201 (useMemo reduces usage), rendered 322.
- **Why**: 60 020 = 10 000 контактов + 50 000 запросов + 20 цепочек. Три ортогональных сущности (люди, API-запросы, AI-генерации) сложены как «единицы». Клиент читая «60 020 единиц» не может reverse-engineer что это. Хуже — два клиента на одном тарифе могут иметь identical total пока один заблокирован по контактам, другой нет. Число это **misinformation**.
- **Fix**: Удалить total. Если summary нужен: *«На балансе: 6 370 контактов, 40 880 запросов, 16 цепочек»* — три real units. Или surface most-stressed limit: *«Ближайший лимит — Контакты Instantly, 36% израсходовано»*.
- **Command**: `clarify`

### [P1] Status-as-Pill вместо Status-as-Data
- **Where**: page.tsx:272-282 — `ds-status-tag` обёртывает dot + UPPERCASE mono label в визуальную pill (без bg, но typographically heavy).
- **Why**: Doctrine #2 говорит цвет reserved для **dot**, не chrome around it. UPPERCASE mono «АКТИВЕН» рядом с «Standard» h2 fights bold heading за внимание.
- **Fix**: Render только dot inline перед именем тарифа: `● Standard`. Drop tag wrapper. Если status `expired` или `setup` — surface explanatory copy под этим, но в 95% случае («Активен») dot достаточно.
- **Command**: `quieter`

### [P1] Loading + error states anemic
- **Where**: page.tsx:203-211 (initial loading = bare `<div className="neu-spinner animate-spin" />` на всю страницу), 244-256 (error banner без retry).
- **Why**: Olga открывает раз в месяц; если loading >300ms — выглядит сломанным. Если hit error — recovery path («Обновить» pill наверху) не co-located с failure.
- **Fix**: Skeleton — render section shells (headings + eyebrows + grayed cards) immediately, swap numbers on resolve. Для error — inline «Повторить» кнопка рядом с message.
- **Command**: `harden`

### [P2] Lock-card visual cacophony
- **Where**: page.tsx:328-449 — red status dot + Lock icon + h3 + p + button. Три competing visual anchors в начале row.
- **Why**: Lock иконка декоративная — red dot уже несёт семантику. Иконка не добавляет ничего что heading «Ожидается оплата счёта» не говорит.
- **Fix**: Drop Lock icon; keep dot + heading. Status text → одна моно-строка right-aligned под heading.
- **Command**: `distill`

### [P3] Eyebrow case inconsistency
- **Where**: page.tsx:218 «Биллинг» Cap; 264, 559, 293, 308, 615, 630, 645 — все lowercase.
- **Why**: Commit to one register. «Биллинг» alone breaks rhythm.
- **Fix**: Lowercase «биллинг».
- **Command**: `polish`

## Cognitive Load Check (3/8 PASS, 2 partial, 3 FAIL)

| Check | Result | Note |
|---|---|---|
| One scan path top → bottom | ✅ PASS | Single column, sections stacked |
| One color carries meaning per region | ⚠️ PARTIAL/FAIL | Три independent semantic-color systems active: `usageDot()` green/amber/red, status tag color, `last_renewal_error` red dot |
| Numbers mono, body sans | ✅ PASS | `ds-mono` корректно применён |
| ≤2 weights per region | ✅ PASS | font-semibold + font-bold + default — borderline OK |
| Hairline dividers, not shadows | ✅ PASS | neu-card = 1px border, shadow none |
| Status as dots, not pills | ❌ FAIL | `ds-status-tag` (line 273) = pill, не dot |
| Editorial numbering on sections | ⚠️ PARTIAL | 01/02/03 на месте, но lock и autopay sections без номера — breaks rhythm |
| Empty states single CTA | ❌ FAIL | Loading = bare spinner, error = banner без retry button |

## Persona Red Flags

**Olga (новичок, открывает раз в месяц чтобы понять остатки)**
- Видит «12 754 из 60 020 единиц». Думает: «*Что такое единицы? Я близко к лимиту?*» Ответа на странице нет.
- Скроллит. Видит три near-identical карточки. Должна читать каждый subtitle чтобы понять что они про разные вещи — визуально неотличимы пока progress не заполнен.
- Видит три «осталось N...» строки повторяющих tile значения сверху. **Читает как condescending или как будто что-то пропустила**.
- «АКТИВЕН» pill+dot (line 281) — регистрирует как кнопку (UPPERCASE, mono, padded), может попытаться кликнуть.

**Maksim (опытный, хочет предсказать конец месяца и пейсить usage)**
- Хочет: *«При текущем burn rate, у меня кончатся контакты до 01.08?»* Страница показывает %, used, remaining, период dates — но **нет rate, нет trajectory, нет «осталось N дней»**. Открывает калькулятор.
- Период «01.05.2026 — 01.08.2026» заставляет считать дни в уме.
- Нет sparkline daily usage. Нет сравнения с прошлым месяцем. **Страница snapshot, не tool.**
- `usageDot()` thresholds (80/95) ему invisible — не видит когда next color jump произойдёт.

**Sergey (агентский админ debugging «клиент говорит счётчик неправильный»)**
- Хочет: tariff_id, period boundaries в ISO, last refresh timestamp, raw used/limit pairs. **Страница имеет округлённые UI даты и нет raw timestamps** — открывает Postman.
- `payment_locked`, `auto_renew`, `payment_method_saved`, `billing_mode` все в API response — surfaced только частично.
- Нет client_id / tariff_id отображено — когда клиент скриншотит, Sergey не может link обратно без вопроса.

## Minor Observations

- **`max_domains` и `max_emails` в `LimitKey` unused** (page.tsx:20 vs LIMITS 43-71) — dead surface или feature gap
- **`statusDot` falls through `setup` и `inactive` to amber** (88-99) — две разных state'а как один цвет, теряет инфо
- **`payment_locked` section** (327-450) НЕ имеет editorial number — между 02 и 03 без «02b →» или своего номера, breaks нумерацию
- **Modal "first thought"** (668-731) для unlink — listed в absolute bans. Inline confirmation acceptable только когда action genuinely destructive (это случай, но pattern flagged)
- **`rgba(0, 0, 0, 0.6)` scrim** (line 671) — литерал вне token system. Добавить `--cp-scrim`
- **`neu-inset` на error banner** (246) — warm-stone leftover
- **`role="alert"`** есть, но нет `aria-live` на limits — refresh с 79%→96% (amber→red) invisible для screen readers
- **`mt-5` / `mt-4` / `mt-1`** в одной карточке (page 319, 607, etc) — 3+ spacing tokens в одном component, pick one
- **`max-w-5xl`** (214) для single-column + 3 cards forces grid в 2-col, третья card одна слева — visually unbalanced
- **`paid_until` interpretation**: when `billing_mode='invoice'` AND unpaid, paid_until может быть из prior period — autopay section (473) blindly показывает «Текущий оплаченный период до {date}» что misleading
- **`formatNum`** (109) использует `ru-RU` non-breaking space — но «60 020» может wrap awkwardly на mobile. Consider `font-variant-numeric: tabular-nums`
- **Icons в LIMITS почти invisible** (`h-4 w-4` с `cp-paper-faint`, 572-574) — если декоративные drop, если navigational raise contrast

## Questions to Consider

1. **Почему страница Тариф показывает usage at all?** Usage принадлежит странице usage; эта страница должна быть contract. Split позволит этой странице стать calm «что куплено, когда expires, как продлить», а `/client/usage` — burn-rate инструментом для Maksim.
2. **Что агентство хочет чтобы клиент сделал здесь?** Сейчас page informational. Если goal — upsell при approaching limits, где «ваш тариф закроется через 14 дней, обсудить расширение» CTA? «Обновить» только refreshит data — page не имеет tariff-change action несмотря на название.
3. **«Единиц» это real концепт в продукте или UI fiction от `Object.values().reduce()`?** Если users не думают в «единицах» — строка purely artifact от «надо что-то поставить тут». Delete или relabel.
4. **Should `payment_locked` blow past всю layout?** Когда locked=true, limits cards arguably не должны рендериться вообще — page = «сначала оплати», всё остальное noise. Сейчас оба рендерятся, конфликтующие сигналы.
5. **Right shape для трёх лимитов — три карточки, одна таблица, или один stacked progress bar?** Single horizontal stacked-bar showing all three limits proportional to period elapsed answer Maksim's pacing question в один glance и Olga's «am I OK?» в один look. Three cards answer neither well.
