# Portal DB — read-only Q&A

READ-ONLY доступ к основной БД Portal (Supabase Postgres) через MCP-сервер **`portal-db`**
(роль `readonly`, только `SELECT`, `statement_timeout=30s`, `default_transaction_read_only=on`).

Это внутренний инструмент студии Polza: проекты клиентов, задачи, финансы, инвойсы,
переписки менеджеров (Егор, Саша), транскрипты звонков, outreach через TG/LinkedIn/Instantly.
**С 06.07.2026 добавлены внешние источники:** сделки AMO CRM, визиты Яндекс Метрики,
транзакции банков (Точка + Т-Банк) — ночной синк в 2:00 МСК (23:00 UTC) воркером `portal-external-sync`.

Задача — отвечать на операционные вопросы **в разрезе проектов**. Никаких
`INSERT/UPDATE/DELETE/DDL` — роль их физически не пропустит.

Для аналитики холодного outreach (Instantly, кампании, письма, ниши) — другая БД,
отдельный MCP `instantly-dataset`. Не путать: outreach-показатели там, операционка тут.

## Терминология Polza — какое слово в какую таблицу

**Слова из бизнес-языка команды НЕ синонимы. Строгое соответствие:**

| Слово в вопросе | Куда идти | Почему |
|---|---|---|
| **сделка / сделки / лид / лиды / воронка продаж / выиграно / проиграно / win / lost** | `amo_leads` | Это AMO CRM. «Сделка» в Polza — всегда про AMO. |
| **проект / проекты / клиент в работе / продление / KPI / launch / срок сдачи** | `projects` | Это портал. «Проект» — работа со уже подписанным клиентом. |
| **выручка / деньги пришли / оплата на счёт / поступления / банк** | `bank_transactions` | Живые деньги из банка. Всегда `is_revenue = true`. |
| **инвойс / счёт-фактура / Yookassa** | `invoices` | Онлайн-оплаты через портал. Не путать с банком. |
| **выплата команде / зарплата / расход / компенсация** | `payment_requests` | Внутренние заявки на выплаты сотрудникам. |
| **визиты / трафик / источники / bounce / посетители** | `metrika_visits_daily` | Метрика (агрегат). |
| **задачи / просрочка / дедлайн / kanban** | `tasks` | Портальные задачи. |
| **переписка / чат с клиентом / сообщения менеджеров** | `sales_chat_messages` | Егор, Саша. |
| **звонок / транскрипт / расшифровка** | `tg_video_transcripts` | |
| **AI-разбор сделки / оценка менеджера / что делать по сделке / manager_score / risk / рекомендации по сделке / чему учить менеджера** | `sales_ai_deal_analysis` | Ночной AI-аудит по 27 вопросам управленческого разбора. **С 15.07.2026** — приоритетный источник для любых оценочных вопросов про качество ведения сделок. |

**Один AMO win = один портальный projects.** Но это разные строки в разных таблицах.
Не заменяй одно другим — если пользователь сказал «сделка», не показывай `projects`,
и наоборот.

## Центральная сущность — `projects`

**Проект — единственная главная сущность в этой БД. Всё остальное — данные по проекту:**
задачи, оплаты, звонки, сообщения менеджеров, гипотезы, KPI, продления, outreach-логи.
Любой операционный ответ **про уже работающих клиентов** имеет смысл в разрезе проекта:
**где деньги, где риск, кто владелец, что делать дальше, когда продление**.

**Но:** если вопрос про **воронку продаж до клиента** (лиды, сделки, конверсии) —
это AMO, `amo_leads`, а не `projects`. Смотри таблицу выше.

**Правила ответов:**
- Любой операционный ответ должен быть привязан к проекту (или списку проектов),
  а не оторван от него.
- Спросили про задачи → покажи с `project.client` и `project.status` рядом.
- Спросили про оплаты → свяжи через `payment_requests.project_id` или через клиента с `invoices`.
- Спросили про сообщения/звонки → через контакт клиента найди проект(ы) и покажи привязку.
- Если данные привязываются только по эвристике (нет FK) — прямо скажи в ответе:
  «связка через контакт, часть событий может не найтись».
- Общие агрегаты без разреза проекта — только если явно попросили тренд по компании.

**Приоритет источников для оценочных вопросов о сделках (кто как ведёт, где риск, что улучшать):**

Для «сухих» фактов о сделке (сумма, статус, менеджер) → `amo_leads`.
Для оценки качества ведения, риска, рекомендаций, оценки менеджера, разбора звонков → **`sales_ai_deal_analysis` (первый источник)**, `amo_leads` только для join'а по `amo_lead_id`. Если по конкретному критерию в AI-разборе стоит `"unknown"` или пустая строка — так и говори: «по этому критерию AI-аудит данных не нашёл» (например, звонков не было или переписка слишком короткая). Не додумывай оценку сам из raw-данных.

**Карта связей — как всё подвязано к `projects`:**

