---
target: app/src/app/client/replies/page.tsx
total_score: 20
p0_count: 0
p1_count: 3
timestamp: 2026-05-23T19-31-06Z
slug: app-src-app-client-replies-page-tsx
---
# Critique — `app/src/app/client/replies/page.tsx`

**System:** "Decisive Editorial Dark" (DESIGN.md + 7 Named Rules)
**Mode:** Assessment A (design review via sub-agent) + Assessment B (manual anti-pattern scan; CLI detector unavailable — bundled module still missing).
**Run:** first formal critique for this target.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | "Загрузка..." без skeleton/счётчика; mark-lead показывает "Сохраняем...", но никакого тоста после успеха |
| 2 | Match System / Real World | 3 | Inbox-вокабуляр чистый; eyebrow `01 → Inbox` смешивает EN-слово в русский заголовок |
| 3 | User Control & Freedom | 1 | Detail-view = state toggle, не route. URL не меняется, browser back уходит со страницы, нет shareable link, refresh теряет выбор |
| 4 | Consistency & Standards | 2 | h1 (font-bold) легче чем h2 (font-extrabold) — инвертированная иерархия; `neu-pill` + `neu-btn` смешаны без логики; `rounded-2xl` для ошибки vs `rounded-xl` для остальных |
| 5 | Error Prevention | 2 | Reply textarea не сохраняет черновик при switch actionMode; форма forward без email валидации сверх type="email"; comment Enter отправляет без подтверждения |
| 6 | Recognition vs Recall | 3 | Идентичность лида видна сверху detail; "наше последнее письмо" даёт контекст. Но в композере оригинальный текст скроллится за viewport, нет quote/snippet |
| 7 | Flexibility & Efficiency | 1 | Нет фильтров (unread-only / leads-only), нет поиска, нет сортировки, нет bulk actions, нет keyboard nav (j/k/Enter/Esc) |
| 8 | Aesthetic & Minimalist | 2 | 5 font weights в LeadDetail; редундантный `04 → комментарии` + `<h3>Комментарии</h3>` 5px ниже |
| 9 | Error Recovery | 2 | loadComments и handleSubmit оба `// ignore` — UI ничего не показывает при failure; mark-lead error есть, но без retry |
| 10 | Help & Documentation | 2 | mark-as-lead имеет инлайн-обоснование; empty state хорош. Но reply/forward формы стартуют без guidance — какой тон, есть ли подпись, с какого адреса |
| **Total** | | **20/40** | **Mixed (нижняя граница)** |

## Anti-Patterns Verdict

**LLM assessment** — выглядит частично AI-generated, но не от криминала, а от инерции каскадного рефакторинга:

- **Стэк лейблов**: `04 → комментарии` + `<h3>Комментарии</h3>` в 5px друг от друга (page.tsx:241-243). Editorial numbering должен заменять заголовок, а не дублировать его.
- **Инвертированная иерархия weights**: page h1 = font-bold (line 435), lead-detail h2 = font-extrabold (line 155). Локальный контекстный заголовок кричит громче названия страницы.
- **Пять font weights в одном роуте** (medium / semibold / bold / extrabold + default normal в `<pre>`).
- **Pseudo-modal back button** (line 144-150) вместо реального роута — list/detail toggle через `selectedLead` state, URL не меняется. Классический AI shortcut "single component tree".
- **Русская плюрализация ломается на 11-14** (line 371) — `commentCount === 1 ? 'комментарий' : commentCount < 5 ? 'комментария' : 'комментариев'` даёт "11 комментария". Characteristic LLM near-miss.
- **`neu-*` classnames** остались из warm-stone эры; CSS теперь remap'нут в flat editorial. Читается как "модель мигрировала токены, не концепты".

**Не slop**: copy грамотный, статус-цвет иерархия в LeadCard (315-326) реально продумана, editorial eyebrows на section openers применены правильно.

