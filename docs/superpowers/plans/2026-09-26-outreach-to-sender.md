# Автоаутричи → «Рассылка» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Дешёвый конвейер RU/EN автоаутричей (дорогое в конце, отдельные ключи, бюджет $10), цепочки писем Gemini 3.1 Pro один раз на оффер, портальные поиск/проверка почт, заливка готовых компаний в «Рассылку» (папки RU/EN) и запуск по кнопке.

**Спецификация (читать целиком перед любой задачей):** `docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md`.

**Tech Stack:** TypeScript (Next.js + esbuild-воркеры), Supabase Postgres, Requesty (OpenAI-совместимый API), Node `AsyncLocalStorage`.

**Правила репозитория:** новых `*.test.ts` не заводим (существующие тесты чинить, если меняется сигнатура); dev-сервер не поднимаем; коммит в `dmitriy_kuladmed_new`, без push; `git status` перед коммитом и стейджить только свои файлы; команды — из `/g/PycharmProjects/Portal/app`; комментарии — по-русски, объясняют «почему», в стиле соседнего кода. Проверка задачи: eslint по изменённым файлам + `npx tsc --noEmit -p tsconfig.typecheck.core.json` (и `tsconfig.typecheck.api.json`/`pages` для роутов/экранов) + затронутые существующие тесты.

Этапы выкладываются по отдельности: 1 (задачи 1–4), 2 (5–8), 3 (9–11), 4 (12–15), итог (16).

---

## Этап 1. Ключи, модели, учёт денег

### Task 1: Миграция аутричей (этапы 1–3)

**Files:** Create `supabase/migrations/20260926_0001_outreach_llm_and_templates.sql`

- [ ] Таблица кэша разбора сайта:
  `polza_site_analysis_cache(lang text check in ('ru','en'), domain text, prompt_version text, model text, result jsonb not null, created_at timestamptz default now(), primary key (lang, domain, prompt_version, model))` + индекс по `created_at`; RLS on; `grant all … to service_role`.
- [ ] Таблица шаблонов цепочек:
  `polza_chain_templates(id uuid pk default gen_random_uuid(), job_id uuid not null, lang text check in ('ru','en'), offer_key text not null, status text check in ('pending','ok','failed'), letters jsonb, qa_flags text[] default '{}', model text, cost_usd numeric(10,4) default 0, attempt int default 0, error text, created_at, updated_at, unique (job_id, lang, offer_key))`; индекс по `job_id`; RLS on; grant service_role + `select` для authenticated (экран запуска читает через API, но так же, как `polza_ru_outreach_companies`, — сверить с соседней миграцией `20260922_0008` и повторить её гранты).
- [ ] RU строки `polza_ru_outreach_companies`: `add column if not exists chain_template_id uuid, sender_campaign_id uuid, sender_uploaded_at timestamptz`.
- [ ] EN строки `polza_outreach_companies`: `add column if not exists chain_template_id uuid, email_verification text, sender_campaign_id uuid, sender_uploaded_at timestamptz`.
- [ ] Настройки EN-аутрича: `polza_outreach_settings(key text primary key, value jsonb not null, updated_at timestamptz default now())`, сид `('signature', '"Julia Mira\nAccount Manager\nPolza Agency"')` `on conflict do nothing`; RLS on; grant service_role.
- [ ] `npx jest tests/migrations --silent` → PASS. Commit `feat(outreach): миграция — кэш разбора, шаблоны цепочек, поля заливки`.

### Task 2: Общий ИИ-клиент аутричей с бюджетом

**Files:** Create `app/src/lib/outreachLlm/client.ts`, `app/src/lib/outreachLlm/context.ts`, `app/src/lib/outreachLlm/prices.ts`

