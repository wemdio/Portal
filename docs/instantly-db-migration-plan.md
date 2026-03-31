# План миграции Instantly-данных в отдельный Supabase-инстанс

> Документ составлен: 2026-03-31  
> Цель: вынести все таблицы, связанные с Instantly, в отдельный проект Supabase.  
> Принцип: схемы идентичны, данные те же, только меняются credentials подключения.

---

## 1. Общая картина

Портал взаимодействует с Instantly по двум каналам:

| Канал | Описание |
|---|---|
| **REST API** (`api.instantly.ai/api/v2`) | Операции с кампаниями, лидами, аккаунтами, аналитикой и т.д. |
| **Supabase (текущая основная БД)** | Кэш каталога кампаний, webhook-события, AI-квалификация лидов, права доступа клиентов |

Задача: сохранить оба канала, но Supabase-часть перевести на отдельный инстанс (`INSTANTLY_SUPABASE_*`), не меняя логику приложения — только точку подключения.

---

## 2. Таблицы, которые нужно мигрировать

### 2.1 Группа A — «чистые» Instantly-таблицы (нет FK на пользовательские данные)

Эти таблицы мигрируются без каких-либо изменений схемы.

| Таблица | Миграции | Назначение |
|---|---|---|
| `instantly_campaign_catalog` | `20260328_0001_...` + `20260331_0002_...` | Кэш кампаний + аналитика |
| `instantly_webhook_events` | `20260330_0001_...` | Сырые webhook-события от Instantly |
| `instantly_lead_qualifications` | `20260330_0001_...` | AI-результаты квалификации лидов |

**Зависимость**: `instantly_lead_qualifications.webhook_event_id` → `instantly_webhook_events.id`  
Обе таблицы переезжают вместе — FK сохраняется.

### 2.2 Группа B — таблицы с FK на основную БД (profiles, projects, auth.users)

| Таблица | FK-зависимость | Миграции |
|---|---|---|
| `user_instantly_campaign_preferences` | `profiles(id)` | `20260330_0001_...` |
| `client_instantly_access` | `profiles(id)` × 2 | `20260323_0002_...` + `20260330_0002_...` |
| `client_campaign_leads` | `profiles(id)` | `20260330_0002_...` |
| `instantly_lead_imports` | `projects(id)`, `auth.users(id)` | `20260302_0004_...` |

**Ключевое замечание**: все операции с этими таблицами в коде используют `supabaseAdmin` (service role), а не пользовательский JWT. RLS-политики с `auth.uid()` технически есть, но через сервисный ключ они всегда обходятся. Поэтому в новой БД FK-ограничения **снимаются** (referential integrity обеспечивает приложение), RLS заменяется на политики «только service role».

> **Альтернатива**: оставить таблицы группы B в основной БД.  
> Плюсы: меньше изменений кода, сохраняется FK-целостность и auth-based RLS.  
> Минусы: split-brain — часть Instantly-данных в основной БД, часть в новой.  
> **Рекомендация**: мигрировать всё в одну новую БД (вариант ниже), FK группы B заменить на plain UUID без constraint.

---

## 3. Схема новой БД

### 3.1 SQL для создания всех таблиц в новом инстансе

Запустить в SQL Editor нового Supabase-проекта в следующем порядке:

