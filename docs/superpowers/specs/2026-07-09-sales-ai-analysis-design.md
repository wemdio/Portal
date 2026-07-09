# Sales AI Analysis — Design Spec

**Date:** 2026-07-09
**Status:** Draft → user review
**Scope:** V1 (MVP) реализация AI-аудитора продаж для Polza Agency.

## 1. Цель

Ежедневно анализировать активные сделки в AMO по данным из AMO CRM + переписок менеджеров в Telegram, выдавать РОПу структурированные выводы: где сделка, что мешает закрытию, что менеджер сделал плохо/пропустил регламент, какое следующее касание нужно и что поправить в AMO/скрипте. Каждый вывод обязательно подкреплён цитатой из источника (антигаллюцинация).

Источник требований: [`sales_ai_analysis_tz_prompts.md`](../../../../AyuGram%20Desktop/sales_ai_analysis_tz_prompts.md) (внешнее ТЗ).

## 2. Что уже готово в проекте (переиспользуем)

| Возможность | Где | Готовность |
|---|---|---|
| AMO CRM ingestion | `services/portal-external-sync/sources/amo.py` → `public.amo_leads` | Прод, ночной APScheduler 5 AM MSK |
| Telegram-переписки | `sales_chat_messages` + `sales_chat_dialogs` + `sales_chat_accounts` | Прод, realtime + backfill |
| LLM (OpenRouter/Requesty) | Паттерн из `app/src/lib/salesCopilot/llm.ts` | Прод |
| Воркеры/очередь | `app/worker/_shared.ts` (`pollLoop`, `claimJob`) + шаблон `salesCopilot.ts` | Прод |
| Миграции Supabase | `supabase/migrations/` + `app/scripts/db/ensureDatabase.js` | Прод |
| Next.js структура тула | `app/src/app/tools/<slug>` + `api/tools/<slug>` (25+ примеров) | Прод |
| CI/CD | Semaphore + `docker-compose.prod.yml` + `scheduled-deploy.yml` | Прод |

**Единственный настоящий инфра-гэп** — общий LLM-хелпер с JSON-schema валидацией. Стрим одним небольшим модулем.

## 3. Ключевые решения (согласованы с юзером)

- **AMO ↔ Telegram-диалог:** авто-связка по нормализованному телефону + ручной override в UI (для сделок, где авто не нашёл).
- **Регламент продаж:** в БД (таблица `sales_regulation`), редактируется РОПом в UI, версионируется.
- **Триггер:** крон 1×/сутки в 3 AM MSK + кнопка «Проанализировать сейчас» в UI.
- **Пайплайн:** source-then-final (variant A из ТЗ) — сначала AMO и чат анализируются отдельно, потом финальный вывод с явным `mismatch`.
- **LLM:** `claude-haiku-4-5` через OpenRouter (тот же ключ/провайдер, что у sales_copilot).
- **Бюджет:** ~$0.7–1.8/день в норме за счёт трёх ограничителей: дедуп по `input_hash`, cap 40 сообщений на чат, дневной cap 50 сделок.

## 4. Данные (миграция)

Новая миграция: `supabase/migrations/20260710_0001_create_sales_ai_tables.sql`

### 4.1. `sales_ai_deal_chat_link`
Маппинг AMO-сделка ↔ Telegram-диалог.

```sql
create table public.sales_ai_deal_chat_link (
  amo_lead_id bigint primary key references public.amo_leads(id) on delete cascade,
  dialog_id uuid not null references public.sales_chat_dialogs(id) on delete cascade,
  match_method text not null check (match_method in ('auto_phone', 'manual')),
  confidence numeric(3,2),
  linked_at timestamptz not null default now(),
  linked_by uuid references public.profiles(id)
);
create index idx_sales_ai_deal_chat_link_dialog on public.sales_ai_deal_chat_link(dialog_id);
```

### 4.2. `sales_regulation`
Версионируемый текст регламента.

```sql
create table public.sales_regulation (
  id bigserial primary key,
  version integer not null,
  body text not null,
  is_active boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index idx_sales_regulation_active on public.sales_regulation(is_active) where is_active = true;
```

Изменение регламента = insert новой строки + trigger, снимающий `is_active` у старой.

### 4.3. `sales_ai_analysis_jobs`
Очередь по паттерну `sales_copilot_jobs`.