```
projects.id ──┬── tasks.project_id                    ← прямой FK
              ├── payment_requests.project_id         ← прямой FK
              ├── project_notes.project_id            ← прямой FK
              ├── project_periods.project_id          ← прямой FK (циклы продлений)
              ├── project_contacts_history.project_id ← прямой FK
              ├── attribution_amo_project.project_id  ← атрибуция AMO-сделки (FK + confidence)
              └── attribution_payment_project.project_id ← атрибуция банковского платежа

projects.client_user_id ── profiles.id ── invoices.client_user_id   ← через клиента

projects.client (text) ─┬─ sales_chat_dialogs         ← эвристика по имени/контакту
                        ├─ tg_video_transcripts       ← через chat_id/контакт
                        └─ tg_outreach_dialogs        ← через контакт

amo_leads.id ─── sales_ai_deal_analysis.amo_lead_id  ← FK, AI-разборы по сделке
amo_leads.ym_client_id ─── metrika_visits.ym_client_id  ← Метрика → сделка
                           (или через attribution_visit_lead с confidence)
```

Прямые FK — гарантированная связка. `attribution_*` — с confidence 0.0-1.0 (фильтруй
`WHERE confidence >= 0.7` для надёжных). Через `profiles` — надёжная. Эвристика по
контакту — может недоохватить (менеджер не подшил переписку к клиенту → она «не найдётся»).

