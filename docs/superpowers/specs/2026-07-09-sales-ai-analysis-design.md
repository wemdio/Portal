# Sales AI Analysis — Design Spec (revised)

**Date:** 2026-07-09 (revised)
**Status:** Draft → user review
**Scope:** V1 — headless (без UI). Всё крутится в фоне, РОП читает результаты через Codex + MCP `portal-db`.

## 1. Цель

Каждую ночь анализировать активные сделки в AMO + переписки менеджеров в Telegram и складывать структурированные разборы в БД. РОП открывает **Codex**, задаёт вопросы вроде «покажи сделки, требующие внимания» или «разбор сделки Иванов». Codex через MCP `portal-db` (роль `readonly`) читает наши новые таблицы `sales_ai_*` и, опираясь на расширенный `AGENTS.md`, отвечает.

**UI мы не делаем.** Захотим позже — накрутим, но сейчас нужны только данные.

## 2. Что уже готово (переиспользуем)

| Возможность | Где | Готовность |
|---|---|---|
| AMO CRM ingestion | `services/portal-external-sync/sources/amo.py` → `amo_leads` | Прод, ночной APScheduler 2 AM MSK |
| Telegram-переписки | `sales_chat_messages` + `sales_chat_dialogs` | Прод, ~270k сообщений с 2022 |
| LLM-вызовы | Паттерн `app/src/lib/salesCopilot/llm.ts` | Прод |
| Воркеры/очередь | `app/worker/_shared.ts` (`pollLoop`, `claimJob`) | Прод |
| Миграции | `supabase/migrations/` | Прод |
| CI/CD | Semaphore + `docker-compose.prod.yml` | Прод |
| Codex + `portal-db` MCP | `G:\portal-db-readonly\AGENTS.md` — семантический слой | Прод |

**Единственный инфра-гэп:** LLM-хелпер с JSON-schema валидацией. Один маленький модуль.

## 3. Ключевые решения (согласованы)

- **UI и API — не делаем.** Всё через фон + Codex.
- **AMO ↔ Telegram-диалог:** авто-связка по нормализованному телефону, кэш в `sales_chat_dialogs.peer_phone` (новая колонка). Если не нашлось — сделка помечается `job.status='skipped'` с `skip_reason='no_chat_link'`, РОП увидит это в SQL.
- **Регламент продаж:** файл `docs/sales-regulation.md` в репе. Правится через PR. Cron-воркер читает его при старте каждого прогона, sha256 → колонка `regulation_hash` в анализе.
- **Триггер:** только крон, 1×/сутки в 3:00 MSK (после ночного AMO-синка в 2:00). Manual-триггер — не делаем, потому что портов записи в БД у Codex нет (роль `readonly`).
- **Пайплайн:** source-then-final (variant A из ТЗ) — AMO и чат анализируются отдельно, потом финальный вывод с явными `mismatch`.
- **LLM:** `claude-haiku-4-5` через OpenRouter (тот же провайдер, что у sales_copilot).
- **Бюджет:** ~$0.7–1.8/день (дедуп по input_hash + cap 40 сообщений + cap 50 сделок/сутки).
- **Доступ РОПа:** через Codex, MCP `portal-db`, роль `readonly`. Значит новые таблицы — `GRANT SELECT ... TO readonly`.

## 4. Данные (миграция)

Одна миграция `supabase/migrations/20260710_0001_create_sales_ai_tables.sql`, 4 таблицы (без `sales_regulation` — оно в файле).

### 4.1. `sales_ai_deal_chat_link`
Кэш связки AMO-сделка ↔ Telegram-диалог.

```sql
create table public.sales_ai_deal_chat_link (
  amo_lead_id bigint primary key references public.amo_leads(id) on delete cascade,
  dialog_id uuid not null references public.sales_chat_dialogs(id) on delete cascade,
  match_method text not null check (match_method in ('auto_phone')),
  confidence numeric(3,2),
  linked_at timestamptz not null default now()
);
create index idx_sales_ai_deal_chat_link_dialog on public.sales_ai_deal_chat_link(dialog_id);
```

`match_method` — оставлен как enum, чтобы позже добавить `manual` без миграции.

### 4.2. `sales_ai_analysis_jobs`
Очередь по паттерну `sales_copilot_jobs`.

```sql
create table public.sales_ai_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  amo_lead_id bigint not null references public.amo_leads(id) on delete cascade,
  trigger text not null check (trigger in ('cron')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  skip_reason text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index idx_sales_ai_jobs_status_pending on public.sales_ai_analysis_jobs(created_at) where status = 'pending';
create index idx_sales_ai_jobs_lead on public.sales_ai_analysis_jobs(amo_lead_id, created_at desc);
```

