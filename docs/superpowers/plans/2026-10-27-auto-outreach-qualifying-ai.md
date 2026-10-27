# Квалифицирующий ИИ для автоаутрича RU/EN — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ответ лида с интересом в папках «Рассылки» `auto_ru`/`auto_en` ведёт ИИ: отвечает в той же переписке, проверяет актуальность, просит слоты/телефон/контакт и только тогда передаёт лида в Telegram и AMO.

**Architecture:** новый модуль `app/src/lib/senderAiQualifier/` в воркере `worker-sender-leads` (139) встаёт между квалификацией ответов и доставкой лидов в `runSenderLeadsPass`. Состояние разговора — таблица `sender_ai_conversations` (одна строка на получателя). Письма ИИ ставятся в существующую очередь `sender_manual_messages` (флаг `by_ai`) и уходят через `manualWorker` на sender-хостах. Доставка в Telegram/AMO остаётся прежней (`deliverLeads` → RPC `enqueue_sender_auto_leads_crm`), но для переписок ИИ пропускает только строку передачи.

**Tech Stack:** TypeScript, Next.js 16 (API-роуты), Supabase/Postgres, Requesty (OpenAI-совместимый `chat/completions`), esbuild-воркеры.

**Spec:** `docs/superpowers/specs/2026-10-27-auto-outreach-qualifying-ai-design.md` — читать вместе с планом.

## Global Constraints

- Только папки `auto_ru`/`auto_en` (кампании `polza_ru`/`polza_en`). OutreachOS, Instantly-кампании, клиентские рассылки не трогаем.
- **Новые `*.test.ts`/`*.test.tsx` не создавать** (CLAUDE.md). Проверка — scratch-скрипты (esbuild из `app/node_modules`, файлы в scratchpad), холостой прогон на проде, eslint и точечный TS7.
- Не запускать dev-сервер, полный typecheck и полный jest локально. Typecheck — временный `tsconfig.scratch-*.json` с `files` + `node node_modules/typescript-7/bin/tsc -p … --checkers 1`, затем удалить файл.
- Миграция: новая таблица — `enable row level security`, `revoke all … from anon, authenticated`, `grant all … to service_role` (иначе падает `tests/migrations/grants.test.ts`). Применённые миграции не переписывать.
- SMTP — только на sender-хостах через `manualWorker`; на 139 только очередь.
- ИИ — Requesty. Ключ `SENDER_AI_QUALIFIER_API_KEY`, при пустом — `SENDER_LEADS_AI_API_KEY`. Модель `SENDER_AI_QUALIFIER_MODEL`, по умолчанию `policy/gemini-flash` (та же политика, что у квалификатора, — уже одобрена на этом ключе).
- Квалификация (решение пользователя): передаём, когда лид **подтвердил актуальность** И прислал **слоты, телефон или контакт** (почта «давайте по почте» тоже контакт).
- На «пришлите КП / сколько стоит / расскажите» — короткое КП (5–7 строк) из текста настройки «Короткое КП», затем «Актуально? Пришлите пару удобных слотов или телефон». Цены, кейсы, сроки — только из этого текста. Бюджет не спрашивать.
- Не больше **3** писем ИИ на лида; напоминание одно, через **2 рабочих дня** молчания; ответ — не раньше чем через 5 минут после письма лида и только в окне отправки папки.
- Письма ИИ: тот же ящик (`sender_recipients.mailbox_id`), `In-Reply-To` = письмо лида, без ссылок и вложений, язык ответа лида (иначе `ru` для `auto_ru`, `en` для `auto_en`).
- Письмо передачи — с копией на адреса `agency_lead_handoff_settings.cc_emails` того же скоупа (`auto_ru`/`auto_en`); шаблон автопередачи для переписок ИИ не отправляется.
- Не писать: отписке/стоп-листу/отбою, ручной метке «лид»/«не лид», после ручного ответа оператора, при открытой сделке в AMO (по копии `amo_leads_with_origin_v`).
- Подписи на экранах короткие (одна строка). Файлы с CRLF сохраняют CRLF. Коммиты — явными путями.

