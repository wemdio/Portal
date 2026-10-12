# Ответы «N. Polza» → квалификация → сделка в AMO — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Новый ответ на нашу email-кампанию «N. Polza_…» оценивает ИИ; лид сам попадает в AMO (новой сделкой или примечанием к открытой) и сообщением в чат «Продажи Polza».

**Architecture:** Ответы уже лежат в `instantly_reply_inbox` (база Instantly). Новый проход в воркере `worker/senderLeads.ts` раз в минуту забирает свежие строки по курсору, оценивает их `qualifyReply`, лидов ставит в очередь `own_reply_crm_pushes` (основная база), которую разбирает общая очередь AMO `lib/crm/dealQueue.ts` (расширяется хуком «найти открытую сделку»), и после AMO шлёт сообщение в ТГ тем же ботом, что лиды «Рассылки». Настройки и история — блок на вкладке автоаутрича «Квалификация».

**Tech Stack:** Next.js 15 (app router), TypeScript, Supabase/PostgREST (основная база + база Instantly), amoCRM API v4, Telegram Bot API, esbuild-воркеры.

**Spec:** `docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md`

## Global Constraints

- Только кампании, для которых `isOwnAgencyCampaign(name)` (`/^\s*\d+\s*\.\s*polza/i`), только основной аккаунт Instantly (`instantly_account_id` пусто или `'main'`). Кампании клиентов — никогда.
- Только ответы с `reply_timestamp >= enabled_at`; историю не прогоняем.
- Новая сделка: воронка **7670334**, этап **63385358** («Новый лид»), ответственный **10539886** (Юлия Миронова), тег **«портал»**.
- Поля: Источник 1314379 = «Email Outreach»; Контур 1317011 = «Email-outreach»; Подысточник 1314381 = «аутрич» / «англ аутрич»; Ком-й 402805 = название кампании; Сайт 402799 = сайт или домен корпоративной почты; Оффер 402797 — не заполняем.
- Открытая сделка (статус не 142/143) по контакту с этой почтой или по домену компании → примечание в неё, новую не создаём, её этап/ответственного/поля не трогаем.
- Одна передача на человека: уникальность `lower(lead_email)` среди живых задач (`pending`, `sent`).
- Сообщение в чат — на каждого переданного лида, и для «создана», и для «добавлено к сделке». Бот и чат — `leadTelegramConfig()` (только `sendMessage`, без кнопок).
- Выключатель по умолчанию выключен.
- **Новых `*.test.ts` не пишем** (CLAUDE.md, «Правило: тесты пишем скупо»). Проверки — существующий CI ветки (в т.ч. `tests/migrations/grants.test.ts`) и холостой прогон на бою (Task 7). Тяжёлые проверки локально не гонять (typecheck и полный jest — работа CI).
- Одна кнопка «Сохранить» на вкладку: настройки блока «Instantly · X. Polza» сохраняются общей кнопкой карточки настроек.
- Подписи на экране — короткие, одной строкой.
- Коммиты — в `dmitriy_kuladmed_new`, только свои файлы (`git commit -- <пути>`): в дереве может работать параллельный агент.

## Review Focus

1. **Instantly занят (отказ лимита чтения писем)** — ответ не должен получить «не лид» без переписки и не должен тратить попытку: строка ждёт и повторяется (Task 4, `qualifyOne`, ветка `readInstantlyEmailReadDeferral` и `historyFetchFailed`).
2. **Пачка строк с одинаковым `created_at`** (одна страница сборщика вставляется одним запросом) — курсор по паре (`created_at`, `email_id`), иначе проход зациклится или пропустит строки (Task 4, `claimFromInbox`).
3. **Повтор после сбоя AMO на примечании** — не заводить вторую сделку; найденная открытая сделка тоже сохраняется в строку до примечания (Task 2, `pushOne`).
4. **Тот же человек ответил ещё раз / на другую кампанию** — вторая задача AMO не создаётся (уникальный индекс → 23505 → пометка в истории), сообщение в чат не дублируется (Task 1, Task 4).
5. **Бесплатная почта (gmail, mail.ru)** — по домену чужие сделки не искать и в «Сайт» его не писать (Task 3, `corporateDomain`).

Каждый пункт закрыт кодом в указанной задаче; тестов не добавляем — проверка в Task 7 (холостой прогон и первый живой лид).

---

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `supabase/migrations/20261011_0010_own_reply_leads.sql` | Создать: настройки, оценки, очередь AMO | 1 |
| `app/src/lib/crm/amoClient.ts` | Изменить: ответственный, текстовые поля, `findOpenLeadOfContact` | 2 |
| `app/src/lib/crm/dealQueue.ts` | Изменить: хук «найти открытую сделку», текстовые поля, ответственный, патчи строки | 2 |
| `app/src/lib/crm/connections.ts` | Изменить: константы полей и значений email-аутрича | 2 |
| `app/src/lib/ownReplyLeads/settings.ts` | Создать: константы AMO канала, чтение/сохранение настроек | 3 |
| `app/src/lib/ownReplyLeads/card.ts` | Создать: карточка-примечание, подысточник, домен, текст ТГ | 3 |
| `app/src/lib/ownReplyLeads/process.ts` | Создать: проход — забор из инбокса, оценка, очередь, AMO, ТГ | 4 |
| `app/worker/senderLeads.ts` | Изменить: второй проход | 5 |
| `app/worker/ownReplyLeadsDryRunCli.ts` | Создать: холостой прогон | 5 |
| `app/package.json`, `Dockerfile.worker` | Изменить: точка входа CLI | 5 |
| `app/src/lib/ownReplyLeads/history.ts` | Создать: DTO и выборка истории | 6 |
| `app/src/app/api/tools/own-reply-leads/route.ts` | Создать: GET истории | 6 |
| `app/src/app/api/tools/own-reply-leads/settings/route.ts` | Создать: GET/PUT настроек | 6 |
| `app/src/components/senderLeads/api.ts` | Изменить: клиентские вызовы | 6 |
| `app/src/components/senderLeads/OwnRepliesHistory.tsx` | Создать: история блока | 6 |
| `app/src/components/senderLeads/QualificationTab.tsx` | Изменить: раздел настроек в общей карточке + история | 6 |

---

### Task 1: Миграция основной базы

**Files:**
- Create: `supabase/migrations/20261011_0010_own_reply_leads.sql`

**Interfaces:**
- Produces: таблицы `own_reply_lead_settings` (одна строка `id = 1`), `own_reply_qualifications` (PK `email_id`), `own_reply_crm_pushes` (колонки общей очереди + канал). Имена колонок ниже используют Task 3–6.

- [ ] **Step 1: Написать миграцию**

```sql
-- Ответы наших email-кампаний «N. Polza_…» → квалификация → сделка в AMO
-- (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
--
-- Сами ответы лежат в базе Instantly (instantly_reply_inbox). Здесь — настройки
-- блока «Instantly · X. Polza», оценки ответов и очередь в нашу AMO, которую
-- разбирает общая очередь lib/crm/dealQueue.ts.

-- ── Настройки (одна строка) ──────────────────────────────────────────────────
create table if not exists public.own_reply_lead_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- Когда включили: ответы раньше этого момента не оцениваем.
  enabled_at timestamptz,
  -- null — общие правила квалификатора.
  lead_criteria text,
  -- Докуда прочитан instantly_reply_inbox: created_at (как строка из базы, с
  -- микросекундами) и email_id последней взятой строки.
  inbox_cursor_at text,
  inbox_cursor_id text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.own_reply_lead_settings (id) values (1) on conflict (id) do nothing;

alter table public.own_reply_lead_settings enable row level security;
grant all on public.own_reply_lead_settings to service_role;

-- ── Оценки ответов ───────────────────────────────────────────────────────────
create table if not exists public.own_reply_qualifications (
  email_id text primary key check (length(email_id) between 1 and 500),
  campaign_id text not null,
  campaign_name text not null default '',
  lead_email text not null,
  thread_id text,
  reply_subject text,
  reply_preview text,
  reply_timestamp timestamptz,
  -- pending — в работе или ждёт повтора; error — ИИ или Instantly не ответили за 5 попыток.
  status text not null default 'pending'
    check (status in ('pending', 'lead', 'not_lead', 'error', 'skipped')),
  ai_reason text,
  interest_signals text[] not null default '{}',
  criteria_used boolean not null default false,
  model text,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  qualified_at timestamptz,
  -- Лид, но в AMO не пошёл (этого человека уже передавали) — пояснение для истории.
  handoff_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_own_reply_qualifications_pending
  on public.own_reply_qualifications (next_attempt_at)
  where status = 'pending';
create index if not exists idx_own_reply_qualifications_created
  on public.own_reply_qualifications (created_at desc);

alter table public.own_reply_qualifications enable row level security;
grant all on public.own_reply_qualifications to service_role;

-- ── Очередь в AMO ────────────────────────────────────────────────────────────
-- Колонки очереди — те же, что у tg_outreach_crm_pushes (общая очередь
-- lib/crm/dealQueue.ts), плюс данные лида и доставка сообщения в ТГ.
create table if not exists public.own_reply_crm_pushes (
  id uuid primary key default gen_random_uuid(),
  qualification_id text not null references public.own_reply_qualifications(email_id) on delete cascade,
  connection text not null default 'polza',
  pipeline_id bigint,
  status_id bigint,
  lead_email text not null,
  lead_name text,
  company_name text,
  website text,
  campaign_name text not null default '',
  sub_source text not null default 'аутрич',
  message_text text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  -- created — новая сделка; note_added — переписка в уже открытую.
  action text check (action is null or action in ('created', 'note_added')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  amo_contact_id bigint,
  amo_lead_id bigint,
  amo_lead_name text,
  lead_url text,
  error_message text,
  sent_at timestamptz,
  tg_sent_at timestamptz,
  tg_message_id bigint,
  tg_attempts int not null default 0,
  tg_error text,
  created_at timestamptz not null default now()
);

-- Один человек — одна передача. Упавшая задача повтор не блокирует.
create unique index if not exists own_reply_crm_pushes_one_per_email_idx
  on public.own_reply_crm_pushes (lower(lead_email))
  where status in ('pending', 'sent');
create index if not exists idx_own_reply_crm_pushes_pending
  on public.own_reply_crm_pushes (next_attempt_at)
  where status = 'pending';
create index if not exists idx_own_reply_crm_pushes_tg_due
  on public.own_reply_crm_pushes (next_attempt_at)
  where status = 'sent' and tg_sent_at is null;
create index if not exists idx_own_reply_crm_pushes_qualification
  on public.own_reply_crm_pushes (qualification_id);

alter table public.own_reply_crm_pushes enable row level security;
grant all on public.own_reply_crm_pushes to service_role;
```