`skip_reason` перечень: `no_chat_link`, `no_new_data` (input_hash совпал), `not_in_scope` (отсеяли фильтром).

### 4.3. `sales_ai_contact_analyses`
Результаты (история сохраняется).

```sql
create table public.sales_ai_contact_analyses (
  id uuid primary key default gen_random_uuid(),
  amo_lead_id bigint not null references public.amo_leads(id) on delete cascade,
  regulation_hash text,
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

### 4.4. `sales_ai_evidence`
Цитаты-доказательства, привязанные к анализу.

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

### 4.5. Расширение `sales_chat_dialogs`
```sql
alter table public.sales_chat_dialogs add column if not exists peer_phone text;
create index if not exists idx_sales_chat_dialogs_peer_phone
  on public.sales_chat_dialogs(peer_phone) where peer_phone is not null;
```
Заполняет `linker.ts` через MTProto `users.getFullUser` при первой попытке матчинга, кэшируется.

### 4.6. RLS + grants (включая readonly для Codex)
```sql
alter table public.sales_ai_deal_chat_link enable row level security;
alter table public.sales_ai_analysis_jobs enable row level security;
alter table public.sales_ai_contact_analyses enable row level security;
alter table public.sales_ai_evidence enable row level security;

-- policies: select for authenticated (для будущего UI)
create policy sales_ai_*_select_auth for select using (auth.uid() is not null);

-- service_role — воркер пишет
grant all on public.sales_ai_deal_chat_link       to service_role, postgres;
grant all on public.sales_ai_analysis_jobs        to service_role, postgres;
grant all on public.sales_ai_contact_analyses     to service_role, postgres;
grant all on public.sales_ai_evidence             to service_role, postgres;

-- readonly — для Codex (MCP portal-db)
grant select on public.sales_ai_deal_chat_link,
                 public.sales_ai_analysis_jobs,
                 public.sales_ai_contact_analyses,
                 public.sales_ai_evidence
  to readonly;