## Review Focus

1. Лид прислал два письма подряд, пока ИИ не ответил → ИИ отвечает **одним** письмом, видя оба (Task 4: обработка берёт самое свежее письмо, история — все).
2. Лид пишет «не пишите / отпишите» посреди разговора → ИИ больше не пишет ни строки (Task 4 стоп-проверка + Task 5 перепроверка в `manualWorker`).
3. Оператор ответил с портала или поставил метку → разговор `stopped`, письма ИИ из очереди не уходят (Task 4, Task 5).
4. Ответ лида в пятницу вечером/ночью → письмо ИИ встаёт на начало следующего окна, не ночью (Task 2 `replyDueAt`, Task 4).
5. Модель вернула мусор или Requesty недоступен трижды → разговор `failed`, лид уходит менеджерам **прежним путём** и не теряется (Task 4, Task 5 `deliverLeads`).

---

## Карта файлов

| Файл | Что | Task |
|---|---|---|
| `supabase/migrations/20261027_0010_sender_ai_qualifier.sql` | создать: таблица, колонки папки, флаг письма, claim RPC | 1 |
| `app/src/lib/senderAiQualifier/types.ts` | создать: типы состояния и шага ИИ | 2 |
| `app/src/lib/senderAiQualifier/decide.ts` | создать: чистая логика решений и времени | 2 |
| `app/src/lib/senderAiQualifier/ai.ts` | создать: промпт и вызов Requesty | 3 |
| `app/src/lib/senderAiQualifier/amo.ts` | создать: открытая сделка в AMO | 4 |
| `app/src/lib/senderAiQualifier/engine.ts` | создать: старт и ход разговоров, очередь писем, передача | 4 |
| `app/src/lib/senderLeads/process.ts` | изменить: вызов движка, фильтр `deliverLeads` | 5 |
| `app/src/lib/senderLeads/settings.ts` | изменить: поля ИИ у папки | 5 |
| `app/src/lib/agencyLeadHandoff/process.ts` | изменить: `withHistory` экспорт, пропуск переписок ИИ | 4, 5 |
| `app/src/lib/sender/manualWorker.ts` | изменить: перепроверка и без повтора для `by_ai` | 5 |
| `app/src/lib/senderLeads/history.ts`, `app/src/app/api/tools/sender-leads/settings/route.ts`, `app/src/components/senderLeads/QualificationTab.tsx`, `app/src/components/senderLeads/api.ts` | изменить: настройки ИИ | 6 |
| `app/src/app/api/tools/sender-leads/verdict/route.ts`, `app/src/components/senderLeads/LeadVerdictBar.tsx`, `app/src/app/api/tools/sender/threads/[id]/route.ts` | изменить: состояние ИИ и пометка писем | 7 |
| `app/worker/senderAiQualifierDryRunCli.ts`, `app/package.json`, `Dockerfile.worker` | создать/изменить: холостой прогон | 8 |

---

### Task 1: Миграция

**Files:**
- Create: `supabase/migrations/20261027_0010_sender_ai_qualifier.sql`

**Interfaces:**
- Produces: таблица `public.sender_ai_conversations`; колонки `sender_folders.ai_enabled boolean not null default false`, `ai_enabled_at timestamptz`, `ai_offer_text text`; `sender_manual_messages.by_ai boolean not null default false`.

- [ ] **Step 1: Таблица `sender_ai_conversations`**