## How to query
- MCP-тул **`query`** с одним `SELECT`.
- Разведка схемы: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1;`
- Комментарии на колонках/таблицах: `SELECT obj_description('projects'::regclass);` — часто пусто, семантика ниже в этом файле.
- Джойни `profiles` для имён по `manager/specialist` из projects.
- При exploratory запросах — всегда `LIMIT 100`.

## Секретные таблицы — не читать
Отозваны на уровне роли (SELECT вернёт «permission denied»):
- `sales_chat_accounts` — session_sealed для TG-сессий Егора и Саши.
- `tg_outreach_accounts` — сессии outreach-аккаунтов.
- `team_activity_plan_items` — закрытый рабочий план команды, включая внутренние примечания и бюджет.
- `payment_request_managers` — закрытый список пользователей, которые согласуют и отмечают оплаты.
- `payment_request_events` — закрытый журнал решений и изменений заявок на оплату.

## Ключевые таблицы (полей и семантики достаточно для 90% вопросов)

### `projects` — карточка проекта (~125 записей)
Главная сущность, всё крутится вокруг неё.
Ключевые поля:
- `id` (uuid, PK)
- `client` — название клиента строкой
- `name` — список услуг через запятую (Аутрич, Колди, ЛинкедИн, ...)
- `status`: `В работе` | `Тестирование` | `На паузе` | `Подготовка` | `Завершен` | `Отменен`
  (расклад: Завершен 68, Тестирование 29, В работе 19, Подготовка 4, На паузе 2)
- `manager` (text) — имя менеджера
- `specialist` (text) — имя специалиста
- `budget` (**text!**) — сумма договора строкой
- `margin` (**text!**) — маржа строкой
- `payment_amount`, `payment_date`, `contract_date`
- `project_type`: `Продажа` | `Продление`
- `work_format`: `Колди` | `Тригга` | `Инстантли`
- `lead_source`: `Аутрич` | `Телеграм` | `Лидскан` | `ЛинкедИн` | `Перфоманс` | `Органика` | `Партнер`
- `brief_text`, `hypotheses`, `hypotheses_result`
- `launch_date`, `deadline`, `kpi_plan`, `kpi_fact`
- `client_user_id` → `profiles.id`

**Ловушки:**
- `budget`/`margin` — text, не numeric. Приводить через
  `NULLIF(regexp_replace(budget,'\D','','g'),'')::numeric`.
- Один клиент может быть на нескольких проектах — не дедуплицировать по `client`.
- `manager`/`specialist` — text-поля, **не FK** на `profiles`. Один человек может
  фигурировать под разными строками (`Dmitriy Kulaga` = `dima.kulaga5`, email vs
  full name, разные регистры). При агрегации по сотруднику — нормализуй
  (`LOWER(TRIM(...))`, ручные алиасы) или джойни на `profiles.full_name`/`email`
  по эвристике. Иначе один исполнитель считается дважды, аналитика загрузки врёт.

### `tasks` — задачи (~934)
- `id`, `project_id`, `title`, `description`, `result`, `status`, `specialist`, `deadline`, `board_id`, `column_id`, `created_by`
- Статусы: `done` (835), `pending` (57), `in_progress` (41), `backlog` (1)
- Может быть без `project_id` (общие задачи).
- `specialist` — text без FK, та же ловушка что и в `projects` (см. выше про алиасы).

### `invoices` — инвойсы через Yookassa (~44)
- `id`, `company_name`, `client_user_id`, `amount` (numeric), `currency`, `description`, `status`, `yookassa_payment_id`, `paid_at`
- Статусы: `paid` (10), `pending` (3), `cancelled` (31)

### `payment_requests` — заявки на расходы и выплаты команде
- Базовые поля: `id`, `user_id`, `department`, `description`, `amount`, `project_id`, `comment`, `created_at`, `updated_at`.
- Тип расхода: `one_time` (разовый, входит в общий месячный лимит), `planned` (плановый, не входит в лимит) или `legacy_unclassified` (старая запись с неполными данными).
- Жизненный цикл: `pending` → `approved` → `paid`; вместо одобрения возможен `rejected`.
- `expected_payment_on` определяет месяц резерва и финансового плана; `paid_on` — месяц фактического расхода. Для факта всегда используй `paid_on`, а не `created_at`/`decided_at`.
- `approval_reason`: `planned` или `limit_exceeded`; `decided_by`, `decided_at`, `decision_comment` сохраняют решение; `paid_by`, `paid_at` и `paid_on_source` — фиксацию оплаты.
- `urgency`: `normal` | `urgent` | `critical`.
- `user_id` может быть `NULL`: при удалении профиля сотрудника заявка и журнал решений сохраняются, а автор остаётся замороженным снимком внутри таблицы (readonly-доступа к нему нет). Для отчётов по людям учитывай пустой `user_id`.
- Старые строки мигрированы как `paid + legacy_unclassified`; их дата оплаты приближённо восстановлена из московской даты создания и помечена `paid_on_source = legacy_created_at`. До ручного уточнения они консервативно входят в лимит разовых расходов.

**Лимит разовых расходов общий для компании:** 75 000 ₽ в обычный месяц и 40 000 ₽ в январе, мае и декабре. В лимите учитываются оплаченные разовые/неуточнённые расходы по `paid_on` и одобренные разовые расходы по `expected_payment_on`; `pending`, `rejected` и `planned` в лимит не входят.

**Readonly-ловушка:** доступ выдан только к фиксированному безопасному набору колонок и не включает `document_url`. Используй явный список нужных колонок; `SELECT *` по этой таблице завершится ошибкой. Ссылки на счета и подтверждающие документы доступны только автору заявки и согласующему через Portal API.

### `sales_chat_dialogs` / `sales_chat_messages` — переписки менеджеров с клиентами
- Аккаунты Егора и Саши, backfill сделан.
- `sales_chat_dialogs`: 3165, `sales_chat_messages`: 269 645 (2022-04 → 2026-06).
- Связь с проектом **не прямая** — идёт через контакт (телефон/username), не через FK.
- **269k строк** — при запросах ВСЕГДА фильтруй по дате/диалогу, иначе повиснешь.
- Attachments: `sales_chat_message_attachments`.

### `tg_video_transcripts` — транскрипты звонков (~369)
- Готовы 339, в процессе/ошибка 30.
- Период: 2026-05 → 2026-06.
- Связь с проектом — через chat_id/контакт, не через FK.

### `profiles` — пользователи (~62)
- Роли: `client` (21), `manager` (20), `technician` (8), `admin` (5), `lead` (4), `marketer` (2), `sales` (2).
- Тут `email`, `full_name`, `role` — для расшифровки `manager`/`specialist` строк в `projects`.
- `can_access_team_private` — отдельное fail-closed полномочие на закрытые вкладки «Статистика», «Ревью» и «Активности» страницы «Команда». Роль сама по себе доступа не даёт; на 10.08.2026 полномочие выдано только Алине и Сергею Лазуткину.
- `market` ('ru'|'eng', default 'ru', миграция 20260804_0004) — рынок клиента:
  'eng' = ENG-кабинет app.outreachos.xyz (middleware/signup/навигация разводят по нему).

### `project_notes` / `project_periods` / `project_contacts_history`
- 72 / 15 / 5006 записей соответственно.
- Заметки, циклы продлений, история контактов по проекту.

## Sales AI-аудит — приоритетный источник для оценки сделок

Ночной AI-разбор всех активных сделок AMO по регламенту отдела продаж. Работает раз
в сутки в 03:30 UTC (06:30 МСК) воркером `portal-worker-sales-ai-analysis`, модель
`claude-haiku-4-5` через Requesty. Бэклог хвостом ~500 сделок за 60 дней, дельта
20-30 сделок/день. Дедуп по `input_hash` — сделка не пересчитывается если ни AMO,
ни переписка, ни транскрипты, ни регламент не менялись с прошлого разбора.

**Когда идти в эту таблицу вместо `amo_leads`:** любые вопросы формата
- «как ведёт менеджер эту сделку?»
- «где риск потерять сделку X?»
- «топ-5 сделок, которые могут отвалиться на этой неделе»
- «какие возражения не закрыты?»
- «оцени работу менеджера [имя] за месяц»
- «что улучшить в скрипте / регламенте?»
- «есть ли рекомендации по следующему касанию?»

### `sales_ai_deal_analysis` — 27 ответов + метрики (одна запись на прогон)

**Ключевые поля (быстрые SQL-фильтры, без разбора JSON):**
- `amo_lead_id` → FK на `amo_leads.id` (не путать с `amo_leads.amo_id`)
- `analyzed_at` — timestamp разбора. **Всегда бери самый свежий**: `ORDER BY analyzed_at DESC LIMIT 1` per сделка.
- `manager_score int (1..10)` — оценка менеджера по этой сделке
- `action_type` — `manager_action_needed` | `no_action_needed`
- `risk_level` — `low` | `medium` | `high` (риск потерять сделку)
- `confidence` — `low` | `medium` | `high` (уверенность AI в выводах при имеющихся данных)
- `context_messages_count`, `context_transcripts_count` — сколько сообщений/звонков попало в контекст (для оценки «а хватало ли данных»)
- `tokens_used`, `cost_usd` — экономика вызова
- `llm_model`, `regulation_id` — версия модели и регламента

**Детальные 27 ответов лежат в `analysis_json` (JSONB).** Читай через
`analysis_json->>'qN_имя_поля'`. Схема ниже — что где и зачем:

| Поле в `analysis_json` | Ответ на вопрос | Когда использовать |
|---|---|---|
| `q1_funnel_stage` | На каком этапе воронки клиент? | «На каком этапе сделка X?» |
| `q2_next_step` | Есть ли понятный следующий шаг? | «Что дальше по сделке?» |
| `q3_loss_risk` | Есть ли риск потери, какой? | «Что может пойти не так?» |
| `q4_script_followed` | Прошёл ли менеджер регламент? | «Соблюдён ли скрипт?» |
| `q5_missed_stages` | Какие этапы регламента пропущены? | «Что менеджер не сделал?» |
| `q6_dialog_opening` | Корректно открыт диалог? | «Как менеджер начал разговор?» |
| `q7_unclear_zones` | Невыясненные потребность / бюджет / ЛПР / сроки | «Что мы не выяснили у клиента?» |
| `q8_offer_to_need_match` | Привязано ли предложение к боли клиента? | «Насколько релевантно предложение?» |
| `q9_evidence_used` | Использовал ли менеджер кейсы, цифры, доказательства? | «Есть ли аргументация?» |
| `q10_next_step_clarity` | Ясно ли объявлен следующий шаг? | «Клиент понял, что дальше?» |
| `q11_objections_found` | Какие возражения выявлены? | «Что беспокоит клиента?» |
| `q12_objections_handled` | Как отработал возражения? | «Отработал ли менеджер возражение X?» |
| `q13_objections_open` | Какие возражения не закрыты? | «Что до сих пор мешает купить?» |
| `q14_pauses_initiative` | Были ли паузы / потеря инициативы? | «Менеджер держит инициативу?» |
| `q15_interruptions_templates` | Перебивания / шаблоны / игнор вопросов | «Как ведёт разговор?» |
| `q16_manager_did_well` | Что менеджер сделал хорошо | «Что похвалить?» |
| `q17_manager_score_reason` | Обоснование числовой оценки (в `manager_score`) | «Почему такая оценка?» |
| `q18_top3_strengths` | 3 сильные стороны менеджера в этом контакте | «Сильные стороны?» |
| `q19_top3_growth_zones` | 3 зоны роста | «Что подтянуть?» |
| `q20_skill_to_improve` | Один навык на прокачку в первую очередь | «Чему учить менеджера?» |
| `q21_source_alignment` | Совпадают ли данные chat/call/AMO | «Есть ли расхождения между источниками?» |
| `q22_purchase_probability_up` | Факторы за покупку | «Что играет в плюс?» |
| `q23_purchase_probability_down` | Факторы против покупки | «Что снижает вероятность?» |
| `q24_next_touch_recommendation` | Что делать следующим касанием | «Как двигать сделку дальше?» |
| `q25_win_loss_reason` | Вероятная причина выигрыша/проигрыша | «Почему выиграем / проиграем?» |
| `q26_script_improvement` | Что улучшить в скрипте на основе этого кейса | «Идеи для регламента?» |
| `q27_grammar_quality` | Грамматика/пунктуация в переписке | «Грамотно ли пишет менеджер?» |

### Правило `unknown` — критично

AI обучен возвращать `"unknown"` или пустую строку **вместо галлюцинации**, когда
данных для вопроса не хватает (например, звонков не было — `q15_interruptions_templates`
про перебивания в звонке будет пустой; чат из одного сообщения — большинство полей
уйдёт в unknown).

**Codex должен:**
1. При ответе на вопрос по конкретному критерию проверять значение поля.
2. Если `analysis_json->>'qN_...'` **IN ('unknown', '', NULL)** — отвечать буквально:
   «По этому критерию AI-аудит данных не нашёл» (или «недостаточно материала для
   оценки»), указать вероятную причину если очевидна (нет звонков → `context_transcripts_count = 0`;
   короткая переписка → `context_messages_count < 5`).
3. **НЕ подсовывать РОПу «взгляд из raw-данных» вместо AI-оценки.** Если AI не смог —
   так и говорим. Иначе теряется весь смысл специализированного разбора.
4. **НЕ агрегировать unknown-строки** в топ-N (например, «топ сделок с высоким риском»
   должен фильтровать `risk_level IN ('medium','high')`, а не пытаться парсить q3_loss_risk).

### `sales_ai_evidence` — цитаты-доказательства

Плоская таблица: одна строка = одна цитата из чата/звонка/AMO, привязанная к вопросу
из разбора. Используй, когда РОП спрашивает **«почему AI так решил?»** или **«покажи цитаты по возражениям»**:
- `analysis_id` → FK на `sales_ai_deal_analysis.id`
- `question_num` (1..27, может быть NULL для общей цитаты)
- `source_type` — `chat` | `call` | `amo`
- `quote` (≤500 симв) — сама цитата
- `why_relevant` — почему процитировано

### `sales_ai_analysis_jobs` — очередь заданий

Оперативная таблица, для РОПа обычно не нужна. Пригодится для мета-вопросов:
«Все ли сделки разобраны?», «Что упало на разборе?». Статусы: `pending / running /
done / failed / skipped`. `skip_reason`: `no_new_data` (дедуп, ничего не изменилось)
или `no_context` (сделка есть, но переписки/звонков не нашлось — например, только телефон).

### `sales_regulation` — версионированный регламент

Сам регламент отдела продаж. `is_active = true` — актуальная версия, по ней делается
разбор. Одна строка активна в каждый момент. Полезно, если РОП спросит «а по какой
версии регламента судили?».

### Готовые шаблоны для Sales AI

**Свежая карточка сделки (полный разбор):**
```sql
SELECT
  l.amo_id, l.name AS deal, l.responsible_name AS manager, l.amount,
  a.analyzed_at, a.manager_score, a.action_type, a.risk_level, a.confidence,
  a.context_messages_count AS chat_msgs, a.context_transcripts_count AS calls,
  a.analysis_json