- [ ] **Step 2: Сверить с правилами миграций**

Открыть `app/tests/migrations/grants.test.ts` и `app/tests/migrations/noTransactionMigrations.test.ts`, убедиться, что файл им удовлетворяет: у каждой таблицы есть `grant … to service_role`; файл не помечен `no-transaction`. Тесты не запускать локально — CI ветки выберет их сам (читают файлы репозитория).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261011_0010_own_reply_leads.sql
git commit -m "feat(own-reply-leads): таблицы настроек, оценок и очереди AMO для ответов «N. Polza»" -- supabase/migrations/20261011_0010_own_reply_leads.sql
```

---

### Task 2: AMO-клиент и общая очередь — открытая сделка, ответственный, текстовые поля

**Files:**
- Modify: `app/src/lib/crm/amoClient.ts` (интерфейс `AmoClient` ~L150, `createLead` ~L321, после `findLeadFieldEnumId` ~L343)
- Modify: `app/src/lib/crm/dealQueue.ts` (`CrmDealSpec` ~L67, `pushOne` ~L115–176, шапка L11–15)
- Modify: `app/src/lib/crm/connections.ts` (после L23)

**Interfaces:**
- Produces:
  - `AmoClient.findOpenLeadOfContact(contactId: number): Promise<{ id: number; name: string } | null>`
  - `AmoClient.createLead(input)` принимает `responsibleUserId?: number | null` и `customFields?: AmoLeadCustomField[]`
  - `export type AmoLeadCustomField = { field_id: number; values: Array<{ enum_id: number } | { value: string }> }`
  - `CrmDealSpec` получает необязательные `responsibleUserId`, `polzaTexts`, `findExistingLead`, `existingLeadPatch`, `createdLeadPatch`
  - Константы `POLZA_SOURCE_EMAIL_OUTREACH = 'Email Outreach'`, `POLZA_CONTOUR_EMAIL_OUTREACH = 'Email-outreach'`, `POLZA_SUBSOURCE_FIELD_ID = 1314381`, `POLZA_CAMPAIGN_FIELD_ID = 402805`, `POLZA_SITE_FIELD_ID = 402799`
- TG-аутрич новые поля не задаёт — его поведение не меняется.

- [ ] **Step 1: Константы в `connections.ts`** — после `POLZA_CONTOUR_TG_OUTREACH`:

```ts
/**
 * Email-аутрич наших кампаний «N. Polza_…» (с 11.10.2026): значения и
 * текстовые поля — как в ручных сделках менеджеров (сверено по amo_leads).
 */
export const POLZA_SOURCE_EMAIL_OUTREACH = 'Email Outreach';
export const POLZA_CONTOUR_EMAIL_OUTREACH = 'Email-outreach';
/** «Подысточник» (текст): «аутрич» / «англ аутрич». */
export const POLZA_SUBSOURCE_FIELD_ID = 1314381;
/** «Ком-й» (текст): менеджеры писали туда название кампании. */
export const POLZA_CAMPAIGN_FIELD_ID = 402805;
/** «Сайт» (текст). */
export const POLZA_SITE_FIELD_ID = 402799;
```

- [ ] **Step 2: Тип поля и `createLead` в `amoClient.ts`**

Над `export interface AmoClient` добавить:

```ts
/** Значение поля сделки: списочное — по enum_id, текстовое — по value. */
export type AmoLeadCustomField = { field_id: number; values: Array<{ enum_id: number } | { value: string }> };
```

В интерфейсе заменить сигнатуру `createLead` и добавить метод:

```ts
  createLead(input: {
    name: string;
    pipelineId: number | null;
    statusId: number | null;
    contactId: number;
    tags: string[];
    customFields?: AmoLeadCustomField[];
    /** Не задан — ответственным станет владелец токена. */
    responsibleUserId?: number | null;
  }): Promise<number>;
  addLeadNote(leadId: number, text: string): Promise<void>;
  /** id варианта в списочном поле сделки по его тексту, без учёта регистра. */
  findLeadFieldEnumId(fieldId: number, value: string): Promise<number | null>;
  /** Последняя по обновлению открытая (не 142/143) сделка контакта; null — открытых нет. */
  findOpenLeadOfContact(contactId: number): Promise<{ id: number; name: string } | null>;
```

В реализации `createLead` после строки `if (input.statusId) lead.status_id = input.statusId;`:

```ts
      if (input.responsibleUserId) lead.responsible_user_id = input.responsibleUserId;
```

После реализации `findLeadFieldEnumId` добавить:

```ts
    async findOpenLeadOfContact(contactId) {
      type ContactRaw = { _embedded?: { leads?: Array<{ id: number }> } };
      const contact = await call<ContactRaw>('GET', `/api/v4/contacts/${contactId}?with=leads`);
      const ids = (contact?._embedded?.leads ?? []).map((l) => l.id).slice(0, 50);
      if (!ids.length) return null;
      type LeadsRaw = { _embedded?: { leads?: Array<{ id: number; name?: string | null; status_id?: number; updated_at?: number }> } };
      const filter = ids.map((id) => `filter[id][]=${id}`).join('&');
      const data = await call<LeadsRaw>('GET', `/api/v4/leads?limit=50&${filter}`);
      const open = (data?._embedded?.leads ?? [])
        .filter((l) => !SYSTEM_STATUS_IDS.has(l.status_id ?? 0))
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
      const hit = open[0];
      return hit ? { id: hit.id, name: (hit.name ?? '').trim() || `Сделка #${hit.id}` } : null;
    },
```

- [ ] **Step 3: `CrmDealSpec` в `dealQueue.ts`**

Импорт: добавить `type AmoLeadCustomField` в импорт из `./amoClient`. В `CrmDealSpec` после `polzaSelects` добавить:

```ts
  /** Текстовые поля сделки — только в нашей AMO; пустые значения пропускаются. */
  polzaTexts?: Array<{ fieldId: number; value: string }>;
  /** Ответственный в AMO; не задан — владелец токена (как у TG-аутрича). */
  responsibleUserId?: number | null;
  /**
   * Открытая сделка, куда положить переписку вместо новой (email-аутрич
   * «N. Polza»: дубли не заводим). Нет хука — сделка создаётся всегда.
   */
  findExistingLead?: (client: AmoClient) => Promise<{ id: number; name: string } | null>;
  /** Доп. колонки строки канала, когда переписка ушла в найденную сделку. */
  existingLeadPatch?: (lead: { id: number; name: string }) => Record<string, unknown>;
  /** Доп. колонки строки канала, когда создана новая сделка. */
  createdLeadPatch?: Record<string, unknown>;
```

- [ ] **Step 4: `pushOne`** — заменить блок от `let leadId = task.amo_lead_id;` до сохранения `lead_url` включительно:

```ts
    let leadId = task.amo_lead_id;
    let existing: { id: number; name: string } | null = null;

    // Сначала — открытая сделка этого человека: id пишем сразу, повтор после
    // сбоя на примечании пойдёт в неё же, а не заведёт новую.
    if (!leadId && spec.findExistingLead) {
      existing = await spec.findExistingLead(client);
      if (existing) {
        leadId = existing.id;
        await db
          .from(table)
          .update({
            amo_lead_id: leadId,
            lead_url: `${client.baseUrl}/leads/detail/${leadId}`,
            ...(spec.existingLeadPatch?.(existing) ?? {}),
          })
          .eq('id', task.id);
      }
    }

    if (!leadId) {
      if (!contactId) {
        const { name, telegram, email, phone } = spec.contact;
        contactId = (await client.findContact({ name, telegram, email }))
          ?? (await client.createContact({
            name,
            telegram,
            telegramField: telegram ? await telegramContactField(client) : null,
            email,
            phone,
          }));
        await db.from(table).update({ amo_contact_id: contactId }).eq('id', task.id);
      }

      const customFields: AmoLeadCustomField[] = [];
      if (isPolza) {
        const missing: string[] = [];
        for (const select of spec.polzaSelects) {
          const enumId = await leadSelectEnumId(client, select.fieldId, select.value).catch(() => null);
          if (enumId) customFields.push({ field_id: select.fieldId, values: [{ enum_id: enumId }] });
          else missing.push(`«${select.fieldName}» = «${select.value}»`);
        }
        for (const text of spec.polzaTexts ?? []) {
          const value = text.value.trim().slice(0, 255);
          if (value) customFields.push({ field_id: text.fieldId, values: [{ value }] });
        }
        // Сделку всё равно заводим: лид важнее пометки, её доставят руками.
        if (missing.length) warning = `в AMO не найдено ${missing.join(', ')} — проставьте руками`;
      }

      leadId = await client.createLead({
        name: spec.leadName,
        pipelineId: task.pipeline_id,
        statusId: task.status_id,
        contactId,
        tags: spec.tags.map((t) => t.slice(0, 100)).filter(Boolean),
        customFields,
        responsibleUserId: spec.responsibleUserId ?? null,
      });
      await db
        .from(table)
        .update({
          amo_lead_id: leadId,
          lead_url: `${client.baseUrl}/leads/detail/${leadId}`,
          ...(spec.createdLeadPatch ?? {}),
        })
        .eq('id', task.id);
    }
```

И строку журнала успеха заменить на:

```ts
    log('info', `CRM: ${existing ? `переписка добавлена в сделку ${leadId}` : `сделка ${leadId} создана`} — ${spec.label}${warning ? ` — ${warning}` : ''}`);
```

Шапку модуля (строки про f5781ca22 и «вернуть — взять из этого коммита…») заменить на:

```ts
 * Email-аутрич наших кампаний «N. Polza_…» — с 11.10.2026 своя очередь
 * own_reply_crm_pushes (lib/ownReplyLeads/process.ts): открытая сделка
 * человека получает примечание, новая не заводится. По кампаниям клиентов —
 * никогда (условие пользователя 06.10.2026).