Колонки (ровно эти имена, их читают Task 4–8):
`recipient_id uuid primary key references sender_recipients(id) on delete cascade`,
`campaign_id uuid not null references sender_campaigns(id) on delete cascade`,
`folder_key text not null check (folder_key in ('auto_ru','auto_en'))`,
`state text not null default 'active' check (state in ('active','handed_off','no_reply','closed','stopped','failed'))`,
`ai_messages integer not null default 0`, `reminder_sent boolean not null default false`,
`last_reply_id uuid references sender_replies(id) on delete set null` (последнее обработанное письмо лида),
`trigger_reply_id uuid not null references sender_replies(id) on delete cascade` (ответ, с которого начали),
`last_ai_sent_at timestamptz`, `next_action_at timestamptz`,
`handoff_reply_id uuid references sender_replies(id) on delete set null`, `handoff_contact text`, `summary text`,
`attempts integer not null default 0`, `last_error text`,
`started_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
Индекс `(state, next_action_at)`. RLS/revoke/grant — по Global Constraints.

- [ ] **Step 2: Колонки папки и письма** — `alter table … add column if not exists` для полей из Interfaces.

- [ ] **Step 3: `claim_sender_manual_messages`** — `create or replace` с телом из `20261023_0120_sender_client_handoff.sql`, в stale-ветке добавить `and not mm.by_ai`: письмо ИИ, зависшее в `sending`, повторно не забирается (могло уйти).

- [ ] **Step 4: Проверка** — `npx jest tests/migrations` из `app/` (тесты, читающие миграции).
Expected: PASS.

- [ ] **Step 5: Commit** — `git add supabase/migrations/20261027_0010_sender_ai_qualifier.sql && git commit -m "ИИ-квалификатор автоаутрича: миграция …"`

### Task 2: Типы и чистая логика решений

**Files:**
- Create: `app/src/lib/senderAiQualifier/types.ts`, `app/src/lib/senderAiQualifier/decide.ts`

**Interfaces:**
- Produces:
  - `type AiState = 'active' | 'handed_off' | 'no_reply' | 'closed' | 'stopped' | 'failed'`
  - `interface AiStep { relevant: 'yes' | 'no' | 'unclear'; contact: string | null; outcome: 'continue' | 'handoff' | 'close' | 'counter_offer'; reply: string; summary: string }`
  - `type AiDecision = { kind: 'handoff'; letter: string; contact: string; summary: string } | { kind: 'reply'; letter: string } | { kind: 'close'; letter: string | null } | { kind: 'no_reply' }`
  - `parseAiStep(raw: string): AiStep` — берёт первый JSON-объект из текста (модель может обернуть в ```json), проверяет поля; при ошибке бросает `Error`.
  - `decideStep(step: AiStep, ctx: { aiMessages: number; stopRequested: boolean }): AiDecision`
  - `addBusinessDays(from: Date, days: number, timezone: string): Date` — пропускает сб/вс в поясе папки.
  - `replyDueAt(receivedAt: Date, window: SendWindow): Date` = `nextWindowSlot(receivedAt + 5 мин, window)` (`SendWindow`, `nextWindowSlot` из `lib/sender/sendWindow.ts`).
  - `reminderDueAt(lastAiSentAt: Date, timezone: string): Date` = `addBusinessDays(lastAiSentAt, 2, timezone)`.

- [ ] **Step 1: Реализовать `decideStep` по правилам** (код решает, а не доверяет `outcome` модели):
  - `relevant === 'yes'` и непустой `contact` → `handoff` (даже если модель написала `continue`).
  - `outcome === 'handoff'` без `contact` или без `relevant==='yes'` → понижается до `reply`.
  - `outcome === 'counter_offer'` → `close` с `letter: null`.
  - `outcome === 'close'` → `close`; `letter: null`, если `stopRequested`.
  - `reply`/`continue` при `aiMessages >= 3` → `no_reply` (лимит писем).
  - пустой `reply` при решении, требующем письма → `Error('пустое письмо')`.