- [ ] `prices.ts`: цены USD за 1M токенов (с наценкой Requesty) для `deepinfra/deepseek-v4-flash-0731` (0.094 / 0.38), `google/gemini-3.1-pro-preview` (1.8 / 10.8), `openai/gpt-4o-mini` (0.15 / 0.6); `estimateCostUsd(model, promptTokens, completionTokens): number | null`. Цифры взять из `lib/verticalEngineV2/llm.ts` (`MODEL_PRICES`) — скопировать, НЕ импортировать из движка вертикалей (изоляция движка проверяется тестом `tests/architecture/verticalEngineV2Isolation.test.ts`).
- [ ] `context.ts`: `AsyncLocalStorage<OutreachLlmContext>`, где
  ```ts
  export type OutreachLang = 'ru' | 'en';
  export class JobBudget { constructor(public readonly limitUsd: number) {} spentUsd = 0; calls = 0; byRole: Record<'analysis'|'writer', { usd: number; calls: number }>; add(role, usd): void; exhausted(): boolean; snapshot(): { spent_usd; calls; limit_usd; by_role } }
  export interface OutreachLlmContext { lang: OutreachLang; budget: JobBudget }
  export function runWithOutreachContext<T>(ctx: OutreachLlmContext, fn: () => Promise<T>): Promise<T>;
  export function currentOutreachContext(): OutreachLlmContext | null;
  export class BudgetExceededError extends Error {}
  export class LlmAuthError extends Error {}   // 401/403 от Requesty
  export class LlmCallError extends Error {}   // прочие сбои ИИ (сеть, 5xx, битый JSON после повторов)
  ```
- [ ] `client.ts`:
  ```ts
  export type OutreachLlmRole = 'analysis' | 'writer';
  export function outreachApiKey(lang): string   // POLZA_RU_OUTREACH_API_KEY / POLZA_EN_OUTREACH_API_KEY
  export function outreachModel(lang, role): string
    // writer: POLZA_{RU|EN}_WRITER_MODEL || 'google/gemini-3.1-pro-preview'
    // analysis: POLZA_{RU|EN}_ANALYSIS_MODEL || 'deepinfra/deepseek-v4-flash-0731'
  export async function callOutreachJson(opts: { role; system; user; title; maxTokens?; lang?: OutreachLang }): Promise<Record<string, unknown>>
  export async function callOutreachText(opts: same): Promise<string>   // для писателя, если JSON неудобен — по выбору реализации
  ```
  Поведение: язык и бюджет — из `currentOutreachContext()` (явный `opts.lang` имеет приоритет; вне контекста — `lang` обязателен, бюджета нет). Перед вызовом `budget.exhausted()` → `BudgetExceededError`. Запрос — прямой `fetch` к `process.env.OPENROUTER_ENDPOINT || 'https://router.requesty.ai/v1/chat/completions'` (как `lib/openrouter/client.ts`; посмотреть его заголовки и формат), `temperature: 0` для analysis и `0.4` для writer, `response_format: { type: 'json_object' }` для JSON, `max_tokens` (analysis по умолчанию 1500; writer 8000). Ответ: `choices[0].message.content`, `finish_reason`, `usage` (`prompt_tokens`, `completion_tokens`, `cost`). Стоимость = `usage.cost` ‖ `estimateCostUsd`; добавить в бюджет ДАЖЕ если ответ потом не распарсился. 401/403 → `LlmAuthError` (без повторов). 429/5xx/сеть → до 2 повторов с паузой 2 с·2^n, потом `LlmCallError`. Битый JSON → 1 повтор, потом `LlmCallError`. `finish_reason: 'length'` у writer → 1 повтор с `max_tokens × 2` (до 16000). Ключ пуст → `LlmAuthError('Не задан ключ ИИ для RU/EN автоаутрича (POLZA_…_API_KEY)')`. Заголовок `X-Title: Portal - Polza {RU|EN} Outreach {title}`.
- [ ] eslint + tsc core. Commit `feat(outreach): общий ИИ-клиент аутричей — свои ключи, модели, бюджет запуска`.

### Task 3: RU на новом клиенте + бюджет + кэш разбора сайта

