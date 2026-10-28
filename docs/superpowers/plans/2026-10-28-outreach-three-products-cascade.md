# Каскад трёх продуктов в русском автоаутриче — план реализации

> **Для агентов:** выполнять задачу за задачей через superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans. Шаги — чекбоксы `- [ ]`.

**Цель:** каждая компания русского автоаутрича получает по одному разу три продукта — СДР,
классический аутрич, автоаутрич. Первый продукт выбирает повод, дальше идёт круг
СДР → классика → автоаутрич → СДР с паузой 14 дней. После трёх продуктов без результата
компании больше не пишем.

**Архитектура:** у строки компании появляется продукт (`product`) и номер шага
(`cascade_no`). Вместо вечного «уже выгружалась» раннер строит индекс каскада по прошлым
строкам и данным «Рассылки»: что уже предлагали, когда ушло последнее письмо, чем
кончилось. Компании, у которых прошла пауза, возвращаются в запуск со следующим
продуктом, но занимают не больше половины заказа. Шаблон цепочки пишется на продукт, а
повод компании подставляется кодом, как сейчас.

**Стек:** Next.js 16 + TypeScript, Supabase/Postgres (миграции `supabase/migrations`),
воркеры `polza-outreach` (139) и «Рассылки» (хосты 144 и 77.239.125.235), Requesty
(Gemini 3.1 Pro — писатель шаблонов).

**Спека:** `docs/superpowers/specs/2026-10-28-outreach-three-products-cascade-design.md`.
Читать вместе с планом. Решения владельца — в спеке, раздел «Каскад».

## Общие ограничения

- Только русский автоаутрич (`app/src/lib/polzaRuOutreach/`, папка `auto_ru`). Английский
  (`app/src/lib/polzaOutreach/`, `auto_en`) не трогать.
- Пауза 14 дней от последнего ушедшего письма; «напишите через квартал» — 90 дней.
- Вернувшимся компаниям — не больше `ceil(limit / 2)` готовых строк запуска, пока в пуле
  есть новые кандидаты; когда новые кончились, добирать вернувшимися можно.
- Письма пишет только Gemini 3.1 Pro шаблоном на ключ; лимит `llm_budget_usd` $10 не
  поднимать.
- Цены в письмах не называть. Письмо 4 не говорит «последнее письмо» / «не побеспокою».
- **Новых `*.test.ts` / `*.test.tsx` не заводить** (CLAUDE.md). `it()` в существующие файлы —
  только с согласия владельца. Проверка логики — разовым скриптом в scratch, без коммита.
- Локально не запускать dev-сервер, `typecheck` и полный jest (вешают ПК). Перед коммитом —
  `npx eslint <изменённые файлы>`; типы проверит CI ветки.
- Коммиты — без упоминаний Claude. Пушить только после явного «да» владельца.
- Комментарии и подписи — по-русски, коротко, как в соседнем коде.

## На что смотреть при проверке (Review Focus)

1. **Компания в нескольких прошлых запусках.** Предложенные продукты собираются со всех её
   строк `ready`, последнее письмо — максимум по всем. Второй раз один продукт — провал.
2. **Рассылку удалили после отправки.** `sender_campaign_id` стал null, получателей и писем
   нет, но `sender_uploaded_at` остался. Продукт считается предложенным, пауза — от
   `sender_uploaded_at + 7 дней`. Сразу снова не писать.
3. **Цепочка ещё идёт.** Есть получатель `active` с запланированными письмами — компания
   ждёт, даже если с заливки прошло 14 дней.
4. **Ответ пришёл во время паузы**, после конца цепочки. `repliesWorker` ставит `replied` и
   по `finished`. Решение по каскаду берётся из ответа (лид / отказ / «через квартал»), а
   не из статуса.
5. **Одна компания, разные ключи.** Совпадение по ИНН при другом домене — та же компания.
   Вернувшаяся компания с адресом в стоп-листе или с непрошедшей почтой отсеивается
   обычными проверками раннера.

Каждый пункт покрыт шагом проверки в задаче, которая владеет кодом.

---

### Задача 1: Миграция

**Файлы:**
- Создать: `supabase/migrations/20261029_0010_polza_ru_product_cascade.sql`