**Deterministic scan** — unavailable (CLI detector `node .claude/skills/impeccable/scripts/detect.mjs` всё ещё ломается на "bundled detector not found"). Manual scan дал:
- ✅ **0 absolute-ban нарушений**: нет hex литералов, linear-gradient, bg-clip-text, side-stripe borders, backdrop-blur, Tailwind color leaks.
- ⚠️ **1 doctrine issue confirmed** (совпало с Assessment A minor obs): `app/src/app/client/replies/page.tsx:279` — `var(--cp-inset, rgba(180,173,164,0.08))` ссылается на never-defined token `--cp-inset`, fallback — warm-stone tan (R180 G173 B164). Шипит warm-stone цвет под flat editorial layout.
- `neu-inset` в ReplyThreadActions используется корректно (CSS remap → surface-rest).

**Visual overlays** — unavailable (no browser automation в этой сессии).

## Overall Impression

Страница НЕ выглядит "AI made this" в стиле gradient banner или indigo-spam. Anti-banов нет. Но editorial-doctrine **есть, но местами**: eyebrows на месте, статус-семантика хорошая, hairline'ы корректные — а weights хаотичные, иерархия инвертирована, и **главное проблема не визуальная, а архитектурная**: detail-view сделан как состояние, а не как маршрут.

**Single biggest opportunity**: вытащить detail в `/client/replies/[id]` роут. Это закроет 3 разных heuristic-провала (User Control, Flexibility, Recovery) и снимет UX claustrophobia.

## What's Working

1. **`LeadCard` status hierarchy** (page.tsx:315-326) — `statusColor / statusTextColor / statusLabel` это единый источник правды; lead-over-unread-over-read precedence применён через tag + dot, не через колор-chrome. Textbook Status-as-Data.
2. **Variable section numbering** (page.tsx:193) — `${lead.last_outbound_preview ? '03' : '02'}` показывает, что eyebrow numbers content-aware, не hardcoded. Большинство каскадных правок оставили бы статичный `02/03` и сломали бы последовательность когда preview отсутствует.
3. **Empty state** (page.tsx:453-474) — объясняет цикл, ставит ожидание, даёт next step. Не "Ничего не найдено" shrug, а образовательное состояние.

## Priority Issues

### [P1] Detail view = state toggle вместо route
- **Evidence**: page.tsx:408-427, 384 — `selectedLead` через `useState`, URL остаётся `/client/replies`
- **Why**: Browser back уходит со страницы инбокса; refresh теряет выбор; нет shareable link ("посмотри этот ответ — *нет URL*"); Olga рефлекторно жмёт back и вылетает.
- **Fix**: Route to `/client/replies/[id]` через `next/link`. Server-fetch lead на detail-route; preserve list state на back. Минимум — sync `selectedLead.id` в search param и read on mount.
- **Command**: `shape` (требует обсуждения архитектуры перед кодом)

### [P1] Нет фильтров / поиска / сортировки
- **Evidence**: page.tsx:475-514 — плоский paginated list 30, только prev/next
- **Why**: Inbox без фильтров провален для Maksim (50+ кампаний — не может сканировать) и для Olga (через 2 недели не найдёт "тот ответ от понедельника").
- **Fix**: Hairline filter-strip над counter: три pill-toggle (`Все / Непрочитано / Лиды`) wired в `?status=`, плюс text search в `?q=`. Doctrine соблюдена — pills ghost, active state через `.active`.
- **Command**: `craft`

### [P1] Ошибки молча проглатываются
- **Evidence**: page.tsx:94 (`loadComments` catch `// ignore`), page.tsx:118 (`handleSubmit` catch `// ignore`)
- **Why**: При 500/401 на comments API пользователь видит пустой стейт "Комментариев пока нет" — это ложь. На submit failure инпут не очищается (это внутри try, но всё равно нет UI-сигнала). Sergey в dev отлаживая не имеет ни одного сигнала из UI.
- **Fix**: Catch в `setCommentsError` + inline retry. Для submit — clear `newComment` ТОЛЬКО на success (move setNewComment вне try либо после await), и surface error как mark-lead делает.
- **Command**: `harden`

