# Polza ENG Outreach — план реализации MVP

Автор плана: сессия анализа 17.09.2026. Исполнитель: отдельный агент.
Дедлайн демо: **понедельник 21.09.2026**. Рабочее окно: вечер чт 17.09 + пт 18.09, сб — буфер.

---

## 1. Что делаем и зачем

Автоматизируем английский холодный аутрич агентства Polza. Система сама находит IT-компании,
которые **прямо сейчас нанимают SDR/BDR**, доказывает по тексту вакансии, **на какой рынок**
компания продаёт, находит корпоративную почту и собирает готовую цепочку из 4 писем.

Первоисточники требований (прочитать перед началом, оба лежат у пользователя):
- `enagency_шаблоны_цепочек.txt` — утверждённые тексты цепочек (версия 2026-09-11);
- `polza_auto_outreach_pipeline.md` — спецификация конвейера.

**MVP = один источник (SDR-вакансии), одна цепочка (SDR hiring-trigger), генерация писем без отправки.**

### Что демо должно доказать

1. Компании настоящие и свежие, со ссылкой на вакансию.
2. Гео продаж определяется **из текста вакансии** с сохранённой цитатой-доказательством.
3. Система не выдумывает: нет пруфа — откат на безопасную формулировку, и это видно в таблице.
4. Видна воронка: сколько из тысяч вакансий доходит до готового письма.

---

## 2. Принятые решения (не пересматривать без пользователя)

| Решение | Выбор |
|---|---|
| Экран | новая вкладка на странице `/parsers`, клон вкладки «ENG вакансии» |
| Фоновая обработка | **отдельный контейнер** `worker-polza-outreach` |
| Источник | только `eng_hiring_cache`, source `jobhive` |
| Отправка писем | **нет**, только генерация и выгрузка |
| Тесты | **новых тестов не пишем** (запрет в `CLAUDE.md`) |
| Деплой на прод | делает пользователь сам, агент только готовит код |

---

## 3. Состояние данных (проверено 17.09.2026 на боевой БД)

Таблица `public.eng_hiring_cache`:

| Факт | Значение |
|---|---|
| Свежие строки источника `jobhive` | 13 700 за 45 дней, ингест отработал 16.09 |
| Из них SDR/BDR/Sales Development/Business Development | **2 857 вакансий, 2 483 компании** |
| С текстом вакансии > 300 символов | 2 380 |
| `country_code` заполнен | 2 529, **в нижнем регистре**: `us` 881, `gb` 307, `de` 273, `ca` 248, `fr` 132, `remote` 171 |
| `vacancy_url` | есть у всех |
| `company_site_url` | **почти всегда NULL** у jobhive — домен восстанавливаем резолвером |

Ловушки:
- нативные ATS (`greenhouse`, `lever`, `ashby`, …) в кэше **протухли, последняя выкачка 02.08.2026** — в MVP не используем;
- у части строк `published_at` уезжает в будущее (встречается `2027-01-01`) — фильтровать через `published_at between now() - interval 'N days' and now()`;
- поле `country` (текстом) у jobhive пустое, есть только `country_code`.

---

## 4. Архитектура

```
UI (вкладка «Polza аутрич»)
  └─ POST /api/parsers/polza-outreach      → строка в parser_jobs (parser_type='polza_outreach')
       └─ worker/polzaOutreach.ts (claimParserJob)
            ├─ S1 выборка вакансий из eng_hiring_cache
            ├─ S2 восстановление домена (PDL-резолвер)
            ├─ S3 ICP-фильтр и исключения
            ├─ S4 LLM-разбор вакансии: мандат + гео + услуга
            ├─ S5 поиск корпоративной почты на сайте
            └─ S6 сборка 4 писем + гарды
                 └─ строки в polza_outreach_companies
  └─ GET /api/parsers/polza-outreach/[jobId] → таблица + воронка + CSV
```

Каждая стадия **пишет результат в строку и не удаляет предыдущие**: строка, отсеянная на S3,
остаётся в таблице со статусом `excluded` и причиной. Воронка считается по этим статусам —
она и есть главный артефакт демо.

---

## 5. Что переиспользуем (не писать заново!)