**Интерфейсы:**
- Даёт: `polza_ru_outreach_companies.product text`
  (`check product in ('sdr','classic','classic_abroad','auto')`, null у старых строк),
  `polza_ru_outreach_companies.cascade_no smallint` (`check cascade_no between 1 and 3`);
  `polza_ru_offer_claims_chain_type_check` расширен ключами продуктов; индекс
  `polza_ru_outreach_companies (normalized_domain) where row_status = 'ready'` и такой же по
  `inn`; `sender_ai_conversations.close_reason text`
  (`check close_reason in ('decline','counter_offer','stop')`);
  `sender_folders.ai_offer_texts jsonb not null default '{}'`,
  `sender_folders.kp_links jsonb not null default '{}'` (ключи — продукты).

- [ ] **Шаг 1:** написать миграцию идемпотентно: `add column if not exists`,
  `drop constraint if exists` + `add constraint`, `create index if not exists`. Ограничение
  claims пересоздать с полным списком: 7 нынешних `chain_type`, `'all'` и 4 продукта (как в
  `20260925_0003_polza_ru_outreach_automation_offer.sql:10-14`). Новых таблиц нет, грантов не
  нужно.
- [ ] **Шаг 2:** `npx jest tests/migrations --silent` — PASS (проверки по всем миграциям,
  в т.ч. `grants.test.ts`).
- [ ] **Шаг 3:** коммит «Каскад автоаутрича: колонки продукта и шага, причина закрытия
  разговора ИИ, короткие КП и ссылки на КП по продуктам».

### Задача 2: Логика каскада (чистые функции)

**Файлы:**
- Создать: `app/src/lib/polzaRuOutreach/cascade.ts` (без `server-only`, без БД)

**Интерфейсы:**
- Потребляет: `ChainType`, `Signal` из `./types`.
- Даёт:
  - `CASCADE_STEPS = ['sdr','classic','auto'] as const`, `type CascadeStep`.
  - `PRODUCTS = ['sdr','classic','classic_abroad','auto'] as const`, `type Product`,
    `PRODUCT_LABELS: Record<Product,string>` — «СДР», «Классический аутрич РФ/СНГ»,
    «Классический аутрич за рубеж», «Автоаутрич»; `isProduct(v: string): v is Product`.
  - `stepOfProduct(p: Product): CascadeStep` (`classic_abroad` → `classic`).
  - `firstStepFor(chain: ChainType): CascadeStep` — таблица спеки: `hiring`, `event` → `sdr`;
    `ad_budget`, `reactivation`, `automation` → `auto`; `growth_event`, `icp_only` → `classic`.
  - `legacyStepOf(chain: ChainType | null): CascadeStep` — строки до каскада:
    `automation` → `auto`, всё остальное (и null) → `classic`.
  - `nextStep(offered: CascadeStep[]): CascadeStep | null` — следующий по кругу после
    последнего предложенного, пропуская уже предложенные; все три — `null`; пусто — `null`
    (новой компании первый шаг даёт `firstStepFor`).
  - `isAbroad(signals: Signal[]): boolean` — есть сигнал `export_launch`.
  - `productFor(step: CascadeStep, abroad: boolean): Product`.
  - `type ReplyOutcome = 'decline' | 'later' | 'other'`;
    `classifyCascadeReply(body: string | null): ReplyOutcome` — регулярки по первым 2000
    символам: отказ (`не актуальн`, `не интересн`, `нам не нужн`, `нет потребност`,
    `не рассматрива`) → `decline`; «позже» (`через квартал`, `через полгода`,
    `через \d+ месяц`, `в следующем (квартале|году)`, `после нового года`,
    `напишите позже`) → `later`; остальное (в т.ч. «не тот человек», «переслал») → `other`.
  - `interface CascadeFacts { offered: CascadeStep[]; lastSentAt: Date | null;
    chainRunning: boolean; lead: boolean; closed: boolean; suppressed: boolean;
    laterAt: Date | null }`.
  - `type CascadeDecision = { kind: 'due'; next: CascadeStep } | { kind: 'wait'; until: Date }
    | { kind: 'closed'; reason: 'lead' | 'declined' | 'suppressed' | 'all_offered' }`.
  - `cascadeDecision(f: CascadeFacts, now: Date, pauseDays = 14, laterDays = 90):
    CascadeDecision` — порядок: `lead` → closed/lead; `suppressed` → closed/suppressed;
    `closed` → closed/declined; `nextStep(offered) === null` → closed/all_offered;
    `chainRunning` или нет `lastSentAt` → wait (until = now + pauseDays);
    срок = max(`lastSentAt` + pauseDays, `laterAt` + laterDays); срок в будущем → wait,
    иначе due.