**Files:** Modify `app/src/lib/polzaRuOutreach/llm.ts`, `runner.ts`, `types.ts`, `sources/siteSignals.ts`, `analyze.ts`, `sources/news.ts`, `letters/chains.ts` (только вызов гипотезы), `app/src/app/api/tools/polza-ru-outreach/route.ts` (создание запуска), `app/src/components/polzaRuOutreach/LaunchPanel.tsx`, `JobDetail.tsx`, `shared.ts`

- [ ] `llm.ts`: `callJson(system, user, title, maxTokens)` становится обёрткой над `callOutreachJson({ role: 'analysis', … })` (язык берётся из контекста; если контекста нет — `lang: 'ru'`). Убрать собственный ключ/модель; `RU_OUTREACH_MODEL` оставить только если где-то используется для отображения — иначе удалить.
- [ ] `types.ts`: в `RuOutreachConfig` поле `llm_budget_usd: number` (санитизация 1–100, по умолчанию `DEFAULT_LLM_BUDGET_USD = 10`); `REASON_LABELS`: `LLM_FAILED: 'ИИ не ответил (сбой модели или ключа)'`.
- [ ] `runner.ts`: весь запуск внутри `runWithOutreachContext({ lang: 'ru', budget: new JobBudget(config.llm_budget_usd) }, …)`. Снимок бюджета — в `progress_detail.llm` при каждом `publish` и в финале. `BudgetExceededError` в любой строке → строка возвращается в «не обработана» (не failed), цикл останавливается, запуск `completed` с `stop_reason: 'budget'`. `LlmAuthError` → запуск `failed` с понятным текстом. `LlmCallError` в разборе сайта/вакансии → строка `rejected`, причина `LLM_FAILED` (а не `SITE_UNREACHABLE`): в `analyzeSite` перестать глотать ошибку ИИ в `EMPTY_SITE` — различать «сайт не открылся» (обход) и «ИИ не ответил».
- [ ] Кэш разбора сайта в `analyzeSite`: перед вызовом ИИ читать `polza_site_analysis_cache` по `(lang='ru', domain, prompt_version, model)` не старше 30 дней; после успешного разбора писать. `prompt_version` — константа рядом с промптом (менять при правке промпта). Домен — нормализованный. Обход страниц нужен всё равно? Нет: при попадании в кэш страницы не качать.
- [ ] `route.ts` (POST запуска): если `POLZA_RU_OUTREACH_API_KEY` пуст — 400 «Не задан ключ ИИ для русского автоаутрича». `llm_budget_usd` проходит через `sanitizeRuOutreachConfig`.
- [ ] UI: `LaunchPanel` — поле «Лимит на ИИ, $» (число 1–100, по умолчанию 10, подсказка «запуск остановится, готовое сохранится»), «Повторить» подставляет значение. `JobDetail` — строка «ИИ: потрачено $X из $Y» (из `progress_detail.llm`), при `stop_reason === 'budget'` — плашка «Остановлен: достигнут лимит на ИИ». `shared.ts` — типы.
- [ ] Прогнать `npx jest tests/lib --silent -t "polza"` (или все, если фильтр ничего не находит) + tsc core/api/pages + eslint. Commit `feat(polza-ru-outreach): свой ключ, дешёвый разбор, лимит на ИИ, кэш разбора сайта`.

### Task 4: EN на новом клиенте + бюджет + кэш

**Files:** Modify `app/src/lib/polzaOutreach/siteProfile.ts`, `analyzeVacancy.ts`, `runner.ts`, `types.ts`, `app/src/app/api/parsers/polza-outreach/route.ts`, `app/src/components/parsers/PolzaOutreachLaunchPanel.tsx`, `PolzaOutreachResults.tsx` (или где показывается прогресс запуска), `app/src/types` (если там типы EN)

