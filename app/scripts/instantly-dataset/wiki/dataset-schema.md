# Dataset Schema

База `instantly_dataset` на production-сервере `139.60.162.12:35432`, юзер `instantly`. ~12 GB на 18.07.2026, 23 таблицы + 6 views.

Связь устройства: `raw_*` хранит сырые данные из Instantly API, `lookup_*` расшифровывает magic-numbers, `*_snap` хранит снапшоты аналитики во времени, `v_*` — pre-joined проекции для типовых запросов.

---

## Таблицы (raw_)

| Table | Что хранит | Ключи и связи |
|---|---|---|
| **`raw_campaigns`** | Outbound-кампании | PK: `id`. `status` → `lookup_campaign_status`. `email_list[]` → `raw_accounts.email`. Sequences развёрнуты в `raw_campaign_steps`. |
| **`raw_campaign_steps`** | Развёрнутые шаги последовательности (subject + body на каждый вариант) | PK: `(campaign_id, sequence_n, step_n, variant_n)`. FK → `raw_campaigns.id`. JOIN с `raw_campaign_step_analytics_snap` по `(campaign_id, step_n, variant_n)` даёт subject × open/reply. |
| **`raw_accounts`** | Mailbox-аккаунты отправителей | PK: `email`. `status` → `lookup_account_status`. `warmup_status` → `lookup_warmup_status`. `provider_code` → `lookup_provider_code`. |
| **`raw_leads`** | Карточки лидов (получателей). **С 2026-08-18 — ночной захват** (`sync.mjs`, фаза 5): все кампании с `leads_count>0`, UPSERT по `id`, **без удалений** — карточка в Instantly живёт 4–8 недель (команда чистит кампании ради тарифа), здесь остаётся последний снимок. Строки до этого — разовый слепок мая 2026 (194 кампании; поля захвата NULL) | PK: `id`. `status` → `lookup_lead_status` (1 active / 3 completed / **-1 bounced**). `interest_status` (= `lt_interest_status`) → `lookup_interest_status`. `campaign_id` → `raw_campaigns.id`. **Поконтактный исход:** `email_open_count`, `email_reply_count`, `email_click_count`, `email_opened_step`, `email_replied_step`, `timestamp_last_*`. `company_domain` (~100%) — ключ обогащения. `upload_payload` JSONB — исходная строка CSV **как залили** (все колонки; типовые `companyName/email/website/personalization`, бывают `jobTitle/linkedIn/City`). `upload_method` (`manual`), `uploaded_by_user`. `pulled_at` = когда видели в последний раз, `first_pulled_at` = первый захват. ⚠ `lead_list_id` у кампанийных лидов **пуст** (замер 17.08: 0%) — признаки брать из имени кампании (`v_campaign_client`/`v_campaign_segment`). Служебное: `lead_capture_state` (отпечаток счётчиков, `cleaned_at` = когда кампанию вычистили). |
| **`raw_emails`** | **Каждое письмо** (отправленное, ответ от лида, наш ответ) | PK: `id`. `ue_type` → `lookup_ue_types`. `i_status` → `lookup_interest_status`. Группируй по `thread_id` чтобы реконструировать диалог. `body_text` — HTML stripped (оригинал в `raw_payload.body`). |
| **`raw_lead_lists`** | Именованные списки лидов | PK: `id`. ⚠ Связь `raw_leads.lead_list_id` у кампанийных лидов пуста (0% на 17.08.2026) — списки полезны именами (клиент/источник/ниша/фильтр), не связью. |
| **`raw_email_templates`** | Сохранённые шаблоны | PK: `id`. `body` — plain text. |
| **`raw_custom_tags`** + **`raw_custom_tag_mappings`** | Теги и их применение к ресурсам | Mapping: `(tag_id, resource_id, resource_type)`. Фильтруй по `resource_type IN ('campaign', 'account', 'lead')`. |
| **`raw_lead_labels`** | Цветные label-ы для лидов | Мало используется, 8 записей. |
| **`raw_block_list`** | Блок-лист (домены/email-ы которым не пишем) | `type` = `'email'` \| `'domain'`. |
| **`raw_subsequences`** | Follow-up последовательности привязанные к родительской кампании | FK на `parent_campaign`. Запускаются после основной. |

## Snapshot-таблицы (*_snap)