```

- [ ] **Step 5: Проверить, что больше никто не реализует `AmoClient`**

Run: `git grep -n "AmoClient = {\|: AmoClient = \|implements AmoClient" -- app/src app/tests app/worker`
Expected: пусто (единственная реализация — `createAmoClient`). Если найдётся мок — добавить в него `findOpenLeadOfContact: async () => null`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(crm): открытая сделка вместо дубля, ответственный и текстовые поля в общей очереди AMO" -- app/src/lib/crm/amoClient.ts app/src/lib/crm/dealQueue.ts app/src/lib/crm/connections.ts
```

---

### Task 3: Настройки и сборка карточки канала

**Files:**
- Create: `app/src/lib/ownReplyLeads/settings.ts`
- Create: `app/src/lib/ownReplyLeads/card.ts`

**Interfaces:**
- Consumes: `LEAD_CRITERIA_MAX`, `DEFAULT_LEAD_CRITERIA`, `isDefaultLeadCriteria` (`lib/senderLeads/settings.ts`); `isFreeProvider` (`lib/emailValidation/shared.ts`); `stripQuoted` (`lib/senderLeads/telegram.ts`); `getBodyText`, `extractAuthoredReplyText`, `ThreadContext` (`lib/instantly/leadQualifier.ts`).
- Produces:
  - `settings.ts`: `OWN_REPLY_PIPELINE_ID = 7670334`, `OWN_REPLY_STATUS_ID = 63385358`, `OWN_REPLY_RESPONSIBLE_USER_ID = 10539886`, `OWN_REPLY_TAG = 'портал'`; `interface OwnReplySettings { enabled: boolean; enabledAt: string | null; criteria: string | null; cursorAt: string | null; cursorId: string | null }`; `loadOwnReplySettings(db): Promise<OwnReplySettings>`; `saveInboxCursor(db, at: string, id: string): Promise<void>`; `interface OwnReplySettingsDto { enabled: boolean; enabledAt: string | null; criteria: string }`; `ownReplySettingsDto(s: OwnReplySettings): OwnReplySettingsDto`; `parseOwnReplySettingsInput(body: unknown): { ok: true; value: { enabled: boolean; criteria: string | null } } | { ok: false; error: string }`; `ownReplySettingsPatch(prev: OwnReplySettings, input: { enabled: boolean; criteria: string | null }, nowIso: string, userId: string | null): Record<string, unknown>`.
  - `card.ts`: `interface CardMessage { role: 'us' | 'lead'; text: string; timestamp: string | null }`; `messagesFromContext(ctx: ThreadContext): CardMessage[]`; `buildOwnReplyCard(input): string`; `subSourceOf(messages: CardMessage[], replyPreview: string | null): 'аутрич' | 'англ аутрич'`; `emailDomain(email: string | null | undefined): string | null`; `corporateDomain(email: string): string | null`; `siteHost(url: string | null | undefined): string | null`; `buildOwnReplyTgMessage(input: OwnReplyTgInput): string`.

- [ ] **Step 1: `settings.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_LEAD_CRITERIA, LEAD_CRITERIA_MAX, isDefaultLeadCriteria } from '@/lib/senderLeads/settings';

/**
 * Блок «Instantly · X. Polza» вкладки «Квалификация»: ответы наших кампаний
 * «N. Polza_…» → оценка ИИ → сделка в нашей AMO
 * (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
 *
 * Куда и кому ставить сделку — решение пользователя 11.10.2026, по id
 * (правило «этапы AMO только по id»): удалят этап и создадут заново — id новый.
 */
export const OWN_REPLY_PIPELINE_ID = 7670334; // «Воронка - новые лиды»
export const OWN_REPLY_STATUS_ID = 63385358; // «Новый лид»
export const OWN_REPLY_RESPONSIBLE_USER_ID = 10539886; // Юлия Миронова
export const OWN_REPLY_TAG = 'портал';

export interface OwnReplySettings {
  enabled: boolean;
  enabledAt: string | null;
  criteria: string | null;
  cursorAt: string | null;
  cursorId: string | null;
}

interface SettingsRow {
  enabled: boolean;
  enabled_at: string | null;
  lead_criteria: string | null;
  inbox_cursor_at: string | null;
  inbox_cursor_id: string | null;
}

const COLUMNS = 'enabled, enabled_at, lead_criteria, inbox_cursor_at, inbox_cursor_id';

export async function loadOwnReplySettings(db: Pick<SupabaseClient, 'from'>): Promise<OwnReplySettings> {
  const { data, error } = await db.from('own_reply_lead_settings').select(COLUMNS).eq('id', 1).maybeSingle();
  if (error) throw new Error(`own_reply_lead_settings: ${error.message}`);
  const row = data as SettingsRow | null;
  const criteria = row?.lead_criteria?.trim() ?? '';
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabled_at ?? null,
    criteria: criteria ? criteria.slice(0, LEAD_CRITERIA_MAX) : null,
    cursorAt: row?.inbox_cursor_at ?? null,
    cursorId: row?.inbox_cursor_id ?? null,
  };
}

export async function saveInboxCursor(db: Pick<SupabaseClient, 'from'>, at: string, id: string): Promise<void> {
  const { error } = await db
    .from('own_reply_lead_settings')
    .update({ inbox_cursor_at: at, inbox_cursor_id: id })
    .eq('id', 1);
  if (error) throw new Error(`own_reply_lead_settings cursor: ${error.message}`);
}

export interface OwnReplySettingsDto {
  enabled: boolean;
  enabledAt: string | null;
  criteria: string;
}

export function ownReplySettingsDto(s: OwnReplySettings): OwnReplySettingsDto {
  // Своего правила нет — показываем пересказ общих правил, как у папок «Рассылки».
  return { enabled: s.enabled, enabledAt: s.enabledAt, criteria: s.criteria ?? DEFAULT_LEAD_CRITERIA };
}

export function parseOwnReplySettingsInput(body: unknown):
  | { ok: true; value: { enabled: boolean; criteria: string | null } }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Невалидный JSON' };
  const { enabled, criteria } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled — да/нет' };
  if (criteria != null && typeof criteria !== 'string') return { ok: false, error: 'criteria — текст' };
  const text = (criteria ?? '').trim();
  if (text.length > LEAD_CRITERIA_MAX) return { ok: false, error: `Правило длиннее ${LEAD_CRITERIA_MAX} символов` };
  return { ok: true, value: { enabled, criteria: !text || isDefaultLeadCriteria(text) ? null : text } };
}

/**
 * Что записать при сохранении. Включение после выключения ставит новую точку
 * отсчёта: ответы, пришедшие пока блок был выключен, не оцениваются.
 */
export function ownReplySettingsPatch(
  prev: OwnReplySettings,
  input: { enabled: boolean; criteria: string | null },
  nowIso: string,
  userId: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    enabled: input.enabled,
    lead_criteria: input.criteria,
    updated_at: nowIso,
    updated_by: userId,
  };
  if (input.enabled && !prev.enabled) {
    patch.enabled_at = nowIso;
    patch.inbox_cursor_at = nowIso;
    patch.inbox_cursor_id = '';
  }
  return patch;
}
```

- [ ] **Step 2: `card.ts`**

```ts
import { extractAuthoredReplyText, getBodyText, type ThreadContext } from '@/lib/instantly/leadQualifier';
import { isFreeProvider } from '@/lib/emailValidation/shared';
import { stripQuoted } from '@/lib/senderLeads/telegram';

/**
 * Карточка лида «N. Polza» для примечания в AMO и сообщение в ТГ.
 * Вид примечания — как у TG-аутрича: шапка, контакты, переписка (МСК).
 */

export interface CardMessage {
  role: 'us' | 'lead';
  text: string;
  timestamp: string | null;
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 3000;
const REPLY_PREVIEW_MAX = 1200;
const REASON_MAX = 600;

/** Письма ветки по порядку: ue_type 2 — ответ лида, остальное — наши. */
export function messagesFromContext(ctx: ThreadContext): CardMessage[] {
  const emails = [...ctx.threadEmails];
  if (!emails.some((e) => e.id === ctx.replyEmail.id)) emails.push(ctx.replyEmail);
  return emails
    .map((e) => ({
      role: (e.ue_type ?? 2) === 2 ? ('lead' as const) : ('us' as const),
      text: extractAuthoredReplyText(getBodyText(e.body)).trim(),
      timestamp: e.timestamp_email ?? e.timestamp_created ?? null,
    }))
    .filter((m) => m.text)
    .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
}

function fmtStamp(value: string | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}] `;
}

export function buildOwnReplyCard(input: {
  campaignName: string;
  leadEmail: string;
  leadName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  website?: string | null;
  messages: CardMessage[];
}): string {
  const lines = [`Лид email-аутрича · ${input.campaignName || 'N. Polza'}`, '', `Почта: ${input.leadEmail}`];
  if (input.leadName) lines.push(`Имя: ${input.leadName}`);
  if (input.companyName) lines.push(`Компания: ${input.companyName}`);
  if (input.website) lines.push(`Сайт: ${input.website}`);
  if (input.phone) lines.push(`Телефон: ${input.phone}`);
  const messages = input.messages.slice(-MAX_MESSAGES);
  if (messages.length) {
    lines.push('', '── Переписка ──');
    for (const m of messages) {
      const clipped = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
      lines.push(`${fmtStamp(m.timestamp)}${m.role === 'us' ? 'Мы' : 'Клиент'}: ${clipped}`);
    }
  }
  return lines.join('\n');
}

const CYRILLIC = /[а-яё]/i;

/** «аутрич» — если наши письма по-русски; иначе «англ аутрич» (как пишут менеджеры). */
export function subSourceOf(messages: CardMessage[], replyPreview: string | null): 'аутрич' | 'англ аутрич' {
  const ours = messages.filter((m) => m.role === 'us').map((m) => m.text).join('\n');
  const sample = ours || replyPreview || '';
  return CYRILLIC.test(sample) ? 'аутрич' : 'англ аутрич';
}

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return null;
  const domain = (email ?? '').trim().toLowerCase().slice(at + 1);
  return domain.includes('.') ? domain : null;
}

/** Домен почты, если она не на бесплатном сервисе (gmail, mail.ru…); иначе null. */
export function corporateDomain(email: string): string | null {
  const domain = emailDomain(email);
  return domain && !isFreeProvider(domain) ? domain : null;
}