| Нужно | Берём из |
|---|---|
| Очередь задач, claim, recovery | `app/worker/parserJobs.ts` (`claimParserJob`, `recoverRunningParserJobs`), `app/worker/_shared.ts` |
| Каркас воркера | `app/worker/engHiring.ts` — копировать целиком, поменять тип задачи |
| API-роут создания/списка задач | `app/src/app/api/parsers/eng-hiring/route.ts` (150 строк, копировать) |
| Вкладка UI | `app/src/components/parsers/EngHiringParserView.tsx` (491), `EngHiringParserForm.tsx` (261), `EngHiringVacancyResults.tsx` (227) |
| Список запусков | `app/src/components/parsers/JobsList.tsx` |
| Восстановление домена | `app/src/lib/parsers/companyDomainResolver.ts` → `resolveCompanyDomainViaPdl(name, countryCode)` |
| Поиск почты | `app/src/lib/enrich/emailScraper.ts` → `scrapeEmails(url, { locale: 'en', maxPages, timeout })` |
| Вызов модели | `app/src/lib/openrouter/client.ts` → `callOpenRouterChat` (ключ `OPENROUTER_PERSONALIZATION_API_KEY`) |
| Проверки текста письма | `app/src/lib/verticalEngineV2/letterChecks.ts` → `checkLetterRules` |
| Банк кейсов | `app/src/lib/verticalEngineV2/caseBank.ts` |

---

## 6. Шаги реализации

### Шаг 0. Ветка

Отойти от `main` новой веткой `polza-eng-outreach`. Перед коммитами — `git status`:
в дереве бывают чужие незакоммиченные правки.

### Шаг 1. Миграция

Файл `supabase/migrations/2026MMDD_000N_polza_outreach_mvp.sql` (номер по дню создания,
формат как у соседей). Применяется автоматически на деплое.

```sql
create table if not exists public.polza_outreach_companies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.parser_jobs(id) on delete cascade,

  -- источник
  source_type text not null default 'sdr_job',
  vacancy_id uuid references public.eng_hiring_cache(id) on delete set null,
  job_title text,
  job_source_url text,
  job_country_code text,
  job_published_at timestamptz,

  -- компания
  company_name text not null,
  normalized_domain text,
  company_website text,

  -- разбор вакансии
  outbound_mandate boolean,
  outbound_evidence text,
  service_line text,
  target_sales_geo text,
  target_sales_geo_evidence text,
  target_sales_geo_confidence text check (target_sales_geo_confidence in ('high','medium','low')),

  -- почта
  selected_company_email text,
  email_type text,
  email_source_url text,

  -- письма
  sequence_id text,
  letters jsonb,

  -- конвейер
  status text not null default 'discovered',
  stage text,
  exclusion_reason text,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_polza_outreach_job on public.polza_outreach_companies(job_id);
create index if not exists idx_polza_outreach_domain on public.polza_outreach_companies(normalized_domain);

alter table public.polza_outreach_companies enable row level security;
-- RLS-политики и grants скопировать один-в-один с соседней результирующей таблицы парсеров.
-- ВАЖНО: у каждой новой таблицы обязан быть `grant ... to service_role`,
-- это проверяет tests/migrations/grants.test.ts — иначе прогон в ветке красный.
```

Статусы MVP: `discovered → normalized → excluded | needs_review | qualified → ready`.

У `parser_jobs.parser_type` нет CHECK-констрейнта — новый тип `polza_outreach` добавлять никуда не нужно.

**Готово, когда:** миграция проходит линтер миграций и `npm run typecheck:strict` зелёный.

---

### Шаг 2. Стадия S1 — выборка вакансий

Файл: `app/src/lib/polzaOutreach/selectVacancies.ts`

```
from eng_hiring_cache
where source = 'jobhive'
  and published_at between now() - interval '<posted_within_days> days' and now()
  and vacancy_title ~* '\m(sdr|bdr|sales development|business development|outbound sales)\M'
  and lower(country_code) = any(<выбранные гео>)
  and vacancy_description is not null and length(vacancy_description) > 300
order by published_at desc
limit <limit>
```

Дедуп по компании: одна строка на `company_name`, берём самую свежую вакансию.

Гео по умолчанию: `us, ca, gb, de, nl, fr, se, ie, es, ch, be, dk, no, fi, at, it, pl, pt, cz`.
Строки с `country_code = 'remote'` или NULL в MVP **не берём** — гео там недоказуемо.

**Готово, когда:** на лимите 100 функция возвращает 100 непустых компаний.

