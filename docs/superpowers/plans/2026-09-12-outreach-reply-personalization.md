# Персонализированные ответы на входящие — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить изолированный инструмент портала «Персонализированные ответы на входящие»: сотрудник выбирает проект, видит, кто ответил на рассылку, по кнопке получает черновик ответа уровня вручную написанных писем (живой ресёрч компании через Gemini 3.1 Pro), может его отправить (с подтверждением) прямо из портала — без единой строчки кода, импортированной из квалификатора входящих/автопередачи.

**Architecture:** Новый модуль `app/src/lib/replyPersonalization/*` поверх двух новых таблиц основной БД портала (`reply_personalization_kb`, `reply_personalization_drafts`). Чтение уже готовых данных о лидах — read-only из `instantly_lead_qualifications`/`project_instantly_campaigns` (Instantly-датасет) и `projects` (основная БД), теми же примитивами, что уже безопасно переиспользуются в `my-projects` (auth, доступ по специалисту) и `client.ts` (`listEmails`/`replyToEmail`, Instantly-аккаунты). Генерация — один вызов Gemini 3.1 Pro через уже используемый прокси `router.requesty.ai` с `tools:[{type:'web_search'}]`, в новом независимом клиенте с собственной логикой ретрая при `finish_reason:'length'`. UI — по образцу существующего сплит-пейн экрана `app/src/app/instantly/incoming-leads/page.tsx` (список слева / деталь справа) и модалки подтверждения из `ProjectList.tsx`.

**Tech Stack:** Next.js App Router, TypeScript, Supabase (Postgres, service-role доступ через `supabaseAdmin`/`supabaseInstantly`), Tailwind (сырые классы, в проекте нет общей библиотеки UI-компонентов), Gemini 3.1 Pro через `router.requesty.ai`.

**Спека:** [`docs/superpowers/specs/2026-09-12-outreach-reply-personalization-design.md`](../specs/2026-09-12-outreach-reply-personalization-design.md)

**Тесты:** по решению пользователя (12.09.2026) — новых `*.test.ts` в этом плане нет, см. «Правило: тесты пишем скупо» в [`CLAUDE.md`](../../../CLAUDE.md). Каждая задача проверяется типами/сборкой и, где применимо, существующими тестами-линтерами миграций (`app/tests/migrations/*.test.ts` — уже существующие файлы, не новые).

---

## Область этого плана

**Входит:** две миграции, весь бэкенд-пайплайн генерации и отправки, все API-роуты, экран проекта/списка/переписки/черновика, экран настройки базы знаний, регистрация инструмента в общей навигации.

**Не входит** (см. §9 спеки): копилка отраслевых кейсов, расширенные права на редактирование базы знаний, полностью автоматическая отправка без подтверждения.

## Отклонения от спеки, зафиксированные при планировании

1. **Квалификатор наполняет `instantly_lead_qualifications` только для аккаунта `main`.** `getCampaignsByAccountCached()` (`app/src/lib/instantly/leadQualificationWorker.ts:2084-2103`) безусловно кладёт ВСЕ привязанные к проектам кампании (`project_instantly_campaigns` + `project_period_instantly_campaigns`) под ключ `'main'` — отдельного поля «на каком Instantly-аккаунте живёт проект» там нет. Значит для проекта на другом аккаунте (Okdesk) эта таблица никогда не получит его ответы: квалификатор физически не читает чужой воркспейс. Трогать `leadQualificationWorker.ts`, чтобы это исправить, нельзя (входит в список нетрогаемого).
   **Решение:** список ответивших (Task 13) веток по `instantly_account_id` из карточки знаний проекта:
   - `'main'` → читаем `instantly_lead_qualifications` (как в спеке, без обращений к Instantly);
   - любой другой аккаунт → инструмент сам вызывает `listEmails` (тот же безопасный примитив `client.ts`, что и для точечного треда) по кампаниям проекта, `email_type: 'received'`. Это отдельный от `main` аккаунт/бюджет `emailReadBudget` (бюджеты в `app/src/lib/instantly/emailReadBudget.ts` ключуются по `accountId`) — до появления этого инструмента на аккаунте Okdesk не было ни одного потребителя лимита, поэтому даже нечастый живой список не может выбрать его лимит.
2. **`generated_text` в `reply_personalization_drafts` — nullable**, не `not null`, как можно было бы предположить из спеки. Строка со статусом `skipped` создаётся без когда-либо сгенерированного текста (сотрудник пропустил письмо, не генерируя ответ), поэтому колонка обязана допускать `null`.

## Структура файлов

**Создать:**

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260912_0001_reply_personalization_kb.sql` | таблица базы знаний проекта |
| `supabase/migrations/20260912_0002_reply_personalization_drafts.sql` | таблица журнала черновиков/отправок |
| `app/src/lib/replyPersonalization/types.ts` | общие типы модуля |
| `app/src/lib/replyPersonalization/db.ts` | доступ к данным: KB, качественные проекты/кампании, `instantly_lead_qualifications`, журнал черновиков |
| `app/src/lib/replyPersonalization/instantlyThread.ts` | точечное получение полного треда письма из Instantly + фолбэк |
| `app/src/lib/replyPersonalization/liveReplyList.ts` | живой список ответивших для не-`main` аккаунтов (см. отклонение №1) |
| `app/src/lib/replyPersonalization/promptRules.ts` | универсальные анти-слоп правила (общие для всех проектов) |
| `app/src/lib/replyPersonalization/buildPrompt.ts` | сборка system/user-сообщений из KB + треда + метаданных |
| `app/src/lib/replyPersonalization/geminiClient.ts` | вызов Gemini 3.1 Pro с `web_search` + ретрай при обрезании по длине |
| `app/src/lib/replyPersonalization/generateDraft.ts` | оркестратор пайплайна генерации (шаги 1-7 из спеки) |
| `app/src/lib/replyPersonalization/sendDraft.ts` | отправка черновика через `instantly.replyToEmail` |
| `app/src/app/api/tools/reply-personalization/projects/route.ts` | GET: проекты, доступные пользователю, с флагом наличия KB |
| `app/src/app/api/tools/reply-personalization/projects/[projectId]/kb/route.ts` | GET/PUT карточки знаний проекта |
| `app/src/app/api/tools/reply-personalization/projects/[projectId]/replies/route.ts` | GET: список ответивших по проекту со статусом |
| `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/generate/route.ts` | POST: сгенерировать черновик |
| `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/send/route.ts` | POST: отправить черновик (после подтверждения на фронте) |
| `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/skip/route.ts` | POST: пропустить письмо |
| `app/src/app/tools/reply-personalization/page.tsx` | точка входа страницы |
| `app/src/components/reply-personalization/api.ts` | клиентские fetch-хелперы |
| `app/src/components/reply-personalization/ReplyPersonalizationView.tsx` | корневой клиентский компонент (выбор проекта, переключение вида) |
| `app/src/components/reply-personalization/ProjectPicker.tsx` | список проектов |
| `app/src/components/reply-personalization/KnowledgeBaseForm.tsx` | форма базы знаний проекта |
| `app/src/components/reply-personalization/ProjectInbox.tsx` | двухпанельный экран: список + деталь |
| `app/src/components/reply-personalization/ReplyDetailPanel.tsx` | переписка, кнопка генерации, черновик, копировать/пропустить/отправить |
| `app/src/components/reply-personalization/SendConfirmDialog.tsx` | модалка подтверждения отправки |

**Изменить:** `app/src/lib/toolsRegistry.ts` — добавить запись инструмента.

---

### Task 1: Миграция — база знаний проекта

**Files:**
- Create: `supabase/migrations/20260912_0001_reply_personalization_kb.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- База знаний проекта для инструмента «Персонализированные ответы на
-- входящие» (docs/superpowers/specs/2026-09-12-outreach-reply-personalization-design.md).
--
-- Одна строка на проект: бриф, факты о продукте, тон/ограничения, пример
-- хорошего письма — то, чем раньше был вручную веденный скилл
-- okdesk-personalized-replies, но параметризуемое под любой проект студии.
-- instantly_account_id — на каком Instantly-воркспейсе живут кампании этого
-- проекта (по умолчанию 'main'; для Okdesk будет отдельный id из
-- INSTANTLY_ACCOUNTS_JSON после того, как заведут ключ).
--
-- Изолирована от таблиц квалификатора входящих: ни FK, ни триггеров туда нет,
-- инструмент только читает их отдельно (см. db.ts).