```sql
create table public.sales_ai_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  amo_lead_id bigint not null references public.amo_leads(id) on delete cascade,
  trigger text not null check (trigger in ('cron', 'manual')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  skip_reason text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index idx_sales_ai_jobs_status_pending on public.sales_ai_analysis_jobs(created_at) where status = 'pending';
```

### 4.4. `sales_ai_contact_analyses`
Результаты анализа (история сохраняется).

```sql
create table public.sales_ai_contact_analyses (
  id uuid primary key default gen_random_uuid(),
  amo_lead_id bigint not null references public.amo_leads(id) on delete cascade,
  regulation_version integer,
  analyzed_at timestamptz not null default now(),

  action_type text not null check (action_type in ('manager_action_needed', 'no_action_needed')),

  current_stage text,
  recommended_stage text,
  next_step_exists boolean,
  next_step text,

  risk_level text check (risk_level in ('low', 'medium', 'high')),
  risk_reason text,

  purchase_probability text check (purchase_probability in ('low', 'medium', 'high', 'unknown')),
  manager_score integer check (manager_score between 1 and 10),
  score_reason text,
  main_skill_to_improve text,

  summary text,
  next_touch_recommendation text,

  input_hash text not null,
  analysis_json jsonb not null,

  llm_model text,
  tokens_used integer,
  cost_usd numeric(10,4),

  confidence text check (confidence in ('low', 'medium', 'high'))
);
create index idx_sales_ai_analyses_lead_date on public.sales_ai_contact_analyses(amo_lead_id, analyzed_at desc);
create index idx_sales_ai_analyses_action on public.sales_ai_contact_analyses(action_type);
create index idx_sales_ai_analyses_risk on public.sales_ai_contact_analyses(risk_level, analyzed_at desc);
create index idx_sales_ai_analyses_hash on public.sales_ai_contact_analyses(amo_lead_id, input_hash);
```

### 4.5. `sales_ai_evidence`
Цитаты-доказательства, привязанные к конкретному анализу.

```sql
create table public.sales_ai_evidence (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.sales_ai_contact_analyses(id) on delete cascade,
  source_type text not null check (source_type in ('chat', 'call', 'amo')),
  source_id text,
  quote text not null,
  why_relevant text
);
create index idx_sales_ai_evidence_analysis on public.sales_ai_evidence(analysis_id);
```

### 4.6. RLS / grants
Все 5 таблиц:
```sql
alter table ... enable row level security;
create policy ..._select_auth for select using (auth.uid() is not null);
grant all on ... to service_role, postgres;
grant select on ... to authenticated;
grant usage, select on sequence ..._id_seq to service_role, postgres;
```

Дополнительная колонка на существующей таблице:
```sql
alter table public.sales_chat_dialogs add column if not exists peer_phone text;
create index if not exists idx_sales_chat_dialogs_peer_phone on public.sales_chat_dialogs(peer_phone) where peer_phone is not null;
```
`peer_phone` заполняет `linker.ts` через MTProto `users.getFullUser` при первом матчинге, кэшируется.

## 5. Модуль `app/src/lib/salesAiAnalysis/`

Все файлы под этой директорией:

| Файл | Назначение |
|---|---|
| `types.ts` | TS-типы: `SalesAiContext`, `SourceAnalysis`, `FinalAnalysis` |
| `schemas.ts` | Zod-схемы для JSON-mode LLM ответов (`SourceAnalysisSchema`, `FinalAnalysisSchema`) |
| `prompts.ts` | Три текстовых промта из ТЗ: `SYSTEM_PROMPT`, `SOURCE_PROMPT`, `FINAL_PROMPT` |
| `llm.ts` | `callLLMWithSchema<T>()` — OpenRouter + JSON-mode + Zod-валидация + retry×1 + cost tracking |
| `dealFilter.ts` | SQL-запрос «какие сделки берём» + `attentionScore()` для приоритезации |
| `linker.ts` | Авто-матчинг `amo_leads.contact_phone` ↔ `sales_chat_dialogs.peer_phone` (+MTProto fetch) |
| `contextBuilder.ts` | Собирает контекст-пакет: AMO + последние 40 сообщений + активный регламент |
| `hasher.ts` | `computeInputHash(deal, messages, regulation)` → sha256, для дедупа |
| `pipeline.ts` | Оркестрация: link → context → hash → analyzeAmo || analyzeChat → final → save |