---

### Шаг 3. Стадия S2 — домен компании

Файл: `app/src/lib/polzaOutreach/resolveDomain.ts`

Вызов `resolveCompanyDomainViaPdl(company_name, country_code)`. Резолвер намеренно
возвращает пустую строку при коллизии имён — это правильное поведение, «чинить» не надо.

Нормализация домена по спеке §8: убрать протокол, `www.`, путь, параметры, привести к нижнему регистру.
Никогда не подставлять домен LinkedIn или job board вместо сайта компании.

Не разрешился → `status='excluded'`, `exclusion_reason='domain_not_resolved'`.

**Готово, когда:** в логе видно, какой процент компаний получил домен. Ожидание: 30–60%.
Если ниже 20% — остановиться и сказать пользователю: это меняет разговор про объёмы.

---

### Шаг 4. Стадия S3 — ICP-фильтр

Файл: `app/src/lib/polzaOutreach/icpFilter.ts`

Исключаем по спеке §3.4 — по названию компании, описанию из вакансии и домену:
- лидген / appointment setting / outbound-агентства — **это прямые конкуренты, критично**;
- staffing и recruitment без собственной разработки;
- generic digital marketing;
- B2C-only, образование, маркетплейсы и каталоги;
- размер 10–50 сотрудников (Глеб работает по ним сам) — берём из `pdl_companies.size`, если домен нашёлся.
  **Осторожно:** корзины в `pdl_companies` не совпадают с сегментами спеки. Фактические значения —
  `1-10` (13,9 млн), `11-50` (3,75 млн), `51-200` (1,21 млн), `201-500`, `501-1000`, `1001-5000`,
  `5001-10000`, `10001+`. Исключению «10–50» соответствует корзина `11-50`; корзина `1-10`
  остаётся (спека допускает малые компании при наличии коммерчески значимого оффера).
  Размер неизвестен — компанию не выбрасываем;
- домен уже встречался в этом же запуске.

Дешёвые правила (списки стоп-слов) — до LLM, чтобы не платить за заведомо мусорные строки.
Каждое исключение пишет человеческую причину в `exclusion_reason`.

**Готово, когда:** в выборке из 100 руками проверено 10 исключённых и все отсеяны по делу.

---

### Шаг 5. Стадия S4 — LLM-разбор вакансии ⭐ ядро демо

Файл: `app/src/lib/polzaOutreach/analyzeVacancy.ts`

Вход: `vacancy_title`, `vacancy_description` (обрезать до ~6000 символов), `company_name`, `country_code`.

Выход — строгая JSON-схема:

```ts
{
  outbound_mandate: boolean,          // есть ли cold email / prospecting / pipeline generation
  outbound_evidence: string,          // ДОСЛОВНАЯ цитата из вакансии, ≤ 200 символов
  service_line: string | null,        // какую услугу компании будет продавать SDR
  service_line_confident: boolean,
  target_sales_geo: string | null,    // 'North America' | 'DACH' | 'UK' | 'EMEA' | страна
  target_sales_geo_evidence: string,  // ДОСЛОВНАЯ цитата
  target_sales_geo_confidence: 'high' | 'medium' | 'low',
  is_lead_gen_agency: boolean         // страховка поверх правил шага 4
}
```

Правила уровней (спека §5):
- `high` — рынок прямо назван в вакансии или её заголовке;
- `medium` — следует из требуемого языка, рабочих часов или описания клиентов;
- `low` — только косвенный контекст или страна офиса.

**Железное правило:** каждая цитата обязана дословно встречаться в тексте вакансии.
После ответа модели проверять это программно; подстрока не нашлась — понижать confidence до `low`
и очищать поле. У модели не должно быть возможности выдумать доказательство.

Модель: через `callOpenRouterChat`, дешёвая (уровень `bulk`), температура 0, по одной вакансии на вызов,
параллельность 4–6, один ретрай. На 100 компаниях стоимость копеечная.

`outbound_mandate = false` → `status='excluded'`, `exclusion_reason='no_outbound_mandate'`.
`is_lead_gen_agency = true` → `exclusion_reason='competitor'`.

**Готово, когда:** на 30 строках руками сверено, что цитаты реальные, а гео правдоподобное.
Записать в лог распределение `high/medium/low` — **это цифра для демо**.

---

### Шаг 6. Стадия S5 — корпоративная почта