create table if not exists public.reply_personalization_kb (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  brief text not null default '',
  product_facts text not null default '',
  tone_notes text not null default '',
  example_case text not null default '',
  instantly_account_id text not null default 'main',
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reply_personalization_kb is
  'Карточка знаний проекта для генератора персонализированных ответов на входящие: бриф, факты о продукте, тон, пример письма. Одна строка на проект.';

alter table public.reply_personalization_kb enable row level security;

-- Доступ только через service-role из API-роутов инструмента (как у
-- instantly_lead_qualifications) — с браузера таблицу напрямую не читают.
create policy reply_personalization_kb_service_role on public.reply_personalization_kb
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_kb to service_role;
```

- [ ] **Step 2: Прогнать существующие тесты-линтеры миграций**

Run: `cd app && npx jest tests/migrations --silent`
Expected: PASS (новая таблица проходит проверку `grants.test.ts` — есть `grant ... to service_role`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260912_0001_reply_personalization_kb.sql
git commit -m "feat(reply-personalization): миграция базы знаний проекта"
```

---

### Task 2: Миграция — журнал черновиков и отправок

**Files:**
- Create: `supabase/migrations/20260912_0002_reply_personalization_drafts.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- Журнал сгенерированных/отправленных/пропущенных ответов для инструмента
-- «Персонализированные ответы на входящие».
--
-- qualification_id — id строки instantly_lead_qualifications (Instantly-
-- датасет, отдельная БД от этой): FK невозможен между базами, поэтому просто
-- uuid без внешнего ключа, как это уже сделано для project_id в
-- project_instantly_campaigns (см. её комментарий "projects table is in main
-- DB").
--
-- Строка со статусом 'skipped' может не иметь текста вовсе (сотрудник
-- пропустил письмо, ни разу не сгенерировав ответ) — generated_text nullable.
--
-- Статус «обработано» для этого инструмента живёт только здесь: письмо
-- считается отправленным, если по его qualification_id есть строка со
-- status='sent'. Таблицы квалификатора эта запись не трогает.

create table if not exists public.reply_personalization_drafts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  qualification_id uuid not null,
  campaign_id text not null,
  thread_id text,
  lead_email text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'skipped')),
  generated_text text,
  facts_used text,
  sources jsonb not null default '[]'::jsonb,
  context_complete boolean not null default true,
  model text,
  latency_ms integer,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.reply_personalization_drafts is
  'Журнал черновиков/отправок/пропусков инструмента персонализированных ответов. Статус sent = письмо реально ушло через кнопку «Отправить» — это и есть «обработано» в списке слева.';

create index if not exists reply_personalization_drafts_project_idx
  on public.reply_personalization_drafts (project_id, created_at desc);

create index if not exists reply_personalization_drafts_qualification_idx
  on public.reply_personalization_drafts (qualification_id, created_at desc);

alter table public.reply_personalization_drafts enable row level security;

create policy reply_personalization_drafts_service_role on public.reply_personalization_drafts
  for all to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.reply_personalization_drafts to service_role;
```

- [ ] **Step 2: Прогнать существующие тесты-линтеры миграций**

Run: `cd app && npx jest tests/migrations --silent`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260912_0002_reply_personalization_drafts.sql
git commit -m "feat(reply-personalization): миграция журнала черновиков"
```

---

### Task 3: Общие типы модуля

**Files:**
- Create: `app/src/lib/replyPersonalization/types.ts`

- [ ] **Step 1: Написать типы**

```ts
// Общие типы инструмента «Персонализированные ответы на входящие».
// Модуль изолирован от квалификатора входящих: сюда ничего не импортируется
// из lib/instantly/leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts.

export interface KnowledgeBase {
  projectId: string;
  brief: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  instantlyAccountId: string;
  updatedAt: string;
}

export interface QualificationRow {
  id: string;
  campaignId: string;
  campaignName: string | null;
  leadEmail: string;
  companyName: string | null;
  threadId: string | null;
  replySubject: string | null;
  replyBody: string | null;
  lastOutboundPreview: string | null;
  instantlyEmailId: string | null;
  eaccount: string | null;
  replyTimestamp: string | null;
}

export interface ThreadMessage {
  fromUs: boolean;
  text: string;
  timestamp?: string;
}

export type DraftStatus = 'draft' | 'sent' | 'skipped';

export interface DraftRow {
  id: string;
  projectId: string;
  qualificationId: string;
  status: DraftStatus;
  generatedText: string | null;
  factsUsed: string | null;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
  model: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Строка списка «кто ответил» на экране инструмента. */
export interface ReplyListItem extends QualificationRow {
  /** 'new' — ни одного 'sent' черновика по этому qualification_id. */
  listStatus: 'new' | 'sent';
}

export interface GenerateDraftResult {
  draftId: string;
  text: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: без новых ошибок (файл пока никем не импортируется).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/types.ts
git commit -m "feat(reply-personalization): общие типы модуля"
```

---

### Task 4: Доступ к данным (KB, проекты, качественные ответы, журнал)

**Files:**
- Create: `app/src/lib/replyPersonalization/db.ts`

- [ ] **Step 1: Написать хелперы**

```ts
// Слой доступа к данным инструмента. Читает из instantly_lead_qualifications
// / project_instantly_campaigns / project_period_instantly_campaigns
// исключительно SELECT — никогда не пишет туда и не импортирует бизнес-логику
// квалификатора (leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { DraftRow, DraftStatus, KnowledgeBase, QualificationRow } from './types';

export function requireClients() {
  if (!supabaseAdmin || !supabaseInstantly) {
    throw new Error('Server misconfigured: supabaseAdmin/supabaseInstantly missing');
  }
  return { admin: supabaseAdmin, instantly: supabaseInstantly };
}

const SUPERVISOR_ROLES = ['admin', 'director', 'lead', 'manager'];

export async function isSupervisor(userId: string): Promise<boolean> {
  const { admin } = requireClients();
  const { data } = await admin.from('profiles').select('role').eq('id', userId).single();
  return SUPERVISOR_ROLES.includes((data?.role as string) ?? '');
}

/** Проекты, видимые пользователю — тот же критерий, что у /api/instantly/my-projects. */
export async function listVisibleProjects(userId: string) {
  const { admin } = requireClients();
  const supervisor = await isSupervisor(userId);

  let query = admin
    .from('projects')
    .select('id, client, name, specialist, specialist_user_id')
    .in('status', ['В работе', 'Тестирование', 'Подготовка'])
    .order('client');
  if (!supervisor) query = query.eq('specialist_user_id', userId);

  const { data, error } = await query;
  if (error) throw new Error(`projects query failed: ${error.message}`);
  return (data ?? []).map((p) => ({
    id: p.id as string,
    client: (p.client as string) ?? (p.name as string) ?? '',
  }));
}

/** Кампании проекта — тот же join, что у /api/instantly/my-projects. */
export async function getProjectCampaignIds(projectId: string): Promise<string[]> {
  const { instantly } = requireClients();
  const [legacy, period] = await Promise.all([
    instantly.from('project_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
    instantly.from('project_period_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
  ]);
  const ids = new Set<string>();
  for (const row of legacy.data ?? []) if (row.campaign_id) ids.add(row.campaign_id as string);
  for (const row of period.data ?? []) if (row.campaign_id) ids.add(row.campaign_id as string);
  return [...ids];
}

export async function getKnowledgeBase(projectId: string): Promise<KnowledgeBase | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_kb')
    .select('project_id, brief, product_facts, tone_notes, example_case, instantly_account_id, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw new Error(`kb query failed: ${error.message}`);
  if (!data) return null;
  return {
    projectId: data.project_id as string,
    brief: (data.brief as string) ?? '',
    productFacts: (data.product_facts as string) ?? '',
    toneNotes: (data.tone_notes as string) ?? '',
    exampleCase: (data.example_case as string) ?? '',
    instantlyAccountId: (data.instantly_account_id as string) ?? 'main',
    updatedAt: data.updated_at as string,
  };
}

export async function upsertKnowledgeBase(
  projectId: string,
  patch: Pick<KnowledgeBase, 'brief' | 'productFacts' | 'toneNotes' | 'exampleCase' | 'instantlyAccountId'>,
  userId: string,
): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_kb').upsert(
    {
      project_id: projectId,
      brief: patch.brief,
      product_facts: patch.productFacts,
      tone_notes: patch.toneNotes,
      example_case: patch.exampleCase,
      instantly_account_id: patch.instantlyAccountId || 'main',
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id' },
  );
  if (error) throw new Error(`kb upsert failed: ${error.message}`);
}

function mapQualificationRow(row: Record<string, unknown>): QualificationRow {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    campaignName: (row.campaign_name as string) ?? null,
    leadEmail: row.lead_email as string,
    companyName: (row.company_name as string) ?? null,
    threadId: (row.thread_id as string) ?? null,
    replySubject: (row.reply_subject as string) ?? null,
    replyBody: (row.reply_body as string) ?? null,
    lastOutboundPreview: (row.last_outbound_preview as string) ?? null,
    instantlyEmailId: (row.instantly_email_id as string) ?? null,
    eaccount: (row.eaccount as string) ?? null,
    replyTimestamp: (row.reply_timestamp as string) ?? null,
  };
}

const QUALIFICATION_COLUMNS =
  'id, campaign_id, campaign_name, lead_email, company_name, thread_id, reply_subject, reply_body, last_outbound_preview, instantly_email_id, eaccount, reply_timestamp';

/** Read-only: уже синхронизированные квалификатором ответы (только account 'main', см. §«Отклонения»). */
export async function listSyncedQualifications(campaignIds: string[], limit = 50): Promise<QualificationRow[]> {
  if (!campaignIds.length) return [];
  const { instantly } = requireClients();
  const { data, error } = await instantly
    .from('instantly_lead_qualifications')
    .select(QUALIFICATION_COLUMNS)
    .in('campaign_id', campaignIds)
    .order('reply_timestamp', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`qualifications query failed: ${error.message}`);
  return (data ?? []).map(mapQualificationRow);
}

export async function getQualificationById(id: string): Promise<QualificationRow | null> {
  const { instantly } = requireClients();
  const { data, error } = await instantly
    .from('instantly_lead_qualifications')
    .select(QUALIFICATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`qualification lookup failed: ${error.message}`);
  return data ? mapQualificationRow(data) : null;
}

/** Последний нескрытый статус на каждый qualification_id ('skipped' исключается из выдачи целиком в вызывающем коде). */
export async function getLatestDraftStatuses(
  qualificationIds: string[],
): Promise<Record<string, DraftStatus>> {
  if (!qualificationIds.length) return {};
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .select('qualification_id, status, created_at')
    .in('qualification_id', qualificationIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`draft status query failed: ${error.message}`);
  const result: Record<string, DraftStatus> = {};
  for (const row of data ?? []) {
    const qid = row.qualification_id as string;
    if (!(qid in result)) result[qid] = row.status as DraftStatus;
  }
  return result;
}

function mapDraftRow(row: Record<string, unknown>): DraftRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    qualificationId: row.qualification_id as string,
    status: row.status as DraftStatus,
    generatedText: (row.generated_text as string) ?? null,
    factsUsed: (row.facts_used as string) ?? null,
    sources: (row.sources as { url: string; title?: string }[]) ?? [],
    contextComplete: (row.context_complete as boolean) ?? true,
    model: (row.model as string) ?? null,
    createdAt: row.created_at as string,
    sentAt: (row.sent_at as string) ?? null,
  };
}

export async function insertDraft(input: {
  projectId: string;
  qualificationId: string;
  campaignId: string;
  threadId: string | null;
  leadEmail: string;
  generatedText: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
  model: string;
  latencyMs: number;
  createdBy: string;
}): Promise<DraftRow> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .insert({
      project_id: input.projectId,
      qualification_id: input.qualificationId,
      campaign_id: input.campaignId,
      thread_id: input.threadId,
      lead_email: input.leadEmail,
      status: 'draft',
      generated_text: input.generatedText,
      facts_used: input.factsUsed,
      sources: input.sources,
      context_complete: input.contextComplete,
      model: input.model,
      latency_ms: input.latencyMs,
      created_by: input.createdBy,
    })
    .select()
    .single();
  if (error) throw new Error(`draft insert failed: ${error.message}`);
  return mapDraftRow(data);
}