```sql
-- ═══════════════════════════════════════════════════════
-- 1. instantly_campaign_catalog
-- ═══════════════════════════════════════════════════════
create table if not exists public.instantly_campaign_catalog (
  id uuid primary key,
  name text not null default '',
  status integer,
  timestamp_created timestamptz,
  timestamp_updated timestamptz,
  synced_at timestamptz not null default now(),
  emails_sent_count    integer,
  open_count           integer,
  reply_count          integer,
  new_leads_contacted_count integer,
  bounced_count        integer,
  unsubscribed_count   integer,
  analytics_synced_at  timestamptz
);

create index if not exists idx_instantly_campaign_catalog_synced_at
  on public.instantly_campaign_catalog (synced_at desc);
create index if not exists idx_instantly_campaign_catalog_updated
  on public.instantly_campaign_catalog (timestamp_updated desc nulls last);

alter table public.instantly_campaign_catalog enable row level security;
create policy "Service role full access on instantly_campaign_catalog"
  on public.instantly_campaign_catalog for all using (true) with check (true);

comment on table public.instantly_campaign_catalog is
  'Instantly campaign id/name cache for portal tools; synced periodically from api.instantly.ai';
comment on column public.instantly_campaign_catalog.analytics_synced_at is
  'Timestamp of the last successful analytics sync from Instantly API';


-- ═══════════════════════════════════════════════════════
-- 2. instantly_webhook_events
-- ═══════════════════════════════════════════════════════
create table if not exists public.instantly_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  campaign_id text,
  lead_email text,
  thread_id text,
  email_id text,
  payload jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_instantly_webhook_events_processed
  on public.instantly_webhook_events (processed, created_at)
  where not processed;
create index if not exists idx_instantly_webhook_events_campaign
  on public.instantly_webhook_events (campaign_id);

alter table public.instantly_webhook_events enable row level security;
create policy "Service role full access on instantly_webhook_events"
  on public.instantly_webhook_events for all using (true) with check (true);


-- ═══════════════════════════════════════════════════════
-- 3. instantly_lead_qualifications
-- ═══════════════════════════════════════════════════════
create table if not exists public.instantly_lead_qualifications (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid references public.instantly_webhook_events(id) on delete set null,
  campaign_id text not null,
  campaign_name text,
  lead_email text not null,
  lead_name text,
  company_name text,
  thread_id text,
  reply_subject text,
  reply_preview text,
  reply_body text,
  last_outbound_preview text,
  last_outbound_ue_type integer,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'lead', 'not_lead', 'needs_review', 'error')),
  proposal_seen boolean,
  interest_signals text[],
  ai_reason text,
  ai_confidence real,
  error_message text,
  instantly_email_id text,
  instantly_lead_id text,
  reply_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_instantly_lead_qualifications_status
  on public.instantly_lead_qualifications (status);
create index if not exists idx_instantly_lead_qualifications_campaign
  on public.instantly_lead_qualifications (campaign_id, created_at desc);
create index if not exists idx_instantly_lead_qualifications_email
  on public.instantly_lead_qualifications (lead_email);
create unique index if not exists idx_instantly_lead_qualifications_event
  on public.instantly_lead_qualifications (webhook_event_id)
  where webhook_event_id is not null;

alter table public.instantly_lead_qualifications enable row level security;
-- Политика для чтения через API (сервисный ключ). Если нужен доступ через user JWT из нового
-- Supabase-инстанса — добавить отдельно через INSTANTLY_SUPABASE_ANON_KEY + profiles в этой БД.
create policy "Service role full access on instantly_lead_qualifications"
  on public.instantly_lead_qualifications for all using (true) with check (true);


-- ═══════════════════════════════════════════════════════
-- 4. user_instantly_campaign_preferences
--    FK на profiles СНЯТ — user_id хранится как plain UUID
-- ═══════════════════════════════════════════════════════
create table if not exists public.user_instantly_campaign_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,   -- was: references public.profiles(id) on delete cascade
  campaign_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, campaign_id)
);

create index if not exists idx_user_instantly_campaign_prefs_user
  on public.user_instantly_campaign_preferences (user_id);

alter table public.user_instantly_campaign_preferences enable row level security;
create policy "Service role full access on user_instantly_campaign_preferences"
  on public.user_instantly_campaign_preferences for all using (true) with check (true);


-- ═══════════════════════════════════════════════════════
-- 5. client_instantly_access
--    FK на profiles СНЯТ
-- ═══════════════════════════════════════════════════════
create table if not exists public.client_instantly_access (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,  -- was: references public.profiles(id) on delete cascade
  resource_type text not null check (resource_type in ('campaign', 'lead_list')),
  resource_id text not null,
  created_by uuid,               -- was: references public.profiles(id) on delete set null
  created_at timestamptz not null default now(),
  leads_synced_at timestamptz,
  unique (client_user_id, resource_type, resource_id)
);

create index if not exists idx_client_instantly_access_user
  on public.client_instantly_access(client_user_id);

alter table public.client_instantly_access enable row level security;
create policy "Service role full access on client_instantly_access"
  on public.client_instantly_access for all using (true) with check (true);


-- ═══════════════════════════════════════════════════════
-- 6. client_campaign_leads
--    FK на profiles СНЯТ
-- ═══════════════════════════════════════════════════════
create table if not exists public.client_campaign_leads (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null,  -- was: references public.profiles(id) on delete cascade
  campaign_id text not null,
  email text not null,
  first_name text,
  last_name text,
  company_name text,
  website text,
  linkedin_url text,
  synced_at timestamptz not null default now(),
  unique (client_user_id, campaign_id, email)
);

create index if not exists idx_client_campaign_leads_user_campaign
  on public.client_campaign_leads(client_user_id, campaign_id);

alter table public.client_campaign_leads enable row level security;
create policy "Service role full access on client_campaign_leads"
  on public.client_campaign_leads for all using (true) with check (true);


-- ═══════════════════════════════════════════════════════
-- 7. instantly_lead_imports
--    FK на projects и auth.users СНЯТ
-- ═══════════════════════════════════════════════════════
create table if not exists public.instantly_lead_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,         -- was: references projects(id)
  campaign_id text,
  campaign_name text,
  lead_list_id text,
  lead_list_name text,
  leads_count integer not null default 0,
  imported_by uuid,        -- was: references auth.users(id)
  tab_name text,
  created_at timestamptz not null default now()
);

alter table public.instantly_lead_imports enable row level security;
create policy "Service role full access on instantly_lead_imports"
  on public.instantly_lead_imports for all using (true) with check (true);
```