```

## 5. Регламент — файл в репе

`docs/sales-regulation.md` — обычный markdown-текст (этапы воронки, правила квалификации, работа с возражениями, next-step-фиксация, требования к AMO). Пример структуры в ТЗ, раздел «Регламент продаж».

**Воркер читает его так:**
```typescript
const REGULATION_PATH = path.join(process.cwd(), 'docs/sales-regulation.md');
const body = fs.readFileSync(REGULATION_PATH, 'utf-8');
const hash = crypto.createHash('sha256').update(body).digest('hex');
```

`hash` пишется в `sales_ai_contact_analyses.regulation_hash` — трассировка «под какой версией регламента был сделан анализ». Регламент правится через git PR.

## 6. Модуль `app/src/lib/salesAiAnalysis/`

| Файл | Назначение |
|---|---|
| `types.ts` | TS-типы |
| `schemas.ts` | Zod: `SourceAnalysisSchema`, `FinalAnalysisSchema` |
| `prompts.ts` | 3 промта из ТЗ (system + source + final) |
| `llm.ts` | `callLLMWithSchema<T>()` — JSON-mode + Zod + retry×1 + cost |
| `regulation.ts` | Чтение файла + sha256 |
| `dealFilter.ts` | SQL «какие сделки берём» + `attentionScore()` |
| `linker.ts` | Авто-матч `amo_leads.contact_phone` ↔ `sales_chat_dialogs.peer_phone` (+MTProto fetch) |
| `contextBuilder.ts` | Пакет: AMO + последние 40 сообщений + регламент |
| `hasher.ts` | `input_hash` = sha256 от (deal.updated_at, last_msg.sent_at, regulation_hash) |
| `pipeline.ts` | Оркестрация: link → context → hash-check → analyzeAmo ‖ analyzeChat → final → save |

`callLLMWithSchema` — единственный настоящий новый инфра-модуль. Внутри: OpenRouter `response_format: json_object` → Zod → retry×1 → throw `LLMValidationError`.

## 7. Воркеры

### 7.1. `app/worker/salesAiAnalysis.ts`
Job-воркер. Копия шаблона `salesCopilot.ts`:
- `resetStuckJobs()` — `running → failed` на старте
- `pollLoop` из `_shared.ts`
- `claimJob()` — атомарный pick
- `pollOnce()` — `pipeline.runPipeline(amo_lead_id)` → done/failed
- Graceful shutdown

### 7.2. `app/worker/salesAiAnalysisCron.ts`
Крон-воркер. Ждёт 3:00 MSK, затем:
1. `dealFilter.pickDealsForAnalysis()` — активные сделки по критериям ТЗ.
2. `linker.tryAutoLink()` — попытка связать чат для всех без записи в `sales_ai_deal_chat_link`.
3. Дедуп по `input_hash`.
4. Cap `SALES_AI_DAILY_CAP` = 50 по `attentionScore`.
5. Bulk-insert в `sales_ai_analysis_jobs` (trigger='cron').
6. Спать до следующих 3:00 MSK.

### 7.3. Пайплайн
```
context = contextBuilder.build(amoLeadId)     -- если no chat link → skip
hash = hasher.compute(context)
if analysis exists with same hash → mark skipped 'no_new_data'
[amoSummary, chatSummary] = await Promise.all([
  callLLMWithSchema(SOURCE_PROMPT('amo', ...), SourceAnalysisSchema, ...),
  callLLMWithSchema(SOURCE_PROMPT('chat', ...), SourceAnalysisSchema, ...),
])
final = callLLMWithSchema(FINAL_PROMPT(context, amoSummary, chatSummary), FinalAnalysisSchema, ...)
insert into sales_ai_contact_analyses (analysis_json = final, input_hash = hash, regulation_hash, ...)
insert into sales_ai_evidence (final.evidence[])
```

## 8. Env

```
OPENROUTER_SALES_AI_API_KEY=...           # или reuse OPENROUTER_SALES_COPILOT_API_KEY
SALES_AI_LLM_MODEL=claude-haiku-4-5
SALES_AI_CRON_HOUR_MSK=3
SALES_AI_DAILY_CAP=50
SALES_AI_CHAT_MSG_LIMIT=40
SALES_AI_ATTENTION_MIN_DAYS_WITHOUT_TOUCH=3
```

## 9. CI/CD

- `app/package.json` `build:workers`: +2 esbuild-строки для новых воркеров.
- `docker-compose.prod.yml`: 2 новых сервиса (`portal-worker-sales-ai`, `portal-worker-sales-ai-cron`) — командой `node dist/worker/...`.
- `.semaphore/scheduled-deploy.yml`: добавить оба сервиса в `docker compose up -d` блок.
- `.semaphore/semaphore.yml`: менять не нужно, если один общий portal-worker образ.

## 10. Расширение `G:\portal-db-readonly\AGENTS.md`

Дописать новый раздел после «AI/Copilot слой»:

### 10.1. Секция «Sales AI Analysis — ночной разбор сделок»
Описание что это, когда льётся (крон 3:00 MSK, после AMO-синка в 2:00), терминологический маппинг:

| Слово РОПа | Куда идти | Почему |
|---|---|---|
| «разбор сделки», «анализ», «что с сделкой» | `sales_ai_contact_analyses` | Последний ночной AI-анализ |
| «требует внимания», «нужно действие» | `sales_ai_contact_analyses WHERE action_type='manager_action_needed'` | Фильтр без «уже подписывают» |
| «цитаты», «пруфы», «доказательства», «откуда AI это взял» | `sales_ai_evidence JOIN sales_ai_contact_analyses` | Каждый вывод AI подкреплён цитатой |
| «пропущенные этапы регламента» | `analysis_json->'regulation_steps_missed'` | Массив строк из JSON |
| «оценка менеджера» | `manager_score` (1-10), `score_reason` | С причиной |
| «сделка без чата», «нет переписки» | `sales_ai_analysis_jobs WHERE skip_reason='no_chat_link'` | Авто-линк не нашёл |

### 10.2. Секция «Карта связей»
```
sales_ai_contact_analyses.amo_lead_id ── amo_leads.id                    ← прямой FK
sales_ai_contact_analyses.id ── sales_ai_evidence.analysis_id            ← прямой FK
sales_ai_deal_chat_link.amo_lead_id ── amo_leads.id                       ← прямой FK
sales_ai_deal_chat_link.dialog_id ── sales_chat_dialogs.id               ← прямой FK
```

Все связи прямые (FK), никакой эвристики.

### 10.3. Готовые SQL-шаблоны для РОПа
Секция расширится с примерами:

**Сделки, где менеджеру нужно действие (сегодня)**
```sql
select a.analyzed_at,
       l.name as deal, l.responsible_name as manager,
       a.risk_level, a.manager_score,
       a.summary, a.next_touch_recommendation,
       'https://polza.amocrm.ru/leads/detail/' || l.amo_id as amo_url
from sales_ai_contact_analyses a
join amo_leads l on l.id = a.amo_lead_id
where a.action_type = 'manager_action_needed'
  and a.analyzed_at = (
    select max(analyzed_at) from sales_ai_contact_analyses
    where amo_lead_id = a.amo_lead_id
  )
  and a.risk_level in ('medium','high')
order by
  case a.risk_level when 'high' then 0 when 'medium' then 1 else 2 end,
  a.manager_score;
```

**Полный разбор конкретной сделки + evidence**
```sql
select a.summary, a.next_step, a.risk_reason, a.score_reason,
       a.analysis_json->'objections' as objections,
       a.analysis_json->'regulation_steps_missed' as missed_steps,
       jsonb_agg(jsonb_build_object(
         'source', e.source_type, 'quote', e.quote, 'why', e.why_relevant
       )) as evidence