- [ ] **Step 2: Проверочный scratch-скрипт** `…/scratchpad/ai-qualifier/decide-check.ts` (бандл esbuild с `NODE_PATH=app/node_modules`): `console.assert` на случаи —
  - `{relevant:'yes', contact:'+7 999 …', outcome:'continue'}` → `handoff`;
  - `{relevant:'unclear', contact:'+7…', outcome:'handoff'}` → `reply`;
  - `{outcome:'counter_offer'}` → `close`, `letter === null`;
  - `aiMessages: 3`, `outcome:'continue'` → `no_reply`;
  - `parseAiStep('```json\n{...}\n```')` разбирается; `parseAiStep('нет json')` бросает;
  - `addBusinessDays(пт 15:00 МСК, 2, 'Europe/Moscow')` → вт 15:00 МСК;
  - `replyDueAt(сб 12:00, окно будни 7–18 МСК)` → пн 07:00 МСК.
  Run: `node <bundle>` → нет сообщений `Assertion failed`.

- [ ] **Step 3: eslint по двум файлам** — `npx eslint --max-warnings=0 src/lib/senderAiQualifier/types.ts src/lib/senderAiQualifier/decide.ts` → без ошибок.

- [ ] **Step 4: Commit** (явные пути).

### Task 3: Промпт и вызов модели

**Files:**
- Create: `app/src/lib/senderAiQualifier/ai.ts`

**Interfaces:**
- Consumes: `AiStep`, `parseAiStep` (Task 2).
- Produces:
  - `interface AiQualifierConfig { apiKey: string; model: string }`
  - `aiQualifierConfig(env?: NodeJS.ProcessEnv): AiQualifierConfig | null` — ключи/модель из Global Constraints.
  - `interface AiPromptInput { language: 'ru' | 'en'; offerText: string; mode: 'reply' | 'reminder'; aiMessages: number; ccEmail: string | null; history: Array<{ from: 'us' | 'lead'; at: string | null; text: string }> }`
  - `buildAiMessages(input: AiPromptInput): Array<{ role: 'system' | 'user'; content: string }>`
  - `requestAiStep(cfg: AiQualifierConfig, input: AiPromptInput): Promise<AiStep>` — POST `https://router.requesty.ai/v1/chat/completions`, `temperature 0.3`, `max_tokens ≥ 800`, таймаут 60 с, `parseAiStep` ответа.

- [ ] **Step 1: Системный промпт** — обязательные правила (формулировки на усмотрение исполнителя):
  - роль: сотрудник, который вёл эту переписку; подпись — как в наших письмах выше;
  - цель: выяснить, актуально ли, и получить слоты/телефон/контакт; не назначать встречу самому;
  - на КП/цену/«расскажите» — короткое КП 5–7 строк **только** из `offerText`, затем вопрос про актуальность и слоты/телефон;
  - не придумывать цены, сроки, скидки, гарантии, кейсы; чего нет в `offerText` — «это подробно разберёт менеджер — пришлите удобные слоты или телефон»;
  - бюджет не спрашивать; не больше одного-двух вопросов в письме; без ссылок; язык — язык последнего письма лида (`language` — запасной);
  - ответил не тот человек — попросить контакт ответственного за привлечение клиентов;
  - `mode: 'reminder'` — одно короткое напоминание к прошлому письму;
  - при передаче (`relevant=yes` и есть контакт): письмо-благодарность, что коллега свяжется; если `ccEmail` задан — «напишет с адреса <ccEmail>»;
  - отказ/«не актуально» → `outcome: close`, одна вежливая строка; встречное предложение → `counter_offer`;
  - ответ — строго JSON `AiStep`; `summary` — 1–3 строки для менеджера (кто, что нужно, что прислал).

- [ ] **Step 2: Проверка сборки промпта** — scratch-скрипт печатает `buildAiMessages` для истории «наше письмо → лид: Пришлите КП» с `offerText` из 3 строк; глазами: КП-текст и правила на месте, история в порядке времени.

- [ ] **Step 3 (по возможности): живой вызов** — тот же скрипт с рабочим ключом Requesty (если локальный ключ не пускает к модели — пропустить, проверка будет холостым прогоном Task 8 на проде). Expected: валидный `AiStep`, письмо с КП и вопросом про слоты.

- [ ] **Step 4: eslint + Commit.**

### Task 4: Движок разговоров