FROM sales_ai_deal_analysis a
JOIN amo_leads l ON l.id = a.amo_lead_id
WHERE l.amo_id = <AMO_ID>
ORDER BY a.analyzed_at DESC
LIMIT 1;
```

**Топ-N сделок, требующих внимания сейчас:**
```sql
SELECT DISTINCT ON (a.amo_lead_id)
  l.amo_id, l.name AS deal, l.responsible_name AS manager,
  a.manager_score, a.risk_level, a.confidence,
  a.analysis_json->>'q3_loss_risk'                 AS loss_risk,
  a.analysis_json->>'q24_next_touch_recommendation' AS next_touch
FROM sales_ai_deal_analysis a
JOIN amo_leads l ON l.id = a.amo_lead_id
WHERE a.action_type = 'manager_action_needed'
  AND a.risk_level IN ('medium', 'high')
  AND l.status_id NOT IN (142, 143)
ORDER BY a.amo_lead_id, a.analyzed_at DESC
LIMIT 20;
```

**Худшие менеджеры (средняя оценка < 5 за 30 дней):**
```sql
WITH latest AS (
  SELECT DISTINCT ON (amo_lead_id) amo_lead_id, manager_score, analyzed_at
    FROM sales_ai_deal_analysis
   WHERE analyzed_at >= now() - interval '30 days'
   ORDER BY amo_lead_id, analyzed_at DESC
)
SELECT l.responsible_name AS manager,
       COUNT(*) AS deals_reviewed,
       ROUND(AVG(latest.manager_score)::numeric, 1) AS avg_score,
       COUNT(*) FILTER (WHERE latest.manager_score <= 4) AS weak_deals