- [ ] `siteProfile.ts`: вместо RU `callJson` — `callOutreachJson({ role: 'analysis', lang: 'en', … })`; `crawlSite` из RU можно оставить (обход — не ИИ). Кэш разбора как в Task 3 (`lang='en'`).
- [ ] `analyzeVacancy.ts`: свой вызов `callOpenRouterChat` заменить на `callOutreachJson({ role: 'analysis', lang: 'en', … })`.
- [ ] `types.ts`: `llm_budget_usd` в конфиге (1–100, по умолчанию 10).
- [ ] `runner.ts`: `runWithOutreachContext({ lang: 'en', … })`, `progress_detail.llm`, `stop_reason: 'budget'`, `LlmAuthError` → failed, `LlmCallError` → строка `excluded`/`llm_failed` (не `site_unreachable`).
- [ ] Роут запуска: нет `POLZA_EN_OUTREACH_API_KEY` → 400.
- [ ] UI: поле лимита в панели запуска, строка «ИИ: потрачено $X из $Y», плашка при `budget`.
- [ ] tsc core/api/pages + eslint + затронутые тесты. Commit `feat(polza-outreach): свой ключ, дешёвый разбор, лимит на ИИ, кэш разбора сайта`.

---

## Этап 2. Почты и порядок шагов

### Task 5: Портальный поиск + проверка почты для аутричей

**Files:** Create `app/src/lib/outreachEmail/findAndVerify.ts`

- [ ] API:
  ```ts
  export type OutreachEmailVerdict = 'ok' | 'catch_all' | 'unverified' | 'invalid' | 'none';
  export interface FoundEmail { email: string; verification: 'ok' | 'catch_all' | 'unverified'; /* + то, что вернул picker */ picked: unknown; triedInvalid: string[] }
  export async function findAndVerifyCompanyEmail<P>(opts: {
    website: string; domain: string; locale: 'ru' | 'en';
    pick: (emails: string[], excluded: Set<string>) => (P & { email: string }) | null; // наши правила выбора
    domainCache: Map<string, unknown>; // один на запуск, для validateEmailForAutoPipeline
    maxCandidates?: number; // 3
  }): Promise<{ result: (P & { email: string; verification: 'ok' | 'catch_all' | 'unverified' }) | null; verdict: OutreachEmailVerdict; triedInvalid: string[] }>
  ```
  Поиск: `email_scraper_cache` (ключ и формат — как в `lib/enrich/websiteEnrichmentWorker.ts`, TTL 7 дней удача / 6 часов ошибка) → иначе `scrapeEmails(website, { locale, maxPages: 8 })`, результат записать в кэш. Выбор — `pick` (исключая уже отбракованные); проверка — `validateEmailForAutoPipeline` (`lib/jobs/autoPipelineEmailValidation.ts`): `ok|role|free` → `ok`, `catch_all` → `catch_all`, `unknown`/ошибка транспорта → `unverified`, `invalid|disposable` → в `triedInvalid`, следующий кандидат (до `maxCandidates`). Нет ни одного адреса → `none`; все отбракованы → `invalid`.
  Флаг `smtpAvailable()` — есть ли `SMTP_PROXY_URLS`/`SMTP_PROXY_URL` (для плашки на экране).
- [ ] RU picker = `pickRuEmail` (адаптировать, чтобы принимал исключения), EN picker = логика `polzaOutreach/findEmail.ts` (вынести чистую функцию выбора, если её нет). Существующие `findRuCompanyEmail`/`findCompanyEmail` переписать поверх `findAndVerifyCompanyEmail` или удалить, если не нужны.
- [ ] eslint + tsc core. Commit `feat(outreach): поиск почты через портальный кэш и SMTP-проверку`.

### Task 6: RU — новый порядок шагов

**Files:** Modify `app/src/lib/polzaRuOutreach/runner.ts`, `doubts.ts`, `types.ts`, `components/polzaRuOutreach/Stages.tsx` (подписи этапов)