- [ ] **Шаг 1:** реализовать модуль.
- [ ] **Шаг 2:** проверка разовым скриптом (scratch, esbuild-сборка как раньше в этой ветке,
  алиас `server-only` → заглушка): `nextStep([])` → null; `nextStep(['classic'])` →
  `'auto'`; `nextStep(['auto'])` → `'sdr'`; `nextStep(['sdr'])` → `'classic'`;
  `nextStep(['classic','auto'])` → `'sdr'`; `nextStep(['auto','sdr','classic'])` → null;
  `firstStepFor('hiring')` → `'sdr'`, `('ad_budget')` → `'auto'`, `('icp_only')` → `'classic'`;
  `classifyCascadeReply('Спасибо, нам не актуально')` → `'decline'`,
  `('Напишите через квартал')` → `'later'`, `('Я не тот человек, переслал коллеге')` →
  `'other'`; `cascadeDecision` с `lastSentAt` = now − 10 дней → wait, − 15 дней → due,
  `chainRunning: true` при − 30 днях → wait (Review Focus 3), `laterAt` = now − 30 дней →
  wait до laterAt + 90.
- [ ] **Шаг 3:** `npx eslint app/src/lib/polzaRuOutreach/cascade.ts`, коммит «Каскад
  автоаутрича: круг продуктов, первый продукт по поводу, решение «писать/ждать/закрыто»».

### Задача 3: Индекс каскада из базы

**Файлы:**
- Создать: `app/src/lib/polzaRuOutreach/cascadeIndex.ts` (`import 'server-only'`)
- Изменить: `app/src/lib/polzaRuOutreach/company.ts` — `loadPreviouslyExported` убрать
  (единственный вызов — `runner.ts:780-782`), `ExportedIndex` заменить индексом каскада.

**Интерфейсы:**
- Потребляет: задача 2 целиком; `chunkForInFilter` (`@/lib/sender/inFilter`).
- Даёт:
  - `interface CascadeCompany { domain: string | null; inn: string | null;
    lastRowId: string; companyName: string | null; signals: Signal[];
    facts: CascadeFacts; decision: CascadeDecision }`.
  - `interface CascadeIndex { byDomain: Map<string, CascadeCompany>;
    byInn: Map<string, CascadeCompany>; due: CascadeCompany[] }` — `due` отсортирован по
    сроку, старые первыми.
  - `loadCascadeIndex(db: SupabaseClient, excludeJobId: string, now: Date,
    pauseDays: number): Promise<CascadeIndex>`.
  - `lookupCascade(index: CascadeIndex, domain: string | null, inn: string | null):
    CascadeCompany | null` (сначала домен, потом ИНН — Review Focus 5).

Как собирать факты (всё постранично по `id`, 1000 на страницу, `in` — через
`chunkForInFilter`):
1. Строки `polza_ru_outreach_companies` с `row_status = 'ready'` и `job_id <> excludeJobId`:
   `id, normalized_domain, inn, company_name, signals, chain_type, product,
   sender_campaign_id, sender_uploaded_at, created_at`. Компания — по домену (если нет —
   по ИНН). Строки компании склеиваются (Review Focus 1).
2. Продукт строки: `stepOfProduct(product)`, если он есть; иначе, если строка уходила
   (`sender_uploaded_at` не null или у неё были отправленные письма), —
   `legacyStepOf(chain_type)`. Строка `ready`, не залитая и без писем (спека, решение 11),
   продуктом не считается. Строки, выгруженные до «Рассылки» (нет ни `sender_uploaded_at`,
   ни `sender_campaign_id`, `created_at` раньше 26.09.2026), считаются ушедшими,
   `lastSentAt = created_at`.