from sales_ai_contact_analyses a
left join sales_ai_evidence e on e.analysis_id = a.id
where a.amo_lead_id = <ID>
  and a.analyzed_at = (select max(analyzed_at) from sales_ai_contact_analyses where amo_lead_id = <ID>)
group by a.id;
```

**Аналитика по менеджеру за 30 дней**
```sql
select l.responsible_name as manager,
       count(*) as deals_analyzed,
       round(avg(a.manager_score)::numeric, 1) as avg_score,
       round(100.0 * count(*) filter (where a.next_step_exists = false) / count(*), 1) as pct_no_next_step,
       round(100.0 * count(*) filter (where a.risk_level = 'high') / count(*), 1) as pct_high_risk,
       array_agg(distinct s) filter (where s is not null) as common_missed_steps
from sales_ai_contact_analyses a
join amo_leads l on l.id = a.amo_lead_id
left join lateral jsonb_array_elements_text(a.analysis_json->'regulation_steps_missed') s on true
where a.analyzed_at > current_date - interval '30 days'
group by l.responsible_name
order by avg_score;
```

**Топ незакрытых возражений (портфель)**
```sql
select o->>'objection' as objection, count(*) as freq
from sales_ai_contact_analyses a,
     lateral jsonb_array_elements(a.analysis_json->'objections') o
where a.analyzed_at > current_date - interval '30 days'
  and (o->>'handled')::boolean = false
group by o->>'objection'
order by freq desc
limit 20;
```

**Сколько денег на AI за месяц**
```sql
select date_trunc('day', analyzed_at) as day,
       count(*) as analyses, sum(tokens_used) as tokens, sum(cost_usd) as usd
from sales_ai_contact_analyses
where analyzed_at > current_date - interval '30 days'
group by 1 order by 1 desc;
```

## 11. Acceptance criteria

**Функциональные:**
1. Крон 3 AM MSK берёт сделки, связывает с чатами, вызывает LLM.
2. LLM возвращает валидный JSON, проходящий Zod.
3. Каждый риск/ошибка/рекомендация имеет ≥1 запись в `sales_ai_evidence`.
4. `action_type='no_action_needed'` для сделок «уже подписывают/оплачено».
5. Все результаты в `sales_ai_contact_analyses` + `sales_ai_evidence`.
6. `readonly` роль имеет `SELECT` на все 4 новые таблицы.
7. РОП может через Codex + `portal-db` MCP получить готовые ответы по шаблонам из раздела 10.3.

**Технические:**
- Воркер и крон переживают рестарт.
- Дедуп по `input_hash` работает (повторный прогон не тратит токены).
- `cost_usd` пишется в каждый анализ.
- Миграция проходит migration lint.
- `docs/sales-regulation.md` существует (стартовый вариант) и читается воркером.
- `AGENTS.md` обновлён и коммичен в `G:\portal-db-readonly\`.

## 12. Что не входит в V1

- **UI и API-роуты** — вообще.
- **Кнопка «Проанализировать сейчас»** — только крон.
- **Ручная привязка чата** — только авто по телефону.
- **Расшифровки звонков** — V2.
- **Автообновление AMO** — V2.
- **Еженедельный отчёт РОПу** — РОП сам ходит в Codex.
- **Ролевая проверка** — readonly-роль сама по себе изолирует.

## 13. Риски и mitigation

| Риск | Митигация |
|---|---|
| Авто-линк по телефону <30% | Нормализация номеров, ретрай через MTProto `users.getFullUser` |
| Часто невалидный JSON от LLM | Ужесточаем промт, переключаем на `sonnet` через env |
| Стоимость >$3/день | Снижаем `SALES_AI_DAILY_CAP`, режем `SALES_AI_CHAT_MSG_LIMIT` |
| Регламент >10k токенов | Компрессия через LLM в отдельный `-summary.md` |
| Codex/РОП не понимает новые таблицы | Расширение `AGENTS.md` + query-шаблоны (раздел 10) — обязательно вместе с миграцией |

## 14. Сроки

**~1 неделя** одним разработчиком (без UI резко короче):

- Миграция + `docs/sales-regulation.md` (первая версия) + расширение `AGENTS.md`: 1 день
- Zod-схемы + промты + LLM-хелпер: 1 день
- Linker + contextBuilder + hasher + dealFilter: 1 день
- Воркер + крон + пайплайн: 1 день
- CI/деплой: 0.5 дня
- Проверка на реальных сделках через Codex + фиксы промтов: 1-2 дня

## 15. План имплементации

Отдельным документом после утверждения этой ревизии — через `superpowers:writing-plans`.