Каждый запуск pull/sync создаёт строку в `dataset_snapshots` (`mode = 'full' | 'delta' | 'analytics-only'`). Снапшот-таблицы FK на неё через `snapshot_id`. Можно делать time-travel.

| Snapshot table | Гранулярность | Ключевое использование |
|---|---|---|
| `raw_campaign_analytics_overview_snap` | per (snapshot, campaign) | Текущие aggregate-цифры кампании на момент snapshot |
| `raw_campaign_analytics_daily_snap` | per (snapshot, ~~campaign~~, date) — `campaign` фиктивен | ❌ **СЛОМАНА для per-campaign.** Хранит workspace-wide дневной ряд, продублированный под каждым `campaign_id`. **Не суммируй `sent`/любые метрики per-campaign.** См. ⚠️ ниже. |
| `raw_campaign_step_analytics_snap` | per (snapshot, campaign, step_n, variant_n) | **Главное** для subject performance |
| `raw_warmup_analytics_snap` | per (snapshot, email, date) | Здоровье mailbox-а по дням |

### ⚠️ `raw_campaign_analytics_daily_snap` сломана: workspace-wide ряд под каждым `campaign_id` (2026-05-30)

**Не используй `sent` / `opened` / `replies` / любую дневную метрику этой таблицы для per-campaign анализа.** Это НЕ данные кампании — это дневной ряд по **всему workspace**, записанный одинаково под каждым `campaign_id`. `campaign_id` в этой таблице несёт ноль информации.

**Доказательство** (snapshot `98974f54-…`, full pull 2026-05-21):
- **1881 кампания → у ВСЕХ `sum(sent)` ровно `7 381 152`** (один distinct-значение на всю таблицу), один и тот же 965-дневный ряд `2023-09-30 … 2026-05-21`, пиковый день = 36030.
- Кампании с lifetime `contacted_count` = 1, 2, 4, 5, 500 — у всех **byte-identical** дневной ряд (27026 sent на 2026-05-21). Кампания, написавшая 1 письмо за всю жизнь, не может иметь историю на 7.38M отправок.
- `raw_payload` дневной строки содержит те же инфлированные числа (`"sent": 27026`, `"contacted": 26369`) → это **не** ошибка нашего парсинга, Instantly API реально вернул workspace-данные.

**Чему верить вместо этого:**
- **`raw_campaign_analytics_overview_snap`** — per-campaign **корректна** (overview endpoint реально принимает `id`; цифры различаются по кампаниям: 1, 2, …, 500). Используй её для lifetime-aggregate.
- **Дневная динамика кампании** → используй готовый **`v_campaign_daily`** (migration 009, собран из `raw_emails`: `sent`/`lead_replies`/`our_replies`/`threads_with_reply` per campaign×date). Корректный, полный, без API. (Opens/clicks/bounces по дням в `raw_emails` нет — для них только починенный daily_snap для активных кампаний, либо overview lifetime.)

> **Статус (migration 009, 2026-05-30):** код в 3 местах **исправлен** (`campaign_id`, проверено живым вызовом), sync передеплоен. Поломанные строки `raw_campaign_analytics_daily_snap` **удалены** (было 1.94M); починенный nightly sync пишет туда корректные строки, но только для активных кампаний (разреженно). Для полного дневного ряда — `v_campaign_daily`.