3. Получатели: `sender_recipients` по `campaign_id in (…)` и `group_key in (row ids)`, только в
   рассылках с `sender_campaigns.source_kind = 'polza_ru'` (у `ve2` `group_key` значит
   другое). Поля: `id, email, status, lead_verdict, lead_verdict_source`.
   `chainRunning` — есть получатель `active`. `lead` — `lead_verdict = 'lead'` или
   `sender_ai_conversations.state = 'handed_off'`. `closed` — `lead_verdict = 'not_lead'` с
   `lead_verdict_source = 'manual'`, или `close_reason in ('decline','counter_offer')`, или
   человеческий ответ с `classifyCascadeReply = 'decline'`.
4. `lastSentAt` — `max(sender_messages.sent_at)` при `status = 'sent'` по получателям строки.
   Нет получателей, а `sender_uploaded_at` есть (рассылку удалили) — `sender_uploaded_at`
   + 7 дней (Review Focus 2).
5. Ответы: `sender_replies` с `kind = 'human'` по получателям: `body, received_at`. `later` —
   самый поздний `received_at` ответа с `classifyCascadeReply = 'later'`.
6. `suppressed` — любой адрес компании в `sender_suppressions` или статус получателя
   `unsubscribed`/`bounced` (адрес) — для всей компании (спека, решение 4).
7. `decision = cascadeDecision(facts, now, pauseDays)`.

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** проверка разовым read-only скриптом против базы (коннектор Portal DB или
  `supabaseAdmin` из scratch): число компаний в индексе ≈ числу различных доменов
  `ready`-строк (~5 800 на 28.10.2026); у компаний, залитых позже 14.10.2026, нет `due`; ни у
  одной компании в `offered` нет дублей; компания с удалённой рассылкой (найти запросом
  строку с `sender_uploaded_at is not null and sender_campaign_id is null`) — `wait`.
- [ ] **Шаг 3:** eslint, коммит «Каскад автоаутрича: индекс компаний по прошлым запускам и
  «Рассылке» вместо вечного «уже выгружалась»».

### Задача 4: Раннер — вернувшиеся компании, продукт строки, потолок половины

**Файлы:**
- Изменить: `app/src/lib/polzaRuOutreach/types.ts` — `RuOutreachConfig.cascade_pause_days:
  number` (по умолчанию 14, `sanitizeRuOutreachConfig` ограничивает 7–60); в
  `REASON_LABELS` — `CASCADE_WAIT` «Ждёт паузу каскада», `CASCADE_CLOSED` «Каскад закрыт»,
  `CASCADE_CAP` «Половина запуска уже за вернувшимися»; `TEMPLATE_VERSION` →
  `'offer_templates_v4@2026-10-29'`.
- Изменить: `app/src/lib/polzaRuOutreach/collect.ts` — `cascadeCandidates(index:
  CascadeIndex, limit: number): Candidate[]` из `index.due` (`source_type: 'cascade'`,
  домен, ИНН, название, прежние сигналы, поле `cascade: { next: CascadeStep;
  offered: CascadeStep[] }`). Добавлять в пул после новых, не больше `limit`.
- Изменить: `app/src/lib/polzaRuOutreach/runner.ts`:
  - `:780-782` — `loadCascadeIndex`, если не `config.include_previously_exported`;
  - `prepare` (`:1100`) — новая компания, найденная в индексе: `due` → дальше как
    вернувшаяся (`cascade` из индекса), `wait` → `CASCADE_WAIT`, `closed` → `CASCADE_CLOSED`
    (вместо `PREVIOUSLY_EXPORTED`);
  - анализ (`:1399`) — вызов `splitAutomation` убрать, `route.chain` остаётся поводом;
    шаг = `candidate.cascade?.next ?? firstStepFor(route.chain)`;
    `product = productFor(step, isAbroad(signals))`; в патч оценки (`:1421-1438`) —
    `product`, `cascade_no = (candidate.cascade?.offered.length ?? 0) + 1`;
  - `takeLettersSlot` (`:1543`) — вернувшаяся строка берёт слот, только если готовых и
    занятых вернувшихся меньше `ceil(target / 2)` или новых кандидатов в пуле не осталось;
    иначе строка `rejected` с `CASCADE_CAP` (в индексе её строка не `ready` — следующий
    запуск возьмёт её снова);
  - счётчики `progress_detail` — добавить `products[product]` рядом с `chains`.