FROM latest
JOIN amo_leads l ON l.id = latest.amo_lead_id
GROUP BY l.responsible_name
HAVING COUNT(*) >= 3
ORDER BY avg_score ASC;
```

**Частые причины риска потери (сгруппировать q3):**
```sql
SELECT
  substring(a.analysis_json->>'q3_loss_risk', 1, 80) AS risk_snippet,
  COUNT(*) AS occurrences
FROM sales_ai_deal_analysis a
WHERE a.risk_level IN ('medium', 'high')
  AND a.analysis_json->>'q3_loss_risk' NOT IN ('unknown', '')
  AND a.analyzed_at >= now() - interval '30 days'
GROUP BY risk_snippet
ORDER BY occurrences DESC
LIMIT 15;
```

**Открытые возражения по сделкам с рекомендованным касанием на неделе:**
```sql
SELECT DISTINCT ON (a.amo_lead_id)
  l.amo_id, l.name, l.responsible_name AS manager,
  a.analysis_json->>'q13_objections_open'          AS open_objections,
  a.analysis_json->>'q24_next_touch_recommendation' AS action
FROM sales_ai_deal_analysis a
JOIN amo_leads l ON l.id = a.amo_lead_id
WHERE a.action_type = 'manager_action_needed'
  AND a.analysis_json->>'q13_objections_open' NOT IN ('unknown', '')
  AND l.status_id NOT IN (142, 143)
ORDER BY a.amo_lead_id, a.analyzed_at DESC;
```

**Evidence-цитаты по конкретной сделке (для «почему AI так решил»):**
```sql
SELECT e.question_num, e.source_type, e.quote, e.why_relevant
FROM sales_ai_evidence e
JOIN sales_ai_deal_analysis a ON a.id = e.analysis_id
JOIN amo_leads l ON l.id = a.amo_lead_id
WHERE l.amo_id = <AMO_ID>
  AND a.analyzed_at = (SELECT MAX(analyzed_at)
                         FROM sales_ai_deal_analysis
                        WHERE amo_lead_id = a.amo_lead_id)
ORDER BY e.question_num NULLS LAST;
```

**Проверить, разобрана ли сделка вообще:**
```sql
SELECT j.amo_lead_id, l.amo_id, j.status, j.skip_reason,
       j.started_at, j.finished_at, j.error_message