**Корень бага (ingestion).** Endpoint `GET /campaigns/analytics/daily` фильтруется параметром **`campaign_id`**, и «если он пуст — возвращаются все кампании» ([Instantly API v2 docs](https://developer.instantly.ai/api/v2/campaign/getcampaignanalytics)). Наш код шлёт UUID под ключом `id`, который endpoint игнорирует → workspace-wide ответ, продублированный под каждой кампанией:
- [`app/src/lib/instantly/client.ts:175`](../../app/src/lib/instantly/client.ts) — `getCampaignAnalyticsDaily` мапит `campaign_id` → `query.id` (copy-paste из `getCampaignAnalyticsOverview` строкой выше, где `id` корректен для overview).
- [`app/scripts/instantly-dataset/sync.mjs:436`](../../app/scripts/instantly-dataset/sync.mjs) — `syncDailyAnalytics` шлёт `params: { id }`.
- [`app/scripts/instantly-dataset/pull.mjs:409`](../../app/scripts/instantly-dataset/pull.mjs) — `phaseDailyAnalytics` шлёт `params: { id }`.

Фикс: слать `{ campaign_id: id, start_date, end_date }` (`start_date`/`end_date` обязательны по докам). Для сравнения `syncStepAnalytics` уже шлёт `campaign_id` правильно. Баг **продолжается каждую ночь** (`sync.mjs` nightly cron): каждый новый snapshot тоже workspace-wide. Все исторические snapshot'ы уже отравлены — фикс кода починит только **будущие** pull'ы; для корректной истории нужен разовый ре-pull дневной аналитики с `campaign_id` (API отдаёт историю по диапазону дат). До этого вся таблица — мусор для per-campaign. См. [log.md](../log.md) `2026-05-30`.

## Lookup-таблицы

Маленькие таблички расшифровки, **всегда JOIN'ь их** вместо угадывания:

| Lookup | Decodes | Sample values |
|---|---|---|
| `lookup_ue_types` | `raw_emails.ue_type` | 1=sent, 2=lead_reply, 3=our_reply, 4=unknown (rare) |
| `lookup_interest_status` | `raw_leads.interest_status`, `raw_emails.i_status` | 0=unprocessed, 1=interested, -1..-3=negatives |
| `lookup_campaign_status` | `raw_campaigns.status` | 0=draft, 1=active, 2=paused, 3=completed, -1/-2/-99 negatives |
| `lookup_account_status` | `raw_accounts.status` | 1=active, 2=paused, 3=maintenance, -1..-3=errors |
| `lookup_warmup_status` | `raw_accounts.warmup_status` | 0=paused, 1=active, -1=banned, -2=spam, -3=permanent_suspend |
| `lookup_provider_code` | `raw_accounts.provider_code` | 1=IMAP, 2=Google, 3=Microsoft, 4=AWS, 8=AirMail |

У каждого: `value`, `label` (английский snake_case), `label_ru` (русский для UI), `description`.

## Views (`v_*`)

Pre-built проекции. Не материализованы — пересчитываются при каждом SELECT, но используют индексы.

| View | Что отдаёт |
|---|---|
| **`v_subject_performance`** | (campaign × step × variant × subject) + sent/opened/replied/clicked + расчётные rate'ы. **Главный rabit-hole для анализа** что зашло. |
| **`v_campaign_summary`** | Обзор кампаний с метриками |
| **`v_account_daily_volume`** | Нагрузка по mailbox-ам по дням |
| **`v_thread_outcomes`** | По `thread_id` агрегированный исход цепочки |
| **`v_lead_journey`** | Все письма по `lead_id` в хронологии |
| **`v_latest_snapshot`** | Просто `MAX(started_at)` из `dataset_snapshots WHERE ok` |

---

## Discovery через `pg_description` / `information_schema`

Все важные таблицы и поля имеют `COMMENT ON`. AI может узнать схему динамически:

```sql
-- описания всех таблиц
SELECT relname AS table, obj_description(oid) AS description
FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r';

-- описание всех колонок конкретной таблицы
SELECT column_name, col_description(c.oid, a.attnum) AS description
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid
JOIN information_schema.columns ic ON ic.column_name = a.attname AND ic.table_name = c.relname
WHERE c.relname = 'raw_emails' AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;
```

74 описания всего: 23 на таблицы, 51 на колонки.

---

## ⚠️ Датасет НЕДОПУЛЕН на 60% — старые письма ДОСТУПНЫ, надо дотянуть (2026-05-31)

**Текущий датасет содержит только ~40% писем; ~2.6M писем (60%) НЕ выкачаны, но живы в Instantly.**

| | |
|---|---|
| Lifetime отправок (по `overview`, надёжно) | **4 420 784** |
| `raw_emails` ue_type=1 сейчас | 1 789 648 (40%) |
| **Недотянуто** | **2 631 136 (60%)**, 1206 из 1925 кампаний >50% |

`raw_emails` начинается с 11 дек 2025 (отправки). Из 4.42M lifetime-отправок (overview) в датасете 1.79M (40%); 2.63M «недотянуто». **НО измерено (40 случайных недотянутых кампаний, живой API): восстановимо лишь ~1–5% от slate каждой** — Instantly стёр основную массу. По месяцам: фев–июл 2025 → ~0%; авг–ноя 2025 → 1–3%; дек 2025 → ~5%. Т.е. из 2.63M реально вернётся **~50–130K** (свежие хвосты), не 2.6M.

**Вывод: гранулярную историю назад заметно НЕ расширить** — данных нет у источника (стёрты). ~6 месяцев (дек'25–май'26) — реальный и почти полный гранулярный горизонт. Backfill недотянутых кампаний даст ~2–4% прибавки — не стоит многодневного пула.

**Для старых кампаний (с нач. 2025)** — только `overview` lifetime-агрегаты (sent/open/reply totals), per-email детали утеряны.

### Официальные сроки хранения Instantly (от поддержки, 2026-06)

| Объект | Хранится в Instantly |
|---|---|
| Отправленные письма + тела | «ограниченный период» (точного числа не дают; наш замер ≈ **6 мес**) |
| Ответ в папке **Others** | **30 дней**, затем удаляется |
| Ответ, **привязанный к лиду** (Primary folder) | **≥1 год** |
| Campaign-level статистика (`overview`) | остаётся (агрегаты) |

Это объясняет асимметрию датасета: ответы у нас с авг-2025 (привязанные к лидам живут год), отправки только с дек-2025 (~полгода). **Старше — стёрто у источника, не вернуть** (подтверждено вендором). Экспорт только через API: `/api/v2/emails` (ID) → `/api/v2/emails/{id}` (тело).

**Защита от потерь:** (1) ночной `sync.mjs` выкачивает всё до истечения срока; (2) привязка ответа к лиду в Instantly продлевает его хранение там до года.

> ⚠️ История метаний (урок: МЕРЬ до того как утверждать): сначала «стёрто, нельзя» (тест на «пробной» кампании → ложно), потом «можно 2.6M/15мес» (принял 2.8%-хвост ProdavAI за полную доступность → ложно), измерение показало правду — ~1–5% восстановимо, т.е. практически нельзя.

## Две оси сегментации: КЛИЕНТ (чисто) и target-вертикаль (migrations 010-011)

**Ключевой факт:** название кампании ≈ `<НАШ КЛИЕНТ-отправитель> + <источник базы> + <target-хинты/ОКВЭД>`. Клиент почти всегда первым.

### Ось 1 — клиент (авторитетно): `v_campaign_client`
Кто из клиентов студии вёл кампанию. Источник: `projects.client` через `project_instantly_campaigns` (чисто, 940 кампаний) + name-match по 107 известным клиентам (66). Покрытие ~52%.
```sql
SELECT campaign_name, client FROM v_campaign_client WHERE client ILIKE '%inmyroom%';
```

### Ось 2 — target-вертикаль получателей: `v_campaign_segment`
Индустрия ПОЛУЧАТЕЛЕЙ. У лидов ОКВЭД нет (0.025%), брифы пусты → выводится из названия **после вычитания клиента** + декода ОКВЭД-кодов (workflow `classify-campaign-segments-v2`). 14 вертикалей. Где после вычитания клиента остаётся только источник/роль (HH/руспрофайл/ЛПРы) без индустрии → честно **`other_unclear`** (481 кампания, 25% — НЕ угадываем).
```sql
SELECT campaign_name FROM v_campaign_segment WHERE segment='logistics_transport' AND confidence='high';
```

> ⚠️ **Двойной урок (2026-05-31), оба найдены вызовом пользователя:**
> 1. **keyword-regex по названию = мусор.** `(логист|перевозк|склад…)` дал 138 «логистов»: только 46 истинных (67% ложных) + пропустил 29.
> 2. **LLM-классификация v1 тоже текла** — путала индустрию КЛИЕНТА с target (Smartway/Инфолоджистикс — наши клиенты, не получатели). v2 чинит это вычитанием известного клиента ПЕРЕД классификацией + декодом ОКВЭД. Smartway→manufacturing(ОКВЭД 28) или other_unclear(если только продукт), не logistics.
>
> **Правило:** target-вертикаль — best-effort (low/other_unclear где не выводимо), КЛИЕНТ — авторитетен. Для решений опирайся на клиента; вертикаль — для приблизительных срезов с фильтром `confidence='high'`.

## Что вне scope

- **Полный текст ВСЕХ писем за всё время** — иммутабельная история, не модифицируется sync'ом. Только append новых.
- **Реал-таймная статистика «прямо сейчас»** — для этого Instantly UI, не наш датасет. Наша свежесть = sync, т.е. <24 часа.
- **Атрибуция конверсий в выручке** — это CRM, не Instantly. Связь между нашим `lead_email` и сделкой нужно искать в [`portal` main DB](../../README.md).