**Files:**
- Create: `app/src/lib/senderAiQualifier/amo.ts`, `app/src/lib/senderAiQualifier/engine.ts`
- Modify: `app/src/lib/agencyLeadHandoff/process.ts` (сделать `withHistory` экспортом без изменения поведения)

**Interfaces:**
- Consumes: Task 2, Task 3; `buildMessageId` (`lib/mail/message`); `withHistory` (`lib/agencyLeadHandoff/process`); `loadHandoffSettings` (`lib/agencyLeadHandoff/settings`).
- Produces:
  - `hasOpenAmoDeal(db: SupabaseClient, email: string): Promise<boolean>` — `amo_leads_with_origin_v`: `closed_at is null` и `status_id` не 142/143, по `contact_email` (без учёта регистра) или по домену почты в `company_website` (домены бесплатной почты не сопоставлять по сайту).
  - `runSenderAiQualifier(db: SupabaseClient, log: Log): Promise<{ started: number; letters: number; handedOff: number; closed: number }>` — `Log` из `lib/senderLeads/process`.

- [ ] **Step 1: Старт разговоров** (`startConversations`, внутри engine): строки `sender_reply_qualifications` со `status='lead'`, `tg_sent_at is null`, `tg_attempts < 5`, у папки `ai_enabled`, `leads_enabled`, `leads_telegram`, ключ `auto_ru|auto_en`, `qualified_at >= ai_enabled_at`. Разговор **не** создаётся (лид идёт старым путём), если: у получателя уже есть разговор; `status` в `unsubscribed|bounced|stopped`; `lead_verdict_source='manual'`; есть ручное письмо оператора (`agency_handoff_id is null and handoff is null and not by_ai`); по получателю уже есть `tg_sent_at`; `hasOpenAmoDeal`. Иначе вставка `state='active'`, `trigger_reply_id`, `next_action_at = replyDueAt(received_at, окно папки)`.

- [ ] **Step 2: Ход разговора** (`processDue`): разговоры `state='active'`, `next_action_at <= now()`. По порядку:
  1. стоп-проверки из Step 1 (кроме AMO) → `state='stopped'`;
  2. самое свежее письмо лида `kind='human'` новее `last_reply_id` (с начала — `trigger_reply_id`); если его строка квалификации ещё `pending`/отсутствует — перенести `next_action_at` на +2 мин;
  3. нет нового письма: если `last_ai_sent_at` и прошёл `reminderDueAt` — при `!reminder_sent && ai_messages < 3` режим `reminder`, иначе `state='no_reply'`; если срок не наступил — `next_action_at = reminderDueAt`;
  4. вне окна отправки — `next_action_at = nextWindowSlot(now)`, выход;
  5. `requestAiStep` с историей: `sender_messages` (sent) + `sender_replies` human + отправленные `sender_manual_messages` — по времени;
  6. `decideStep` и действие:
     - `handoff` → письмо с CC (скоуп = `folder_key`, адреса минус ящик и лид), `state='handed_off'`, `handoff_reply_id`, `handoff_contact`, `summary`; строке квалификации этого письма: `status='lead'`, `ai_reason = «Передал ИИ. Контакт: … . <summary>»`, `tg_attempts=0`, `tg_error=null`;
     - `reply` → письмо, `ai_messages+1`, `last_ai_sent_at=now`, `reminder_sent` = (режим reminder), `next_action_at = reminderDueAt(now)`;
     - `close` → письмо (если есть), `state='closed'`; `no_reply` → `state='no_reply'`;
  7. `last_reply_id` = обработанное письмо, `attempts=0`, `last_error=null`.
  Ошибка модели/разбора: `attempts+1`, `last_error`, `next_action_at=+10 мин`; при `attempts >= 3` — `state='failed'`, строке квалификации `trigger_reply_id` сбросить `tg_attempts=0`, `tg_error=null` (уйдёт менеджерам прежним путём).