/** «https://www.Acme.ru/about» → «acme.ru». */
export function siteHost(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return host.includes('.') ? host : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface OwnReplyTgInput {
  action: 'created' | 'note_added';
  campaignName: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  replySubject: string | null;
  replyBody: string | null;
  aiReason: string | null;
  leadUrl: string | null;
  amoLeadName: string | null;
}

export function buildOwnReplyTgMessage(input: OwnReplyTgInput): string {
  const lines: string[] = input.action === 'created'
    ? ['🟢 <b>Новый лид с email-аутрича</b>', '']
    : [`🔁 <b>Переписка добавлена к сделке</b>${input.amoLeadName ? ` «${escapeHtml(clip(input.amoLeadName, 200))}»` : ''}`, ''];
  lines.push(`<b>Кампания:</b> ${escapeHtml(clip(input.campaignName, 200))}`);
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(input.leadName ? `${input.leadName} · ${input.leadEmail}` : input.leadEmail, 320))}`);
  if (input.companyName) lines.push(`<b>Компания:</b> ${escapeHtml(clip(input.companyName, 200))}`);
  if (input.action === 'note_added') lines.push('С этой почтой или компанией сделка уже была — дубль не создан.');
  if (input.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(clip(input.replySubject, 300))}`);
  const body = (input.replyBody ?? '').trim();
  const reply = stripQuoted(body) || body;
  if (reply) lines.push('', '<b>Ответ:</b>', `<pre>${escapeHtml(clip(reply, REPLY_PREVIEW_MAX))}</pre>`);
  if (input.aiReason) lines.push('', `<b>ИИ:</b> ${escapeHtml(clip(input.aiReason, REASON_MAX))}`);
  if (input.leadUrl) lines.push('', `🔗 <a href="${escapeHtml(input.leadUrl)}">Сделка в AMO</a>`);
  return lines.join('\n');
}
```

- [ ] **Step 3: Проверить импорты на «тяжесть»**

Run: `git grep -n "^import" -- app/src/lib/emailValidation/shared.ts app/src/lib/senderLeads/telegram.ts`
Expected: нет `server-only` и нет модулей Next (модуль собирается и в воркер, и в API-роуты). Если `shared.ts` тянет `server-only` — скопировать проверку `isFreeProvider` нельзя (DRY): вместо этого вынести набор `FREE_PROVIDERS` в отдельный файл без зависимостей и импортировать оттуда в обоих местах.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/ownReplyLeads/settings.ts app/src/lib/ownReplyLeads/card.ts
git commit -m "feat(own-reply-leads): настройки блока и карточка лида для AMO и чата" -- app/src/lib/ownReplyLeads/settings.ts app/src/lib/ownReplyLeads/card.ts
```

---

### Task 4: Проход — инбокс → оценка → очередь AMO → чат

**Files:**
- Create: `app/src/lib/ownReplyLeads/process.ts`

**Interfaces:**
- Consumes: Task 1 (таблицы), Task 2 (`processCrmQueue`, `CRM_QUEUE_COLUMNS`, `CrmDealSpec`, константы полей), Task 3 (всё из `settings.ts`, `card.ts`); `fetchThreadContext`, `qualifyReply` (`lib/instantly/leadQualifier.ts`); `readInstantlyEmailReadDeferral`; `isOwnAgencyCampaign`; `getLeadsByEmail` (`lib/instantly/client.ts`); `senderLeadsAi`, `type Log` (`lib/senderLeads/process.ts`); `leadTelegramConfig`, `sendLeadMessage`, `type LeadTelegramConfig`.
- Produces:
  - `runOwnReplyLeadsPass(db: SupabaseClient, instantlyDb: SupabaseClient | null, log: Log): Promise<OwnReplyPassResult>`
  - `interface OwnReplyPassResult { claimed: number; qualified: number; leads: number; pushed: number; delivered: number }`
  - `dryRunOwnReplies(instantlyDb: SupabaseClient, settingsCriteria: string | null, limit: number, log: Log): Promise<DryRunRow[]>`; `interface DryRunRow { campaign: string; email: string; reply: string; verdict: 'lead' | 'not_lead' | 'error'; reason: string }`