**Ключевая обёртка `callLLMWithSchema`:**
```typescript
export async function callLLMWithSchema<T>(
  messages: LLMMessage[],
  schema: z.ZodSchema<T>,
  opts: { model: string; maxTokens?: number; retries?: number }
): Promise<{ data: T; tokensUsed: number; costUsd: number }>
```
Внутри: POST в `router.requesty.ai` с `response_format: { type: 'json_object' }`, парс → Zod → при ошибке 1 ретрай с «твой прошлый ответ невалиден, вот ошибка», при повторной невалидности — throw `LLMValidationError`. Считает `costUsd` из `MODEL_PRICES`.

## 6. Воркеры

### 6.1. `app/worker/salesAiAnalysis.ts`
Джоб-воркер. Копия шаблона `salesCopilot.ts`:
- `resetStuckJobs()` — на старте: `running` → `failed`
- `pollLoop` из `_shared.ts` (Supabase Realtime + fallback timer, 5с)
- `claimJob()` — атомарный pick `sales_ai_analysis_jobs`
- `pollOnce()` — для job: `pipeline.runPipeline(amo_lead_id)` → mark done/failed
- Graceful shutdown

### 6.2. `app/worker/salesAiAnalysisCron.ts`
Крон-воркер. Ждёт до 3:00 MSK (env `SALES_AI_CRON_HOUR_MSK`), затем:
1. `dealFilter.pickDealsForAnalysis()` — SELECT из `amo_leads` по критериям ТЗ (late-stage, без next-task, без касаний N дней, входящее без ответа, определённые этапы; исключить «уже подписывают»).
2. Отсеять сделки без `sales_ai_deal_chat_link` (после попытки авто-линка).
3. Дедуп: посчитать `input_hash`, отбросить сделки с существующим анализом с тем же `input_hash`.
4. Cap `SALES_AI_DAILY_CAP` (дефолт 50), приоритезация по `attentionScore`.
5. Пачкой вставить в `sales_ai_analysis_jobs` с `trigger='cron'`.
6. Спать до следующих 3 AM.

### 6.3. Пайплайн `runPipeline(amoLeadId)`
```
context = contextBuilder.build(amoLeadId)
hash = hasher.compute(context)
if analysis exists with same hash → mark job skipped, exit
[amoSummary, chatSummary] = await Promise.all([
  callLLMWithSchema(SOURCE_PROMPT('amo', ...), SourceAnalysisSchema, ...),
  callLLMWithSchema(SOURCE_PROMPT('chat', ...), SourceAnalysisSchema, ...),
])
final = callLLMWithSchema(FINAL_PROMPT(context, amoSummary, chatSummary), FinalAnalysisSchema, ...)
insert into sales_ai_contact_analyses (analysis_json = final, input_hash = hash, ...)
insert into sales_ai_evidence (final.evidence[])
```

## 7. Next.js UI

### 7.1. API-роуты
Под `app/src/app/api/tools/sales-analyzer/`:
- `GET /deals?action_type=&manager=&risk=&from=&to=` — список анализов
- `GET /deals/[amoLeadId]` — последний анализ + evidence + AMO-контекст + история
- `POST /deals/[amoLeadId]/analyze` — enqueue manual-job
- `POST /deals/[amoLeadId]/link` — привязать диалог вручную
- `GET /unlinked` — сделки без чат-линка
- `GET /regulation` — активный регламент
- `PUT /regulation` — сохранить новую версию
- `GET /managers?from=&to=` — агрегаты по менеджерам

### 7.2. Страницы
Под `app/src/app/tools/sales-analyzer/`, компоненты под `app/src/components/salesAnalyzer/`:

| Роут | Компонент | Назначение |
|---|---|---|
| `/tools/sales-analyzer` | `DealListView.tsx` | Главная — таблица «нужно действие» |
| `/tools/sales-analyzer/[amoLeadId]` | `DealCardView.tsx` | Карточка сделки со всеми блоками |
| `/tools/sales-analyzer/managers` | `ManagersView.tsx` | Аналитика по менеджерам |
| `/tools/sales-analyzer/settings` | `RegulationSettingsView.tsx` | Редактор регламента |

Табличная разметка — Tailwind по паттерну `parsers/*Results.tsx`. Простые SVG-бары для средней оценки менеджеров (без сторонней либы графиков в MVP).

Sidebar: пункт «Анализ продаж» в разделе `tools`, иконка `Brain` (`lucide-react`).

## 8. Env