- [ ] Порядок в `qualify` (спека §2 RU): AMO по ИНН → домен → AMO по домену / повторы / «уже выгружалась» → **почта** (`findAndVerifyCompanyEmail`; реактивация — почта из AMO без поиска) → стоп-лист (`isSuppressed`) → вакансии hh + разбор вакансии → разбор сайта → фильтры ползунков, ФНС, новости → оффер, оценка, порог. Почта и её проверка сохраняются в строке сразу (`recipient_email`, `email_type`, `email_verification`, `email_source_url`, `recipient_role`, `is_routing`). Этап воронки `recipient_resolved` теперь раньше `enriched`: переставить `STAGES` так, чтобы порядок этапов на экране совпадал с фактическим (и подписи в `Stages.tsx`).
- [ ] Новые причины: `EMAIL_INVALID: 'Почта на сайте не прошла проверку'`. `EMAIL_NOT_FOUND` — как было.
- [ ] Сомнения — ДО писем: признак `EMAIL_UNVERIFIED` («почта не проверена») сразу делает строку «очень спорной» (независимо от числа прочих признаков). «Очень спорные» писем не получают: статус `doubtful`, `pipeline_stage = 'scored'`, причина в `doubt_detail`. Остальные признаки считаются как сейчас.
- [ ] Вторая фаза (`finalize`) — только письма (Task 9 заменит сборку); поиск почты из неё убрать. Лимит готовых — как сейчас.
- [ ] Параллельность: поиск почты медленный (до 60 с), разрешить `POLZA_RU_OUTREACH_EMAIL_CONCURRENCY` (по умолчанию 8) для шага почты, если он выделяется в отдельный пул; иначе оставить общий.
- [ ] tsc + eslint + тесты. Commit `feat(polza-ru-outreach): почта до ИИ, очень спорные без писем`.

### Task 7: EN — новый порядок шагов, повторы между запусками, стоп-лист

**Files:** Modify `app/src/lib/polzaOutreach/runner.ts`, `types.ts`, UI этапов EN (`components/parsers/PolzaOutreachStages.tsx` — подписи/подсказки)

- [ ] После S3: повторы между запусками — компания (по `normalized_domain`) уже была `ready` в другом запуске → `excluded` с причиной `previously_exported` (как RU `loadPreviouslyExported`, но по `polza_outreach_companies`). Затем почта (`findAndVerifyCompanyEmail`, locale `en`) → стоп-лист (`sender_suppressions`) → S4 разбор → оценка → письма.
- [ ] `unverified` → `needs_review`, причина `email_unverified`, писем не пишем. `invalid`/`none` → `excluded` (`email_invalid` / `no_corporate_email`). Сохранять `email_verification`.
- [ ] Подписи этапов EN: этап «Корпоративная почта» теперь раньше «Lead Score» — поправить порядок/подсказки так, чтобы воронка на экране отражала реальный порядок (если воронка считается счётчиками — пересчитать корректно).
- [ ] tsc + eslint + тесты. Commit `feat(polza-outreach): почта до ИИ, повторы между запусками, стоп-лист`.

### Task 8: Прод-окружение воркера аутричей

**Files:** Modify `docker-compose.prod.yml` (сервис `worker-polza-outreach`)

- [ ] Добавить в `environment`: `POLZA_RU_OUTREACH_API_KEY=${POLZA_RU_OUTREACH_API_KEY:-}`, `POLZA_EN_OUTREACH_API_KEY=${POLZA_EN_OUTREACH_API_KEY:-}`, необязательные `POLZA_RU_ANALYSIS_MODEL`, `POLZA_RU_WRITER_MODEL`, `POLZA_EN_ANALYSIS_MODEL`, `POLZA_EN_WRITER_MODEL` (`${…:-}`), SMTP-прокси — ровно те переменные, что у `worker-emailvalidation` (скопировать имена). Комментарий: зачем, и что правка требует `--force-recreate`.
- [ ] Роут создания запуска (Next.js) тоже проверяет ключи — посмотреть, какой сервис отдаёт API (`app`/`portal-app`) и добавить туда два ключа, если env передаётся явным списком.
- [ ] `npx jest tests/architecture --silent`. Commit `ci(outreach): ключи ИИ и SMTP-прокси для воркера аутричей`.

---

## Этап 3. Цепочки Gemini 3.1 Pro на оффер

### Task 9: RU — шаблоны цепочек