- [ ] **Step 1: Написать модуль**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { getLeadsByEmail } from '@/lib/instantly/client';
import { readInstantlyEmailReadDeferral } from '@/lib/instantly/emailReadDeferral';
import { fetchThreadContext, qualifyReply, type ThreadContext } from '@/lib/instantly/leadQualifier';
import { isOwnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';
import {
  POLZA_CAMPAIGN_FIELD_ID,
  POLZA_CONNECTION,
  POLZA_CONTOUR_EMAIL_OUTREACH,
  POLZA_CONTOUR_FIELD_ID,
  POLZA_SITE_FIELD_ID,
  POLZA_SOURCE_EMAIL_OUTREACH,
  POLZA_SOURCE_FIELD_ID,
  POLZA_SUBSOURCE_FIELD_ID,
} from '@/lib/crm/connections';
import type { AmoClient } from '@/lib/crm/amoClient';
import { processCrmQueue, type CrmDealSpec, type CrmQueueRow } from '@/lib/crm/dealQueue';
import { senderLeadsAi, type Log, type SenderLeadsAi } from '@/lib/senderLeads/process';
import { leadTelegramConfig, sendLeadMessage, type LeadTelegramConfig } from '@/lib/senderLeads/telegram';
import {
  buildOwnReplyCard,
  buildOwnReplyTgMessage,
  corporateDomain,
  emailDomain,
  messagesFromContext,
  siteHost,
  subSourceOf,
} from './card';
import {
  OWN_REPLY_PIPELINE_ID,
  OWN_REPLY_RESPONSIBLE_USER_ID,
  OWN_REPLY_STATUS_ID,
  OWN_REPLY_TAG,
  loadOwnReplySettings,
  saveInboxCursor,
  type OwnReplySettings,
} from './settings';

/**
 * Ответы наших email-кампаний «N. Polza_…» → оценка ИИ → сделка в нашей AMO
 * → сообщение в «Продажи Polza» (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
 *
 * 1. Новые строки instantly_reply_inbox (база Instantly) наших кампаний —
 *    по курсору (created_at, email_id), только с ответом после включения.
 * 2. Переписку читаем из Instantly сами: отказ общего лимита — не повод
 *    оценивать ответ без нашего письма, строка ждёт без счёта попытки.
 * 3. Лид → задача own_reply_crm_pushes; одна на человека (уникальный индекс).
 * 4. Общая очередь AMO: открытая сделка человека → примечание, иначе новая.
 * 5. После AMO — сообщение в ТГ; сбой ТГ не трогает AMO.
 */

const CLAIM_BATCH = 200;
const QUALIFY_BATCH = 10;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MIN = [1, 5, 15, 60];
const DEFERRAL_DELAY_MS = 2 * 60_000;
const TG_BATCH = 20;
const CONSUMER = 'own_reply_leads';

export interface OwnReplyPassResult {
  claimed: number;
  qualified: number;
  leads: number;
  pushed: number;
  delivered: number;
}

interface InboxRow {
  email_id: string;
  campaign_id: string;
  thread_id: string | null;
  lead_email: string;
  subject: string | null;
  body_preview: string | null;
  reply_timestamp: string | null;
  created_at: string;
}

interface QualRow {
  email_id: string;
  campaign_id: string;
  campaign_name: string;
  lead_email: string;
  thread_id: string | null;
  reply_preview: string | null;
  attempts: number;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

function retryAt(attempts: number): string {
  const minutes = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Значение для or-фильтра PostgREST: в кавычках, иначе «:», «+», «.» ломают разбор. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Наши кампании основного аккаунта: id → название. */
async function ownCampaigns(instantlyDb: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await instantlyDb
    .from('instantly_campaign_catalog')
    .select('id, name, instantly_account_id')
    .ilike('name', '%polza%');
  if (error) throw new Error(`instantly_campaign_catalog: ${error.message}`);
  const out = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; name: string | null; instantly_account_id: string | null }[]) {
    if ((row.instantly_account_id || 'main') === 'main' && isOwnAgencyCampaign(row.name)) out.set(row.id, row.name ?? '');
  }
  return out;
}

/** Новые ответы из инбокса → строки оценки (pending). Курсор двигается всегда. */
async function claimFromInbox(db: SupabaseClient, instantlyDb: SupabaseClient, settings: OwnReplySettings): Promise<number> {
  if (!settings.enabledAt || !settings.cursorAt) return 0;
  const campaigns = await ownCampaigns(instantlyDb);
  if (!campaigns.size) return 0;

  // Пара (created_at, email_id): одна страница сборщика вставляется одним
  // запросом и получает одинаковый created_at — по одной дате курсор бы стоял.
  const { data, error } = await instantlyDb
    .from('instantly_reply_inbox')
    .select('email_id, campaign_id, thread_id, lead_email, subject, body_preview, reply_timestamp, created_at')
    .in('campaign_id', [...campaigns.keys()])
    .or(`created_at.gt.${quoted(settings.cursorAt)},and(created_at.eq.${quoted(settings.cursorAt)},email_id.gt.${quoted(settings.cursorId ?? '')})`)
    .order('created_at', { ascending: true })
    .order('email_id', { ascending: true })
    .limit(CLAIM_BATCH);
  if (error) throw new Error(`instantly_reply_inbox: ${error.message}`);
  const rows = (data ?? []) as InboxRow[];
  if (!rows.length) return 0;

  const enabledMs = Date.parse(settings.enabledAt);
  // Догрузка истории пишет старые ответы свежими строками — фильтр по времени ответа.
  const fresh = rows.filter((r) => r.reply_timestamp && Date.parse(r.reply_timestamp) >= enabledMs);
  if (fresh.length) {
    const nowIso = new Date().toISOString();
    const { error: insertError } = await db.from('own_reply_qualifications').upsert(
      fresh.map((r) => ({
        email_id: r.email_id,
        campaign_id: r.campaign_id,
        campaign_name: campaigns.get(r.campaign_id) ?? '',
        lead_email: r.lead_email.trim().toLowerCase(),
        thread_id: r.thread_id,
        reply_subject: r.subject,
        reply_preview: r.body_preview,
        reply_timestamp: r.reply_timestamp,
        status: 'pending',
        next_attempt_at: nowIso,
      })),
      { onConflict: 'email_id', ignoreDuplicates: true },
    );
    if (insertError) throw new Error(`own_reply_qualifications insert: ${insertError.message}`);
  }
  const last = rows[rows.length - 1];
  await saveInboxCursor(db, last.created_at, last.email_id);
  return fresh.length;
}

async function dueQualifications(db: SupabaseClient): Promise<QualRow[]> {
  const { data, error } = await db
    .from('own_reply_qualifications')
    .select('email_id, campaign_id, campaign_name, lead_email, thread_id, reply_preview, attempts')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at')
    .limit(QUALIFY_BATCH);
  if (error) throw new Error(`own_reply_qualifications due: ${error.message}`);
  return (data ?? []) as QualRow[];
}

async function markQual(db: SupabaseClient, emailId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('own_reply_qualifications')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('email_id', emailId);
  if (error) throw new Error(`own_reply_qualifications update: ${error.message}`);
}

async function failAttempt(db: SupabaseClient, row: QualRow, attempts: number, message: string, log: Log): Promise<void> {
  const final = attempts >= MAX_ATTEMPTS;
  log(final ? 'error' : 'warn', `X. Polza: ответ ${row.email_id} не оценён (попытка ${attempts}): ${message}`);
  await markQual(db, row.email_id, {
    status: final ? 'error' : 'pending',
    attempts,
    next_attempt_at: final ? new Date().toISOString() : retryAt(attempts),
    last_error: message,
  });
}

/** Переписка ответа; null — Instantly занят (строка уже отложена). */
async function loadContext(db: SupabaseClient, row: QualRow): Promise<ThreadContext | 'deferred' | null> {
  try {
    return await fetchThreadContext(row.campaign_id, row.lead_email, row.thread_id, 'main', {
      consumer: CONSUMER,
      requestPriority: 'bulk',
    });
  } catch (err) {
    if (!readInstantlyEmailReadDeferral(err)) throw err;
    await markQual(db, row.email_id, {
      next_attempt_at: new Date(Date.now() + DEFERRAL_DELAY_MS).toISOString(),
      last_error: 'Instantly занят — повторю',
    });
    return 'deferred';
  }
}

/** Данные лида из Instantly; не нашлось или ошибка — пусто, лид важнее. */
async function instantlyLead(row: QualRow) {
  try {
    const items = await getLeadsByEmail(
      { email: row.lead_email, campaign_id: row.campaign_id },
      { accountId: 'main', consumer: CONSUMER, requestPriority: 'bulk' },
    );
    return items.find((l) => (l.email ?? '').trim().toLowerCase() === row.lead_email) ?? null;
  } catch {
    return null;
  }
}

async function enqueuePush(db: SupabaseClient, row: QualRow, ctx: ThreadContext, log: Log): Promise<void> {
  const lead = await instantlyLead(row);
  const messages = messagesFromContext(ctx);
  const leadName = [lead?.first_name, lead?.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || null;
  const companyName = (lead?.company_name ?? '').trim() || null;
  const website = siteHost(lead?.website) ?? siteHost(lead?.company_domain) ?? corporateDomain(row.lead_email);
  const { error } = await db.from('own_reply_crm_pushes').insert({
    qualification_id: row.email_id,
    connection: POLZA_CONNECTION,
    pipeline_id: OWN_REPLY_PIPELINE_ID,
    status_id: OWN_REPLY_STATUS_ID,
    lead_email: row.lead_email,
    lead_name: leadName,
    company_name: companyName,
    website,
    campaign_name: row.campaign_name,
    sub_source: subSourceOf(messages, row.reply_preview),
    message_text: buildOwnReplyCard({
      campaignName: row.campaign_name,
      leadEmail: row.lead_email,
      leadName,
      companyName,
      phone: (lead?.phone ?? '').trim() || null,
      website,
      messages,
    }),
  });
  if (error?.code === '23505') {
    await markQual(db, row.email_id, { handoff_note: 'Этого человека уже передавали в AMO' });
    return;
  }
  if (error) throw new Error(`own_reply_crm_pushes insert: ${error.message}`);
  log('info', `X. Polza: лид ${row.lead_email} поставлен в AMO`);
}

async function qualifyOne(db: SupabaseClient, row: QualRow, settings: OwnReplySettings, ai: SenderLeadsAi, log: Log): Promise<boolean> {
  const attempts = row.attempts + 1;
  try {
    const ctx = await loadContext(db, row);
    if (ctx === 'deferred') return false;
    // Без нашего письма ИИ легко назовёт интерес «не лидом» — не оцениваем вслепую.
    if (!ctx || ctx.historyFetchFailed) {
      await failAttempt(db, row, attempts, `переписка не прочиталась${ctx?.historyFetchFailureReason ? `: ${ctx.historyFetchFailureReason}` : ''}`, log);
      return false;
    }
    const verdict = await qualifyReply(row.campaign_id, row.lead_email, row.thread_id, {
      apiKey: ai.apiKey,
      ...(ai.model ? { model: ai.model } : {}),
      // Пустая строка, а не null: при null квалификатор искал бы бриф кампании.
      briefText: '',
      leadCriteria: settings.criteria,
      prefetchedContext: ctx,
      maxRetries: 1,
    }, 'main');
    await markQual(db, row.email_id, {
      status: verdict.isLead ? 'lead' : 'not_lead',
      ai_reason: verdict.reason?.slice(0, 2000) ?? null,
      interest_signals: verdict.interestSignals ?? [],
      criteria_used: Boolean(settings.criteria),
      model: ai.model ?? 'default',
      attempts,
      last_error: null,
      qualified_at: new Date().toISOString(),
    });
    if (verdict.isLead) await enqueuePush(db, row, ctx, log);
    return verdict.isLead;
  } catch (err) {
    await failAttempt(db, row, attempts, errorText(err), log);
    return false;
  }
}

// ── AMO ─────────────────────────────────────────────────────────────────────

interface PushRow extends CrmQueueRow {
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  website: string | null;
  campaign_name: string;
  sub_source: string;
}

const PUSH_EXTRA_COLUMNS = 'lead_email, lead_name, company_name, website, campaign_name, sub_source';

/**
 * Открытая сделка человека: сначала контакт с этой почтой в живой AMO, потом —
 * для корпоративной почты — сделка компании по домену в зеркале amo_leads.
 */
async function findOpenLead(db: SupabaseClient, client: AmoClient, email: string): Promise<{ id: number; name: string } | null> {
  const contactId = await client.findContact({ name: email, email });
  if (contactId) {
    const lead = await client.findOpenLeadOfContact(contactId);
    if (lead) return lead;
  }
  const domain = corporateDomain(email);
  if (!domain) return null;
  const { data, error } = await db
    .from('amo_leads')
    .select('amo_id, name, contact_email, company_website, status_id')
    .not('status_id', 'in', '(142,143)')
    .or(`contact_email.ilike.${quoted(`*@${domain}`)},company_website.ilike.${quoted(`*${domain}*`)}`)
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`amo_leads: ${error.message}`);
  const hit = ((data ?? []) as { amo_id: number; name: string | null; contact_email: string | null; company_website: string | null }[])
    .find((l) => emailDomain(l.contact_email) === domain || siteHost(l.company_website) === domain);
  return hit ? { id: Number(hit.amo_id), name: (hit.name ?? '').trim() || `Сделка #${hit.amo_id}` } : null;
}

function toDeal(db: SupabaseClient, row: PushRow): CrmDealSpec {
  const leadName = `${row.company_name || row.lead_email} · ${row.campaign_name}`.slice(0, 250);
  return {
    contact: { name: row.lead_name || row.lead_email, email: row.lead_email },
    leadName,
    tags: [OWN_REPLY_TAG],
    polzaSelects: [
      { fieldId: POLZA_SOURCE_FIELD_ID, fieldName: 'Источник', value: POLZA_SOURCE_EMAIL_OUTREACH },
      { fieldId: POLZA_CONTOUR_FIELD_ID, fieldName: 'Контур', value: POLZA_CONTOUR_EMAIL_OUTREACH },
    ],
    polzaTexts: [
      { fieldId: POLZA_SUBSOURCE_FIELD_ID, value: row.sub_source },
      { fieldId: POLZA_CAMPAIGN_FIELD_ID, value: row.campaign_name },
      { fieldId: POLZA_SITE_FIELD_ID, value: row.website ?? '' },
    ],
    responsibleUserId: OWN_REPLY_RESPONSIBLE_USER_ID,
    findExistingLead: (client) => findOpenLead(db, client, row.lead_email),
    existingLeadPatch: (lead) => ({ action: 'note_added', amo_lead_name: lead.name }),
    createdLeadPatch: { action: 'created', amo_lead_name: leadName },
    label: `${row.lead_email} · ${row.campaign_name}`,
  };
}

async function processPushes(db: SupabaseClient, log: Log): Promise<number> {
  return processCrmQueue<PushRow>(db, {
    table: 'own_reply_crm_pushes',
    extraColumns: PUSH_EXTRA_COLUMNS,
    toDeal: (row) => toDeal(db, row),
    log: (level, msg) => log(level === 'warning' ? 'warn' : level, msg),
  });
}

// ── Чат ─────────────────────────────────────────────────────────────────────

async function deliverMessages(db: SupabaseClient, tg: LeadTelegramConfig, log: Log): Promise<number> {
  const { data, error } = await db
    .from('own_reply_crm_pushes')
    .select('id, qualification_id, action, lead_url, amo_lead_name, lead_email, lead_name, company_name, campaign_name, tg_attempts')
    .eq('status', 'sent')
    .is('tg_sent_at', null)
    .lt('tg_attempts', MAX_ATTEMPTS)
    .lte('next_attempt_at', new Date().toISOString())
    .order('sent_at')
    .limit(TG_BATCH);
  if (error) throw new Error(`own_reply_crm_pushes tg: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string; qualification_id: string; action: 'created' | 'note_added' | null; lead_url: string | null;
    amo_lead_name: string | null; lead_email: string; lead_name: string | null; company_name: string | null;
    campaign_name: string; tg_attempts: number;
  }>;
  if (!rows.length) return 0;

  const { data: quals, error: qualError } = await db
    .from('own_reply_qualifications')
    .select('email_id, reply_subject, reply_preview, ai_reason')
    .in('email_id', rows.map((r) => r.qualification_id));
  if (qualError) throw new Error(`own_reply_qualifications tg: ${qualError.message}`);
  const byId = new Map(((quals ?? []) as { email_id: string; reply_subject: string | null; reply_preview: string | null; ai_reason: string | null }[])
    .map((q) => [q.email_id, q]));

  let sent = 0;
  for (const row of rows) {
    const q = byId.get(row.qualification_id);
    try {
      const messageId = await sendLeadMessage(tg, buildOwnReplyTgMessage({
        action: row.action ?? 'created',
        campaignName: row.campaign_name,
        leadEmail: row.lead_email,
        leadName: row.lead_name,
        companyName: row.company_name,
        replySubject: q?.reply_subject ?? null,
        replyBody: q?.reply_preview ?? null,
        aiReason: q?.ai_reason ?? null,
        leadUrl: row.lead_url,
        amoLeadName: row.amo_lead_name,
      }));
      await db.from('own_reply_crm_pushes').update({ tg_sent_at: new Date().toISOString(), tg_message_id: messageId, tg_error: null }).eq('id', row.id);
      sent += 1;
    } catch (err) {
      const attempts = row.tg_attempts + 1;
      log('warn', `X. Polza: сообщение по ${row.lead_email} не ушло в чат (попытка ${attempts}): ${errorText(err)}`);
      await db.from('own_reply_crm_pushes').update({ tg_attempts: attempts, tg_error: errorText(err), next_attempt_at: retryAt(attempts) }).eq('id', row.id);
    }
  }
  return sent;
}

// ── Проход ──────────────────────────────────────────────────────────────────

/**
 * Один круг. Выключенный блок не берёт новые ответы, но уже поставленные
 * лиды доводит до AMO и чата.
 */
export async function runOwnReplyLeadsPass(db: SupabaseClient, instantlyDb: SupabaseClient | null, log: Log): Promise<OwnReplyPassResult> {
  const result: OwnReplyPassResult = { claimed: 0, qualified: 0, leads: 0, pushed: 0, delivered: 0 };
  const settings = await loadOwnReplySettings(db);
  const ai = senderLeadsAi();
  if (settings.enabled && ai && instantlyDb) {
    result.claimed = await claimFromInbox(db, instantlyDb, settings);
    for (const row of await dueQualifications(db)) {
      const isLead = await qualifyOne(db, row, settings, ai, log);
      result.qualified += 1;
      if (isLead) result.leads += 1;
    }
  }
  result.pushed = await processPushes(db, log);
  const tg = leadTelegramConfig();
  if (tg) result.delivered = await deliverMessages(db, tg, log);
  return result;
}

// ── Холостой прогон ─────────────────────────────────────────────────────────

export interface DryRunRow {
  campaign: string;
  email: string;
  reply: string;
  verdict: 'lead' | 'not_lead' | 'error';
  reason: string;
}

/**
 * Последние ответы наших кампаний через квалификатор — без записи в базу,
 * без AMO и без чата. Для сверки с пользователем до включения.
 */
export async function dryRunOwnReplies(instantlyDb: SupabaseClient, criteria: string | null, limit: number, log: Log): Promise<DryRunRow[]> {
  const ai = senderLeadsAi();
  if (!ai) throw new Error('SENDER_LEADS_AI_API_KEY не задан');
  const campaigns = await ownCampaigns(instantlyDb);
  const { data, error } = await instantlyDb
    .from('instantly_reply_inbox')
    .select('email_id, campaign_id, thread_id, lead_email, body_preview, reply_timestamp')
    .in('campaign_id', [...campaigns.keys()])
    .order('reply_timestamp', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`instantly_reply_inbox: ${error.message}`);
  const out: DryRunRow[] = [];
  for (const r of (data ?? []) as InboxRow[]) {
    const base = { campaign: campaigns.get(r.campaign_id) ?? r.campaign_id, email: r.lead_email, reply: (r.body_preview ?? '').slice(0, 200).replace(/\s+/g, ' ') };
    try {
      const ctx = await fetchThreadContext(r.campaign_id, r.lead_email, r.thread_id, 'main', { consumer: CONSUMER, requestPriority: 'bulk' });
      if (!ctx || ctx.historyFetchFailed) { out.push({ ...base, verdict: 'error', reason: 'переписка не прочиталась' }); continue; }
      const v = await qualifyReply(r.campaign_id, r.lead_email, r.thread_id, {
        apiKey: ai.apiKey, ...(ai.model ? { model: ai.model } : {}), briefText: '', leadCriteria: criteria, prefetchedContext: ctx, maxRetries: 1,
      }, 'main');
      out.push({ ...base, verdict: v.isLead ? 'lead' : 'not_lead', reason: (v.reason ?? '').slice(0, 300) });
    } catch (err) {
      log('warn', `dry-run ${r.email_id}: ${errorText(err)}`);
      out.push({ ...base, verdict: 'error', reason: errorText(err) });
    }
  }
  return out;
}
```

- [ ] **Step 2: Сверить используемые имена с исходниками**

Run: `git grep -n "export interface Email\b" -A30 -- app/src/lib/instantly/types.ts`
Expected: у `Email` есть `id`, `ue_type`, `body`, `timestamp_email`, `timestamp_created`. Если `timestamp_email` нет — в `card.ts` брать только `timestamp_created`.

Run: `git grep -n "historyFetchFailureReason\|export function senderLeadsAi\|export type Log\|export interface SenderLeadsAi" -- app/src/lib`
Expected: все четыре имени существуют (они использованы выше).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/ownReplyLeads/process.ts
git commit -m "feat(own-reply-leads): ответы «N. Polza» — оценка, сделка в AMO без дублей, сообщение в чат" -- app/src/lib/ownReplyLeads/process.ts
```

---

### Task 5: Воркер и холостой прогон

**Files:**
- Modify: `app/worker/senderLeads.ts`
- Create: `app/worker/ownReplyLeadsDryRunCli.ts`
- Modify: `app/package.json` (скрипты `build:workers` и `build:workers:watch` — дописать `worker/ownReplyLeadsDryRunCli.ts` после `worker/senderLeads.ts`)
- Modify: `Dockerfile.worker:43` (список esbuild — дописать `worker/ownReplyLeadsDryRunCli.ts` после `worker/senderLeads.ts`)

**Interfaces:**
- Consumes: `runOwnReplyLeadsPass`, `dryRunOwnReplies` (Task 4); `loadOwnReplySettings` (Task 3); `supabaseInstantly` (`lib/supabaseInstantly.ts`, может быть `null`).

- [ ] **Step 1: Второй проход в `worker/senderLeads.ts`**

Импорты:

```ts
import { runOwnReplyLeadsPass } from '@/lib/ownReplyLeads/process';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
```

В шапку-комментарий дописать абзац:

```ts
 * Здесь же — ответы наших email-кампаний «N. Polza_…» из Instantly → оценка →
 * сделка в нашей AMO → сообщение в чат (lib/ownReplyLeads, с 11.10.2026): тот
 * же ключ ИИ и тот же бот. Блок «Instantly · X. Polza» вкладки «Квалификация».
```

После строки предупреждения про токен:

```ts
  if (!supabaseInstantly) log('warn', 'База Instantly не настроена — ответы «N. Polza» не оцениваются');
```

В цикле после блока `try { const pass = await runSenderLeadsPass… } catch …` добавить отдельный try — сбой одного не трогает другой:

```ts
    try {
      const own = await runOwnReplyLeadsPass(db, supabaseInstantly, log);
      if (own.claimed || own.qualified || own.pushed || own.delivered) {
        log('info', `X. Polza: взято ${own.claimed}, оценено ${own.qualified}, лидов ${own.leads}, в AMO ${own.pushed}, в чат ${own.delivered}`);
      }
    } catch (err) {
      log('error', 'Круг ответов «N. Polza» упал', err);
    }
```

- [ ] **Step 2: `worker/ownReplyLeadsDryRunCli.ts`**

```ts
import { dryRunOwnReplies } from '@/lib/ownReplyLeads/process';
import { loadOwnReplySettings } from '@/lib/ownReplyLeads/settings';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createWorkerLogger, requireSupabaseAdmin } from './_shared';

/**
 * Холостой прогон квалификатора по последним ответам «N. Polza»: ничего не
 * пишет, в AMO и чат не шлёт. Запуск на 139:
 *   docker exec portal-worker-sender-leads node /app/workers/ownReplyLeadsDryRunCli.js 50
 */
const log = createWorkerLogger('own-reply-leads-dry-run');

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 50, 1), 200);
  const db = requireSupabaseAdmin(log);
  if (!supabaseInstantly) throw new Error('База Instantly не настроена');
  const settings = await loadOwnReplySettings(db);
  const rows = await dryRunOwnReplies(supabaseInstantly, settings.criteria, limit, log);
  console.log(['verdict', 'campaign', 'email', 'reply', 'reason'].join('\t'));
  for (const r of rows) console.log([r.verdict, r.campaign, r.email, r.reply, r.reason].join('\t'));
  const leads = rows.filter((r) => r.verdict === 'lead').length;
  console.log(`\nИтого ${rows.length}: лидов ${leads}, не лидов ${rows.filter((r) => r.verdict === 'not_lead').length}, ошибок ${rows.filter((r) => r.verdict === 'error').length}`);
}