### [P2] 5 font weights в LeadDetail + инвертированная h1/h2
- **Evidence**: page.tsx:155 (h2 font-extrabold) vs 435 (h1 font-bold); + medium/semibold/bold/extrabold смешаны (299, 215, 256, 284, 204, 241)
- **Why**: Doctrine violation "no more than 2 weights per region" + Sharp-Type. Когда всё bold — ничего не bold; reader не может разобрать иерархию.
- **Fix**: Page h1 → font-extrabold. Detail h2 → font-bold. Удалить font-medium из InfoRow (default Inter normal). Удалить font-bold из mark-as-lead intro (204) — это абзац-преамбула, не заголовок.
- **Command**: `typeset`

### [P2] Редундантный section label
- **Evidence**: page.tsx:238-243 — eyebrow `04 → комментарии` + `<h3>Комментарии</h3>` 5px ниже. Остальные секции (182-183, 191-194) так не делают.
- **Why**: Doctrine drift. Editorial numbering — это и есть заголовок секции; повторение тавтологично.
- **Fix**: Удалить `<h3>`. Eyebrow выполняет роль heading.
- **Command**: `distill`

### [P3] Русская плюрализация ломается на 11-14
- **Evidence**: page.tsx:371 — упрощённый ternary даёт "11 комментария" вместо "11 комментариев"
- **Why**: Trust over time. Один клиент увидит "11 комментария" и решит, что продукт делали люди, не знающие язык.
- **Fix**: Использовать утилиту plural() (она же в dashboard/page.tsx уже определена и экспортируется в нескольких местах) либо inline rule с учётом 11-14 exception.
- **Command**: `polish`

## Cognitive Load Check (5/8 PASS)

| Check | Result | Note |
|---|---|---|
| One scan path top → bottom | ✅ PASS | Header → counter → cards stack чисто |
| One color carries meaning per region | ✅ PASS | Green/amber/grey dot rule disciplined; red reserved для ошибок |
| Numbers are mono, body is sans | ❌ FAIL | Counter "Всего ответов: {total}" (477-479) — total в Inter; LeadCard timestamps (344) и comment count (370-372) тоже sans |
| ≤2 weights per region | ❌ FAIL | LeadDetail uses semibold + bold + extrabold + medium |
| Hairline dividers, not shadows | ✅ PASS | `neu-divider` = 1px height + cp-divider bg; `neu-card` border 1px, shadow none |
| Status as dots not pills (data) | ✅ PASS | ds-status-tag + ds-status-dot в LeadCard 350-353 |
| Editorial numbering on sections | ✅ PASS | 01 → / 02 → / 03 → / 04 → последовательно; variable numbering на 193 |
| Empty states have single CTA | ✅ PASS | "Создать кампанию" — единственный action |

## Persona Red Flags

**Olga (новичок, первая неделя)** — primary: open inbox, прочитать первый ответ, ответить.
- Нет breadcrumb после входа в detail (line 144 back arrow). Через 3 минуты чтения длинного ответа теряет spatial awareness.
- mark-as-lead и reply-by-email оба gated на `canReplyByEmail` (200, 228). Если лид из forwarded-path без email_id — видит ничего про "как ответить", только comments-вкладку.
- Reply form (ReplyThreadActions:106-166) без guidance: какая подпись, с какого адреса, увидит ли лид thread.
- `04 → комментарии` в lowercase, остальные смешано: `01 → Inbox`, `02 → наше последнее письмо`. Читается как непоследовательная типографика.

**Maksim (опытный, 50+ кампаний)** — primary: triage 30 ответов в день, быстро.
- Нет keyboard nav. j/k через карточки нельзя, Enter не открывает, Esc не закрывает. Только мышь — убивает throughput.
- Нет "unread only" фильтра. Глазами выискивает amber dots в списке где 80% серые "Ответ".
- list → detail → back теряет scroll position. Кликнул row 27, прочитал, "Назад к ответам" → top of list, скроллит до 28.
- mark-lead button похоронен в параграфе (200-226). Для него должно быть one-click на row, а не 3-click drill-down.