**Files:** Create `app/src/lib/polzaRuOutreach/letters/templateWriter.ts`, `letters/renderTemplate.ts`; Modify `letters/chains.ts` (оставить образцы как вход писателю), `qa.ts` (режим шаблона), `runner.ts` (`finalize`), `types.ts`

- [ ] `templateWriter.ts`: `getChainTemplate(jobId, chainType): Promise<ChainTemplate>` — ленивая генерация на оффер: in-memory `Map<string, Promise<ChainTemplate>>` на запуск + строка в `polza_chain_templates` (статус `pending` → `ok`/`failed`). Промпт писателя (роль `writer`): суть оффера `CHAIN_LABELS[chainType]` и цель каждого письма; образец — текущая цепочка из `buildChain` для этого типа, собранная на фиктивных данных с плейсхолдерами (или текстовое описание структуры, если сборка без данных невозможна); утверждённые формулировки (`libraries.claims` для этого типа); правила из спеки §4; ответ JSON:
  ```json
  {"letters":[
    {"n":1,"subject":"…","body_direct":"…","body_routing":"…"},
    {"n":2,"body":"…"},
    {"n":3,"body_with_case":"…","body_without_case":"…"},
    {"n":4,"body":"…"}]}
  ```
  Плейсхолдеры RU: `{{бренд}}`, `{{повод}}`, `{{кейс}}`, `{{гипотеза}}`, `{{подпись}}`. Тело начинается с «Добрый день!» и заканчивается `С уважением,\n{{подпись}}`.
- [ ] Проверка шаблона (`qa.ts`, режим шаблона): нет незнакомых `{{…}}`; обязательные плейсхолдеры на месте (`{{повод}}` в письме 1, `{{кейс}}` в `body_with_case`, `{{подпись}}` везде); ровно один `?` в каждом теле; запретные/служебные слова; цифры только из утверждённых формулировок и слов шаблона (`TEMPLATE_NUMBERS`). Провал → повтор с перечнем замечаний → провал: `status='failed'`.
- [ ] `renderTemplate.ts`: подстановка значений; строка/абзац, ставшие пустыми, удаляются; выбор `body_direct`/`body_routing` по `is_routing`, `body_with_case`/`body_without_case` по наличию кейса; тема письма 1 — `subject` с `{{бренд}}`; письма 2–4 без темы. Результат — `Letter[]` (как сейчас).
- [ ] `runner.ts` `finalize`: вместо `buildChain` — `getChainTemplate` → гипотеза сегментов (как сейчас, но роль `analysis`, и только если нет кейса) → `renderTemplate` → нынешний `runQa` для готовых писем. Шаблон `failed` или QA провален → `doubtful` с причиной в `doubt_detail` («цепочка оффера не прошла проверку» / флаги QA). В строке `chain_template_id`. При старте запуска удалять шаблоны этого `job_id`.
- [ ] Роут `POST /api/tools/polza-ru-outreach/[jobId]/templates/[offerKey]/regenerate`: перегенерировать шаблон (новая попытка) и пересобрать письма строк этого оффера в статусах `doubtful` с причиной шаблона → по результату `ready`/`doubtful` (с тем же лимитом готовых). Выполнять в воркере? Нет — пересборка без обхода сайтов быстрая; в роуте с бюджетом запуска из `progress_detail.llm` (лимит тот же), таймаут роута учесть (до 60 с на шаблон).
- [ ] tsc + eslint + тесты (`tests` по chains/qa, если есть). Commit `feat(polza-ru-outreach): цепочки Gemini 3.1 Pro на оффер, факты подставляются в шаблон`.

### Task 10: EN — шаблоны цепочек + настройка подписи

**Files:** Create `app/src/lib/polzaOutreach/templateWriter.ts`, `renderTemplate.ts`; Modify `buildLetters.ts` (оставить как образец + `guardLetters` режим шаблона), `runner.ts`, роут настроек `app/src/app/api/parsers/polza-outreach/settings/route.ts` (новый: GET/PUT подписи), `PolzaOutreachLaunchPanel.tsx` (поле «Подпись»)