Новые переменные (продовый `.env`):
```
OPENROUTER_SALES_AI_API_KEY=...        # можно reuse OPENROUTER_SALES_COPILOT_API_KEY
SALES_AI_LLM_MODEL=claude-haiku-4-5
SALES_AI_CRON_HOUR_MSK=3
SALES_AI_DAILY_CAP=50
SALES_AI_CHAT_MSG_LIMIT=40
SALES_AI_ATTENTION_MIN_DAYS_WITHOUT_TOUCH=3
```

## 9. CI/CD

### 9.1. `app/package.json`
Расширяем `build:workers`:
```
esbuild worker/salesAiAnalysis.ts --bundle --platform=node --outfile=dist/worker/salesAiAnalysis.js
esbuild worker/salesAiAnalysisCron.ts --bundle --platform=node --outfile=dist/worker/salesAiAnalysisCron.js
```

### 9.2. `docker-compose.prod.yml`
Два новых сервиса:
```yaml
portal-worker-sales-ai:
  image: ghcr.io/wemdio/portal-worker:${TAG}
  command: ["node", "dist/worker/salesAiAnalysis.js"]
  restart: always
  env_file: .env
portal-worker-sales-ai-cron:
  image: ghcr.io/wemdio/portal-worker:${TAG}
  command: ["node", "dist/worker/salesAiAnalysisCron.js"]
  restart: always
  env_file: .env
```

### 9.3. `.semaphore/scheduled-deploy.yml`
Добавить оба сервиса в существующий `docker compose pull && up -d` блок.

### 9.4. `.semaphore/semaphore.yml`
Менять только если для каждого воркера собирается отдельный образ; в текущем паттерне (один общий portal-worker image) — не нужно.

## 10. Acceptance criteria

**Функциональные (по ТЗ):**
1. Крон 3 AM MSK берёт сделки, тянет чат, регламент, вызывает LLM.
2. LLM возвращает валидный JSON, проходящий Zod.
3. Каждый риск/ошибка/рекомендация имеет ≥1 запись в `sales_ai_evidence`.
4. Фильтр `action_type='manager_action_needed'` работает: сделки на «Договор подписывается» не показываются в списке РОПа.
5. В таблице РОПа есть колонка «дней без касания» из `MAX(sales_chat_messages.sent_at, amo_leads.updated_at)`.
6. Результаты сохраняются в `sales_ai_contact_analyses` + `sales_ai_evidence`.
7. Кнопка «Проанализировать сейчас» ставит `sales_ai_analysis_jobs` с `trigger='manual'`.
8. `/managers` показывает агрегаты за период.

**Технические:**
- Воркер и крон переживают рестарт (стуковые `running`-джобы → `failed`).
- Дедуп по `input_hash` работает — два прогона подряд без изменений не тратят токены.
- `cost_usd` пишется в каждый анализ.
- Миграции проходят migration lint (RLS + grants).

## 11. Что явно не входит в MVP (отложено на V2)

- Расшифровки звонков в анализе (инфра `transcription.ts` готова, подключение — V2).
- Автосвязка звонок ↔ сделка.
- Автообновление AMO рекомендациями (нужен write-эндпоинт AMO API).
- Еженедельный отчёт РОПу в Telegram/почту.
- Сравнение менеджеров «А vs Б».
- Продвинутые графики (`recharts` только если V2 потребует).
- Ролевая проверка `role='rop'` (в MVP все `authenticated` видят всё).
- Экспорт CSV/markdown.
- UI-дашборд по расходам LLM (`cost_usd` пишется, вьюхи нет).
- Streaming ответов LLM.

## 12. Риски и mitigation

| Риск | Митигация |
|---|---|
| Авто-линк по телефону находит <30% сделок | Нормализация номеров (уборка +, скобок), потом усиление ручного linker в UI |
| Часто невалидный JSON от LLM | Ужесточаем промт, переключаем на `sonnet` через env |
| Стоимость выше $3/день | Снижаем `SALES_AI_DAILY_CAP`, режем `SALES_AI_CHAT_MSG_LIMIT`, переходим на hybrid (single-shot + fanout) |
| Регламент >10k токенов | Автосжатие через LLM в `sales_regulation.summary` при сохранении |

## 13. Сроки

Оценка: **1.5–2 недели** одним разработчиком.

- Миграции + Zod-схемы: 1 день
- Воркер + LLM-хелпер + промты + пайплайн: 3–4 дня
- API (7 роутов): 1 день
- UI (4 страницы): 3–4 дня
- CI/деплой: 0.5 дня
- Тесты на реальных сделках + фиксы: 2–3 дня

## 14. План имплементации

Отдельным документом после утверждения этой спеки — через `superpowers:writing-plans`.