**Sergey (агентский админ, debugging)** — primary: воспроизвести "у клиента не грузятся комментарии".
- Никакого error UI при comment fetch failure (94). Не отличит 500 от 401 от пустого ответа без DevTools.
- Submit error такая же история (118) — silent catch.
- `selectedLead` локальный React state (384) — не может перезагрузить страницу чтобы воспроизвести "detail сломан", селекция теряется на refresh, нет URL state для шеринга.
- mark-lead success без тоста (133-134), только текст кнопки меняется на "Уже в лидах". Легко проморгать в debug.

## Minor Observations

- page.tsx:169 — `lead.reply_subject.toLowerCase()` force-lowercase'ит subject email. "Interested in pricing" становится "interested in pricing". Doctrine editorial, не lowercase-эстетика.
- page.tsx:279 — input style `background: 'var(--cp-inset, rgba(180,173,164,0.08))'`. Token never defined; fallback — warm-stone tan. Заменить на `var(--cp-surface-rest)` или убрать override (neu-inset класс уже красит).
- page.tsx:271-288 — comment form без max-length, без счётчика символов, без multi-line (single `<input>`, не `<textarea>`). Реальные комменты часто параграфы.
- page.tsx:387 — `LIMIT = 30` в теле компонента, должен быть module scope.
- page.tsx:444 — error banner `rounded-2xl`, остальные surfaces `rounded-xl`. Выбрать один радиус.
- page.tsx:449-452 и 245-247 — "Загрузка..." в двух разных контейнерах (16-tall flex-center vs 4-tall plain). Унифицировать в `<LoadingLine>` примитив.
- page.tsx:477 — counter `{total}` рендерится в Inter. Обернуть в `<span className="ds-mono">`.
- page.tsx:433 — eyebrow "01 → Inbox" миксует EN-noun в RU-страницу. Либо "01 → Входящие", либо h1 тоже "Inbox". Не пол-перевода.
- page.tsx:408-427 — toggle обратно в list unmount'ит LeadDetail, in-flight loadComments fire-and-forget; no abort controller.
- `LeadDetail` и `LeadCard` определены в файле страницы (~300 строк суммарно) — вытащить в `components/client-replies/` per existing convention с ReplyThreadActions.
- page.tsx:79 — `canReplyByEmail` true только когда И `campaign_id` И `email_id` set. Нет UI объясняющего почему нельзя ответить. Inline hint нужен.
- page.tsx:175 — `lead.website` и `lead.linkedin_url` рендерятся как plain text в `InfoRow`. Должны быть `<a>` теги.

## Questions to Consider

1. **Корректен ли вообще list/detail паттерн?** Inbox-ы worth their salt (Superhuman, Front, Hey) на desktop используют two-pane split — лист слева, message справа. Персона desktop-only, экраны широкие. Почему full-page swap?
2. **Где истина для "unread"?** `is_unread` читается, но никогда не пишется — нет "mark as read" action. Открытие detail помечает прочитанным? Если да, где? Если нет — badge permanent пока backend не скажет иное.
3. **Почему comments и email-reply — два отдельных UI affordance?** Клиент читая lead reply интуит "respond". Мы показываем И internal comment input, И external reply form. Не должен ли один быть за tab/toggle, или comments в sidebar чтобы reply-path был dominant?
4. **Что роль `forwarded_lead` vs `reply` source (line 21, 78)?** `canComment = lead.source !== 'reply'` тихо убирает целую comments секцию для половины записей. Это намеренная product policy или data-shape leak в UI?
5. **AI-scored reply (`ai_interest_value`, `ai_reason` поля 36, 43) — почему не на surface-е списка?** LeadCard не показывает AI signal. Maksim в triage убил бы за "AI: hot (8/10)" dot. Поля в типе уже есть, просто не используются.