- [ ] Оффер = тип главного повода (`hiring|yc|launch|tech_stack|none`). Плейсхолдеры `{{company}}`, `{{trigger}}`, `{{trigger_short}}`, `{{case}}`, `{{segments}}`, `{{signature}}`; «Hi there,»; письмо 1 `body_direct`/`body_routing` (общая почта — «who would be the right person…»), письмо 3 `body_with_case`/`body_without_case`; письма 2–4 без темы (ответ в ветке). Подпись — из `polza_outreach_settings.signature` (по умолчанию «Julia Mira…»); `guardLetters` проверяет её вместо константы.
- [ ] Логика ленивой генерации, проверки, повтора, `failed` → `needs_review` с причиной `template_failed`, пересборка по кнопке (`POST /api/parsers/polza-outreach/[jobId]/templates/[offerKey]/regenerate`) — как Task 9.
- [ ] tsc + eslint + тесты. Commit `feat(polza-outreach): цепочки Gemini 3.1 Pro на оффер, подпись из настроек`.

### Task 11: Экран запуска — цепочки и деньги

**Files:** Modify RU `components/polzaRuOutreach/JobDetail.tsx` (+ новый `ChainTemplates.tsx`), EN `components/parsers/PolzaOutreachResults.tsx` (или соседний), роуты чтения шаблонов `GET …/[jobId]/templates` (RU и EN)

- [ ] Блок «Цепочки запуска»: оффер (подпись оффера), статус (готова / не прошла проверку / пишется), стоимость, раскрытие текста (письма шаблона с плейсхолдерами, подсвеченными), кнопка «Переписать цепочку» у `failed` (вызывает regenerate, показывает результат).
- [ ] tsc pages/api + eslint. Commit `feat(outreach): экран запуска — цепочки оффера и расход на ИИ`.

---

## Этап 4. «Рассылка»: папки, заливка, запуск

### Task 12: Миграция сендера

**Files:** Create `supabase/migrations/20260926_0002_sender_folders.sql`

- [ ] `sender_folders` (спека §5) + сиды `auto_ru`, `auto_en` (`on conflict (key) do nothing`); `sender_campaigns` + `folder_id uuid references sender_folders(id) on delete set null`, `source_kind text not null default 'manual' check in ('manual','polza_ru','polza_en')`, `source_job_id uuid`; индекс `(folder_id)`. RLS/гранты — как у `sender_campaigns` в `20260916_0001_sender_tool.sql`.
- [ ] `npx jest tests/migrations --silent`. Commit `feat(sender): папки рассылок — автоаутрич RU и EN`.

### Task 13: Операции сендера в библиотеке + страховка пустого шага

**Files:** Create `app/src/lib/sender/campaignOps.ts`; Modify роуты `api/tools/sender/campaigns/route.ts`, `campaigns/[id]/route.ts`, `campaigns/[id]/recipients/route.ts` (вызывают campaignOps, поведение для пользователя не меняется), `lib/sender/planner.ts`

- [ ] `campaignOps.ts` (серверный модуль, `supabaseAdmin`):
  `createCampaign({ name, folderId?, sourceKind?, sourceJobId?, timezone, sendHourFrom, sendHourTo, sendWeekdays, gapSeconds, gapJitterSeconds, mailboxIds, steps: {subject, body, delayHours}[], createdBy })`;
  `importRecipients(campaignId, rows: { email, name?, vars }[], { mode: 'append' | 'replace' })` → `{ inserted, skippedSuppressed, skippedDuplicates, skippedInvalid }` (нормализация и суппрессия — как в роуте сейчас; строка с пустым `vars.email_1`, если шаг 1 ссылается на `{{email_1}}`, — `skippedInvalid`);
  `startCampaign(campaignId)` → ошибки как сейчас + «нет шагов», «нет проверенных ящиков в пуле» (понятный текст).
  Логику брать из роутов дословно (без изменения поведения), роуты переводятся на эти функции.