- Изменить: `app/src/lib/polzaRuOutreach/router.ts` — `splitAutomation`, `automationFit`,
  `automationHalf`, `AutomationFitInput` удалить, если других вызовов нет (проверить
  `regenerate.ts`).

**Интерфейсы:**
- Потребляет: задачи 2–3.
- Даёт: строки с `product` и `cascade_no`; `Candidate.cascade?`.

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** проверка разовым скриптом на условие слота (вынести в чистую
  `cascadeSlotFree(returningTaken: number, target: number, newLeft: number): boolean` в
  `cascade.ts`): `(4, 10, 3)` → true; `(5, 10, 3)` → false (5 ≥ ceil(10/2)); `(9, 10, 0)` →
  true (новых не осталось); `(5, 9, 1)` → false (ceil(9/2) = 5).
- [ ] **Шаг 2а:** автодобор (`lib/outreachAutofill/settings.ts:104,110`) уже ставит
  `include_previously_exported = false` — значит, его запуски тоже идут через каскад;
  проверить, что больше нигде в автодоборе нет своего отсева «уже писали».
- [ ] **Шаг 3:** eslint по изменённым файлам, коммит «Каскад автоаутрича: раннер берёт
  компании после паузы со следующим продуктом, не больше половины запуска; продукт — по
  поводу, без 50/50».

### Задача 5: Шаблоны писем по продуктам

**Файлы:**
- Изменить: `app/src/lib/polzaRuOutreach/letters/templateWriter.ts` — ключ шаблона
  (`offer_key`) = продукт; `OFFER_BRIEFS: Record<Product, OfferBrief>` (суть и цели писем из
  спеки, раздел «Три продукта»); `writerUserPrompt` берёт `PRODUCT_LABELS`; `LETTER4`
  (`:179`) без «последнее письмо / не хочу надоедать» (это и так нарушало правило 9
  `WRITER_SYSTEM`, `:389`); `ChainTemplates.get(key: Product)`, `retryFailed(): Product[]`,
  `regenerateChainTemplate(deps, key: Product)`, `parseTemplateLetters(raw, key)`,
  `sampleTemplate(key, …)`; `writerReserveUsd` (`runner.ts:154`) — `PRODUCTS.length`
  вместо `CHAIN_TYPES.length`.
- Изменить: `letters/fixedTemplates.ts` — `fixedTemplate(product, sender)`: четыре образца по
  4 письма. Образцы пишет исполнитель по КП (владелец: без утверждения продаж). СДР — зовём
  на встречу или к менеджеру, список не просим; классика РФ/СНГ — сегменты, база, ЛПР,
  гарантия по лидам в договоре; классика за рубеж — Email и LinkedIn на зарубежные рынки,
  без гарантии; автоаутрич — система сама находит и пишет, заявки каждый месяц без найма,
  ведение включено. Цен нет. Письма ≤ 200 символов своего текста (правило 12, `too_long`).
- Изменить: `letters/chains.ts` — `:250` убрать «Это последнее письмо, дальше не
  побеспокою.»; `openingSentence` (повод) не трогать.
- Изменить: `letters/bridge.ts` — `fallbackBridge(chain, baseChain?)` → `fallbackBridge(chain,
  product)`: связка повода с продуктом.
- Изменить: `letters/renderTemplate.ts` — `CompanyLettersInput.product: Product`; повод и
  должность по-прежнему от `chain`.
- Изменить: `libraries.ts` — `claimsForChain(claims, chain, product)`: `'all'`, совпадение
  по продукту или по поводу. `router.routeCase(cases, group, chain, product)`:
  `allowed_chains` пусто или содержит повод или продукт.
- Изменить: API `app/src/app/api/tools/polza-ru-outreach/[jobId]/templates/route.ts`
  (`offer_label` — `PRODUCT_LABELS`, для старых запусков — `CHAIN_LABELS`; `waiting` — по
  `product`, для старых — по `chain_type`), `…/templates/[offerKey]/regenerate/route.ts:47`
  (ключ ∈ `PRODUCTS` или, для старых запусков, `CHAIN_TYPES`), `regenerate.ts:376` (то же).
