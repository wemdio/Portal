# «Наш автоаутрич» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Шаги — чекбоксы.
> Дизайн: `docs/superpowers/specs/2026-09-22-polza-ru-outreach-design.md`.

**Goal:** инструмент `/tools/polza-ru-outreach`: три оффера (SDR, автоматизация, сигналы) → готовые русские цепочки + Excel, без отправки.

**Architecture:** модуль `app/src/lib/polzaRuOutreach/` по образцу `polzaOutreach/`; задача `parser_jobs.parser_type='polza_ru_outreach'`, исполняет существующий воркер `worker/polzaOutreach.ts` во втором слоте; API `app/src/app/api/tools/polza-ru-outreach/*`; UI `app/src/components/polzaRuOutreach/*`.

**Tech Stack:** Next.js route handlers, Supabase (service_role в воркере, authed-клиент в роутах), OpenRouter (`callOpenRouterChat`, `openai/gpt-4o-mini`, temp 0, JSON), `xlsx` для выгрузки, hh API через `fetchWithRetry`.

**Проверка вместо TDD.** CLAUDE.md запрещает новые тест-файлы. Каждая задача
проверяется `npm run typecheck:strict` (или `npx tsc --noEmit -p .`) и `npx eslint <файлы>`;
логика писем/QA/цитат — смоук-скриптом в scratchpad (`npx tsx`), источники —
read-only SQL к боевой БД. Dev-сервер не поднимаем.

---

### Task 1: Миграция
**Files:** Create `supabase/migrations/20260922_0008_polza_ru_outreach.sql`
- [ ] Таблицы `polza_ru_outreach_companies`, `polza_ru_offer_claims`, `polza_ru_cases`, `polza_ru_senders` (+ сид подписи Егора, `is_default=true`), `polza_ru_signal_uploads`, `polza_ru_signal_rows` — поля по §3 дизайна.
- [ ] Индексы: `(job_id)`, `(normalized_domain) where row_status='ready'`, `(inn) where row_status='ready'`, `signal_rows(upload_id)`, `signal_rows(kind)`.
- [ ] RLS: companies — через `parser_jobs.user_id` (как `20260917_0003`); библиотеки и загрузки — `authenticated` полный доступ; `grant all ... to service_role` на каждую таблицу.
- [ ] `cd app && npx jest tests/migrations --silent` — grants/no-transaction линты зелёные.
- [ ] Commit `feat(polza-ru-outreach): таблицы журнала, библиотек и загрузок`.

### Task 2: Типы, конфиг, коды причин
**Files:** Create `app/src/lib/polzaRuOutreach/types.ts`
- [ ] `ProfileCode = 'sdr_hiring_v1'|'automated_outreach_v1'|'signals_v1'`, `LETTER_COUNT` (3/3/4), источники по профилю (`sdr: ['hh']`, `automation: ['crm','hh_multi']`, `signals: ['hh_sales','contracts','exhibitors','site_news']`).
- [ ] `RuOutreachConfig {profile_code, sources[], freshness_days(1–90, деф. 45; сигналы 30), limit(1–500, деф. 50), relationship_filter, min_signal_score(0–15, деф. 8), include_previously_exported, sender_id|null}` + `sanitizeRuOutreachConfig` (общий для API и раннера).
- [ ] `RowStatus`, `STAGES` (§4), `REASONS` — объединение кодов из INSTRUCTION_02/03 + сигнальных, с русскими подписями `REASON_LABELS` для UI.
- [ ] `EvidenceLevel`, `GenerationMode`, `Signal {type, title, date, url, quote, level, source}`, `Letter {n, subject, body}`.

### Task 3: Общие примитивы
**Files:** Create `evidence.ts`, `company.ts`, `libraries.ts`, `findEmail.ts`
- [ ] `evidence.ts`: `normalizeText(html|text)` (снять теги, сущности, пробелы, ё→е), `containsVerbatim(src, quote)`, `clipQuote(≤30 слов)`.
- [ ] `company.ts`: `companyBrand(name)` — убирает ООО/АО/ПАО/ОАО/ЗАО/ИП/LLC/Ltd/Inc/GmbH, кавычки «»"", лишние пробелы; `normalizeDomain(url)`; `loadPreviouslyExported(db)` → `{domains:Set, inns:Set}`; `loadSuppressed(db)` из `sender_suppressions`.
- [ ] `libraries.ts`: `loadLibraries(db, profile)` → `{sender, cases (approved, legal, не истёкшие, allowed_profiles∋profile), claims (approved, не истёкшие)}`; `formatSignature(sender)`; `offerVersion` = хэш id+updated_at активных claims.
- [ ] `findEmail.ts`: как английский, `locale:'ru'`, приоритет `sales, prodazhi, sale, b2b, commerce, kommerc, opt, partner(s), bd, zakaz, info, office, mail, contact, hello`; запрет HR/резюме/job/support/buh/noreply; `isRouting` = ящик из общего списка (info/office/mail/contact/hello/zakaz).
- [ ] typecheck + eslint; Commit.