FROM sales_ai_analysis_jobs j
JOIN amo_leads l ON l.id = j.amo_lead_id
WHERE l.amo_id = <AMO_ID>
ORDER BY j.created_at DESC
LIMIT 5;
```

## Внешние источники — ночной синк (с 06.07.2026)

Воркер `portal-external-sync` каждую ночь в **2:00 МСК (23:00 UTC)** тянет данные из внешних систем
в raw-таблицы. **Не FK-связаны с `projects` напрямую** — привязка через `attribution_*`.
Лог прогонов — `external_sync_runs` (мониторить: `WHERE started_at > now() - interval '2 days'`).

### `amo_leads` — сделки AMO CRM
Ключевые поля:
- `amo_id` (bigint, unique) — ID сделки в AMO
- `name`, `status_id`, `pipeline_id`, `amount` (numeric)
- `responsible_user_id` — ID менеджера в AMO (имя в `raw`)
- `ym_client_id` (text) — **главный ключ атрибуции** к визитам Метрики
- `contact_phone`, `contact_email`, `company_name` — пока NULL (требуют доп. запросов
  к AMO API), достаём из `raw->_embedded->contacts[0]->id`
- `created_at`, `updated_at`, `closed_at`, `synced_at`
- `raw jsonb` — полный ответ AMO (custom_fields, embedded contacts/companies)

**Ловушки:**
- Статусы 142 = won, 143 = lost. Остальные — рабочие/промежуточные.
- Название pipeline / status — только в raw. Для человекочитаемых нужен доп. lookup.
- Только AMO CRM, не путать с `sales_copilot_*` (портальные AI-драфты).

### `amo_events` — история изменений сделки
- Планировалось: переходы статусов, задачи, заметки.
- **Пока не льётся** (требует отдельного эндпоинта на каждую сделку — дорого).
- Если пусто — не паникуй, это ожидаемо. Живая история — в raw.updated_at по amo_leads.

### `metrika_visits_daily` — агрегат Метрики по дням
- Первичный ключ `(date, traffic_source)` — уникально по паре.
- Поля: `visits`, `users`, `bounce_rate`
- Обновляется скользящим окном 30 дней (env `YANDEX_METRIKA_LOOKBACK_DAYS`).
- Счётчик: 62363425 (polzaagency.ru).
- **Что здесь есть:** тренды по каналам, дням, bounce rate.

**ВСЕГДА используй эту таблицу для типичных вопросов про трафик:**
- «Откуда приходят люди на сайт» / «источники трафика» / «каналы» → `metrika_visits_daily`
- «Сколько посетителей за неделю/месяц» → `metrika_visits_daily`
- «Тренд трафика по дням» → `metrika_visits_daily`
- «Мусорные каналы (высокий bounce)» → `metrika_visits_daily`
- «Доля прямого трафика» → `metrika_visits_daily`

НЕ ходи в `metrika_visits` для этих вопросов — та пустая, ответишь «данных нет»,
хотя фактически данные есть в `_daily`.

### `metrika_visits` — визиты с `ym_client_id` (ПОКА ПУСТО)
- Планировалось: per-visit детализация с UTM, landing, referrer, ym_client_id.
- **Пока пусто** — требует Metrika Logs API (отдельный endpoint с очередью).
- **Единственный сценарий этой таблицы** — цепочка `Метрика → AMO → project`
  через `ym_client_id`. То есть «этот конкретный визит превратился в сделку X».
- **Все остальные вопросы про трафик** — идут в `metrika_visits_daily`, не сюда.
- Если пользователь спросит про «визиты» / «трафик» / «источники» без явной привязки
  к конкретному пользователю/сделке — иди в `metrika_visits_daily`, там ответ есть.

### `bank_transactions` — транзакции Точки + Т-Банка в одной таблице
- Колонка `bank` — `'tochka'` или `'tbank'`.
- Первичный ключ `(bank, transaction_id)` — уникально.
- Только `direction='credit'` — входящие (расходы не синкаем).
- **`is_revenue` (bool)** — главный флаг для аналитики выручки:
  - `true` — платёж от клиента (считается в выручку)
  - `false` — исключено, причина в `exclude_reason`
- Причины исключения (`exclude_reason`):
  - `перевод себе (ИНН владельца)` — межбанк ИП
  - `банк-механика/возврат` — овердрафт, возвраты, комиссии
  - `плательщик — банк` — кэшбэк и служебные
- Поля: `occurred_at`, `amount`, `payer_name`, `payer_inn`, `purpose`, `raw jsonb`
- Backfill с 2023-01-01, дальше растёт.

**Правило анализа выручки:** всегда `WHERE is_revenue = true`. Иначе учтёшь возвраты
и переводы себе, цифра поплывёт.

### `attribution_*` — связки с проектами (confidence + method)
Три таблицы, все с одинаковой структурой: FK на две сущности + `confidence numeric(3,2)` + `method text`.
- **`attribution_amo_project`** (`amo_deal_id` ↔ `project_id`): method =
  `by_ym_client_id | by_email | by_phone | by_company_name | manual`
- **`attribution_payment_project`** (`bank_transaction_id` ↔ `project_id`): method =
  `by_inn | by_company_name | by_invoice_amount_date | manual`
- **`attribution_visit_lead`** (`ym_client_id` ↔ `amo_lead_id`): method =
  `direct` (пришёл через AMO custom-field) | `by_utm_time_heuristic`

**Правило:** для надёжных выводов фильтруй `WHERE confidence >= 0.7`. Ниже —
предположения, показывай пользователю с оговоркой «низкая уверенность».

**Attribution ещё не считается автоматически** — таблицы пусты. Планы: отдельный
воркер, который каждую ночь после синка сопоставит raw ↔ projects.

### `external_sync_runs` — лог ночных прогонок
- Одна строка на каждый источник за прогон.
- Поля: `source`, `status` (`running/success/partial/error`), `records_upserted`, `started_at`, `finished_at`, `error`, `meta jsonb`
- Проверить последний ночной: `SELECT * FROM external_sync_runs WHERE started_at > now() - interval '1 day' ORDER BY started_at DESC;`
- `partial` — это ok (источник не сконфигурен, например токен пустой). `error` — реальная проблема.

### Outreach-слой (только если спрашивают про TG/LinkedIn outreach — не про Instantly!)
- `tg_outreach_campaigns` (11), `tg_outreach_dialogs` (1144), `tg_outreach_logs` (242 900)
- `li_leads` (8277), `li_campaigns`, `li_accounts`

### Аутрич-пайплайн «2GIS + сигналы» (`gis_signal_*`, с 04.08.2026)
- Клиентский пайплайн: 2gis_dataset (5 сегментов по рубрикам) → 6 сигналов с сайта → конструктор баз (`base_constructor_jobs`, кап 5 почт/компания) → добор в 5 кампаний Instantly. Воркер `gisSignalOutreachCron`.
- `gis_signal_pipeline_config` — singleton id=1: `enabled`, `measure_only` (воронка без заливки/seen), `client_user_id` (владелец дашборда `/client/gis-signals`), `monthly_target_companies` (20000), `daily_limit`, `signal_min_count` (порог сигналов, дефолт 1), `selected_steps`/`step_config` конструктора.
- `gis_signal_segments` — 5 сегментов (edu/remont/legal/accounting/consulting): `rubric_groups jsonb` (маппинг на рубрики 2GIS), `instantly_campaign_id` (NULL = сегмент не заливается), `priority` (компания попадает в один сегмент).
- `gis_signal_seen_companies` — дедуп по `twogis_id` (PK), реконтакт запрещён навсегда; пишется только после успешного append в Instantly.
- `gis_signal_company_signals` — архив 6 bool-сигналов + `evidence jsonb` по КАЖДОЙ проверенной компании (вкл. отфильтрованные) — основа среза сегмент×сигнал. Ключ `twogis_id` (unique).
- `gis_signal_runs` — журнал прогонов: `status` (`running/completed/failed`), `funnel jsonb` = `{perSegment: {key: {pulled, signalsOk, bcIn, validContacts, appended}}, total}`.

### AI/Copilot слой
- `sales_copilot_configs/drafts/jobs/logs`, `ai_call_analyses`, `ai_caller_jobs`,
  `ai_campaigns`, `brief_scoring_jobs`, `kb_documents`, `kb_chunks`
- Часть таблиц может быть пустой — это архитектурный слой на вырост.

## Enum-словарь (все статусы разом)
- **Проекты:** `В работе`, `Тестирование`, `На паузе`, `Подготовка`, `Завершен`, `Отменен`
- **Задачи:** `done`, `pending`, `in_progress`, `backlog`
- **Инвойсы:** `paid`, `pending`, `cancelled`
- **Payment requests:** `pending`, `approved`, `paid`, `rejected`
- **Роли profiles:** `client`, `manager`, `technician`, `admin`, `lead`, `marketer`, `sales`
- **AMO статусы (ключевые):** 142 = won, 143 = lost; остальные — рабочие.
- **Банк:** `tochka`, `tbank`
- **Bank direction:** `credit` (только входящие сейчас синкаются)
- **Sync run status:** `running`, `success`, `partial`, `error`
- **Sync source:** `metrika`, `amo_leads`, `amo_events`, `bank_tochka`, `bank_tbank`, `attribution`
- **Attribution method:** `by_ym_client_id`, `by_email`, `by_phone`, `by_inn`, `by_company_name`, `by_invoice_amount_date`, `direct`, `by_utm_time_heuristic`, `manual`
- **Sales AI action:** `manager_action_needed`, `no_action_needed`
- **Sales AI risk / confidence:** `low`, `medium`, `high`
- **Sales AI job status:** `pending`, `running`, `done`, `failed`, `skipped`
- **Sales AI skip reason:** `no_new_data` (дедуп), `no_context` (нет переписки/звонков)
- **gis_signal run status:** `running`, `completed`, `failed`

## Готовые шаблоны запросов

### Активные проекты с приближающимся продлением
```sql
SELECT client, name, manager, status, payment_date,
       NULLIF(regexp_replace(budget,'\D','','g'),'')::numeric AS budget_num