---

## 4. Миграция данных из текущей БД

### 4.1 Экспорт данных (pg_dump / CSV)

**Вариант 1 — через pg_dump (рекомендуется для prod)**

```bash
# Установить переменные для текущей (основной) БД
export OLD_DB="postgresql://postgres.gngsfwkvnrddfwhpqopr:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
# Установить переменные для новой Instantly-БД
export NEW_DB="postgresql://postgres.<new-project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"

# Дамп только Instantly-таблиц (без владельцев, без привилегий — структура уже создана)
pg_dump "$OLD_DB" \
  --data-only \
  --no-owner \
  --no-privileges \
  -t instantly_campaign_catalog \
  -t instantly_webhook_events \
  -t instantly_lead_qualifications \
  -t user_instantly_campaign_preferences \
  -t client_instantly_access \
  -t client_campaign_leads \
  -t instantly_lead_imports \
  > instantly_data_export.sql

# Восстановить в новой БД
psql "$NEW_DB" < instantly_data_export.sql
```

**Вариант 2 — через Supabase Dashboard (CSV)**

Для каждой таблицы:
1. Table Editor → Export → CSV
2. Новый проект → Table Editor → Import CSV

> Подходит для небольших объёмов данных (< 100k строк).

### 4.2 Проверка после миграции данных

```sql
-- Выполнить в новой БД
select 'instantly_campaign_catalog' as tbl, count(*) from instantly_campaign_catalog
union all
select 'instantly_webhook_events', count(*) from instantly_webhook_events
union all
select 'instantly_lead_qualifications', count(*) from instantly_lead_qualifications
union all
select 'user_instantly_campaign_preferences', count(*) from user_instantly_campaign_preferences
union all
select 'client_instantly_access', count(*) from client_instantly_access
union all
select 'client_campaign_leads', count(*) from client_campaign_leads
union all
select 'instantly_lead_imports', count(*) from instantly_lead_imports;
```