Файл: `app/src/lib/polzaOutreach/findEmail.ts`

`scrapeEmails(websiteUrl, { locale: 'en', maxPages: 5, timeout: 15000 })`, затем выбор по приоритету (спека §10):

```
sales@ → business@ → businessdevelopment@ → partnerships@ → growth@ → commercial@ → contact@ → hello@ → info@
```

Жёстко запрещено: бесплатные домены (gmail, yahoo, outlook, proton), `support@`, `billing@`, `legal@`,
`privacy@`, `careers@`, `jobs@`, `hr@`, `recruiting@`, `noreply@`, почта рекрутера из вакансии,
адреса, собранные перебором. Адрес обязан быть на домене компании.

Параллельность ≤ 5 сайтов, общий таймаут на компанию 30 с, сетевые ошибки не валят запуск.

Не нашли → `status='needs_review'`, `review_reason='no_corporate_email'` (не `excluded`: компания валидная).

**Готово, когда:** известен процент компаний с почтой. Ожидание 40–70%.

---

### Шаг 7. Стадия S6 — сборка писем

Файл: `app/src/lib/polzaOutreach/buildLetters.ts`

Берём цепочку **SDR hiring-trigger** из `enagency_шаблоны_цепочек.txt` (раздел 2). Тексты
переносить дословно — это утверждённый контент. Меняются только слоты.

Развилка первого письма:
- гео подтверждено (`high`/`medium`) **и** `service_line_confident`:
  `I saw that you're hiring an SDR to build pipeline for {service_line} in {target_sales_geo}.`
- иначе безопасный вариант:
  `I saw that you're hiring an SDR. If the role is meant to build pipeline for {service_line}, Polza can test that motion as an external SDR function before you add fixed headcount.`

Кейс для письма 2 — один, из `caseBank.ts`, по правилу: UK → Axisage, mobile → AppsLift,
fintech/payments → INXY, иначе дефолт Itexus. Цифры кейсов не менять никогда.

**Гарды перед сохранением** (строка не прошла — `needs_review`, а не «подправить текст»):
- обращение строго `Hi,` — никаких имён и `Hi team,`;
- в письмах нет дат, годов и ISO-дат;
- сигнал в письме 1 — один факт, ≤ 20 слов, ≤ 1 запятая;
- нет слов `leading`, `full-service`, `end-to-end`;
- подпись строго `Julia Mira / Account Manager / Polza Agency`;
- оффер дословный: `We'll bring you 3 sales-qualified leads, or continue working for free until we do.`;
- один кейс на письмо, цифры совпадают с банком.

Переиспользовать `checkLetterRules` из `verticalEngineV2/letterChecks.ts`, дописав недостающие правила.

Сохраняем в `letters` как `[{n:1, subject, body}, …]`, `sequence_id='sdr_hiring_trigger'`, `status='ready'`.

**Готово, когда:** прочитано 20 писем подряд и ни в одном нет выдуманного факта.

---

### Шаг 8. Воркер

Файл: `app/worker/polzaOutreach.ts` — копия `app/worker/engHiring.ts`, тип задачи `polza_outreach`,
`WORKER_ID = 'polza-outreach-…'`. Раннер: `app/src/lib/polzaOutreach/runner.ts` — последовательно
S1…S6, после каждой стадии обновляет `parser_jobs.progress_stage` и `progress_percent`,
чтобы в UI крутился прогресс.

Ошибка одной компании не валит задачу: пишем `status='failed'` в строку и идём дальше.

---

### Шаг 9. API

- `app/src/app/api/parsers/polza-outreach/route.ts` — копия eng-hiring роута: `GET` список задач, `POST` создание.
  Конфиг: `{ countries: string[], posted_within_days: number (1..45), limit: number (1..300) }`, значения санитизировать.
- `app/src/app/api/parsers/polza-outreach/[jobId]/route.ts` — результаты с пагинацией + сводка воронки
  (`count(*) group by status, exclusion_reason`).

Авторизация как в оригинале: `createAuthedSupabaseClient` + `getBearerToken`, логирование через `logAudit` / `logError`.

---

### Шаг 10. UI