- [ ] **Step 3: Очередь письма** (`enqueueAiLetter`): вставка в `sender_manual_messages` с `id = randomUUID()`, `by_ai: true`, `status: 'queued'`, `mailbox_id` = закреплённый ящик получателя, `to_email` = `from_email` письма лида (иначе адрес получателя), `subject` = `Re: <тема письма лида>` (без двойного `Re:`), `in_reply_to` = `message_id` письма лида, `message_id = buildMessageId(ящик)`, `body = withHistory(письмо, история)`, `cc_emails` только у письма передачи. Нет ящика/`message_id` — ошибка шага (уходит в `attempts`).

- [ ] **Step 4: Проверка** — eslint + TS7 по файлам Task 2–4; scratch-скрипт с подменённым `db` (минимальный объект с `from().select()…`) не нужен — поведение проверяется холостым прогоном Task 8 и Review Focus в Task 9.

- [ ] **Step 5: Commit.**

### Task 5: Встраивание в воркер и отправку

**Files:**
- Modify: `app/src/lib/senderLeads/settings.ts`, `app/src/lib/senderLeads/process.ts`, `app/src/lib/agencyLeadHandoff/process.ts`, `app/src/lib/sender/manualWorker.ts`

**Interfaces:**
- Consumes: `runSenderAiQualifier` (Task 4).
- Produces: `LeadSettings.aiEnabled: boolean`, `LeadSettings.aiEnabledAt: string | null`, `LeadSettings.aiOfferText: string | null` (выборка `sender_folders` в `loadCampaignSettings` дополняется этими колонками).

- [ ] **Step 1: `runSenderLeadsPass`** — после цикла квалификации и до `deliverLeads`: `const ai = await runSenderAiQualifier(db, log)` в своём `try/catch` (сбой ИИ не ломает квалификацию и доставку); счётчики добавить в лог круга в `worker/senderLeads.ts`.

- [ ] **Step 2: `deliverLeads`** — перед отправкой строки читать разговор получателя:
  - нет разговора или `state='failed'` → как сейчас;
  - `state='handed_off'` → отправлять только строку `reply_id === handoff_reply_id` (`aiReason` уже содержит контакт и выжимку), остальные — `skip('Переписку ведёт ИИ')`;
  - иные состояния → `skip('Переписку ведёт ИИ')`.

- [ ] **Step 3: Автопередача** — в `queueSender` до остальных проверок: есть строка в `sender_ai_conversations` у получателя → `SkipHandoff('Переписку вёл ИИ')`.

- [ ] **Step 4: `manualWorker`** — `ManualRow.by_ai?: boolean`. Для `by_ai`: перепроверка перед SMTP (получатель не `unsubscribed|bounced|stopped`, нет ручной метки «не лид», нет записи в `sender_suppressions`, нет ручного письма оператора, созданного позже этого письма, разговор не `stopped`); провал → `status='failed'`, `error='Письмо ИИ отменено: …'`. В условие мягкого повтора добавить `!message.by_ai` (письмо ИИ не повторяется).

- [ ] **Step 5: Проверка** — eslint по изменённым файлам; TS7 по ним + файлам Task 2–4; `npx jest tests/lib/senderLeads tests/lib/sender` (существующие тесты этих модулей, если есть) → PASS.

- [ ] **Step 6: Commit.**

### Task 6: Настройки на вкладке «Квалификация»

**Files:**
- Modify: `app/src/lib/senderLeads/history.ts`, `app/src/app/api/tools/sender-leads/settings/route.ts`, `app/src/components/senderLeads/api.ts`, `app/src/components/senderLeads/QualificationTab.tsx`

**Interfaces:**
- Produces: `LeadSettingsDto` + `aiEnabled: boolean`, `aiOfferText: string`; `LeadSettingsInput` + те же поля; `parseSettingsInput` возвращает дополнительно `ai_enabled`, `ai_offer_text`.

- [ ] **Step 1: DTO и разбор** — `AI_OFFER_TEXT_MAX = 2000`; отсутствие полей во входе = прежние значения не меняются (обратная совместимость); `aiEnabled: true` при пустом тексте → ошибка «Заполните «Короткое КП» — без него ИИ не включается».