Сравнить с аналогичным запросом к старой БД — числа должны совпадать.

---

## 5. Изменения в коде

### 5.1 Новый Supabase-клиент для Instantly-данных

Создать файл `app/src/lib/supabaseInstantly.ts`:

```typescript
import 'server-only';
import { createClient } from '@supabase/supabase-js';

const url = process.env.INSTANTLY_SUPABASE_URL;
const key = process.env.INSTANTLY_SUPABASE_SERVICE_ROLE_KEY;

export const supabaseInstantly = url && key
  ? createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;
```

### 5.2 Карта: таблица → какой клиент использовать после миграции

| Таблица | Клиент сейчас | Клиент после миграции |
|---|---|---|
| `instantly_campaign_catalog` | `supabaseAdmin` | `supabaseInstantly` |
| `instantly_webhook_events` | `supabaseAdmin` | `supabaseInstantly` |
| `instantly_lead_qualifications` | `supabaseAdmin` | `supabaseInstantly` |
| `user_instantly_campaign_preferences` | `supabaseAdmin` | `supabaseInstantly` |
| `client_instantly_access` | `supabaseAdmin` | `supabaseInstantly` |
| `client_campaign_leads` | `supabaseAdmin` | `supabaseInstantly` |
| `instantly_lead_imports` | `supabaseAdmin` | `supabaseInstantly` |

### 5.3 Список файлов, требующих изменений

#### `app/src/lib/tools/instantlyCampaignCatalog.ts`
- Заменить `import { supabaseAdmin }` → `import { supabaseInstantly as supabaseAdmin }`  
  (или переименовать переменную по всему файлу)
- Затронутые функции: `readInstantlyCampaignCatalog`, `syncInstantlyCampaignCatalog`, `upsertInstantlyCatalogFromCampaign`, `syncInstantlyCampaignAnalytics`, `readCampaignAnalyticsFromDb`, `deleteInstantlyCatalogCampaignById`

#### `app/src/lib/instantly/leadQualificationWorker.ts`
- Заменить `import { supabaseAdmin }` → `import { supabaseInstantly as supabaseAdmin }`
- Затронутые функции: `getSubscribedCampaignIds`, `pollAndQualifyReplies`, `qualifyOneReply`

#### `app/src/app/api/instantly/events/route.ts`
- Замена клиента на `supabaseInstantly` для записи в `instantly_webhook_events`

#### `app/src/app/api/instantly/qualified-leads/route.ts`
- Замена клиента на `supabaseInstantly` для чтения из `instantly_lead_qualifications` + `user_instantly_campaign_preferences`

#### `app/src/app/api/instantly/imports/route.ts`
- Замена клиента на `supabaseInstantly` для `instantly_lead_imports`

#### `app/src/app/api/user/campaign-preferences/route.ts`
- Замена клиента на `supabaseInstantly` для `user_instantly_campaign_preferences`

#### `app/src/app/api/client/campaigns/route.ts`
- Замена клиента на `supabaseInstantly` в вызовах `readCampaignAnalyticsFromDb`

#### `app/src/app/api/client/campaigns/[id]/route.ts`
- Замена клиента на `supabaseInstantly` для операций с аналитикой

#### `app/src/app/api/client/bases/route.ts` + `sync/route.ts`
- Замена клиента на `supabaseInstantly` для `client_instantly_access` и `client_campaign_leads`

#### `app/src/app/api/admin/users/[id]/client-access/route.ts`
- Замена клиента на `supabaseInstantly` для CRUD по `client_instantly_access`

#### `app/src/components/DatabaseSpreadsheet.tsx`
- Работает через API-роуты, не напрямую с БД → изменений нет