### Task 4: Источники
**Files:** Create `sources/hhPool.ts`, `sources/hhCard.ts`, `sources/amo.ts`, `sources/uploads.ts`, `sources/siteSignals.ts`
- [ ] `hhPool`: SQL-выборка из `hh_vacancies` по регэкспу словаря (SDR-словарь и расширенный sales-словарь), окно `published_at`, дедуп `vacancy_id`, группировка по `employer_id` (или имени), страницы по offset; для `hh_multi` — работодатели с ≥2 разными вакансиями.
- [ ] `hhCard`: `fetchVacancyCard(id)` через `fetchWithRetry` → `{title, description(text), archived, published_at, alternate_url, employer{id,name,site_url?}}`; 404 → `closed`. `fetchEmployerSite(id)`.
- [ ] `amo`: лиды `amo_leads` с сайтом или корпоративной почтой; `prior_contact` = есть запись в `amo_notes` по лиду; дата = `greatest(updated_at, closed_at)`.
- [ ] `uploads`: строки `polza_ru_signal_rows` по виду и окну дат; `parseUploadFile(buffer, kind)` (xlsx/csv, русские/английские заголовки колонок).
- [ ] `siteSignals`: обход главной и ≤6 разделов (`/products|/solutions|/uslugi|/produkciya|/partners|/partneram|/dealers|/dileram|/news|/novosti|/press`) с таймаутами; LLM → `facts[{type, quote, url, date|null}]`; каждая цитата сверяется с текстом своей страницы; событие сайта без даты не считается свежим.
- [ ] Смоук: `hhPool` на бою (read-only) даёт кандидатов; `parseUploadFile` на пробном csv. Commit.

### Task 5: LLM-разбор вакансии
**Files:** Create `analyze.ts`
- [ ] Промпт по-русски: вернуть JSON `{sdr_function_quote, market, market_quote, is_b2b, b2b_quote, is_recruitment_agency, is_leadgen_competitor, is_b2c_only, industry}`; пост-валидация цитат `containsVerbatim`; несверившаяся → пусто. Ретрай 2. Ключ `OPENROUTER_PERSONALIZATION_API_KEY`, модель `POLZA_RU_OUTREACH_MODEL || 'openai/gpt-4o-mini'`.
- [ ] `pickCase(cases, industry, profile)` — детерминированно по пересечению тегов, иначе null.
- [ ] Commit.

### Task 6: Письма и QA
**Files:** Create `letters/sdr.ts`, `letters/automation.ts`, `letters/signals.ts`, `qa.ts`
- [ ] SDR: шаблоны INSTRUCTION_02 дословно (письмо 1 персональное/routing, письмо 2 с кейсом/без, письмо 3); блок рынка только при `market_quote`; при отсутствии SDR-цитаты строки сюда не доходят.
- [ ] Автоматизация: шаблоны INSTRUCTION_03 (relationship/cold/routing, письмо 2 с `verified_signal_block` или пусто, кейс или блок механики, письмо 3).
- [ ] Сигналы: 4 письма, две темы; фраза сигнала по типу (`sales_hiring`, `trade_show_exhibitor`, `contract_won`, `site_event`); письмо 3 — сегменты от LLM (`segmentsHypothesis`), при отсутствии рынка — нейтральная версия без LLM.
- [ ] `qa.ts`: проверки §6 дизайна → `{status:'passed'|'failed', flags[]}`.
- [ ] Смоук-скрипт: собрать все развилки трёх профилей на фиктивных данных, прогнать QA, вывести тексты — все `passed`, плейсхолдеров нет. Commit.

### Task 7: Раннер и профили
**Files:** Create `runner.ts`, `profiles/sdr.ts`, `profiles/automation.ts`, `profiles/signals.ts`
- [ ] Общий цикл волн как в `polzaOutreach/runner.ts` (цель — `limit` ready, потолок просмотра `min(3000, limit*30)`, отмена через `parser_jobs.status`, прогресс в `progress_detail.funnel`).
- [ ] Профиль = `{loadWave(ctx, want) → Candidate[], qualify(row) , assemble(row)}`; раннер делает общие стадии: вставка строк, домен, дедуп/ранее выгруженные/стоп-лист, почта, QA, запись статусов и причин.
- [ ] Commit.

### Task 8: Воркер
**Files:** Modify `app/worker/polzaOutreach.ts`
- [ ] Второй слот: `claimParserJob(log,'polza_ru_outreach')` с отдельным флагом активности; recovery по обоим типам.
- [ ] Commit.

### Task 9: API
**Files:** Create `app/src/app/api/tools/polza-ru-outreach/route.ts` (GET список / POST запуск), `[jobId]/route.ts` (PATCH stop), `[jobId]/results/route.ts` (строки + воронка + причины), `[jobId]/export/route.ts` (`?kind=ready|journal`, xlsx), `libraries/route.ts` (GET все библиотеки; POST/PATCH/DELETE по `table` ∈ cases|claims|senders), `uploads/route.ts` (GET список, POST multipart файл → строки, DELETE).
- [ ] Паттерн авторизации — как `api/parsers/polza-outreach/route.ts`.
- [ ] Commit.

### Task 10: UI и регистрация
**Files:** Create `app/src/app/tools/polza-ru-outreach/page.tsx`, `app/src/components/polzaRuOutreach/{View,LaunchForm,Results,Libraries}.tsx`; Modify `app/src/lib/toolsRegistry.ts`, `app/src/app/tools/page.tsx`.
- [ ] Вкладки «Запуск» / «Библиотеки»; форма по профилю; история с воронкой; таблица строк с разворотом писем/цитаты/ссылки; кнопки выгрузки; редактирование библиотек; загрузка файлов сигналов.
- [ ] Регистрация `polza-ru-outreach` в `ALL_TOOL_IDS`, `TOOLS_CONFIG` («Наш автоаутрич»), группа «Аутрич», иконка.
- [ ] typecheck + eslint; Commit.

### Task 11: Финальная проверка и пуш
- [ ] `cd app && npm run typecheck:strict && npx eslint src/lib/polzaRuOutreach src/app/api/tools/polza-ru-outreach src/components/polzaRuOutreach worker/polzaOutreach.ts`
- [ ] `npx jest --silent` (полный набор — ветка не должна краснеть).
- [ ] `git push -u origin polza-ru-outreach`; отчёт: ветка, SHA, что проверено, что нужно для запуска на проде (миграция применится на деплое; воркер тот же).