main().then(() => process.exit(0)).catch((err) => {
  log('error', 'Холостой прогон упал', err);
  process.exit(1);
});
```

- [ ] **Step 3: Точки входа сборки**

В `app/package.json` в обеих строках `build:workers` и `build:workers:watch` заменить `worker/senderLeads.ts` на `worker/senderLeads.ts worker/ownReplyLeadsDryRunCli.ts`. В `Dockerfile.worker` строка 43 — то же (прод-образ собирается из своего списка).

Run: `git grep -c "ownReplyLeadsDryRunCli" -- app/package.json Dockerfile.worker`
Expected: `app/package.json:2`, `Dockerfile.worker:1`.

- [ ] **Step 4: Commit**

```bash
git add app/worker/ownReplyLeadsDryRunCli.ts
git commit -m "feat(own-reply-leads): проход в воркере квалификации и холостой прогон" -- app/worker/senderLeads.ts app/worker/ownReplyLeadsDryRunCli.ts app/package.json Dockerfile.worker
```

---

### Task 6: Экран — настройки в общей карточке и история

**Files:**
- Create: `app/src/lib/ownReplyLeads/history.ts`
- Create: `app/src/app/api/tools/own-reply-leads/route.ts`
- Create: `app/src/app/api/tools/own-reply-leads/settings/route.ts`
- Modify: `app/src/components/senderLeads/api.ts`
- Create: `app/src/components/senderLeads/OwnRepliesHistory.tsx`
- Modify: `app/src/components/senderLeads/QualificationTab.tsx` (`SettingsCard` ~L104–257, `QualificationTab` return ~L323)

**Interfaces:**
- Consumes: Task 3 (`loadOwnReplySettings`, `ownReplySettingsDto`, `parseOwnReplySettingsInput`, `ownReplySettingsPatch`, `OwnReplySettingsDto`).
- Produces:
  - `history.ts`: `type OwnHistoryFilter = 'all' | 'lead' | 'not_lead' | 'pending' | 'error'`; `interface OwnHistoryRowDto { emailId; campaignName; leadEmail; replySubject; replyPreview; replyAt; status; aiReason; lastError; attempts; handoffNote; crm: { status: 'pending' | 'sent' | 'failed'; action: 'created' | 'note_added' | null; leadUrl: string | null; amoLeadName: string | null; error: string | null; tgSentAt: string | null; tgError: string | null } | null }`; `interface OwnHistoryDto { rows; counts: Record<OwnHistoryFilter, number>; total; page; pageSize }`; `loadOwnHistory(db, filter, page): Promise<OwnHistoryDto>`; `parseOwnFilter(raw: string | null): OwnHistoryFilter`.
  - API: `GET /api/tools/own-reply-leads?filter=&page=` → `OwnHistoryDto`; `GET|PUT /api/tools/own-reply-leads/settings` → `OwnReplySettingsDto` (PUT — только админ, тело `{ enabled, criteria }`).
  - Клиент: `fetchOwnHistory(filter, page)`, `fetchOwnSettings()`, `saveOwnSettings(body)`.

- [ ] **Step 1: `history.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