- Изменить: `components/polzaRuOutreach/libraryFields.ts` — в выборе `chain_type` формулировки
  и `allowed_chains` кейса добавить 4 продукта.

**Интерфейсы:**
- Потребляет: `Product`, `PRODUCT_LABELS`, `isProduct` (задача 2); строки с `product`
  (задача 4).
- Даёт: `ChainTemplates.get(product)`.

- [ ] **Шаг 1:** реализовать. Старые запуски (шаблоны с `offer_key` = повод) должны
  открываться и переписываться как раньше.
- [ ] **Шаг 2:** `grep -rn "последнее письмо\|не побеспокою\|не хочу надоедать"
  app/src/lib/polzaRuOutreach` — пусто.
- [ ] **Шаг 3:** eslint, коммит «Каскад автоаутрича: шаблон цепочки на продукт (СДР,
  классика РФ/СНГ и за рубеж, автоаутрич), повод — подстановкой; без «последнего письма»».

### Задача 6: Ответы — стоп-лист и причина закрытия разговора ИИ

**Файлы:**
- Изменить: `app/src/lib/sender/replyClassify.ts:128` — `STOP_REQUEST` дополнить: `не\s+беспоко\p{L}*`,
  `не\s+присыла\p{L}*`, `исключ\p{L}*\s+(меня|нас|из)`, `убер\p{L}*\s+(меня|нас|из)`.
  Подпись `isStopRequest(body, subject)` не меняется.
- Изменить: `app/src/lib/senderAiQualifier/engine.ts` — `:338` передавать в `decideStep`
  настоящий `step.stopRequested`; при закрытии (`:352`) писать
  `close_reason`: стоп → `'stop'`, `counter_offer` → `'counter_offer'`, прочее закрытие с
  `relevant = no` → `'decline'`. При `'stop'` — upsert в `sender_suppressions`
  (`reason 'unsubscribe'`, `note 'ИИ: просьба не писать'`), получатель → `unsubscribed`,
  запланированные письма — `canceled` (как `repliesWorker.applyReply`, `:199-205`).

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** разовый скрипт: `isStopRequest('Не беспокойте нас больше', null)` → true,
  `isStopRequest('Пришлите КП', null)` → false.
- [ ] **Шаг 3:** eslint, коммит «Ответы автоаутрича: «не беспокойте» и просьба не писать,
  которую понял ИИ, попадают в стоп-лист; разговор ИИ хранит причину закрытия».

### Задача 7: Сообщение о лиде — продукт и ссылка на КП

**Файлы:**
- Изменить: `app/src/lib/senderLeads/telegram.ts` — `LeadMessageInput.product?: { label:
  string; step: number; kpUrl: string | null }`; в `buildLeadMessage` после строки
  «Контакт»: `<b>Продукт:</b> {label} · шаг {step} из 3` и, если есть ссылка,
  `<b>КП:</b> <a href="{kpUrl}">открыть</a>` (`leadMessageNote` превратит ссылку в текст для
  AMO).
- Изменить: `app/src/lib/senderLeads/process.ts` (`deliverLeads`, `:338-349`) — если у рассылки
  `source_kind = 'polza_ru'`: строка по `group_key` получателя → `product`, `cascade_no`;
  ссылка — `sender_folders.kp_links[product]`. Строки без продукта (старые) — без блока.

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** разовый скрипт: `buildLeadMessage` с `product` даёт обе строки; без
  `product` — текст как раньше (сравнить с выводом до правки).
- [ ] **Шаг 3:** eslint, коммит «Лид автоаутрича в чате и AMO: какой продукт предлагали,
  шаг каскада и ссылка на КП».

### Задача 8: ИИ-собеседник — короткое КП продукта и прогрев к встрече

**Файлы:**
- Изменить: `app/src/lib/senderAiQualifier/engine.ts` — для `folder_key = 'auto_ru'` продукт
  строки по `group_key`; `offerText = folder.ai_offer_texts[product] || folder.ai_offer_text`
  (`FOLDER_SELECT`, `:71` — добавить `ai_offer_texts`).