#### `services/instantly-sync-bot/main.py`
- Добавить переменные окружения `INSTANTLY_SUPABASE_URL` и `INSTANTLY_SUPABASE_SERVICE_ROLE_KEY`
- Заменить `supabase.create_client(SUPABASE_URL, SUPABASE_KEY)` на новые credentials

### 5.4 Переменные окружения

#### `.env` и `.env.production` — добавить:

```env
# Новый Supabase-инстанс для Instantly-данных
INSTANTLY_SUPABASE_URL=https://<new-project-ref>.supabase.co
INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-new-project>
```

#### `docker-compose.yml` / `docker-compose.prod.yml` — пробросить в контейнеры:
- `portal` (Next.js app)
- `worker`
- `instantly-sync-bot`

```yaml
environment:
  - INSTANTLY_SUPABASE_URL=${INSTANTLY_SUPABASE_URL}
  - INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=${INSTANTLY_SUPABASE_SERVICE_ROLE_KEY}
```

---

## 6. Изменения в Telegram-боте синхронизации

Файл: `services/instantly-sync-bot/main.py`

```python
# Было:
supabase_client = supabase.create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)

# Стало:
supabase_client = supabase.create_client(
    os.environ["INSTANTLY_SUPABASE_URL"],
    os.environ["INSTANTLY_SUPABASE_SERVICE_ROLE_KEY"]
)
```

---

## 7. Изменения в воркере (`app/worker/index.ts`)

Воркер сам не обращается напрямую к Instantly-таблицам — он вызывает `pollAndQualifyReplies()` и `syncInstantlyCampaignAnalytics()`. После замены клиентов в шаге 5.3 воркер автоматически начнёт использовать новый инстанс через изменённые библиотечные функции.

Единственное, что нужно убедиться: переменные `INSTANTLY_SUPABASE_URL` и `INSTANTLY_SUPABASE_SERVICE_ROLE_KEY` пробрасываются в контейнер `worker`.

---

## 8. Что остаётся в основной БД (не мигрирует)

Все остальные таблицы портала остаются в основном инстансе `gngsfwkvnrddfwhpqopr`:

- `profiles`, `projects`, все user-related таблицы
- `parser_jobs`, `search_parser_jobs`, `website_enrichment_jobs` и другие воркер-таблицы
- Таблицы Telegram-парсинга, LinkedIn, CIS, KB, Sales Copilot и пр.

**После миграции Instantly-таблиц их копии в основной БД можно будет удалить** (только после проверки, что всё работает с новым инстансом).

---

## 9. Пошаговый план выполнения

### Фаза 0 — Подготовка (1 день)

- [ ] Создать новый проект в Supabase (название рекомендуется: `portal-instantly`)
- [ ] Записать `INSTANTLY_SUPABASE_URL` и `INSTANTLY_SUPABASE_SERVICE_ROLE_KEY`
- [ ] Запустить SQL из раздела 3.1 в SQL Editor нового проекта
- [ ] Проверить, что все 7 таблиц созданы

### Фаза 1 — Миграция данных (1 день)

- [ ] Сделать дамп данных (pg_dump или CSV) из основной БД
- [ ] Загрузить данные в новый инстанс
- [ ] Выполнить проверочный SQL (раздел 4.2) — числа сходятся
- [ ] Убедиться в отсутствии FK-ошибок (группа B без FK constraint должна загрузиться без проблем)

### Фаза 2 — Код (2–3 дня)

- [ ] Создать `app/src/lib/supabaseInstantly.ts`
- [ ] Обновить `instantlyCampaignCatalog.ts`
- [ ] Обновить `leadQualificationWorker.ts`
- [ ] Обновить API-роуты (раздел 5.3 — 8 файлов)
- [ ] Обновить `services/instantly-sync-bot/main.py`
- [ ] Добавить переменные окружения в `.env`, `docker-compose.yml`, `docker-compose.prod.yml`

### Фаза 3 — Тестирование (1–2 дня)