/** История блока «Instantly · X. Polza»: оценки ответов и что сделано в AMO. */

export type OwnHistoryFilter = 'all' | 'lead' | 'not_lead' | 'pending' | 'error';
const FILTERS: OwnHistoryFilter[] = ['all', 'lead', 'not_lead', 'pending', 'error'];
const PAGE_SIZE = 30;

export function parseOwnFilter(raw: string | null): OwnHistoryFilter {
  return FILTERS.includes(raw as OwnHistoryFilter) ? (raw as OwnHistoryFilter) : 'all';
}

export interface OwnHistoryRowDto {
  emailId: string;
  campaignName: string;
  leadEmail: string;
  replySubject: string | null;
  replyPreview: string | null;
  replyAt: string | null;
  status: 'pending' | 'lead' | 'not_lead' | 'error' | 'skipped';
  aiReason: string | null;
  lastError: string | null;
  attempts: number;
  handoffNote: string | null;
  crm: {
    status: 'pending' | 'sent' | 'failed';
    action: 'created' | 'note_added' | null;
    leadUrl: string | null;
    amoLeadName: string | null;
    error: string | null;
    tgSentAt: string | null;
    tgError: string | null;
  } | null;
}

export interface OwnHistoryDto {
  rows: OwnHistoryRowDto[];
  counts: Record<OwnHistoryFilter, number>;
  total: number;
  page: number;
  pageSize: number;
}

type Db = Pick<SupabaseClient, 'from'>;

async function countOf(db: Db, filter: OwnHistoryFilter): Promise<number> {
  let q = db.from('own_reply_qualifications').select('email_id', { count: 'exact', head: true });
  if (filter !== 'all') q = q.eq('status', filter);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function loadOwnHistory(db: Db, filter: OwnHistoryFilter, page: number): Promise<OwnHistoryDto> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const countsList = await Promise.all(FILTERS.map((f) => countOf(db, f)));
  const counts = Object.fromEntries(FILTERS.map((f, i) => [f, countsList[i]])) as Record<OwnHistoryFilter, number>;

  let q = db
    .from('own_reply_qualifications')
    .select('email_id, campaign_name, lead_email, reply_subject, reply_preview, reply_timestamp, status, ai_reason, last_error, attempts, handoff_note')
    .order('reply_timestamp', { ascending: false, nullsFirst: false })
    .range((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE - 1);
  if (filter !== 'all') q = q.eq('status', filter);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const quals = (data ?? []) as Array<{
    email_id: string; campaign_name: string; lead_email: string; reply_subject: string | null; reply_preview: string | null;
    reply_timestamp: string | null; status: OwnHistoryRowDto['status']; ai_reason: string | null; last_error: string | null;
    attempts: number; handoff_note: string | null;
  }>;

  const pushes = new Map<string, OwnHistoryRowDto['crm']>();
  if (quals.length) {
    const { data: pushRows, error: pushError } = await db
      .from('own_reply_crm_pushes')
      .select('qualification_id, status, action, lead_url, amo_lead_name, error_message, tg_sent_at, tg_error, created_at')
      .in('qualification_id', quals.map((r) => r.email_id))
      .order('created_at', { ascending: true });
    if (pushError) throw new Error(pushError.message);
    for (const p of (pushRows ?? []) as Array<{
      qualification_id: string; status: 'pending' | 'sent' | 'failed'; action: 'created' | 'note_added' | null;
      lead_url: string | null; amo_lead_name: string | null; error_message: string | null; tg_sent_at: string | null; tg_error: string | null;
    }>) {
      // Последняя задача ответа — главная (упавшую мог сменить повтор).
      pushes.set(p.qualification_id, {
        status: p.status, action: p.action, leadUrl: p.lead_url, amoLeadName: p.amo_lead_name,
        error: p.error_message, tgSentAt: p.tg_sent_at, tgError: p.tg_error,
      });
    }
  }

  return {
    rows: quals.map((r) => ({
      emailId: r.email_id,
      campaignName: r.campaign_name,
      leadEmail: r.lead_email,
      replySubject: r.reply_subject,
      replyPreview: r.reply_preview,
      replyAt: r.reply_timestamp,
      status: r.status,
      aiReason: r.ai_reason,
      lastError: r.last_error,
      attempts: r.attempts,
      handoffNote: r.handoff_note,
      crm: pushes.get(r.email_id) ?? null,
    })),
    counts,
    total: counts[filter],
    page: safePage,
    pageSize: PAGE_SIZE,
  };
}
```

- [ ] **Step 2: API истории `app/src/app/api/tools/own-reply-leads/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import { loadOwnHistory, parseOwnFilter } from '@/lib/ownReplyLeads/history';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** GET — история блока «Instantly · X. Polza» (вкладка «Квалификация», только админ). */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.history' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const params = new URL(req.url).searchParams;
    try {
      return NextResponse.json(await loadOwnHistory(supabaseAdmin, parseOwnFilter(params.get('filter')), Number(params.get('page') ?? 1)));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить историю', 500);
    }
  });
}
```

- [ ] **Step 3: API настроек `app/src/app/api/tools/own-reply-leads/settings/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/loggerServer';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import {
  loadOwnReplySettings,
  ownReplySettingsDto,
  ownReplySettingsPatch,
  parseOwnReplySettingsInput,
} from '@/lib/ownReplyLeads/settings';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.settings.get' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    return NextResponse.json(ownReplySettingsDto(await loadOwnReplySettings(supabaseAdmin)));
  });
}

/** PUT — вкл/выкл и правило. Воркер перечитывает каждый круг (раз в минуту). */
export async function PUT(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.settings.update' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const parsed = parseOwnReplySettingsInput(await req.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const prev = await loadOwnReplySettings(supabaseAdmin);
    const { error } = await supabaseAdmin
      .from('own_reply_lead_settings')
      .update(ownReplySettingsPatch(prev, parsed.value, new Date().toISOString(), auth.user.id))
      .eq('id', 1);
    if (error) return jsonError(error.message, 500);

    // Включение заводит сделки в AMO — кто и когда, должно быть в журнале.
    await logAudit(
      'own.reply.leads.settings.updated',
      `X. Polza: квалификация и сделки в AMO ${parsed.value.enabled ? 'включены' : 'выключены'}`,
      { enabled: parsed.value.enabled, criteriaLength: parsed.value.criteria?.length ?? 0 },
      { userId: auth.user.id },
    );
    return NextResponse.json(ownReplySettingsDto(await loadOwnReplySettings(supabaseAdmin)));
  });
}
```

Проверить, что `requireAdmin` возвращает `{ user: { id } }`: `git grep -n "export async function requireAdmin" -A25 -- app/src/lib/adminAuth.ts`. Если поле называется иначе — взять его, как в `api/tools/sender-leads/settings/route.ts` (`auth.user.id`).

- [ ] **Step 4: Клиент `components/senderLeads/api.ts`** — дописать в конец:

```ts
import type { OwnHistoryDto, OwnHistoryFilter } from '@/lib/ownReplyLeads/history';
import type { OwnReplySettingsDto } from '@/lib/ownReplyLeads/settings';

const OWN_BASE = '/api/tools/own-reply-leads';

export function fetchOwnHistory(filter: OwnHistoryFilter, page: number) {
  const query = new URLSearchParams({ filter, page: String(page) });
  return authFetchJson<OwnHistoryDto>(`${OWN_BASE}?${query.toString()}`);
}

export function fetchOwnSettings() {
  return authFetchJson<OwnReplySettingsDto>(`${OWN_BASE}/settings`);
}