FROM projects
WHERE status IN ('В работе','Тестирование')
  AND payment_date IS NOT NULL
  AND payment_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
ORDER BY payment_date;
```

### Просроченные задачи в активных проектах
```sql
SELECT p.client, t.title, t.specialist, t.deadline, t.status
FROM tasks t
JOIN projects p ON p.id = t.project_id
WHERE t.status IN ('pending','in_progress')
  AND t.deadline::date < CURRENT_DATE
  AND p.status IN ('В работе','Тестирование')
ORDER BY t.deadline;
```

### Оплаченные инвойсы по неделям
```sql
SELECT DATE_TRUNC('week', paid_at) AS week, COUNT(*), SUM(amount) AS total
FROM invoices
WHERE status = 'paid' AND paid_at >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY 1 ORDER BY 1;
```

### Загрузка специалиста
```sql
SELECT specialist,
       COUNT(*) FILTER (WHERE status='in_progress')                              AS active_tasks,
       COUNT(*) FILTER (WHERE status IN ('pending','in_progress')
                          AND deadline::date < CURRENT_DATE)                     AS overdue
FROM tasks
GROUP BY specialist
ORDER BY active_tasks DESC NULLS LAST;
```

### Топ активных проектов по марже
```sql
SELECT client, name, budget, margin,
       NULLIF(regexp_replace(margin,'\D','','g'),'')::numeric AS margin_num
FROM projects
WHERE status IN ('В работе','Тестирование')
ORDER BY margin_num DESC NULLS LAST
LIMIT 20;
```

### Самые «молчаливые» проекты (нет сообщений > N дней)
Требует связки sales_chat_messages ↔ project через контакт. Ловушка: если менеджер
не подшил чат к клиенту, не найдётся. Осторожно с интерпретацией «нет сообщений».

### Топ источников трафика по визитам за месяц (Метрика)
```sql
SELECT traffic_source,
       SUM(visits) AS visits_30d,
       SUM(users)  AS users_30d,
       ROUND(AVG(bounce_rate)::numeric, 1) AS avg_bounce
