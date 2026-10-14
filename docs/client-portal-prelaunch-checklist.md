# Client Portal — Pre-launch checklist

**Goal.** Walk through this checklist with a real test-client account before each new client is invited. Every item has an explicit pass criterion and an explicit red-flag signal. If anything is red, do not invite the client until it's fixed.

**Excluded from this checklist.** `/client/launch` (campaign launch wizard). Those flows are not in scope for the first paying client.

**Pre-requisites for the run.**

- A test client user with `role='client'` in `public.profiles`. Pick someone who has at least one project assigned, at least one Instantly campaign in their `client_instantly_access` rows, and at least one forwarded reply for that campaign.
- A separate "second" test client (or admin) so we can confirm cross-client isolation by trying to read the first client's resources from a second tab. **This is required, not optional:** do not mark the cross-client checks as N/A. The route-level RBAC suite that used to cover them, `app/tests/api/clientPortalSmoke.test.ts`, was deleted on 2026-08-31 (commit `35bf27d38`, test-suite reduction), and nothing replaced it — see section 15 for what the remaining tests do and do not cover. Without a second client the run is incomplete.
- Browser dev tools open the whole time — keep an eye on the Network tab for any 4xx/5xx that the UI swallows silently.

---

## 0. Environment audit

Before any UI test, confirm the prod env exposes everything the portal needs. SSH to prod (or check the deployment config) and verify these env vars are non-empty:

- [ ] `NEXT_PUBLIC_SUPABASE_URL`
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `INSTANTLY_API_KEY`
- [ ] `OPENROUTER_BRIEF_API_KEY` (powers Brief → Hypotheses; without it the POST returns 500 immediately)
- [ ] `SUPABASE_INSTANTLY_URL` and `SUPABASE_INSTANTLY_SERVICE_ROLE_KEY` (separate Supabase project for `instantly` schema)

**Red flag.** Any of those empty in prod. The whole brief/hypotheses/launch pipeline collapses silently.

---

## 1. Login and middleware

1. Open an incognito window. Go to `https://polza-portal.ru/client/dashboard` while logged out.
   - **Pass.** Redirects to `/login`.
   - **Red flag.** Renders any client page content before the redirect.
2. Log in as the test client.
   - **Pass.** After login, you land on `/client/dashboard` (not `/`, not `/projects`).
   - **Red flag.** Lands on the admin home page (`/`) or the admin nav is visible at the top.
3. While logged in as a client, manually type `/projects` (admin route) into the address bar.
   - **Pass.** Redirects to `/client/dashboard` or returns a 403/404.
   - **Red flag.** Renders the admin Projects page.
4. Log out.
   - **Pass.** Lands on `/login`.

---

## 2. Sidebar navigation and onboarding checklist

On `/client/dashboard`:

- [ ] Sidebar lists exactly the groups: **Старт** (Бриф / Базы / Цепочки писем / Создать кампанию), **Мониторинг** (Кампании / Лиды / Базы кампаний), **Архив** (Проекты).
- [ ] Active item is highlighted.
- [ ] On mobile (<768px) the sidebar collapses into a hamburger drawer that opens correctly and closes when you click a link.
- [ ] The onboarding checklist on the dashboard renders 6 items in order: Бриф → Пресет → Собрать первую базу → Очистить первую базу → Написать первую цепочку писем → Запустить первую кампанию.
- [ ] Each unfinished item has a working link (except "Менеджер настроил пресет" — that one is `href: null` with a "Обратитесь к менеджеру" tooltip when the preset is missing).
- [ ] Steps that are already done show a checkmark.
- [ ] "Написать первую цепочку писем" links to `/client/parsers?tab=email-sequence` and is done only when the client has an `email_sequence_runs` row with `status='completed'` — a freshly-created `draft` run (auto-created on tool open) must NOT tick it.

**Red flags.** A nav item points to a 404, the sidebar layout breaks (overlaps content, no scroll on small viewports), checklist shows fewer than 6 items, or `next_id` highlight desyncs from the actual checklist state.

---

## 3. Brief

Go to `/client/brief`.

1. **Empty state.** New client (no brief saved yet) sees the empty form. The "Сохранить" button is enabled or disabled per the existing UX, but does NOT show stale data from a different account.
2. **Save round-trip.** Fill in only "Описание компании", "Описание продукта", "Целевая аудитория". Click "Сохранить".
   - **Pass.** The page shows a success indicator. Reload — the saved values are there.
   - **Network.** `PUT /api/client/brief` returns 200 with `{ brief: { id, fields, updated_at, ... } }`. No 500.
3. **Validation.** Try to send an obviously broken value (e.g. paste 50 KB of garbage in one field).
   - **Pass.** UI rejects, or the server returns 400 with a meaningful Russian message.
   - **Red flag.** 500.