export async function insertSkip(input: {
  projectId: string;
  qualificationId: string;
  campaignId: string;
  threadId: string | null;
  leadEmail: string;
  createdBy: string;
}): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin.from('reply_personalization_drafts').insert({
    project_id: input.projectId,
    qualification_id: input.qualificationId,
    campaign_id: input.campaignId,
    thread_id: input.threadId,
    lead_email: input.leadEmail,
    status: 'skipped',
    created_by: input.createdBy,
  });
  if (error) throw new Error(`skip insert failed: ${error.message}`);
}

export async function getDraftById(draftId: string): Promise<DraftRow | null> {
  const { admin } = requireClients();
  const { data, error } = await admin
    .from('reply_personalization_drafts')
    .select()
    .eq('id', draftId)
    .maybeSingle();
  if (error) throw new Error(`draft lookup failed: ${error.message}`);
  return data ? mapDraftRow(data) : null;
}

export async function markDraftSent(draftId: string): Promise<void> {
  const { admin } = requireClients();
  const { error } = await admin
    .from('reply_personalization_drafts')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', draftId);
  if (error) throw new Error(`draft sent-update failed: ${error.message}`);
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/db.ts
git commit -m "feat(reply-personalization): слой доступа к данным"
```

---

### Task 5: Точечное получение полного треда из Instantly

**Files:**
- Create: `app/src/lib/replyPersonalization/instantlyThread.ts`

- [ ] **Step 1: Написать хелпер**

```ts
// Точечный, по клику «Сгенерировать», запрос полного треда письма к
// Instantly. Использует только тонкий примитив client.ts (listEmails) —
// НЕ импортирует leadQualifier.ts/leadQualificationWorker.ts. Сам вызов
// проходит через существующий общий бюджет /emails (emailReadBudget.ts),
// как и всё остальное в client.ts — отдельно реализовывать throttling
// не нужно.
//
// У Instantly нет надёжного фильтра по thread_id в /emails (см.
// leadQualifier.ts:148-149) — поэтому, как и там, тянем емейлы по
// campaign_id+search=leadEmail и фильтруем по thread_id на своей стороне.
// Это независимая реализация того же публичного API-нюанса, не импорт кода
// квалификатора.

import { listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';
import type { ThreadMessage } from './types';

function extractEmailText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  if (body.text) return body.text.trim();
  if (body.html) return body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

export async function fetchFullThread(params: {
  campaignId: string;
  leadEmail: string;
  threadId: string;
  accountId: string;
}): Promise<ThreadMessage[] | null> {
  try {
    const response = await listEmails(
      {
        campaign_id: params.campaignId,
        search: params.leadEmail,
        mode: 'emode_all',
        sort_order: 'asc',
      },
      { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'fresh' },
    );
    const messages: ThreadMessage[] = (response.items ?? [])
      .filter((email) => email.thread_id === params.threadId)
      .sort((a, b) => (a.timestamp_created ?? '').localeCompare(b.timestamp_created ?? ''))
      .map((email) => ({
        fromUs: email.ue_type === 1 || email.ue_type === 3,
        text: extractEmailText(email.body),
        timestamp: email.timestamp_created,
      }))
      .filter((message) => message.text.length > 0);
    return messages.length > 0 ? messages : null;
  } catch {
    // Сбой живого запроса не должен ронять генерацию — вызывающий код
    // откатывается на reply_body/last_outbound_preview из уже сохранённых
    // данных (см. generateDraft.ts).
    return null;
  }
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/instantlyThread.ts
git commit -m "feat(reply-personalization): точечное получение полного треда"
```

---

### Task 6: Живой список ответивших для не-main аккаунтов

**Files:**
- Create: `app/src/lib/replyPersonalization/liveReplyList.ts`

- [ ] **Step 1: Написать хелпер**

См. «Отклонения от спеки» выше: квалификатор синкает `instantly_lead_qualifications` только для аккаунта `main`. Для проекта на другом аккаунте (`kb.instantlyAccountId !== 'main'`, например Okdesk) список ответивших строится живым запросом к Instantly.

```ts
// Живой список входящих ответов для Instantly-аккаунта, который квалификатор
// не синкает (не 'main') — см. «Отклонения от спеки» в плане реализации.
// Использует тот же примитив client.ts, что и instantlyThread.ts, поэтому
// проходит через тот же общий бюджет /emails, но уже отдельного, не 'main'
// воркспейса — на момент внедрения на нём нет других потребителей лимита.

import { listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';
import type { QualificationRow } from './types';

function extractPreview(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 500);
  if (body.text) return body.text.slice(0, 500);
  if (body.html) return body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  return '';
}

/**
 * qualification_id для писем с живого аккаунта — сам instantly_email_id
 * (строка, а не uuid из instantly_lead_qualifications). generate/send/skip
 * роуты должны уметь принять оба вида id — см. Task 14-16.
 */
export async function listLiveReplies(params: {
  campaignIds: string[];
  accountId: string;
  limit?: number;
}): Promise<QualificationRow[]> {
  if (!params.campaignIds.length) return [];
  const results: QualificationRow[] = [];
  for (const campaignId of params.campaignIds) {
    try {
      const response = await listEmails(
        { campaign_id: campaignId, email_type: 'received', sort_order: 'desc' },
        { accountId: params.accountId, timeoutMs: 20_000, requestPriority: 'fresh' },
      );
      for (const email of response.items ?? []) {
        if (!email.id || !email.lead) continue;
        results.push({
          id: email.id,
          campaignId,
          campaignName: null,
          leadEmail: email.lead,
          companyName: null,
          threadId: email.thread_id ?? null,
          replySubject: email.subject ?? null,
          replyBody: extractPreview(email.body),
          lastOutboundPreview: null,
          instantlyEmailId: email.id,
          eaccount: email.eaccount ?? null,
          replyTimestamp: email.timestamp_created ?? null,
        });
      }
    } catch {
      // Один недоступный кампании не должен ронять список остальных.
    }
  }
  return results
    .sort((a, b) => (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''))
    .slice(0, params.limit ?? 50);
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/liveReplyList.ts
git commit -m "feat(reply-personalization): живой список ответивших для не-main аккаунтов"
```

---

### Task 7: Универсальные анти-слоп правила

**Files:**
- Create: `app/src/lib/replyPersonalization/promptRules.ts`

- [ ] **Step 1: Написать константу с правилами**

Каркас переносит ЛОГИКУ скилла `okdesk-personalized-replies` (цепочка рассуждения, тест «подставь другую компанию», один CTA), но без Okdesk-специфики — факты о продукте приходят из карточки знаний проекта, не отсюда.

```ts
// Универсальные, одинаковые для всех проектов правила генерации ответа.
// Специфика конкретного продукта/тона — в карточке знаний проекта
// (см. buildPrompt.ts), не здесь.

export const UNIVERSAL_REPLY_RULES = `Ты помогаешь специалисту по холодному email-аутричу написать
ответ на письмо, которое прислал адресат рассылки.

Разбери входящий ответ: кто ответил, какая у него роль (по подписи), что он
спросил или предложил, дал ли номер телефона и чей это номер.

Прежде чем писать, определи ситуацию (типичные варианты, не ограничивайся
ими):
- открытый вопрос («какой вопрос вас интересует», «по какому поводу») —
  назови конкретный процесс адресата и задачу, которую предлагаешь обсудить;
- адресат дал свой рабочий номер и разрешил позвонить — предложи один точный
  слот звонка по этому номеру;
- номер есть только в подписи — интерес ещё не подтверждён, сначала объясни
  применимость, затем спроси про звонок;
- передали контакт коллеги — не выдавай это за проявленный интерес коллеги,
  используй нейтральное «Коллеги подсказали ваш контакт»;
- передали рабочий email другого руководителя — это новый адресат: первым
  предложением честно объясни, что вас перенаправили, и только потом
  переходи к сути;
- запрос цены/КП — ответь по существу или явно передай в продажи, не
  возвращай к общей презентации;
- явный отказ или просьба не писать/не звонить — не продолжай продажу.

Живым поиском в интернете (сайт компании, официальные реестры, аналоги
2ГИС, открытые закупки) найди 1-2 подтверждённых факта об адресате, которые
реально влияют на его рабочий процесс: тип клиентов, объекты, договоры,
оборудование, география, документооборот. Не выдавай предположение за факт.

Строй письмо по цепочке: подтверждённый процесс адресата -> операционная
сложность -> следствие -> подходящая возможность продукта (из карточки
знаний, не более 2-3) -> один следующий шаг. Проверь мысленно: если
подставить другую компанию того же сегмента, письмо должно перестать быть
применимым дословно — иначе персонализация недостаточна.

Требования к письму:
- сначала прямо ответь на реплику адресата;
- используй имя/отчество, если оно есть в подписи;
- обычно укладывайся в 90-170 слов, короткими абзацами;
- сохраняй присланную подпись отправителя как есть;
- один кейс, один призыв к действию;
- не используй общий список функций продукта, рекламные оценки и
  неподтверждённые цифры;
- деловой, спокойный тон, без оправданий и нажима.

Верни только готовый текст письма — без вариантов, без пояснений до или
после.`;
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/promptRules.ts
git commit -m "feat(reply-personalization): универсальные анти-слоп правила"
```

---

### Task 8: Сборка промпта

**Files:**
- Create: `app/src/lib/replyPersonalization/buildPrompt.ts`

- [ ] **Step 1: Написать сборщик**

```ts
import { UNIVERSAL_REPLY_RULES } from './promptRules';
import type { KnowledgeBase, QualificationRow, ThreadMessage } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

function formatThread(thread: ThreadMessage[]): string {
  return thread
    .map((m) => `${m.fromUs ? 'МЫ' : 'ОНИ'} (${m.timestamp ?? '—'}):\n${m.text}`)
    .join('\n\n---\n\n');
}

export function buildReplyPrompt(input: {
  kb: KnowledgeBase;
  qualification: QualificationRow;
  thread: ThreadMessage[];
  contextComplete: boolean;
}): PromptMessage[] {
  const { kb, qualification, thread, contextComplete } = input;

  const system = `${UNIVERSAL_REPLY_RULES}

О продукте/проекте, для которого пишешь письмо:

Бриф:
${kb.brief || '(бриф не заполнен)'}

Факты о продукте и что можно предлагать:
${kb.productFacts || '(факты не заполнены)'}

Тон и ограничения этого проекта:
${kb.toneNotes || '(особых ограничений нет, используй деловой тон по умолчанию)'}

Пример хорошего письма для этого проекта (ориентир по стилю, не копируй
дословно):
${kb.exampleCase || '(примера нет)'}`;

  const user = `Компания-адресат: ${qualification.companyName || qualification.leadEmail}
Email адресата: ${qualification.leadEmail}
${contextComplete ? '' : 'Внимание: полный тред переписки получить не удалось, ниже только сохранённые отрывки — учитывай это и не додумывай детали, которых нет.\n'}
Переписка:

${formatThread(thread)}

Напиши следующий ответ от НАС адресату, отвечая на его последнюю реплику.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/buildPrompt.ts
git commit -m "feat(reply-personalization): сборка промпта"
```

---

### Task 9: Клиент Gemini с веб-поиском и ретраем по длине

**Files:**
- Create: `app/src/lib/replyPersonalization/geminiClient.ts`

- [ ] **Step 1: Написать клиент**

Независимая от `openrouter/client.ts` реализация: тот файл не поддерживает произвольные поля тела запроса вроде `tools` (см. исследование при планировании), а `tools:[{type:'web_search'}]` — это ровно то, что нужно для живого ресёрча компании. Логика ретрая при `finish_reason==='length'` и общий тайм-бюджет по духу повторяют `app/src/lib/tools/personalizationCompletion.ts`, но это отдельный, самостоятельный файл — ничего оттуда не импортируется.

```ts
// Изолированный клиент к Gemini 3.1 Pro через тот же прокси портала
// (router.requesty.ai), с включённым веб-поиском для живого ресёрча
// компании-адресата. Не переиспользует openrouter/client.ts: тот не
// поддерживает поле `tools`, нужное здесь.

const ENDPOINT = process.env.OPENROUTER_ENDPOINT ?? 'https://router.requesty.ai/v1/chat/completions';

// TODO(проверить перед первым запуском в проде): точный id модели «Gemini
// 3.1 Pro» в Model Library Requesty (https://app.requesty.ai/model-library)
// может отличаться по написанию — свериться и при необходимости обновить
// REPLY_PERSONALIZATION_MODEL_ID в .env.
const MODEL_ID = process.env.REPLY_PERSONALIZATION_MODEL_ID ?? 'vertex/google/gemini-3-pro-preview';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 240_000;
const INITIAL_MAX_TOKENS = 1500;
const MAX_TOKENS_CAP = 6000;

export class ReplyGenerationError extends Error {}

export interface GeminiReplyResult {
  text: string;
  sources: { url: string; title?: string }[];
}

interface RequestyChoice {
  message?: { content?: string; web_search?: { url?: string; title?: string }[] };
  finish_reason?: string;
}

export async function generateReplyWithSearch(messages: { role: string; content: string }[]): Promise<GeminiReplyResult> {
  const apiKey = process.env.OPENROUTER_REPLY_PERSONALIZATION_API_KEY ?? process.env.OPENROUTER_BRIEF_API_KEY ?? '';
  if (!apiKey) {
    throw new ReplyGenerationError('OPENROUTER_REPLY_PERSONALIZATION_API_KEY not configured on server');
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let maxTokens = INITIAL_MAX_TOKENS;
  let lastError: Error = new ReplyGenerationError('Generation failed for unknown reason');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw lastError;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL_ID,
          messages,
          max_tokens: maxTokens,
          temperature: 0.4,
          tools: [{ type: 'web_search' }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        lastError = new ReplyGenerationError(`Requesty error ${response.status}: ${await response.text().catch(() => '')}`);
        continue;
      }

      const data = (await response.json()) as { choices?: RequestyChoice[] };
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';

      if (choice?.finish_reason === 'length') {
        lastError = new ReplyGenerationError('Ответ обрезан по длине (finish_reason=length)');
        maxTokens = Math.min(MAX_TOKENS_CAP, maxTokens * 2);
        continue;
      }

      if (!content) {
        lastError = new ReplyGenerationError('Пустой ответ модели');
        continue;
      }

      const sources = (choice?.message?.web_search ?? [])
        .filter((s): s is { url: string; title?: string } => Boolean(s.url))
        .map((s) => ({ url: s.url, title: s.title }));

      return { text: content, sources };
    } catch (err) {
      lastError = err instanceof Error ? err : new ReplyGenerationError('Unknown error');
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/geminiClient.ts
git commit -m "feat(reply-personalization): клиент Gemini с веб-поиском и ретраем по длине"
```

---

### Task 10: Оркестратор генерации черновика

**Files:**
- Create: `app/src/lib/replyPersonalization/generateDraft.ts`

- [ ] **Step 1: Написать оркестратор**

`instantly_lead_qualifications` не хранит обратную ссылку на `projects` (это разные базы), поэтому `projectId` берёт вызывающий роут из URL (он уже проверил по нему доступ пользователя, см. Task 15) и передаёт сюда явно, а не резолвится внутри функции.

```ts
import { buildReplyPrompt } from './buildPrompt';
import { getKnowledgeBase, getQualificationById, insertDraft } from './db';
import { generateReplyWithSearch } from './geminiClient';
import { fetchFullThread } from './instantlyThread';
import type { GenerateDraftResult, ThreadMessage } from './types';

export class GenerateDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function fallbackThread(reply: { replyBody: string | null; lastOutboundPreview: string | null }): ThreadMessage[] {
  const thread: ThreadMessage[] = [];
  if (reply.lastOutboundPreview) thread.push({ fromUs: true, text: reply.lastOutboundPreview });
  if (reply.replyBody) thread.push({ fromUs: false, text: reply.replyBody });
  return thread;
}

/**
 * projectId передаётся явно вызывающим роутом (URL уже содержит его —
 * /projects/[projectId]/... — и он же используется для проверки доступа
 * пользователя ДО вызова этой функции), поэтому здесь не резолвится заново.
 */
export async function generateDraftForQualification(
  projectId: string,
  qualificationId: string,
  userId: string,
): Promise<GenerateDraftResult> {
  const startedAt = Date.now();

  const kb = await getKnowledgeBase(projectId);
  if (!kb) throw new GenerateDraftError('У проекта не заполнена база знаний', 409);

  const qualification = await getQualificationById(qualificationId);
  if (!qualification) throw new GenerateDraftError('Письмо не найдено', 404);

  let contextComplete = true;
  let thread: ThreadMessage[] | null = null;
  if (qualification.threadId) {
    thread = await fetchFullThread({
      campaignId: qualification.campaignId,
      leadEmail: qualification.leadEmail,
      threadId: qualification.threadId,
      accountId: kb.instantlyAccountId,
    });
  }
  if (!thread) {
    contextComplete = false;
    thread = fallbackThread(qualification);
  }
  if (thread.length === 0) {
    throw new GenerateDraftError('Нет текста переписки для генерации ответа', 422);
  }

  const messages = buildReplyPrompt({ kb, qualification, thread, contextComplete });
  const result = await generateReplyWithSearch(messages);

  const draft = await insertDraft({
    projectId,
    qualificationId,
    campaignId: qualification.campaignId,
    threadId: qualification.threadId,
    leadEmail: qualification.leadEmail,
    generatedText: result.text,
    factsUsed: result.sources.map((s) => s.title || s.url).join(', '),
    sources: result.sources,
    contextComplete,
    model: process.env.REPLY_PERSONALIZATION_MODEL_ID ?? 'vertex/google/gemini-3-pro-preview',
    latencyMs: Date.now() - startedAt,
    createdBy: userId,
  });

  return {
    draftId: draft.id,
    text: draft.generatedText ?? '',
    factsUsed: draft.factsUsed ?? '',
    sources: draft.sources,
    contextComplete: draft.contextComplete,
  };
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/generateDraft.ts
git commit -m "feat(reply-personalization): оркестратор генерации черновика"
```

---

### Task 11: Отправка черновика

**Files:**
- Create: `app/src/lib/replyPersonalization/sendDraft.ts`

- [ ] **Step 1: Написать хелпер отправки**

```ts
// Отправка через уже существующий безопасный примитив replyToEmail
// (app/src/lib/instantly/client.ts) — не через handoffSender.ts (это
// бизнес-логика квалификатора, её мы не трогаем).

import { replyToEmail } from '@/lib/instantly/client';
import { getDraftById, getKnowledgeBase, getQualificationById, markDraftSent } from './db';

export class SendDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function sendDraft(draftId: string): Promise<void> {
  const draft = await getDraftById(draftId);
  if (!draft) throw new SendDraftError('Черновик не найден', 404);
  if (draft.status === 'sent') return; // идемпотентно: повторный клик не шлёт письмо дважды
  if (!draft.generatedText) throw new SendDraftError('У черновика нет текста', 422);

  const qualification = await getQualificationById(draft.qualificationId);
  if (!qualification) throw new SendDraftError('Письмо не найдено', 404);
  if (!qualification.instantlyEmailId) throw new SendDraftError('Нет id письма для ответа в Instantly', 422);
  if (!qualification.eaccount) throw new SendDraftError('Не определён почтовый ящик отправителя (eaccount)', 422);

  const kb = await getKnowledgeBase(draft.projectId);
  if (!kb) throw new SendDraftError('У проекта не заполнена база знаний', 409);

  await replyToEmail(
    {
      reply_to_uuid: qualification.instantlyEmailId,
      eaccount: qualification.eaccount,
      subject: qualification.replySubject ? `Re: ${qualification.replySubject}` : 'Re:',
      body: { text: draft.generatedText },
    },
    { accountId: kb.instantlyAccountId },
  );

  await markDraftSent(draftId);
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/replyPersonalization/sendDraft.ts
git commit -m "feat(reply-personalization): отправка черновика через Instantly"
```

---

### Task 12: API — список проектов

**Files:**
- Create: `app/src/app/api/tools/reply-personalization/projects/route.ts`

- [ ] **Step 1: Написать роут**

```ts
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getKnowledgeBase, listVisibleProjects } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const projects = await listVisibleProjects(user.id);
  const withKb = await Promise.all(
    projects.map(async (p) => ({
      ...p,
      hasKnowledgeBase: Boolean(await getKnowledgeBase(p.id)),
    })),
  );

  return NextResponse.json({ projects: withKb });
});
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/reply-personalization/projects/route.ts
git commit -m "feat(reply-personalization): API списка проектов"
```

---

### Task 13: API — карточка знаний проекта

**Files:**
- Create: `app/src/app/api/tools/reply-personalization/projects/[projectId]/kb/route.ts`

- [ ] **Step 1: Написать роут**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, upsertKnowledgeBase } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const kb = await getKnowledgeBase(projectId);
  return NextResponse.json({ kb });
});

export const PUT = withAuth(async (req: NextRequest, user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    brief?: string;
    productFacts?: string;
    toneNotes?: string;
    exampleCase?: string;
    instantlyAccountId?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  await upsertKnowledgeBase(
    projectId,
    {
      brief: body.brief ?? '',
      productFacts: body.productFacts ?? '',
      toneNotes: body.toneNotes ?? '',
      exampleCase: body.exampleCase ?? '',
      instantlyAccountId: body.instantlyAccountId ?? 'main',
    },
    user.id,
  );

  const kb = await getKnowledgeBase(projectId);
  return NextResponse.json({ kb });
});
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/reply-personalization/projects/[projectId]/kb/route.ts
git commit -m "feat(reply-personalization): API карточки знаний проекта"
```

---

### Task 14: API — список ответивших по проекту

**Files:**
- Create: `app/src/app/api/tools/reply-personalization/projects/[projectId]/replies/route.ts`

- [ ] **Step 1: Написать роут**

Ветка по `instantly_account_id` — см. «Отклонения от спеки».

```ts
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getLatestDraftStatuses, getProjectCampaignIds, listSyncedQualifications } from '@/lib/replyPersonalization/db';
import { listLiveReplies } from '@/lib/replyPersonalization/liveReplyList';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const kb = await getKnowledgeBase(projectId);
  if (!kb) return NextResponse.json({ replies: [], needsKnowledgeBase: true });

  const campaignIds = await getProjectCampaignIds(projectId);
  const qualifications =
    kb.instantlyAccountId === 'main'
      ? await listSyncedQualifications(campaignIds)
      : await listLiveReplies({ campaignIds, accountId: kb.instantlyAccountId });

  const statuses = await getLatestDraftStatuses(qualifications.map((q) => q.id));

  const replies: ReplyListItem[] = qualifications
    .filter((q) => statuses[q.id] !== 'skipped')
    .map((q) => ({ ...q, listStatus: statuses[q.id] === 'sent' ? 'sent' : 'new' }));

  return NextResponse.json({ replies, needsKnowledgeBase: false });
});
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/reply-personalization/projects/[projectId]/replies/route.ts
git commit -m "feat(reply-personalization): API списка ответивших"
```

---

### Task 15: API — генерация черновика

**Files:**
- Create: `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/generate/route.ts`

- [ ] **Step 1: Написать роут**

`projectId` приходит в теле запроса (фронт его уже знает — экран открыт в контексте выбранного проекта), а не в URL, чтобы не плодить вложенность путей на два независимых идентификатора.

```ts
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { generateDraftForQualification, GenerateDraftError } from '@/lib/replyPersonalization/generateDraft';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  try {
    const result = await generateDraftForQualification(body.projectId, qualificationId, user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GenerateDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Generation failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/reply-personalization/replies/[qualificationId]/generate/route.ts
git commit -m "feat(reply-personalization): API генерации черновика"
```

---

### Task 16: API — отправка и пропуск

**Files:**
- Create: `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/send/route.ts`
- Create: `app/src/app/api/tools/reply-personalization/replies/[qualificationId]/skip/route.ts`

- [ ] **Step 1: Написать роут отправки**

```ts
// app/src/app/api/tools/reply-personalization/replies/[qualificationId]/send/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getDraftById } from '@/lib/replyPersonalization/db';
import { sendDraft, SendDraftError } from '@/lib/replyPersonalization/sendDraft';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, _user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { draftId?: string } | null;
  if (!body?.draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 });

  // Черновик и адрес в URL должны совпадать — иначе фронт по ошибке (или
  // устаревшая вкладка) мог бы отправить черновик другого письма.
  const draft = await getDraftById(body.draftId);
  if (!draft || draft.qualificationId !== qualificationId) {
    return NextResponse.json({ error: 'Черновик не относится к этому письму' }, { status: 409 });
  }

  try {
    await sendDraft(body.draftId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SendDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Send failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
```

- [ ] **Step 2: Написать роут пропуска**

```ts
// app/src/app/api/tools/reply-personalization/replies/[qualificationId]/skip/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getQualificationById, insertSkip } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const qualification = await getQualificationById(qualificationId);
  if (!qualification) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });

  await insertSkip({
    projectId: body.projectId,
    qualificationId,
    campaignId: qualification.campaignId,
    threadId: qualification.threadId,
    leadEmail: qualification.leadEmail,
    createdBy: user.id,
  });

  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 3: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/src/app/api/tools/reply-personalization/replies/[qualificationId]/send/route.ts app/src/app/api/tools/reply-personalization/replies/[qualificationId]/skip/route.ts
git commit -m "feat(reply-personalization): API отправки и пропуска"
```

---

### Task 17: Регистрация инструмента в навигации

**Files:**
- Modify: `app/src/lib/toolsRegistry.ts`

- [ ] **Step 1: Добавить id в `ALL_TOOL_IDS`**

Найти массив `ALL_TOOL_IDS` и добавить `'reply-personalization'` в список (порядок — рядом с `'hypothesis-engine'`/`'vertical-engine-v2'`).

- [ ] **Step 2: Добавить карточку в `TOOLS_CONFIG`**

```ts
'reply-personalization': {
  id: 'reply-personalization',
  title: 'Персонализированные ответы',
  title_en: 'Reply Personalization',
  description: 'Живой ресёрч компании-адресата и черновик персонализированного ответа на входящее письмо — по кнопке, с отправкой из портала.',
  description_en: 'Live research on the replying company and a personalized reply draft, generated on demand and sendable from the portal.',
  href: '/tools/reply-personalization',
  accentColor: 'violet',
},
```

- [ ] **Step 3: Добавить id инструмента в группу «Аутрич» в `TOOL_GROUPS`**

Найти запись `{ label: 'Аутрич', ... toolIds: [...] }` и добавить `'reply-personalization'` в её `toolIds`.

- [ ] **Step 4: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/toolsRegistry.ts
git commit -m "feat(reply-personalization): регистрация инструмента в навигации"
```

---

### Task 18: Клиентские fetch-хелперы

**Files:**
- Create: `app/src/components/reply-personalization/api.ts`

- [ ] **Step 1: Написать хелперы**

```ts
import { supabase } from '@/lib/supabaseClient';
import type { DraftStatus, ReplyListItem } from '@/lib/replyPersonalization/types';

const BASE = '/api/tools/reply-personalization';

async function fetchWithAuth<T>(path: string, options?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ProjectListItem {
  id: string;
  client: string;
  hasKnowledgeBase: boolean;
}

export function fetchProjects() {
  return fetchWithAuth<{ projects: ProjectListItem[] }>(`${BASE}/projects`);
}

export interface KnowledgeBaseDto {
  projectId: string;
  brief: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  instantlyAccountId: string;
  updatedAt: string;
}

export function fetchKnowledgeBase(projectId: string) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto | null }>(`${BASE}/projects/${projectId}/kb`);
}

export function saveKnowledgeBase(projectId: string, patch: Omit<KnowledgeBaseDto, 'projectId' | 'updatedAt'>) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto }>(`${BASE}/projects/${projectId}/kb`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function fetchReplies(projectId: string) {
  return fetchWithAuth<{ replies: ReplyListItem[]; needsKnowledgeBase: boolean }>(
    `${BASE}/projects/${projectId}/replies`,
  );
}

export interface GenerateResponse {
  draftId: string;
  text: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
}

export function generateReply(qualificationId: string, projectId: string) {
  return fetchWithAuth<GenerateResponse>(`${BASE}/replies/${qualificationId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export function sendReply(qualificationId: string, draftId: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/send`, {
    method: 'POST',
    body: JSON.stringify({ draftId }),
  });
}

export function skipReply(qualificationId: string, projectId: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/skip`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export type { DraftStatus };
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/components/reply-personalization/api.ts
git commit -m "feat(reply-personalization): клиентские fetch-хелперы"
```

---

### Task 19: Форма базы знаний проекта

**Files:**
- Create: `app/src/components/reply-personalization/KnowledgeBaseForm.tsx`

- [ ] **Step 1: Написать компонент**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { fetchKnowledgeBase, saveKnowledgeBase } from './api';

export function KnowledgeBaseForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [brief, setBrief] = useState('');
  const [productFacts, setProductFacts] = useState('');
  const [toneNotes, setToneNotes] = useState('');
  const [exampleCase, setExampleCase] = useState('');
  const [instantlyAccountId, setInstantlyAccountId] = useState('main');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchKnowledgeBase(projectId)
      .then(({ kb }) => {
        if (!kb) return;
        setBrief(kb.brief);
        setProductFacts(kb.productFacts);
        setToneNotes(kb.toneNotes);
        setExampleCase(kb.exampleCase);
        setInstantlyAccountId(kb.instantlyAccountId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveKnowledgeBase(projectId, { brief, productFacts, toneNotes, exampleCase, instantlyAccountId });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-zinc-500">Загрузка...</div>;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-900">База знаний проекта</h2>
        <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-700">
          Назад к письмам
        </button>
      </div>

      <label className="block text-sm font-medium text-zinc-700 mt-4">Бриф</label>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={4}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="О чём продукт, для кого, чем полезен"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Факты о продукте</label>
      <textarea
        value={productFacts}
        onChange={(e) => setProductFacts(e.target.value)}
        rows={5}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Возможности продукта и кейсы, которые можно упоминать в письмах"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Тон и ограничения</label>
      <textarea
        value={toneNotes}
        onChange={(e) => setToneNotes(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Как обращаться, чего избегать, стиль подписи"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Пример хорошего письма</label>
      <textarea
        value={exampleCase}
        onChange={(e) => setExampleCase(e.target.value)}
        rows={5}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Один реальный пример письма как ориентир по стилю"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Instantly-аккаунт проекта</label>
      <input
        value={instantlyAccountId}
        onChange={(e) => setInstantlyAccountId(e.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="main"
      />
      <p className="mt-1 text-xs text-zinc-500">
        Оставьте «main», если проект на основном Instantly-аккаунте. Для проекта на отдельном
        аккаунте (например Okdesk) — id из конфигурации INSTANTLY_ACCOUNTS_JSON.
      </p>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        {saved ? <span className="text-sm text-green-600">Сохранено</span> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/components/reply-personalization/KnowledgeBaseForm.tsx
git commit -m "feat(reply-personalization): форма базы знаний проекта"
```

---

### Task 20: Модалка подтверждения отправки

Файлы этого экрана пишутся снизу вверх по дереву импортов (сначала то, от чего зависят остальные), чтобы после КАЖДОЙ задачи `typecheck:strict` реально проходил, а не падал в ожидании следующего файла.

**Files:**
- Create: `app/src/components/reply-personalization/SendConfirmDialog.tsx`

- [ ] **Step 1: Написать компонент**

По образцу модалки подтверждения удаления из `app/src/components/ProjectList.tsx:3556-3606`.

```tsx
'use client';

import { useState } from 'react';
import { sendReply } from './api';

export function SendConfirmDialog({
  open,
  text,
  qualificationId,
  draftId,
  onCancel,
  onSent,
}: {
  open: boolean;
  text: string;
  qualificationId: string;
  draftId: string;
  onCancel: () => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleConfirm = async () => {
    setSending(true);
    setError(null);
    try {
      await sendReply(qualificationId, draftId);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить письмо');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => !sending && onCancel()} />
      <div className="relative mx-4 w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-center text-lg font-semibold text-zinc-900">Отправить этот ответ?</h3>
        <p className="mt-2 text-center text-sm text-zinc-500">
          Письмо уйдёт получателю через Instantly. Проверьте текст в последний раз:
        </p>
        <div className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">
          {text}
        </div>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={sending}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            {sending ? 'Отправка...' : 'Да, отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/components/reply-personalization/SendConfirmDialog.tsx
git commit -m "feat(reply-personalization): модалка подтверждения отправки"
```

---

### Task 21: Панель переписки, генерация, копирование, пропуск

**Files:**
- Create: `app/src/components/reply-personalization/ReplyDetailPanel.tsx`

- [ ] **Step 1: Написать компонент**

```tsx
'use client';

import { useState } from 'react';
import { generateReply, skipReply, type GenerateResponse } from './api';
import { SendConfirmDialog } from './SendConfirmDialog';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export function ReplyDetailPanel({
  projectId,
  item,
  onHandled,
}: {
  projectId: string;
  item: ReplyListItem;
  onHandled: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<GenerateResponse | null>(null);
  const [draftText, setDraftText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await generateReply(item.id, projectId);
      setDraft(result);
      setDraftText(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сгенерировать ответ');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(draftText).catch(() => {});
  };

  const handleSkip = async () => {
    setSkipping(true);
    try {
      await skipReply(item.id, projectId);
      onHandled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось пропустить письмо');
    } finally {
      setSkipping(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-2 text-xs text-zinc-500">
        Переписка · {item.companyName || item.leadEmail}
      </div>

      {item.lastOutboundPreview ? (
        <div className="mb-2 rounded-lg bg-zinc-50 p-3">
          <div className="mb-1 text-[11px] text-zinc-400">Мы отправили</div>
          <div className="text-sm text-zinc-600">{item.lastOutboundPreview}</div>
        </div>
      ) : null}

      <div className="mb-4 rounded-lg border border-zinc-200 p-3">
        <div className="mb-1 text-[11px] text-zinc-400">Ответили</div>
        <div className="text-sm text-zinc-900 whitespace-pre-wrap">{item.replyBody}</div>
      </div>

      {!draft ? (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {generating ? 'Генерирую...' : 'Сгенерировать ответ'}
        </button>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Черновик ответа</span>
            <button type="button" onClick={handleGenerate} disabled={generating} className="text-xs text-zinc-500 hover:text-zinc-700">
              {generating ? 'Генерирую...' : 'Сгенерировать заново'}
            </button>
          </div>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm"
          />
          {!draft.contextComplete ? (
            <p className="mt-1 text-xs text-amber-600">Контекст переписки неполный — проверьте текст перед отправкой.</p>
          ) : null}
          {draft.factsUsed ? (
            <p className="mt-2 text-xs text-zinc-400">Факты использованы: {draft.factsUsed}</p>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleSkip}
              disabled={skipping}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Пропустить
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Копировать
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
            >
              Отправить ответ
            </button>
          </div>
        </>
      )}

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {draft ? (
        <SendConfirmDialog
          open={confirmOpen}
          text={draftText}
          onCancel={() => setConfirmOpen(false)}
          onSent={() => {
            setConfirmOpen(false);
            onHandled();
          }}
          qualificationId={item.id}
          draftId={draft.draftId}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS (`SendConfirmDialog` уже создан в Task 20)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/reply-personalization/ReplyDetailPanel.tsx
git commit -m "feat(reply-personalization): панель переписки и генерации черновика"
```

---

### Task 22: Двухпанельный экран списка и переписки

**Files:**
- Create: `app/src/components/reply-personalization/ProjectInbox.tsx`

- [ ] **Step 1: Написать компонент**

Сплит-пейн по образцу `app/src/app/instantly/incoming-leads/page.tsx:1162-1220` (`grid-cols-[minmax(320px,2fr)_3fr]`).

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchReplies } from './api';
import { ReplyDetailPanel } from './ReplyDetailPanel';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

function formatDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function ProjectInbox({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ReplyListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsKb, setNeedsKb] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchReplies(projectId)
      .then((res) => {
        setItems(res.replies);
        setNeedsKb(res.needsKnowledgeBase);
        setSelectedId((current) => current ?? res.replies[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить письма'))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (needsKb) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        У проекта не заполнена база знаний — откройте «Настроить базу знаний».
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,2fr)_3fr]">
      <div className="flex flex-col border-r border-zinc-200 bg-white">
        <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
          {loading ? <div className="p-4 text-sm text-zinc-500">Загрузка...</div> : null}
          {error ? <div className="p-4 text-sm text-red-600">{error}</div> : null}
          {!loading && !items.length ? (
            <div className="p-4 text-sm text-zinc-500">Пока никто не ответил.</div>
          ) : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={`block w-full px-3 py-2.5 text-left ${
                selectedId === item.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-900">
                  {item.companyName || item.leadEmail}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    item.listStatus === 'sent' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                  }`}
                >
                  {item.listStatus === 'sent' ? 'отправлено' : 'новый'}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{item.replyBody}</div>
              <div className="mt-0.5 text-[11px] text-zinc-400">{formatDate(item.replyTimestamp)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto bg-white">
        {selected ? (
          <ReplyDetailPanel key={selected.id} projectId={projectId} item={selected} onHandled={load} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Выберите письмо из списка
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `cd app && npm run typecheck:strict`
Expected: PASS (`ReplyDetailPanel` уже создан в Task 21)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/reply-personalization/ProjectInbox.tsx
git commit -m "feat(reply-personalization): двухпанельный экран списка и переписки"
```

---

### Task 23: Список проектов и корневой компонент

**Files:**
- Create: `app/src/components/reply-personalization/ProjectPicker.tsx`
- Create: `app/src/components/reply-personalization/ReplyPersonalizationView.tsx`
- Create: `app/src/app/tools/reply-personalization/page.tsx`

- [ ] **Step 1: Написать `ProjectPicker.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { fetchProjects, type ProjectListItem } from './api';

export function ProjectPicker({ onSelect }: { onSelect: (project: ProjectListItem) => void }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then((res) => setProjects(res.projects))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить проекты'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6 text-sm text-zinc-500">Загрузка проектов...</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!projects.length) return <div className="p-6 text-sm text-zinc-500">Нет доступных проектов.</div>;

  return (
    <div className="max-w-xl mx-auto py-10">
      <h1 className="text-xl font-semibold text-zinc-900 mb-4">Персонализированные ответы — выберите проект</h1>
      <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-50"
          >
            <span className="text-sm font-medium text-zinc-900">{p.client}</span>
            {!p.hasKnowledgeBase ? (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                настройте базу знаний
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Написать `ReplyPersonalizationView.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { KnowledgeBaseForm } from './KnowledgeBaseForm';
import { ProjectInbox } from './ProjectInbox';
import { ProjectPicker } from './ProjectPicker';
import type { ProjectListItem } from './api';

type Mode = 'inbox' | 'settings';

export function ReplyPersonalizationView() {
  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [mode, setMode] = useState<Mode>('inbox');

  if (!project) {
    return (
      <ProjectPicker
        onSelect={(p) => {
          setProject(p);
          setMode(p.hasKnowledgeBase ? 'inbox' : 'settings');
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setProject(null)} className="text-sm text-zinc-500 hover:text-zinc-700">
            ← Все проекты
          </button>
          <span className="text-sm font-medium text-zinc-900">{project.client}</span>
        </div>
        <button
          type="button"
          onClick={() => setMode(mode === 'inbox' ? 'settings' : 'inbox')}
          className="text-sm text-zinc-500 hover:text-zinc-700"
        >
          {mode === 'inbox' ? 'Настроить базу знаний' : 'К письмам'}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {mode === 'settings' ? (
          <KnowledgeBaseForm projectId={project.id} onClose={() => setMode('inbox')} />
        ) : (
          <ProjectInbox projectId={project.id} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Написать `page.tsx`**

```tsx
import { ReplyPersonalizationView } from '@/components/reply-personalization/ReplyPersonalizationView';

export default function ReplyPersonalizationPage() {
  return (
    <div className="h-[calc(100vh-4rem)]">
      <ReplyPersonalizationView />
    </div>
  );
}
```

- [ ] **Step 4: Проверить типы всего модуля**

Run: `cd app && npm run typecheck:strict`
Expected: PASS (`ProjectInbox` уже создан в Task 22 — весь модуль теперь собирается целиком)

- [ ] **Step 5: Commit**

```bash
git add app/src/components/reply-personalization/ProjectPicker.tsx app/src/components/reply-personalization/ReplyPersonalizationView.tsx app/src/app/tools/reply-personalization/page.tsx
git commit -m "feat(reply-personalization): выбор проекта и корневой компонент"
```

---

### Task 24: Финальная проверка

**Files:** нет новых, только верификация всего модуля целиком.

- [ ] **Step 1: Полный typecheck**

Run: `cd app && npm run typecheck:strict`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `cd app && npm run lint`
Expected: PASS

- [ ] **Step 3: Существующие тесты-линтеры миграций и обязательных проверок сборки**

Run: `cd app && npx jest tests/migrations tests/lib/nextBuildTypecheckConfig.test.ts --silent`
Expected: PASS

- [ ] **Step 4: Production build**

Run: `cd app && NEXT_BUILD_SKIP_TYPECHECK=1 npm run build`
Expected: PASS (typecheck уже отработал отдельно в Step 1, как в `.semaphore/semaphore.yml:193-196`)

- [ ] **Step 5: Сообщить пользователю о необходимых переменных окружения**

Перед первым реальным запуском в проде нужно завести (в `.env` на 139, руками — см. `deploy-sync.sh`-подобный процесс, вне рамок этого плана):

- `OPENROUTER_REPLY_PERSONALIZATION_API_KEY` — ключ для вызовов Gemini (либо оставить пусто и полагаться на фолбэк `OPENROUTER_BRIEF_API_KEY`, если он уже настроен и это устраивает по бюджету);
- `REPLY_PERSONALIZATION_MODEL_ID` — точный id «Gemini 3.1 Pro» из Model Library Requesty (проверить на `app.requesty.ai/model-library`, обновить, если код по умолчанию `vertex/google/gemini-3-pro-preview` не совпадает с реальным);
- при подключении Okdesk — новую запись в `INSTANTLY_ACCOUNTS_JSON` (ключ, который даст Вова) и `instantly_account_id` в карточке знаний проекта Okdesk, равный её `id`.

- [ ] **Step 6: Финальный commit (если Step 1-4 что-то поправили)**

```bash
git add -A
git commit -m "fix(reply-personalization): правки по итогам финальной проверки"
```