- [ ] Локальный запуск: убедиться, что `/api/instantly/*` маршруты работают
- [ ] Проверить `GET /api/instantly/campaigns` — каталог читается из новой БД
- [ ] Проверить `GET /api/client/campaigns` — аналитика читается из новой БД
- [ ] Проверить `GET /api/instantly/qualified-leads` — квалификации доступны
- [ ] Запустить воркер — убедиться, что `syncInstantlyCampaignAnalytics` пишет в новую БД
- [ ] Проверить Telegram-бот синхронизации

### Фаза 4 — Деплой (1 день)

- [ ] Добавить `INSTANTLY_SUPABASE_*` переменные в production environment (Fly.io / Railway / VPS)
- [ ] Задеплоить обновлённые контейнеры: `portal`, `worker`, `instantly-sync-bot`
- [ ] Мониторинг 24 часа: проверить логи на ошибки подключения
- [ ] После успешного мониторинга — удалить Instantly-таблицы из основной БД

### Фаза 5 — Очистка (по готовности)

```sql
-- Выполнить в ОСНОВНОЙ БД только после успешного деплоя и мониторинга
drop table if exists instantly_lead_imports;
drop table if exists client_campaign_leads;
drop table if exists client_instantly_access;
drop table if exists user_instantly_campaign_preferences;
drop table if exists instantly_lead_qualifications;
drop table if exists instantly_webhook_events;
drop table if exists instantly_campaign_catalog;
```

---

## 10. Риски и митигация

| Риск | Вероятность | Митигация |
|---|---|---|
| Несовпадение данных после pg_dump | Низкая | Запустить дамп в тихий час; сверить COUNT(*) |
| RLS-ошибки в новой БД | Средняя | Все политики заменены на «service role full access»; проверить при тестировании |
| Забыли обновить один из API-роутов | Средняя | Grep по `supabaseAdmin` после изменений — не должно быть упоминаний Instantly-таблиц |
| FK-ошибки для группы B при импорте данных | Низкая | FK убраны из схемы новой БД |
| Telegram-бот пишет в старую БД | Средняя | Тест через отдельный запуск бота с новыми env |
| Дублирование записей если два экземпляра пишут в разные БД | Высокая при неполном деплое | Деплоить все компоненты одновременно; откат — перепрописать переменные на старый инстанс |

---

## 11. Дополнительно: если нужен доступ по user JWT (не service role)

Таблицы группы B (с user_id) потенциально могут быть нужны для прямого клиентского доступа из браузера (anon/user key). В текущей реализации всё идёт через API-роуты с service role, поэтому это не требуется. Если в будущем потребуется:

1. Добавить в новый инстанс `INSTANTLY_SUPABASE_ANON_KEY` в env
2. Написать RLS-политики на основе переданного `user_id` UUID (без `auth.uid()` — так как auth схемы разные)
3. Либо настроить JWT-sharing между проектами через Supabase custom JWT secret

---

## 12. Итоговый список env-переменных Instantly

```env
# Instantly REST API
INSTANTLY_PORTAL_API_KEY=...
INSTANTLY_WEBHOOK_SECRET=...

# Новый Supabase-инстанс для Instantly-данных
INSTANTLY_SUPABASE_URL=https://<new-ref>.supabase.co
INSTANTLY_SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# Lead qualification AI
INSTANTLY_LEAD_QUAL_MODEL=policy/gemini-flash
OPENROUTER_INSTANTLY_LEAD_API_KEY=...

# Worker sync interval (ms), default 1h
WORKER_ANALYTICS_SYNC_INTERVAL_MS=3600000

# Telegram sync bot
POLZA_INSTANTLY_SYNC_BOT_API_KEY=...
INSTANTLY_SYNC_BOT_CHAT_ID=...
INSTANTLY_SYNC_INTERVAL_SEC=3600
INSTANTLY_SYNC_HTTP_TIMEOUT_SEC=60
INSTANTLY_SYNC_RETRY_ATTEMPTS=3
```