- [ ] Страховка в `planner.ts`: отрендеренное тело шага пустое (после trim) → сообщение не создаётся, получатель `finished` (для шага 1 — `stopped` с причиной в логе). Комментарий почему.
- [ ] Существующие тесты сендера (grep `tests` по `sender`) — PASS. tsc + eslint. Commit `refactor(sender): создание, заливка и запуск рассылки — общие функции; пустое письмо не уходит`.

### Task 14: Заливка из аутричей и запуск

**Files:** Create `app/src/lib/outreachSender/upload.ts`; роуты `app/src/app/api/tools/polza-ru-outreach/[jobId]/sender/route.ts` (POST залить, GET статус), `.../[jobId]/sender/start/route.ts`; то же для EN `app/src/app/api/parsers/polza-outreach/[jobId]/sender/…`

- [ ] `upload.ts`: `uploadJobToSender({ lang, jobId, mode: 'new'|'append', campaignId?, userId })`: папка по ключу `auto_ru`/`auto_en`; выбрать готовые строки без `sender_campaign_id` (RU: `row_status='ready' and qa_status='passed' and recipient_email not null`; EN: `status='ready' and selected_company_email not null`); `new` → `createCampaign` с настройками папки, имя `RU · 26.09 · N компаний` (дата запуска МСК), шаги: 1 `{subject:'{{subject_1}}', body:'{{email_1}}'}`, 2–4 `{subject:'', body:'{{email_N}}', delayHours: folder.step_delays_hours[i]}`; `append` → проверка, что рассылка из этой папки и draft/paused; `importRecipients` с vars `subject_1`, `email_1..4`, `company`, `domain`; пометить строки `sender_campaign_id`, `sender_uploaded_at` (только реально добавленные и дубли в этой рассылке; суппрессированные не помечать, но вернуть счётчик). Ответ: `{ campaignId, name, inserted, skipped… }`.
- [ ] Старт: `startCampaign(campaignId)` с проверкой, что рассылка из папки аутрича и связана с этим запуском.
- [ ] Права — как у роутов сендера (внутренние роли, `authenticateRequest` из sender `apiHelpers`).
- [ ] tsc api + eslint. Commit `feat(outreach): заливка готовых компаний в Рассылку и запуск по кнопке`.

### Task 15: UI — папки в сендере, кнопки в аутричах

**Files:** Modify `components/sender/CampaignsTab.tsx` (+ новый `FolderSettingsModal.tsx`), `components/sender/api.ts`, роут `api/tools/sender/folders/route.ts` (GET список, PATCH настройки); RU `JobDetail.tsx`, EN экран запуска

- [ ] Сендер: рассылки сгруппированы по папкам («Автоаутрич RU», «Автоаутрич EN», «Остальные»); у папки кнопка «Настройки» — ящики (переиспользовать `MailboxPickerModal`), часы/дни/пояс, интервалы писем (дни), сохранение PATCH.
- [ ] Аутричи (RU и EN экран запуска): блок «Рассылка»: если не залито — кнопка «Залить в Рассылку» (+ выбор «новая» / «добавить в существующую» из списка рассылок папки); после — имя рассылки, сколько залито/пропущено, ссылка в сендер, кнопка «Запустить рассылку» (скрыта, если уже идёт), «Долить новые» если появились новые готовые. Ошибки — понятным текстом («Выберите ящики в настройках папки “Автоаутрич RU”»).
- [ ] tsc pages/api + eslint. Commit `feat(sender,outreach): папки в Рассылке и кнопки заливки/запуска в аутричах`.

---

### Task 16: Итог

- [ ] `npm run typecheck:strict`, eslint по изменённым каталогам, `npx jest --silent` (известные падения на Windows: `baseConstructorDeployDrain`, `relevanceEvidenceIdentity`, `workerThreadpool`, `veContactDeliveryWithoutPeriod` — не наши).
- [ ] Финальное ревью, обновить память, push, отчёт пользователю: что выложить (ключи, `--force-recreate worker-polza-outreach`, ящики в папках), первый пробный запуск на 20 компаний и сверка стоимости.