- `app/src/components/parsers/PolzaOutreachView.tsx` — клон `EngHiringParserView.tsx`;
- `PolzaOutreachForm.tsx` — гео (мультивыбор), свежесть вакансии, лимит (дефолт 100);
- `PolzaOutreachResults.tsx` — таблица: Компания · Домен · Вакансия (ссылка) · Услуга · Гео · Уверенность (цветной бейдж) · Почта · «Письма»;
- разворот строки — 4 письма + блок «Доказательства»: цитата про мандат и цитата про гео;
- **шапка-воронка**: `вакансий N → домен найден M → прошли ICP K → гео подтверждено G → почта P → готово R`;
- CSV-экспорт — логика уже есть в клонируемом компоненте, поменять заголовки колонок;
- вкладка регистрируется в `app/src/app/parsers/page.tsx` (тип `Tab`, кнопка, рендер).

Типы строк добавить в `app/src/types`.

---

### Шаг 11. Деплой (делает пользователь, агент только готовит правки)

Новый контейнер требует пяти правок — **пропуск любой = воркер не поедет**:

1. `app/package.json` → `build:workers` **и** `build:workers:watch`: добавить `worker/polzaOutreach.ts`;
2. `docker-compose.prod.yml` → сервис `worker-polza-outreach`, `container_name: portal-worker-polza-outreach`;
   копировать блок `worker-eng-hiring` (образ `portal-worker:prod`, лимиты 1536M / 0.75 cpu / pids 512,
   `WORKER_KIND=polzaoutreach`, обязательно проброс `OPENROUTER_PERSONALIZATION_API_KEY`);
3. `.semaphore/select-deploy-targets.sh` → добавить `worker-polza-outreach` в `ALL_WORKER_SERVICES`;
4. `drain-worker.sh` → добавить `portal-worker-polza-outreach` в список;
5. правка compose обязывает пересоздать сервис:
   `docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps worker-polza-outreach`
   (в scheduled-deploy `--force-recreate` для воркеров уже стоит, но проверить, что контейнер реально поднялся).

Имя compose-проекта всегда `-p portal`.

**Деплой делаем в пятницу вечером, а не в понедельник утром** — выходные должны остаться буфером.

---

## 7. Критерий приёмки демо

На проде, из вкладки «Polza аутрич», запуск на 100 компаниях завершается менее чем за 15 минут и даёт:

1. ≥ 25 строк со статусом `ready` (домен + почта + письма);
2. ≥ 10 строк с `target_sales_geo_confidence` = `high` или `medium`;
3. у каждой такой строки цитата-доказательство дословно встречается в тексте вакансии (проверить руками на 5 строках);
4. воронка в шапке сходится: сумма по статусам равна числу обработанных вакансий;
5. CSV выгружается и открывается.

---

## 8. Вне скоупа MVP (не делать, даже если захочется)

Отправка писем и заливка в Instantly; источники PDL и funding; персонализированная цепочка по сигналам
компании; funding-цепочка (её текстов не существует); проверка по suppression-листу и истории рассылок;
запуск по расписанию; скоринг лидов; автопроверка писем моделью; аналитические отчёты; оживление
протухших ATS-источников.

---

## 9. Риски

| Риск | Что делать |
|---|---|
| Домен восстанавливается у малой доли компаний | замерить на шаге 3 и сразу сказать пользователю — это меняет обещанные объёмы, а не повод «дожимать» резолвер |
| Подтверждённое гео у малой доли вакансий | это тоже результат, показывать честно; персонализация просто применяется реже |
| Скрапинг почты медленный или блокируется | жёсткие таймауты, ограничение параллельности, не ретраить мёртвые хосты |
| Модель выдумывает цитату | программная проверка вхождения подстроки — заложена в шаге 5 |
| Не успели с деплоем в пятницу | запасной вариант: синхронный расчёт на 20 компаниях прямо в API-роуте, без воркера — едет вместе с контейнером приложения |

---

## 10. Правила проекта, которые легко нарушить

- **Новые тесты не пишем.** Ни `*.test.ts`, ни `*.test.tsx`. Правка, требующая нового тестового файла, согласовывается с пользователем отдельно.
- У новой таблицы обязателен `grant ... to service_role`, иначе `tests/migrations/grants.test.ts` красный.
- `.env*` не коммитить.
- Прогон тестов в ветке должен укладываться в 3 минуты.
- Любая правка compose требует `--force-recreate` затронутого сервиса.
- Мерж в `main` и выкатку на прод делает пользователь, не агент.