4. **Hypotheses generation.**
   - On first save, hypotheses generation should auto-trigger. Wait up to 90 seconds (the route's hard timeout).
   - **Pass.** A list of ≥ 5 numbered hypotheses appears. Each has filled ICP / triggers / sources / filters lines on a single line each (no nested bullets). No empty bullets, no "Loading..." stuck for >2 minutes.
   - **Network.** `POST /api/client/brief/hypotheses` returns 200 with `{ ok: true, lead_source_hypotheses: "..." }`. The response time is bounded by `PROJECT_HYPOTHESES_TIMEOUT_MS` (default 90s).
   - **Red flag (regression May 2026).** Only 1 hypothesis returned, or each hypothesis has nested sub-bullets like `  - ICP: ...` rendered as separate empty fields. If you see this, capture the request id and check the LLM output via `app/scripts/test-requesty-policies.mjs` — the parser was hardened in `parseHypotheses.ts` but the prompt formatting can still slip if the underlying model changes.
5. **Regenerate.** Click "Перегенерировать" (or whatever the current label is).
   - **Pass.** New set of hypotheses appears (different from previous). Network tab shows `POST /api/client/brief/hypotheses?regenerate=1` returning 200.
6. **Cross-tool integration.** Open a second tab on `/client/base-constructor`. The "Оценка ЦА" step should be enabled (not locked) because the brief is now filled. Open `/client/launch` — the Step 3 (Sequence) brief tip is gone.

---

## 4. Базы (the new hub at `/client/build`)

1. The page shows a hero ("Базы" + 1-paragraph description) and 5 source cards: B2B-поиск компаний, HH.ru, Поиск, Yandex Maps, Загрузить файл.
   - [ ] Each card has a description and links to the corresponding tool/page.
2. Below: a single "Конструктор баз" CTA linking to `/client/base-constructor`.
   - [ ] Title, description, and arrow render correctly. Hover state works.
3. Click each of the 5 source cards in turn — they should open the corresponding tool, not 404.

**Red flag.** Any card 404s, or its label/description is from the old "companies-search" wording.

---

## 5. B2B-поиск компаний (`/client/companies-search`)

This page now reflects merged styling from `origin/test` (functional refactor) plus our hero header.

1. **Header.** "B2B-поиск компаний" heading + 1-line subtitle in Russian.
2. **Filters.** Each filter group expands cleanly. ОКВЭД / activity types modal opens and closes.
3. **Search.** Run a small search (a region with few hits, e.g. "Чукотка"). Get a count back, then a preview.
   - **Network.** `POST /api/client/companies-search` first with `countOnly: true`, then with rows. Both return 200.
4. **Export CSV/XLSX.** Run an export.
   - **Pass.** A file downloads. Open it — first row is the header, columns include `name`, `inn`, `address`, etc.
   - **Red flag.** Empty file or 500.

---

## 6. Парсеры (`/client/parsers?tab=*`)

For each tab — HH, Yandex Maps, Поиск, Email, Email Sequences:

1. The tab loads without a JS error in the console.
2. The form posts and returns either a result or a clear error message.

The Email Sequences tab is the legacy way to write sequences pre-launch wizard.

**Red flag.** Any tab is blank, or "Loading..." spinner stuck > 30s without a 500 visible in the network tab.

---

## 7. Конструктор баз (`/client/base-constructor`)

1. **Brief gate on TA scoring.** Without a saved brief the "Оценка ЦА" step in the steps grid is **disabled** with a lock icon and a tooltip "Сначала заполните бриф". Click the inline "бриф" link — opens `/client/brief`.
2. **With a saved brief**, the step is enabled and selectable. Toggle it on.
3. **Mandatory steps** (cleanup, dedup, name cleanup, etc.) are forced-on (greyed out as "Выполняется автоматически"). Client cannot turn them off.
4. **10K row limit** for client-uploaded files. Try to upload a CSV with > 10 000 rows.
   - **Pass.** UI rejects with a Russian message.
5. **Run the pipeline** on a small file (≤ 50 rows). Wait until it finishes.
   - **Pass.** Progress bar updates, results appear, no row drops to zero unexpectedly.

---

## 8. Кампании (`/client`)

1. **Empty state.** With no campaigns assigned: "Кампаний пока нет" + a CTA "Создать кампанию" linking to `/client/launch`.
2. **With campaigns.** Each card shows: имя, статус (active / paused / draft), отправлено / открытий / ответов / лидов. `lastSyncedAt` shown somewhere visible.
3. **Cross-client isolation.** Log in as the second test client. Confirm you only see your own campaigns. Then in the network tab manually edit a request URL to use the first client's `campaign_id` — the API must return 404. (No automated test checks this per endpoint any more — the RBAC smoke suite was deleted on 2026-08-31, see section 15 — so this manual step is the only check. Repeat it for the replies, thread and lead-comment requests of that campaign.)
4. **Activate / Pause buttons (if the campaign has a launch).** Click pause on a running campaign.
   - **Network.** `POST /api/client/campaigns/[id]/pause` returns 200 with `{ ok: true, status: 'paused' }`.
   - The UI updates without a full reload.

---

## 9. Базы кампаний (`/client/bases`)

1. **Empty state.** New client: "Контакты ещё не загружены" + CTA "Создать кампанию".
2. **With data.** Lists every campaign you have access to as a row, with `leads_count` and `leads_synced_at`. Click into one — leads table renders.
3. **Search.** Type into the search box. Results filter live. Local search only (no roundtrip per keystroke).

---

## 10. Лиды (`/client/leads`)

1. **Empty state.** "Лидов пока нет" + CTA "Создать кампанию".
2. **With data.** Each row has: лид (имя/компания), кампания, дата ответа, кнопка "Открыть".
3. **Lead detail.** Open one lead.
   - Comments load (your own comments, not other clients').
   - Add a comment. It appears immediately.
4. **RBAC.** In the network tab, change a `lead_id` in the URL to one belonging to another client — must 404.

---

## 11. Inbox / Replies (campaign detail page)

Open a campaign detail (from `/client`). Find the "Ответы" / "Inbox" section.

1. **List.** Replies (`ue_type=2`) are listed with preview, sender, date.
2. **Search.** Search box filters list (passes `search` query to Instantly).
3. **Pagination.** Scroll to bottom — `next_starting_after` cursor pulls more.
4. **Open one reply.** The full thread opens. Inbound and outbound messages are sorted chronologically.
5. **Reply.** Click "Ответить", type something, send.
   - **Pass.** UI shows "Отправлено", thread updates with the new outbound message.
   - **Network.** `POST /api/client/campaigns/[id]/replies/[emailId]/reply` returns 200 with `{ ok: true, eaccount }`.
6. **Cc/Bcc.** Add an email to Cc, send.
   - **Pass.** Same as above. Backend includes `cc_address_email_list`.
   - **Red flag.** 400 with email-validation error if the email is valid.
7. **Forward.** Open another reply, click "Переслать", enter a target address, send.
   - **Network.** `POST /api/client/campaigns/[id]/replies/[emailId]/forward` returns 200.
8. **eaccount auto-detect.** None of the actions ask for "from which mailbox". The eaccount is derived from the original email or its thread.

---

## 12. Проекты (`/client/projects`)

1. **Empty state.** "Проектов пока нет" + "Связаться с менеджером" mailto.
2. **With projects.** List items show: name, status, specialist, manager, contacts done/obligation, deadline, leads_count, tasks counters.
3. **Open a project.**
   - Project detail loads with tasks split into "Активные" / "Готовые".
   - **Privacy.** Inspect a task in DevTools — it has only `id`, `title`, `status`, `deadline`. No `description`, `result`, or `image_url` (those are internal).
   - **Red flag.** Any internal field surfaces in the response.

---

## 13. Тариф (`/client/...` whoever surfaces it)

Tariff API (`GET /api/client/tariff`) exposes plan + limits + status. If the UI shows it anywhere (e.g. profile menu):

- [ ] Numbers match the row in `client_tariffs` for this user.
- [ ] Status (`active` / `expiring_soon` / `expired`) renders correctly.

---

## 14. Cross-page sanity

- [ ] Refreshing any client page does not lose state or kick to login (session is sticky).
- [ ] The browser console has no red errors on any page (warnings are OK).
- [ ] No 5xx responses in the network tab over the course of the run.
- [ ] No CORS errors.
- [ ] No mixed-content warnings (everything HTTPS).
- [ ] Logout cleans the session — going back to a client page redirects to login.

---

## 15. What's covered automatically — and what no longer is

**Read this before skipping anything.** This section used to point at `app/tests/api/clientPortalSmoke.test.ts` (55 route-level tests). That file was deleted on 2026-08-31 (commit `35bf27d38`, test-suite reduction) and no replacement suite exists — there is no `clientEngScopeGuards.test.ts` either. What the tree still checks automatically:

- `app/tests/api/requireClientAuth.test.ts` and `app/tests/api/clientAuthHelper.test.ts` — the shared guard `requireClientAuth` itself: 401 without a user, 403 for a non-client role, demo accounts read-only, infrastructure errors answered 503 instead of an empty result. They test the guard function, **not** that every route calls it.
- `app/tests/lib/clientInstantlyAccess.test.ts` — the scope helpers the campaign routes use (`filterAllowedIds`, `isResourceAllowed`, `scopeAutoReportCampaignIds`). Again the helpers, not the routes.
- `app/tests/architecture/verticalEngineV2Isolation.test.ts` — a static scan of the **ENG cabinet routes only** (`/api/client/eng`, section 17): every handler calls `requireClientAuth`, the market gate and an owner-scope check; client-facing error text is English and free of vendor and table names; no unbounded row reads. It does not cover the routes of sections 1–14.

What is **not** covered automatically any more, so it must be tested by hand on every run: empty new-user state shapes (onboarding, brief, preset, tariff, campaigns, leads, bases, projects); the brief save round-trip and the hypotheses gate (section 3); RBAC across clients on every campaign-bound endpoint — campaigns/[id], replies, thread, reply, forward, activate, pause — and lead comments (section 8, item 3, with the second test client); the cross-campaign `emailId` leak (a known-allowed `campaign_id` with a foreign `emailId` must answer 404); reports scope filtering.

If any of the tests above fails, that is still a higher-priority signal than anything in the manual checklist — but a green run of them says nothing about the items in the previous paragraph.

---

## 16. After the run

If everything is green:

1. Tag the manual run in your records (date, tester, test-client name, prod build sha).
2. Take screenshots of each empty state and each populated page — useful for first-client onboarding docs.
3. Confirm with the tech lead that prod is on the latest deploy SHA.

If anything is red:

1. Capture: page URL, network request URL + status, response body, browser console errors.
2. Open an issue (or message Sergey) with all of the above.
3. Re-run the tests named in section 15 (`npx jest <file>` from `app/`, one file at a time). Note that a green run does **not** prove the bug is UI-only: route-level RBAC and empty-state shapes have no automated coverage since 2026-08-31, so reproduce the failing request by hand (the network tab capture from step 1) before calling it a UI bug.

---

## 17. Движок вертикалей ENG (`/client/eng` на `app.outreachos.xyz`)

Отдельный продукт на отдельном хосте: английский кабинет для рынка `us` поверх движка гипотез (`he_*`). Разделы 1–16 к нему не применяются — там другой хост, другой набор страниц и русский интерфейс. Раздел написан по-русски (документ команды), **все строки интерфейса в кавычках — английские и должны совпадать буквально**: несовпадение текста само по себе не баг, но означает, что кабинет изменился и чек-лист пора обновить.

**Зачем он нужен.** Это и есть тот «smoke `/client/eng`», который [`docs/design/2026-08-20-vertical-engine-v2-isolation.md`](./design/2026-08-20-vertical-engine-v2-isolation.md) называет условием переключения специалистов на v2. Каждая волна порта VE2 → ENG проверяется одним ручным проходом по этому разделу; результат — строкой в таблице.

| Волна | Дата | Кто прошёл | Билд (SHA) | Результат |
|---|---|---|---|---|
|  |  |  |  |  |

**Цена одного прохода — не ноль, поэтому проход один на волну.** Минимальный лимит сборки в кабинете — 2000 строк (`ALLOWED_LIMITS = [2000, 10000]` в `api/client/eng/verticals/[id]/collect`), прогона «на 50 строк» физически нет. Шаг Launch создаёт **реальную кампанию в рабочем Instantly-воркспейсе** и кладёт в неё до 2000 реальных лидов (`HE_LAUNCH_MAX_LEADS`). Кампания создаётся **на паузе** — письма не уходят, но кампания и лиды остаются в воркспейсе, пока их не убрать (см. 17.12). Плюс расход LLM и провайдеров обогащения на каждый проход.

---

### 17.0 Предусловия

- [ ] Тестовый клиент: `profiles.role='client'` **и** `profiles.market='eng'`. Без второго условия middleware уводит из кабинета.
- [ ] Если `market` правили только что — выйти и зайти заново. Роль и рынок кешируются в куке `x-portal-role` формата `userId:role:market` на 30 минут; старая кука из двух сегментов читается как `market='ru'` и даёт ложный «красный» на первом же шаге.
- [ ] У клиента есть подключённый ящик (раздел «Sending mailboxes») и заведённый пресет отправки (`client_campaign_presets` с его `client_user_id`). Без пресета шаг 17.7 упрётся в «No sending preset configured yet — ask your manager to set one up.» — сегодня пресет заводит менеджер staff-роутом, это ограничение, а не баг (см. 17.13).
- [ ] На проде запущен `portal-worker-hypothesis-engine` — без него все шаги останутся в `pending` навсегда.
- [ ] Заполнены ключи research и сбора (`HE_MODEL_*` / `OPENROUTER_*`, Serper, PDL). Пустой ключ = мгновенный `failed` на первой стадии.
- [ ] DevTools открыты весь проход, вкладка Network не очищается: половина проверок этого раздела — про тело ответа, а не про экран.
- [ ] Проход идёт на реальном ENG-аккаунте, не на демо: демо-аккаунту любая мутация режется централизованно (403, `code: 'DEMO_READONLY'`), то есть ни одна стадия прогона не запустится. Текст этого отказа в ENG-кабинете английский — если он пришёл по-русски, см. 17.10 (б).

---

### 17.1 Вход и рыночный гейт

1. Открыть `https://app.outreachos.xyz/` инкогнито, разлогиненным.
   - **Pass.** Редирект на `/login`.
2. Войти тестовым ENG-клиентом.
   - **Pass.** Попадаем в `/client/eng` (а если проекты уже есть — дальше в `/client/eng/dashboard`, с промежуточным «Opening the Command Center…»).
   - **Red flag.** Попали в русский кабинет `/client`, увидели русский сайдбар «Старт / Мониторинг / Архив» или редирект на основной хост.
3. Сайдбар.
   - **Pass.** Ровно два пункта: «Outreach» и «Sending mailboxes». Ни одного RU-раздела.
   - **Red flag.** Видны пункты RU-кабинета (они всё равно закрыты редиректом — значит, это мёртвые ссылки).
4. Вручную набрать `/client/brief` (раздел RU-кабинета).
   - **Pass.** Редирект обратно на `/client/eng`.
5. Заголовок страницы: h1 «Outreach», подзаголовок «Verticals engine: research your market, review verticals, edit letters, collect a base and launch — all in English.»

---

### 17.2 Создание проекта

На `/client/eng` (если редиректнуло на дашборд — «All projects» ведёт на `/client/eng?list=1`).

1. Карточка «New project»: поле «Website» (обязательное, плейсхолдер `acme.com`), поле «Project name (optional)» (плейсхолдер `Acme outbound`), кнопка «Create & start research», подпись «Research starts right away: we profile the site, map competitors and draft market verticals for your offer.»
2. Ввести домен тестового us-сайта, нажать «Create & start research».
   - **Pass.** Сразу переходим на `/client/eng/projects/<id>`; research уже поставлен в очередь.
   - **Network.** `POST /api/client/eng/projects` → **201**, тело `{ project: {...}, job: {...} }`. В `project` обязателен **`"market":"us"`** (рынок форсится сервером, поле из формы не принимается) и `"status":"researching"`.
   - **Red flag.** `market` отличен от `us`; 500; имя проекта не проставилось (при пустом поле имя = хост сайта).
3. Ввести заведомо мусорный адрес (`не-домен`).
   - **Pass.** 400 и английский текст «Invalid `website_url` — enter the domain or URL of your site».
   - **Red flag.** 500 либо русский текст ошибки.

---

### 17.3 Шаг «01 · Brief» и research

Мастер проекта: пять шагов-вкладок «01 · Brief», «02 · Verticals», «03 · Letters», «04 · Bases & Launch», «05 · Review & Launch». Обратите внимание: письма в мастере идут **до** сбора базы — это порядок экранов, а не порядок конвейера.

1. Шапка проекта: имя, бейдж статуса, пока идут джобы — «working…» и кнопка «Cancel all jobs» справа. Внизу страницы — «Updated <дата> · auto-refreshing every 4s».
   - **Red flag.** «auto-refreshing every 4s» есть, а цифры и статусы не меняются минутами при живой джобе (полл стоит).
2. Карточка «Site profile», пока идёт research — «research in progress…» и текст «Profiling the site — the brief will appear here as soon as the research finishes.»
   - **Pass.** За время research (единицы минут) профиль заполняется: поля «Company», «Product», «USP», «Target audience», «Business model», «Price tier», «Deal cycle», «Geo», «Current clients», «Cases» — пустые поля просто не показываются.
   - **Red flag.** Профиль пуст больше 15 минут при отсутствии активных джоб; в шапке появилось «Last error: …».
3. Карточка «Offer & style overrides»: «Business description (manual, max 3000 chars)», «Offer override», «Style reference (1–2 “perfect” emails to imitate)», «Sender signature (used verbatim at the end of every letter)». Заполнить подпись отправителя и нажать «Save overrides».
   - **Pass.** Появляется «Saved», после перезагрузки страницы значения на месте.
   - **Network.** `PATCH /api/client/eng/projects/<id>` → 200.
   - **Red flag.** После перезагрузки поля пустые (форма не показывает сохранённое).
4. Кнопка «Re-run research» при уже идущем research заблокирована; при завершённом — ставит прогон заново. На проходе жать её не нужно, это только проверка состояния кнопки.

---

### 17.4 Шаг «02 · Verticals» и запуск автопилота

1. Пока research не закончился — «No verticals yet — they appear once the research finishes (step 1).»
2. После research: карточки вертикалей (`#rank`, имя, `%`, «N/M accepted») с гипотезами внутри. У гипотезы — бейдж уровня «Tier 1 · obvious» / «Tier 2 · adjacent» / «Tier 3 · non-obvious», процент потенциала и кнопки «Accept» / «Reject».
3. Принять 1–2 гипотезы у одной вертикали, одну отклонить.
   - **Pass.** Счётчик вверху «N of M hypotheses accepted — accepted ones drive the base collection on step 4.» пересчитался, бейджи статусов сменились.
   - **Network.** `PATCH /api/client/eng/hypotheses/<id>` → 200.
4. Кнопка «Start outreach» (появляется только у проекта в статусе `researched` с хотя бы одной принятой гипотезой).
   - **Pass.** После нажатия — зелёная плашка вида «Autopilot started — queued 1 chain · 1 base collect. Review & Launch fills in as stages finish.», кнопка переходит в «Autopilot running…».
   - **Network.** `POST /api/client/eng/projects/<id>/autopilot` → 200.
   - **Red flag.** Кнопки нет при принятых гипотезах; плашка пустая; повторные нажатия плодят новые джобы тех же стадий.
   - **Важно.** Выключателя автопилота в кабинете нет — см. 17.13. После прохода флаг снимается вручную.

---

### 17.5 Шаг «03 · Letters»

1. Пока цепочка генерируется — «generation in progress…» у вертикали; до запуска автопилота — «No letters yet — the autopilot generates them after «Start outreach» on step 2.»
2. Готовая цепочка: бейдж «language: en», счётчик «N steps», письма «Step 1…N» с темой и телом, у шагов 2+ — «wait N days».
   - **Pass.** Язык именно `en`; тексты писем английские; подпись отправителя из шага Brief стоит в конце письма.
   - **Red flag.** `language: ru` на us-проекте; русские фразы или русские примеры внутри писем; в теме шаблон вида `{{firstName}}`, который некому подставить.
3. Поправить одно письмо (например, убрать слово из темы) — появляется кнопка «Save changes».
   - **Pass.** После сохранения правка остаётся на месте после перезагрузки страницы.
   - **Network.** `PATCH /api/client/eng/chains/<id>` → 200.

---

### 17.6 Шаг «04 · Bases & Launch»

Это витрина прогресса: кнопок запуска здесь нет, всё гонит автопилот.

1. Идущая сборка: «Collecting base (limit 2,000)…», список задач построчно (`статус` · источник · `N rows`) и строка итога «X/Y tasks · N rows».
   - **Pass.** Число задач и строк растёт; лимит в заголовке — 2,000 (кабинет не умеет меньше).
   - **Red flag.** Сборка стоит на нулях больше получаса без активной джобы.
2. Решения автопилота (показываются, только если они были): «The plan had no company catalog — the autopilot added one.», «Audience check: the first catalog slice matched the vertical in N% of sampled companies, so it was replaced — the new one matches M%.», «Audience check failed: only N% of K sampled companies belonged to this vertical … The base was not built on purpose — mailing such a list would hurt the verticals that do work.»
   - **Pass.** Если база не построена — причина написана этим текстом, а не просто `failed`.
3. Обогащение почтой: «Finding & validating emails…», затем «Emails found: X · valid: Y».
4. Анализ: бейдж `analyzing` и «Analyzing the base…», затем `analyzed` и строки «Segments: …» / «Angles: …».
5. Шаблон: «Building template…», затем бейдж «template: ready», «N letters» и плашка «Template is ready — launch it from step 5 «Review & Launch».»
   - **Red flag.** Бейдж «template: draft» висит без активной `template`-джобы; база `analyzing` без джобы (оба — признак застрявшего состояния, а не медленной работы).
6. Упавшая база показывает причину под бейджем `failed`.
   - **Red flag.** Причина по-русски (например, «Выбранные гипотезы не найдены или все отклонены») или называет провайдера — см. 17.10.

---

### 17.7 Шаг «05 · Review & Launch»

1. Пока автопилот не довёл ни одну вертикаль — «Autopilot is still working — letters, bases and templates will appear here once they are ready.» и ссылка «See Command Center».
2. По готовым вертикалям — карточка с письмами (тот же редактор, что на шаге 3), базой и бейджем «template: ready».
3. Кнопка «Preview base» → таблица первых 100 строк: колонки `company`, `website`, `email` и «email status», внизу «Showing 100 of N rows».
   - **Pass.** У строк со статусом `ok` заполнен `email`; статус стоит **у того адреса, который в колонке `email`**, а не у соседнего.
   - **Network.** `GET /api/client/eng/bases/<id>/rows?limit=100` → 200.
   - **Red flag.** В ячейке `email` несколько адресов через запятую; пустой `email` при статусе `ok`.
4. Панель запуска вверху: селектор пресета («Sending preset»), кнопка «Launch all (paused)», подпись «N templates ready — campaigns stay paused for review».
5. Нажать «Launch all (paused)».
   - **Pass.** Появляется счётчик «Launched 1/1», карточка вертикали получает бейдж «launched (paused)». Сама запись о запуске — на шаге «04 · Bases & Launch»: бейдж «launched (paused)», имя кампании обычным текстом, «N contacts · <дата>» и подпись «The campaign stays paused — the team reviews and starts it manually.»
   - **Network.** `POST /api/client/eng/templates/<id>/launch` → 200 с `{ ok: true, launch: {...} }`.
   - **Red flag.** В `launch` есть `campaign_url` — волна 0 его убрала, это ссылка на панель рассыльщика.
   - **Pass (в самом рассыльщике, глазами менеджера).** Кампания создана **на паузе**, число лидов в ней совпадает с «N contacts» на карточке шага 4, письма никуда не ушли.
   - **Red flag.** Кампания создана активной; лидов в кампании больше, чем строк со статусом `ok` в превью базы; повторное нажатие создало вторую кампанию на тот же шаблон.
6. Проверить **имя кампании** — см. 17.10, пункт про префикс.

---

### 17.8 «Cancel all jobs»

Кнопка видна только пока есть активные джобы, поэтому проверять её нужно на живом прогоне (например, сразу после «Start outreach» на второй вертикали).

1. Нажать «Cancel all jobs».
   - **Pass.** Кнопка переходит в «Cancelling…», активные джобы исчезают, базы, ждавшие эти джобы, становятся `failed`, и под бейджем написано «The run was cancelled before this step finished. Everything collected before the stop is saved — start it again whenever you are ready.» Строка `Cancelled by user` остаётся в колонке `error` для staff: в кабинет она не едет вовсе — ни на экран, ни в тело ответа (там только код причины).
   - **Network.** `POST /api/client/eng/projects/<id>/cancel` → 200.
   - **Red flag.** 500; джобы остались `running`; после отмены конвейер сам продолжился (значит, автопилот не остановлен — ожидаемое сегодня поведение, фиксировать строкой в отчёте, см. 17.13).
2. Нажать ещё раз, когда активных джоб уже нет.
   - **Pass.** Ответ 409 «No active jobs — nothing to cancel», интерфейс просто перечитывает проект и не показывает ошибку-страшилку.

---

### 17.9 Command Center (`/client/eng/dashboard`)

1. Шапка: «Command Center», «Live view across all your verticals — refreshed every 15s.», кнопка «All projects».
2. Блок «01 → Today»: карточки «Collected today» / «new companies harvested», «Valid today» / «emails passed validation», «Appended today» / «leads added to campaigns» и «Auto-refill».
   - **Pass.** Цифры дня совпадают с тем, что показал мастер (собранные компании, валидные почты, добавленные лиды). «Auto-refill» показывает «off» и «daily refill is not configured» — сегодня это норма (см. 17.13).
   - **Red flag.** «Auto-refill» показывает обратный отсчёт и «next run 03:20 UTC», хотя конфиг долива никто не заводил.
3. Блок «Right now» (виден, пока есть активные джобы): строки вида «collecting the base · <вертикаль>» с прогрессом `done/total`.
   - **Red flag.** Русские подписи прогресса — см. 17.10.
4. Блок «02 → Verticals»: карточка вертикали со status-тегом (`research`, `letters`, `collecting`, `enrichment`, `analysis`, `analyzed`, `ready to launch`, `live`) и картой конвейера «Research → Letters → Lead base → Email enrichment → Analysis → Template → Launch» (+ «Daily refill» у запущенной), строкой «next: …» и кнопкой «Continue» / «View».
   - **Pass.** Кнопка ведёт ровно на тот шаг мастера, который назван текущим; цифры на карте (компании, `valid / found`, лиды) совпадают с мастером.
   - **Red flag.** Вертикаль помечена `live`, хотя кампания создана на паузе и никем не запущена — кабинет врёт про состояние.
5. Пустое состояние (у клиента без вертикалей): «No verticals yet — create a project» и кнопка «Create a project».
6. Блок «03 → Recent activity» — лента событий с относительным временем («just now», «5m ago»).

---

### 17.10 Сквозные проверки волны 0

Эти пять проверок — причина, по которой проход вообще существует. Делать их **на каждом экране**, а не один раз в конце.

**(а) Ни бренда рассыльщика, ни ссылок на него.**

- [ ] Ctrl+F по странице дашборда и мастера: слова `Instantly` нет нигде.
- [ ] На карточке вертикали в Command Center **не должно быть кнопки «Open in Instantly»**: до волны 0 она там была, её уборка — часть волны, и первый же проход обязан это подтвердить.
- [ ] Ссылок наружу в кабинете нет вовсе: на карточке запуска (шаг 4) имя кампании и список «Segment campaigns (N)» — обычный текст, в строке «Launch» на дашборде имя кампании тоже не кликается. До волны 0 все три были ссылками на `app.instantly.ai`; любая кликабельная из них — красный флаг.
- [ ] В теле ответов `GET /api/client/eng/projects/<id>` и `GET /api/client/eng/dashboard` нет подстроки `instantly`.

**(б) Ни одного русского слова в клиентском контуре.**

- [ ] Навести курсор на пункт сайдбара «Outreach» — подсказка (tooltip) должна быть английской при любом значении переключателя языка. Русское описание пункта меню всплывает, когда язык интерфейса аккаунта — русский; это красный флаг, а не настройка тестировщика.
- [ ] Блок «Right now»: подписи прогресса стадий research английские — «checking a hypothesis», «studying a competitor», «mapping a brand». Их русские двойники («проверяем гипотезу», «изучаем конкурента», «разбираем бренд») обслуживают внутренний RU-инструмент; в ENG-кабинете любой из них — красный флаг и признак, что рынок проекта прочитался как `ru`.
- [ ] Текст ошибки под упавшей базой и строка «Last error: …» в шапке проекта — только по-английски.
- [ ] Любой 4xx/5xx в Network: тело не содержит «Сервис временно недоступен — обновите страницу», «Демо-режим: …», «система рассылки». Последнее — подстановка вместо вычищенного бренда: в английском кабинете она сама по себе утечка. Смотреть в первую очередь экран «Sending mailboxes»: его роут `/api/client/mailboxes` общий с RU-кабинетом, то есть русский текст там и живёт — кабинет запроса роут определяет сам, по хосту и рынку клиента.
- [ ] Примечания сборки («реестр исчерпан», «достигнут предел сканирования 200k…») в прогрессе базы — тоже красный флаг.
- [ ] Русский текст на шаге Launch (например, «Слишком много лидов для запуска из мастера…») означает, что рынок проекта прочитался как `ru` — это не косметика, а неверная ветка конвейера. Фиксировать отдельно и с приоритетом.

**(в) Ни себестоимости, ни внутренней кухни.**

- [ ] В теле `GET /api/client/eng/projects/<id>` (ответ приходит каждые 4 секунды) поиском проверить, что **нет** ни одного из: `cost_usd`, `tokens_used`, `llm_model`, `pdl_filters`, `child_job_id`, `bc_job_id`, `collect_info` → `plan`. Волна 0 сузила деталку белым списком полей (`lib/hypothesisEngine/clientEngProjection.ts`), и проверять надо именно тело ответа: на экране этих полей не было и до волны, сломаться может ровно проекция.
- [ ] На экране нет ни одной суммы в долларах, ни числа токенов, ни названия модели (`openrouter`, `gpt`, `claude`, `requesty`).
- [ ] В прогрессе сборки не видно внутренних имён источников и параметров запроса к каталогу.

**(г) Ошибки — английские, без имени провайдера.**

- [ ] Открыть чужой проект: подставить в адрес `/client/eng/projects/<чужой-uuid>` → на экране «Project not found» (не «Forbidden», не пустая страница).
- [ ] Подставить заведомо кривой id (`/client/eng/projects/not-a-uuid`) → **Red flag**, если в ответе видно `invalid input syntax for type uuid` или любой другой текст Postgres.
- [ ] Ни одна ошибка не называет провайдера: `Requesty`, `OpenRouter`, `PDL`, `People Data Labs`, `Serper`, `Instantly`.

**(д) Имя кампании.**

- [ ] Имя запущенной кампании в кабинете (шаг 4 и дашборд) не должно начинаться с префикса `HE · ` и не должно содержать русского слова `база` (оно подставлялось, когда у базы нет имени файла). Волна 0 чистит имя и на записи (новые us-запуски), и на чтении (старые записи), так что в кабинете любой из двух — красный флаг.
- [ ] В самом Instantly проверяется только **новая** кампания этого прохода: у неё префикса и русского фолбэка быть не должно. У кампаний, запущенных до волны 0, имя в рассыльщике осталось прежним намеренно — переименовывать живые кампании волна не стала, по старому имени их ищет staff.

---

### 17.11 Изоляция клиентов

1. Записать `project_id` и `base_id` первого клиента (видны в адресе мастера и в Network).
2. В другом окне войти вторым тестовым клиентом и открыть `/client/eng/projects/<project_id первого>`.
   - **Pass.** На экране «Project not found», в Network — ровно **404**. Факт существования чужого проекта не раскрывается.
   - **Red flag.** 200 с чужими данными, 403 (раскрывает существование) или 500.
3. Там же подменить id в запросе `GET /api/client/eng/bases/<base_id первого>/rows` → 404 «Base not found».

---

### 17.12 Уборка после прохода (обязательна)

Без неё каждая волна оставляет мусор в рабочем Instantly-воркспейсе и живой автопилот на тестовом проекте.

1. [ ] Удалить (или архивировать) созданные paused-кампании и загруженные в них лиды.
2. [ ] «Cancel all jobs» на тестовом проекте, если что-то ещё идёт.
3. [ ] Снять флаг автопилота у тестового проекта — это **прод-изменение, согласовать с владельцем**: из кабинета выключателя нет (см. 17.13).
4. [ ] Записать строку в таблицу прогонов в начале раздела.
5. [ ] Помнить про общий лимит: пока на проде жив `portal-worker-instantly-leads`, не дёргать Instantly `/emails` чаще 10 запросов в минуту (инцидент 22 мая, `wiki/log.md`).

---

### 17.13 Известные ограничения — не считать их багами

Пункты ниже **не проверяются** в ручном проходе, пока соответствующая работа не сделана. Помечать их «н/д» и не переписывать чек-лист под них.

- **Автопилот не выключается из кабинета.** Единственный роут пишет `autopilot: true`, PATCH/DELETE для него нет, «Cancel all jobs» флаг не снимает — крон продолжит доливать после «отмены всего». Пункт «выключить автопилот» станет исполнимым после работ по застрявшим состояниям и подтверждению отмены; до тех пор — ручное снятие флага из 17.12.
- **Ежедневный долив не включается из кабинета.** Конфиги долива заводятся вручную в БД (см. шапку `app/worker/heAutoPipelineCron.ts`), крон ходит в 03:20 UTC. В проходе проверяем только, что карточка «Auto-refill» честно показывает «off». Включить долив «чтобы проверить» нельзя: это прод-изменение, которое заводит клиенту ежесуточный расход, а выключить его из кабинета нечем.
- **Маленького прогона не существует.** Минимальный лимит сборки — 2000 строк.
- **Пресет отправки заводит менеджер.** Пока пресета нет, шаг 17.7 упирается в «No sending preset configured yet — ask your manager to set one up.» — это ожидаемо, а не баг кабинета.