- [ ] **Step 2: Роут PUT** — перед обновлением прочитать текущее `ai_enabled`; переход выкл→вкл ставит `ai_enabled_at = now()`; в `logAudit` добавить `aiEnabled`, длину текста.

- [ ] **Step 3: Экран** — в карточке папки под «Что считать лидом»: чекбокс «ИИ ведёт переписку до передачи» и поле «Короткое КП» (подсказка одной строкой: «что делаем, ориентир цены, кейс»), счётчик символов как у критерия; сохранение — той же единственной кнопкой «Сохранить» (`folderDirty` учитывает новые поля).

- [ ] **Step 4: Проверка** — eslint + TS7 по четырём файлам. Commit.

### Task 7: Состояние ИИ в окне переписки

**Files:**
- Modify: `app/src/lib/senderLeads/history.ts` (`ThreadVerdictDto`), `app/src/app/api/tools/sender-leads/verdict/route.ts`, `app/src/components/senderLeads/LeadVerdictBar.tsx`, `app/src/app/api/tools/sender/threads/[id]/route.ts`

**Interfaces:**
- Produces: `ThreadVerdictDto.aiConversation: { state: AiState; aiMessages: number; handoffContact: string | null } | null`.

- [ ] **Step 1:** GET verdict читает `sender_ai_conversations` по `recipient_id`.
- [ ] **Step 2:** `LeadVerdictBar` — плашка: `active` «ИИ ведёт переписку», `handed_off` «ИИ передал менеджерам», `no_reply` «Не ответил ИИ», `closed` «ИИ закрыл переписку», `stopped` «ИИ остановлен», `failed` «Сбой ИИ — передан как обычно».
- [ ] **Step 3:** ленты переписки: `sender_manual_messages` выбирать с `by_ai`, у таких писем пометка «ИИ» в `note`.
- [ ] **Step 4:** eslint + TS7. Commit.

### Task 8: Холостой прогон

**Files:**
- Create: `app/worker/senderAiQualifierDryRunCli.ts`
- Modify: `app/package.json` (`build:workers`, `build:workers:watch` — дописать файл), `Dockerfile.worker:43` (список esbuild — дописать файл)

**Interfaces:**
- Consumes: `aiQualifierConfig`, `requestAiStep`, `decideStep`; история собирается той же функцией, что в Task 4 (вынести её из `engine.ts` экспортом `loadConversationHistory(db, recipientId)`).

- [ ] **Step 1:** CLI `node /app/workers/senderAiQualifierDryRunCli.js [N=10]`: последние N строк `sender_reply_qualifications` `status='lead'` папок `auto_*` → для каждой печатает адрес, итог `decideStep`, текст письма, `summary`. **Ничего не пишет в базу и не отправляет.** Шапка-комментарий с командой `docker exec portal-worker-sender-leads …` как у `ownReplyLeadsDryRunCli.ts`.
- [ ] **Step 2:** `npm run build:workers` локально не запускать; проверить, что esbuild собирает один файл: `node_modules/.bin/esbuild worker/senderAiQualifierDryRunCli.ts --bundle --platform=node --outfile=<scratchpad>/dry.js` → без ошибок.
- [ ] **Step 3:** eslint + Commit.

### Task 9: Итоговая проверка и выкладка

- [ ] **Step 1:** eslint по всем изменённым файлам; TS7 по ним; `npx jest tests/migrations` → PASS.
- [ ] **Step 2:** Пройтись по Review Focus 1–5 по коду engine/manualWorker, где пункт не покрыт — дописать.
- [ ] **Step 3:** В спеку дописать раздел «Выкладка»: миграция применится сама; обновить оба sender-хоста (флаг `by_ai` и отмена в `manualWorker`) **до** включения; холостой прогон на 139; заполнить «Короткое КП» (ориентир цены и кейсы — от продаж) и включить ИИ отдельно для RU/EN.
- [ ] **Step 4:** Commit; пуш — только по явному «да» пользователя.
