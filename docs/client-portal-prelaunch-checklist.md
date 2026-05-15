# Client Portal — Pre-launch checklist

**Goal.** Walk through this checklist with a real test-client account before each new client is invited. Every item has an explicit pass criterion and an explicit red-flag signal. If anything is red, do not invite the client until it's fixed.

**Excluded from this checklist.** `/client/launch` (campaign launch wizard). Those flows are not in scope for the first paying client.

**Pre-requisites for the run.**

- A test client user with `role='client'` in `public.profiles`. Pick someone who has at least one project assigned, at least one Instantly campaign in their `client_instantly_access` rows, and at least one forwarded reply for that campaign.
- A separate "second" test client (or admin) so we can confirm cross-client isolation by trying to read the first client's resources from a second tab. If you can't easily set this up, mark the cross-client checks as N/A and rely on the automated tests in `app/tests/api/clientPortalSmoke.test.ts` (RBAC suite, 11 cases).
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
3. **Cross-client isolation.** Log in as the second test client. Confirm you only see your own campaigns. Then in the network tab manually edit a request URL to use the first client's `campaign_id` — the API must return 404. (The smoke test suite locks this with 11 RBAC cases; this manual step is just a sanity check on prod.)
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

## 15. What's covered automatically (don't re-test manually)

These are locked by `app/tests/api/clientPortalSmoke.test.ts` (55 tests, runs in <1 s):

- Auth boundary on every `/api/client/*` endpoint (401 without token, 403 for non-client role).
- Empty new-user state shape for: onboarding, brief, preset, tariff, campaigns, leads, bases, projects.
- Brief save round-trip + hypotheses gate (no brief → 400, cached path doesn't call LLM, regenerate=1 forces a fresh call, audience='client' is passed so the prompt drops the «Сигналы» branch).
- RBAC across clients on every campaign-bound endpoint (campaigns/[id], replies, thread, reply, forward, activate, pause) and lead comments.
- Cross-campaign emailId leak (using a known-allowed `campaign_id` with a foreign `emailId` → 404).
- Reports scope filtering (forbidden IDs dropped silently, all-forbidden → 400, no synced data → 503).

If any of those test cases fails, that's a higher-priority signal than anything in the manual checklist.

---

## 16. After the run

If everything is green:

1. Tag the manual run in your records (date, tester, test-client name, prod build sha).
2. Take screenshots of each empty state and each populated page — useful for first-client onboarding docs.
3. Confirm with the tech lead that prod is on the latest deploy SHA.

If anything is red:

1. Capture: page URL, network request URL + status, response body, browser console errors.
2. Open an issue (or message Sergey) with all of the above.
3. Re-run the smoke jest suite — if it's green, the bug is UI-only; if it's red too, there's a backend regression.