export function saveOwnSettings(body: { enabled: boolean; criteria: string }) {
  return authFetchJson<OwnReplySettingsDto>(`${OWN_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

(Импорты типов — поднять к остальным импортам вверху файла.) `settings.ts` импортирует только типы Supabase и `senderLeads/settings` — в клиентский бандл попадает лишь `import type`, это безопасно.

- [ ] **Step 5: Настройки в общей карточке — `SettingsCard` в `QualificationTab.tsx`**

Импорты: добавить `fetchOwnSettings, saveOwnSettings` к импорту из `./api` и `import type { OwnReplySettingsDto } from '@/lib/ownReplyLeads/settings';`.

В `SettingsCard` после существующих `useState` добавить состояние блока:

```tsx
  const [ownLoaded, setOwnLoaded] = useState<OwnReplySettingsDto | null>(null);
  const [ownEnabled, setOwnEnabled] = useState(false);
  const [ownCriteria, setOwnCriteria] = useState('');

  const applyOwn = (settings: OwnReplySettingsDto) => {
    setOwnLoaded(settings);
    setOwnEnabled(settings.enabled);
    setOwnCriteria(settings.criteria);
  };
```

В `useEffect` загрузки рядом с `fetchLeadSettings(folderKey)` добавить параллельно:

```tsx
    fetchOwnSettings()
      .then((settings) => {
        if (!cancelled) applyOwn(settings);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки X. Polza');
      });
```

Заменить `dirty`, `tooLong` и `save`:

```tsx
  const folderDirty = loaded !== null
    && (enabled !== loaded.enabled || telegram !== loaded.telegram || criteria.trim() !== loaded.criteria.trim());
  const ownDirty = ownLoaded !== null
    && (ownEnabled !== ownLoaded.enabled || ownCriteria.trim() !== ownLoaded.criteria.trim());
  const dirty = folderDirty || ownDirty;
  const tooLong = criteria.trim().length > LEAD_CRITERIA_MAX || ownCriteria.trim().length > LEAD_CRITERIA_MAX;

  // Одна кнопка на вкладку: сохраняет и папку, и блок X. Polza — что изменено.
  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const [folderRes, ownRes] = await Promise.all([
        folderDirty && loaded?.folderExists ? saveLeadSettings(folderKey, { enabled, telegram, criteria: criteria.trim() }) : null,
        ownDirty ? saveOwnSettings({ enabled: ownEnabled, criteria: ownCriteria.trim() }) : null,
      ]);
      if (folderRes) apply(folderRes);
      if (ownRes) applyOwn(ownRes);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };
```

У кнопки «Сохранить» условие `disabled` заменить на `saving || !dirty || tooLong || (folderDirty && !loaded?.folderExists)`.

Перед блоком с кнопкой «Сохранить» (`<div className="flex flex-wrap items-center gap-3">`) вставить раздел:

```tsx
          <div className="space-y-3 border-t border-zinc-200 pt-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Instantly · X. Polza</h3>
              <p className="text-xs text-zinc-500">Ответы наших кампаний «N. Polza_…»: лид → сделка в AMO и сообщение в чат.</p>
            </div>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={ownEnabled}
                onChange={(e) => {
                  setOwnEnabled(e.target.checked);
                  touch();
                }}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-zinc-300"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-900">Квалифицировать и заводить сделки в AMO</span>
                <span className="block text-xs text-zinc-500">
                  {ownLoaded?.enabled && ownLoaded.enabledAt
                    ? `Включено с ${new Date(ownLoaded.enabledAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — оцениваются ответы после этого.`
                    : 'Оцениваются только ответы, пришедшие после включения.'}
                </span>
              </span>
            </label>
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="own-lead-criteria" className="text-sm font-medium text-zinc-900">Что считать лидом</label>
                <span className={`text-xs ${ownCriteria.trim().length > LEAD_CRITERIA_MAX ? 'text-red-600' : 'text-zinc-400'}`}>
                  {ownCriteria.trim().length} / {LEAD_CRITERIA_MAX}
                </span>
              </div>
              <textarea
                id="own-lead-criteria"
                value={ownCriteria}
                onChange={(e) => {
                  setOwnCriteria(e.target.value);
                  touch();
                }}
                rows={4}
                placeholder="Пусто — общие правила квалификатора"
                className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </div>
          </div>
```

- [ ] **Step 6: История — `components/senderLeads/OwnRepliesHistory.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { OwnHistoryFilter, OwnHistoryRowDto } from '@/lib/ownReplyLeads/history';
import { fetchOwnHistory } from './api';

const FILTERS: { id: OwnHistoryFilter; label: string; tone: string }[] = [
  { id: 'all', label: 'Всего', tone: 'text-zinc-900' },
  { id: 'lead', label: 'Лиды', tone: 'text-emerald-700' },
  { id: 'not_lead', label: 'Не лиды', tone: 'text-zinc-600' },
  { id: 'pending', label: 'В очереди', tone: 'text-amber-700' },
  { id: 'error', label: 'Ошибки', tone: 'text-red-700' },
];

const BADGE: Record<OwnHistoryRowDto['status'], { label: string; className: string }> = {
  lead: { label: 'Лид', className: 'bg-emerald-100 text-emerald-700' },
  not_lead: { label: 'Не лид', className: 'bg-zinc-100 text-zinc-600' },
  pending: { label: 'В очереди', className: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', className: 'bg-red-100 text-red-700' },
  skipped: { label: 'Пропущен', className: 'bg-zinc-100 text-zinc-500' },
};

function formatAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Что сделано в AMO и в чате — одной строкой. */
function crmLine(row: OwnHistoryRowDto): { text: string; className: string } | null {
  if (row.handoffNote) return { text: row.handoffNote, className: 'text-zinc-500' };
  const crm = row.crm;
  if (!crm) return row.status === 'lead' ? { text: 'AMO: ставится в очередь', className: 'text-amber-700' } : null;
  if (crm.status === 'failed') return { text: `AMO: не получилось — ${crm.error ?? 'ошибка'}`, className: 'text-red-600' };
  if (crm.status === 'pending') return { text: `AMO: в очереди${crm.error ? ` — ${crm.error}` : ''}`, className: 'text-amber-700' };
  const what = crm.action === 'note_added' ? `добавлено к сделке «${crm.amoLeadName ?? ''}»` : 'сделка создана';
  const chat = crm.tgSentAt ? 'в чат ушло' : crm.tgError ? `в чат не ушло: ${crm.tgError}` : 'в чат уходит';
  return { text: `AMO: ${what} · ${chat}`, className: 'text-blue-700' };
}

/** История блока «Instantly · X. Polza» на вкладке «Квалификация». */
export function OwnRepliesHistory() {
  const [filter, setFilter] = useState<OwnHistoryFilter>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OwnHistoryRowDto[]>([]);
  const [counts, setCounts] = useState<Record<OwnHistoryFilter, number>>({ all: 0, lead: 0, not_lead: 0, pending: 0, error: 0 });
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetchOwnHistory(filter, page);
      setRows(res.rows);
      setCounts(res.counts);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setFilter(item.id);
              setPage(1);
            }}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              filter === item.id ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
            }`}
          >
            <div className="text-xs text-zinc-500">{item.label}</div>
            <div className={`text-lg font-semibold ${item.tone}`}>{counts[item.id]}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Instantly · X. Polza ({total})</h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>
        {error ? <p className="px-5 pt-3 text-sm text-red-600">{error}</p> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-zinc-500">Оценённых ответов пока нет.</p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {rows.map((row) => {
              const badge = BADGE[row.status];
              const crm = crmLine(row);
              const explanation = row.status === 'error' || (row.status === 'pending' && row.attempts > 0)
                ? row.lastError
                : row.aiReason;
              return (
                <div key={row.emailId} className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">{row.leadEmail}</span>
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">{row.campaignName}</div>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">{formatAt(row.replyAt)}</span>
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-3 py-2">
                    {row.replySubject ? <p className="mb-0.5 text-xs font-medium text-zinc-600">{row.replySubject}</p> : null}
                    {/* Чужой ввод — текстом, разметку не исполняем. */}
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-700">{row.replyPreview || 'Текста нет'}</p>
                  </div>
                  {explanation ? <p className="text-sm text-zinc-600">{explanation}</p> : null}
                  {crm ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className={`text-xs ${crm.className}`}>{crm.text}</span>
                      {row.crm?.leadUrl ? (
                        <a
                          href={row.crm.leadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50"
                        >
                          Сделка в AMO
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">Стр. {page} из {maxPage}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Подключить историю в `QualificationTab`**

Импорт `import { OwnRepliesHistory } from './OwnRepliesHistory';`. В `return` компонента `QualificationTab` последним дочерним элементом корневого `<div className="space-y-4">` (после карточки истории папки) добавить `<OwnRepliesHistory />`. В JSDoc `QualificationTab` дописать: «Внизу — история блока «Instantly · X. Polza» (ответы наших кампаний → AMO)».

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/ownReplyLeads/history.ts app/src/app/api/tools/own-reply-leads/route.ts app/src/app/api/tools/own-reply-leads/settings/route.ts app/src/components/senderLeads/OwnRepliesHistory.tsx
git commit -m "feat(own-reply-leads): блок «Instantly · X. Polza» на вкладке «Квалификация» — настройки общей кнопкой и история" -- app/src/lib/ownReplyLeads/history.ts app/src/app/api/tools/own-reply-leads/route.ts app/src/app/api/tools/own-reply-leads/settings/route.ts app/src/components/senderLeads/api.ts app/src/components/senderLeads/OwnRepliesHistory.tsx app/src/components/senderLeads/QualificationTab.tsx
```

---

### Task 7: Пуш, CI, выкладка и проверка на бою

**Files:** нет новых.

- [ ] **Step 1: Пуш ветки и CI**

```bash
git -C G:/PycharmProjects/Portal status -sb
git -C G:/PycharmProjects/Portal push origin dmitriy_kuladmed_new
```

Дождаться CI ветки (typecheck:fast + выбранные тесты, в т.ч. `tests/migrations/grants.test.ts`). Красный — чинить код, не тесты. Локально typecheck и полный jest не гонять.

- [ ] **Step 2: Выкладка — делает пользователь** (merge в test → main по его процессу). Миграция `supabase/migrations/20261011_0010_…` применится сама на деплое. Компоновку compose не трогаем — `--force-recreate` не нужен; `worker-sender-leads` пересоздастся штатно с новым образом.

- [ ] **Step 3: Проверка на 139 после выкладки (выключатель выключен)**

Пользователь вводит пароль сам; агент готовит команды:

```bash
docker logs --since 10m portal-worker-sender-leads 2>&1 | tail -20
docker exec portal-worker-sender-leads node /app/workers/ownReplyLeadsDryRunCli.js 50
```

Ожидается: в логах нет «Круг ответов «N. Polza» упал»; холостой прогон печатает таблицу и «Итого 50: лидов N…». Таблицу — пользователю на сверку (кого ИИ назвал лидом).

- [ ] **Step 4: Включение — пользователь** ставит галочку «Квалифицировать и заводить сделки в AMO» на вкладке «Квалификация» и жмёт «Сохранить».

- [ ] **Step 5: Первый живой лид** — проверить в AMO: воронка «Воронка - новые лиды», этап «Новый лид», ответственный Юлия Миронова, Источник/Контур/Подысточник/Ком-й/Сайт, тег «портал», почта в контакте, примечание с перепиской; сообщение в General «Продажи Polza»; строка в истории блока со ссылкой на сделку. Если «Контур = Email-outreach» в AMO не найден — в истории будет предупреждение, проставляется руками (вариант списка смотреть в AMO).

- [ ] **Step 6: Память** — обновить `C:\Users\dimak\.claude\projects\G--PycharmProjects-Portal\memory\polza-own-email-campaigns.md` (сделки по «N. Polza» снова заводятся — новым механизмом) и завести `polza-email-reply-leads-amo.md` (решения пользователя, константы AMO, где выключатель, как гонять холостой прогон), строку в `MEMORY.md`.