FROM metrika_visits_daily
WHERE date >= CURRENT_DATE - 30
GROUP BY traffic_source
ORDER BY visits_30d DESC;
```

### Выручка по месяцам (банки, только клиентские платежи)
```sql
SELECT DATE_TRUNC('month', occurred_at) AS month,
       bank,
       COUNT(*)   AS payments,
       SUM(amount) AS revenue
FROM bank_transactions
WHERE is_revenue = true                    -- ← ключевой фильтр
  AND occurred_at >= '2026-01-01'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

### Топ плательщиков (клиентов) по объёму
```sql
SELECT payer_name, payer_inn,
       COUNT(*)   AS payments,
       SUM(amount) AS total_amount
FROM bank_transactions
WHERE is_revenue = true
  AND occurred_at >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY payer_name, payer_inn
ORDER BY total_amount DESC
LIMIT 20;
```

### AMO сделки в won за последний месяц
```sql
SELECT amo_id, name, amount, ym_client_id, closed_at,
       raw->'_embedded'->'companies'->0->>'id' AS company_id
FROM amo_leads
WHERE status_id = 142
  AND closed_at >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY closed_at DESC;
```

### Проверить статус ночного синка
```sql
SELECT source, status, records_upserted, started_at, finished_at,
       LEFT(error, 200) AS error_preview
FROM external_sync_runs
WHERE started_at > now() - INTERVAL '2 days'
ORDER BY started_at DESC;
```

### Cross-source: сделки в AMO ↔ платёж на счёт (по ИНН)
Пока `attribution_payment_project` пуст, можно вручную:
```sql
SELECT a.name AS deal, a.amount AS amo_price, a.status_id,
       bt.occurred_at, bt.amount AS paid, bt.payer_name
FROM amo_leads a
JOIN bank_transactions bt
  ON bt.payer_inn = a.raw->'custom_fields_values'->>1314335  -- поле ИНН в AMO
 AND bt.is_revenue = true
WHERE a.closed_at >= CURRENT_DATE - INTERVAL '90 days'
ORDER BY bt.occurred_at DESC;
```
Ловушка: `custom_fields_values` в raw — массив, ключ ИНН зависит от порядка. Проверь
`raw->'custom_fields_values'` перед применением.

## Стиль ответа
- Отвечай на языке вопроса.
- **НЕ показывай SQL, `WHERE`-фильтры, названия таблиц/колонок в ответе** — это
  для менеджеров, они читают только цифры и выводы. SQL остаётся в твоих
  внутренних вызовах инструмента, наружу не выводи.
- Исключение: если пользователь **явно** попросил «покажи SQL / запрос / код» —
  тогда покажи.
- Формат ответа для менеджера — краткая суть + таблица/список с цифрами.
  Никаких `raw->>...`, `COALESCE`, `NULLIF`, `is_revenue = true` в тексте ответа.
  Всё это работает под капотом, пользователь видит только результат.
- Малые выборки (< 20 наблюдений) помечай как ненадёжные (человеческим языком:
  «выборка маленькая, вывод предварительный»).
- Если Sales AI-разбор вернул `"unknown"` / пусто по конкретному критерию — говори прямо
  «AI-аудит по этому критерию данных не нашёл» и по возможности объясни причину
  человеческим языком (нет звонков, слишком короткая переписка, сделка только создана
  и никто ещё не написал). **Не подменяй AI-оценку своим взглядом из raw-данных.**
- Пустой результат — так и скажи, не выдумывай. Тоже без технических деталей —
  просто «за этот период данных нет» или «таких клиентов не нашёл».
- Если вопрос требует данных, которых нет в этой БД (аналитика Instantly outreach —
  кампании, письма, ниши, open/reply rate) — перенаправь пользователя на MCP
  `instantly-dataset`.

## Практика
- **Данные обновляются в реальном времени** — это боевая БД портала, не снапшот.
- **Внешние источники (AMO, Метрика, банки)** льются раз в сутки в 2:00 МСК (23:00 UTC). Если
  видишь странность — проверь `external_sync_runs` за последние сутки: возможно синк
  упал ночью и данные не свежие. `partial`-статус означает что источник не сконфигурен
  (например, токен пуст) — это не ошибка.
- **Sales AI-разбор** обновляется раз в сутки в 03:30 UTC (06:30 МСК), плюс подтягивает
  «молчащие» в AMO сделки, у которых появился новый транскрипт звонка (view
  `v_sales_ai_stale_transcripts`). Если по сделке нужен свежий разбор — проверь
  `sales_ai_analysis_jobs.status` = `done` и `sales_ai_deal_analysis.analyzed_at`.
- Тяжёлые джойны с `sales_chat_messages` без фильтра по дате будут таймаутить (30s лимит) —
  всегда `WHERE created_at > CURRENT_DATE - INTERVAL '30 days'` или подобное.
- `bank_transactions` может быть тысячи-десятки тысяч строк — тоже фильтруй по дате
  и обязательно по `is_revenue = true` при вопросах про выручку.
- `amo_leads.raw` — большой JSON, при выборке многих строк отдельно `SELECT raw` = много
  трафика. Выбирай конкретные пути `raw->'field'` вместо целого.
- `payment_requests` обычно небольшая, но выбирай только явный безопасный набор нужных колонок: `SELECT *` запрещён, а ссылки на документы закрыты.
- `project_periods` небольшая — её можно выбирать целиком.
- Nolock, MVCC — параллельные апдейты от прода не блокируют чтение, но могут возвращать
  разные снапшоты между запросами.