- Изменить: `app/src/lib/senderAiQualifier/ai.ts` — `AiPromptInput.productPitch: string` (из
  `PRODUCT_LABELS` и сути продукта); `SYSTEM_PROMPT` (`:39-59`): строка про «что мы
  предлагаем» берёт `productPitch`; по совету Андрея — меньше вопросов квалификации, больше
  пользы под боль компании и приглашения на встречу или к менеджеру; правило «цены, сроки,
  гарантии — только из КОРОТКОГО КП» остаётся.

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** холостой прогон после выкладки (см. задачу 10), не локально.
- [ ] **Шаг 3:** eslint, коммит «ИИ-собеседник автоаутрича: короткое КП того продукта,
  который предлагали, и прогрев к встрече вместо вопросов».

### Задача 9: Экраны

**Файлы:**
- Изменить: `app/src/lib/senderLeads/history.ts` (`FOLDER_LEAD_SELECT :121`, `settingsDto
  :133`, `parseSettingsInput :162`) и `app/src/lib/senderLeads/settings.ts` (лимит
  `AI_OFFER_TEXT_MAX = 2000` на каждый текст) — читать и сохранять `ai_offer_texts`,
  `kp_links` (только для `auto_ru`; ключи — `PRODUCTS`; ссылка — `https://…` или пусто).
- Изменить: `app/src/components/senderLeads/QualificationTab.tsx` (`SettingsCard`, рядом с
  «Коротким КП» `:304-316`) — для `auto_ru` четыре блока «СДР / Классика РФ-СНГ / Классика
  за рубеж / Автоаутрич»: короткое КП и ссылка на КП. Общее «Короткое КП» остаётся
  запасным. Одна кнопка «Сохранить» на вкладку.
- Изменить: `app/src/components/polzaRuOutreach/LaunchPanel.tsx` — в «Тонкой настройке»
  число «Пауза между продуктами, дней» (`cascade_pause_days`); подпись галочки
  `include_previously_exported` (`:300-305`) → «Писать без учёта каскада».
- Изменить: `app/src/components/polzaRuOutreach/ruAdapter.tsx` — колонка и чип «Продукт» и
  «Шаг» рядом с поводом (`:156`, `:385`), в выгрузках CSV — колонки `product`, `cascade_no`
  (`:443-470`, `…/export/route.ts:53,101`, `…/results/route.ts` — выбрать поля).

- [ ] **Шаг 1:** реализовать.
- [ ] **Шаг 2:** eslint по изменённым файлам.
- [ ] **Шаг 3:** коммит «Автоаутрич RU: продукт и шаг каскада в результатах, пауза в
  настройках запуска, короткие КП и ссылки на КП по продуктам на вкладке «Квалификация»».

### Задача 10: Проверка и выкладка

- [ ] **Шаг 1:** `npx eslint` по всем изменённым файлам ветки; `npx jest
  tests/lib/polzaRuOutreachLibraryFilters.test.ts tests/lib/senderHardening.test.ts
  tests/migrations --silent` — PASS (это только связанные файлы, не полный набор).
- [ ] **Шаг 2:** спросить владельца о пуше, назвать все незапушенные коммиты. После пуша —
  CI ветки (typecheck:fast, связанные тесты).
- [ ] **Шаг 3:** порядок выкладки (после мержа в main): миграция применяется сама
  (`supabase/migrations`) → хосты «Рассылки» (меняются `replyClassify.ts` и ИИ-собеседник)
  → 139 (раннер, автодобор, лиды).
- [ ] **Шаг 4:** первый запуск RU на 20–30 компаний вручную: в результатах у строк есть
  продукт и шаг; вернувшиеся — не больше половины; шаблонов ≤ 4; расход ≤ $10. Холостой
  прогон ИИ-собеседника: `docker exec portal-worker-sender-leads node
  /app/workers/senderAiQualifierDryRunCli.js 10`.
- [ ] **Шаг 5:** владельцу — заполнить на «Квалификации» короткие КП и ссылки на КП по
  продуктам (PDF выложить туда, откуда менеджеры откроют ссылку).

---

## Итог реализации (28.10.2026)

Все 10 задач сделаны, каждая проверена отдельным ревьюером, затем вся ветка — итоговым
ревью; найденное исправлено. Коммиты в `dmitriy_kuladmed_new` от `85990bbb5` до
`a3b0a92c8` (в этом же диапазоне три чужих коммита другой сессии: `d52b768f2`,
`7404d44e4`, `b0ee23f17`). Проверка: eslint по 41 файлу — 0 ошибок; связанные jest-наборы
проходят (кроме `veContactDeliveryWithoutPeriod`, он падает на этой Windows-копии и без
наших правок — CRLF). Typecheck локально не гоняли — его делает CI ветки.

### Решения, принятые при реализации (можно поменять)

- Шаблон цепочки — на продукт (4 ключа), повод — подстановкой (спека, решение 1).
- Ответ с «не актуально» и «напишите через квартал» одновременно — это «позже» (90 дней);
  «позже» сильнее более раннего отказа того же человека.
- Компании, которым письма так и не ушли, — новые, в каскад не входят. Исключение: готовая
  строка без заливки моложе 30 дней придерживает компанию на 30 дней (на проде таких 425) —
  иначе две цепочки сразу.
- Несуществующий адрес (hard_bounce) закрывает только этот адрес, не всю компанию. Всю
  компанию закрывают отписка, жалоба, ручной стоп-лист, «не пишите», жалоба на спам.
- Лид: разговор ИИ передан менеджерам или упал с меткой лида, ручная метка лида, метка ИИ
  без разговора, разговор остановлен менеджером, ответ уже ушёл менеджерам в чат.
  ИИ закрыл разговор — отказ; ИИ не дождался ответа — молчание (дальше по каскаду).
- Вернувшиеся компании: первая половина заказа — в начале пула (иначе до них не доходит:
  пулы 42–70 тыс., запуск смотрит 15–19 тыс.), остальные после новых. Компанию, которую за
  последние 14 дней пробовали без результата, 14 дней не ставим в начало.
- Связка повода с предложением (дешёвый ИИ) пишется под продукт шага.
- Повод возврата из AMO без слова «аутрич»: «…по поводу поиска новых клиентов через письма».
- В каскаде (не в общем стоп-листе) осторожные ложные срабатывания допустимы: «не надо
  звонить…» в ответе-не-лиде закрывает каскад; упоминание «спам» — стоп для компании.

### Что осталось (по желанию)

- Живой стоп-лист «Рассылки» стал строже к формулировкам: «Просьба не беспокоить нас» и
  «просим не присылать больше» больше не отписывают (сделано, чтобы не отписывать живых
  лидов на «чтобы не беспокоить звонком, пришлите КП»). Можно вернуть с уточнением
  «не беспокоить (нас|меня)», «не присылать (нам)? больше».
- `classic_abroad` появится редко: признак «за рубеж» — только сигнал `export_launch`.
- Кейсы и формулировки в «Библиотеках» теперь размечаются по продукту; старые по поводу в
  шаблоны продуктов не попадают (на проде таблица формулировок пустая).

### Порядок выкладки

1. CI ветки зелёный на последнем коммите.
2. Мерж в `test` → `main` — только с разрешения владельца.
3. Деплой: миграция `20261029_0010` применяется до пересоздания контейнеров 139; хосты
   «Рассылки» обновляются отдельно (им миграция не нужна, но ИИ-собеседник пишет
   `close_reason` — миграция должна быть уже применена). Проверить колонки
   `polza_ru_outreach_companies.product/cascade_no`, `sender_ai_conversations.close_reason`,
   `sender_folders.ai_offer_texts/kp_links`.
4. Автодобор RU выключить до проверки: первый же запуск начнёт брать вернувшиеся компании.
5. Ручной запуск RU на 20–30 компаний: у строк есть продукт и шаг; вернувшихся ≤ половины;
   есть отсевы «Ждёт паузу каскада» / «Каскад закрыт» / «Половина запуска…»; шаблонов ≤ 4;
   расход ≤ $10; в логе строка пула `returning N, recently tried M` и время загрузки индекса.
6. Включить автодобор обратно.
7. «Квалификация» → `auto_ru`: короткие КП и https-ссылки на КП для всех четырёх продуктов
   и общее «Короткое КП» (на проде оно пустое). PDF положить туда, где менеджеры их откроют.
8. Перед включением ИИ для `auto_ru` — холостой прогон
   `docker exec portal-worker-sender-leads node /app/workers/senderAiQualifierDryRunCli.js 10`.
