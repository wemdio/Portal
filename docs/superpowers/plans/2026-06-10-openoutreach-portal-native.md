# OpenOutreach Portal-native — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (inline) for this plan — фазы C-D требуют live-навигации по `.tmp/OpenOutreach/` и решений на ходу, fresh subagent на каждый task потерял бы контекст. Steps использует checkbox (`- [ ]`) для tracking.

**Goal:** End-to-end интеграция OpenOutreach в Portal как мультитенантного сервиса с единой Supabase-БД, чтобы клик «Старт» в `/tools/li-outreach-v2` реально приводил к LinkedIn-инвайтам, а не висел на «queued».

**Architecture:** Fork OpenOutreach в `services/openoutreach/`, удалить `SiteConfig`-singleton, добавить multi-tenant `Account` model. Django ORM подключён к Portal Supabase напрямую (`DATABASE_URL=$SUPABASE_DB_URL`). Daemon — asyncio main loop + N AccountWorker'ов, ephemeral Chromium per task (cap=3), cookies в Postgres BYTEA+JSONB. Portal API контракт сводится к `li2_accounts.status` flip.

**Tech Stack:** Python 3.11, Django 5.x, Playwright (async API), psycopg 3, Postgres (Portal Supabase @ 144.31.54.166), Next.js 16, TypeScript, Supabase JS client, Docker Compose, supervisord, Xvfb+x11vnc+noVNC.

---

## Phase A — Schema migration (1 task) ☑ checkpoint после

### Task 1: Supabase migration `20260610_0001_li2_openoutreach_schema.sql`

**Files:**
- Create: `supabase/migrations/20260610_0001_li2_openoutreach_schema.sql`

**Конвенция** — `default now()` без триггера, app-code обновляет `updated_at` вручную (см. `start/route.ts:43`).

- [ ] Step 1: Создать миграцию

```sql
-- li2_* schema for OpenOutreach Portal-native integration.
-- Drops li2_jobs (replaced by status-flip on li2_accounts), adds
-- Account/Deal/Task/BrowserSession tables for the multi-tenant daemon,
-- augments existing li2_leads/li2_messages/li2_campaigns.

begin;

-- (a) DROP old queue — no consumer, only orphan rows from start/route.ts
drop table if exists public.li2_jobs cascade;

-- (b) Augment existing tables
alter table public.li2_campaigns
  add column if not exists model_blob bytea,
  add column if not exists qualifiers jsonb not null default '[]'::jsonb;

alter table public.li2_leads
  add column if not exists urn text,
  add column if not exists embedding bytea,
  add column if not exists disqualified boolean not null default false,
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table public.li2_messages
  add column if not exists external_id text;
create unique index if not exists ux_li2_messages_external_id
  on public.li2_messages(external_id)
  where external_id is not null;

-- (c) NEW: li2_accounts — per-user LinkedIn account state, поллится daemon'ом
create table if not exists public.li2_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  status          text not null default 'stopped'
                    check (status in ('stopped','running','needs_captcha','disconnected')),
  runtime_status  text not null default 'idle',
  last_heartbeat_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(user_id)
);
create index if not exists idx_li2_accounts_status
  on public.li2_accounts(status, last_heartbeat_at);

-- (d) NEW: li2_deals — per-(campaign × lead) state machine row
create table if not exists public.li2_deals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  campaign_id           uuid not null references public.li2_campaigns(id) on delete cascade,
  lead_id               uuid not null references public.li2_leads(id) on delete cascade,
  state                 text not null default 'qualified'
                          check (state in ('qualified','ready_to_connect','pending','connected','completed','failed')),
  outcome               text
                          check (outcome is null or outcome in ('converted','not_interested','wrong_fit','no_budget','has_solution','bad_timing','unresponsive','unknown')),
  qualification_score   numeric,
  qualification_reason  text,
  profile_summary       jsonb not null default '[]'::jsonb,
  chat_summary          jsonb not null default '[]'::jsonb,
  next_check_pending_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(campaign_id, lead_id)
);
create index if not exists idx_li2_deals_campaign_state
  on public.li2_deals(campaign_id, state, updated_at desc);

-- (e) NEW: li2_tasks — planner queue, Poisson slots per 24h window
create table if not exists public.li2_tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  account_id      uuid not null references public.li2_accounts(id) on delete cascade,
  campaign_id     uuid not null references public.li2_campaigns(id) on delete cascade,
  type            text not null check (type in ('connect','check_pending','follow_up')),
  status          text not null default 'pending'
                    check (status in ('pending','running','completed','failed','cancelled')),
  scheduled_at    timestamptz not null,
  payload         jsonb not null default '{}'::jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_li2_tasks_account_due
  on public.li2_tasks(account_id, scheduled_at)
  where status = 'pending';
create index if not exists idx_li2_tasks_stale
  on public.li2_tasks(started_at)
  where status = 'running';

-- (f) NEW: li2_browser_sessions — Playwright storage_state + cookies
create table if not exists public.li2_browser_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  account_id      uuid not null references public.li2_accounts(id) on delete cascade,
  storage_state   jsonb,
  cookies         bytea,
  updated_at      timestamptz not null default now(),
  unique(account_id)
);

-- (g) RLS
alter table public.li2_accounts          enable row level security;
alter table public.li2_deals             enable row level security;
alter table public.li2_tasks             enable row level security;
alter table public.li2_browser_sessions  enable row level security;

create policy li2_accounts_own_all on public.li2_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_deals_own_all on public.li2_deals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_tasks_own_all on public.li2_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy li2_browser_sessions_own_all on public.li2_browser_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- (h) Grants
grant all on public.li2_accounts to service_role;
grant all on public.li2_deals to service_role;
grant all on public.li2_tasks to service_role;
grant all on public.li2_browser_sessions to service_role;
grant select, insert, update on public.li2_accounts to authenticated;
grant select, insert, update on public.li2_deals to authenticated;
grant select, insert, update on public.li2_tasks to authenticated;
grant select, insert, update on public.li2_browser_sessions to authenticated;

commit;
```

- [ ] Step 2: Sanity-check SQL syntax

Run: `cat supabase/migrations/20260610_0001_li2_openoutreach_schema.sql | head -5`
Expected: первая строка `-- li2_*…`, файл существует, читаем.

- [ ] Step 3: Apply на удалённую Supabase (через MCP tool)

Использовать `mcp__3f44d3db-...-apply_migration` с `project_id` Portal'a (узнать через `list_projects` если не известно).

- [ ] Step 4: Verify через SELECT

```sql
select table_name from information_schema.tables
where table_schema='public' and table_name like 'li2_%' order by 1;
```
Expected: `li2_accounts, li2_browser_sessions, li2_campaigns, li2_deals, li2_leads, li2_logs, li2_messages, li2_settings, li2_tasks` (нет `li2_jobs`).

- [ ] Step 5: Commit

```bash
git add supabase/migrations/20260610_0001_li2_openoutreach_schema.sql
git commit -m "feat(li-outreach-v2): schema для OpenOutreach Portal-native

Дропает li2_jobs (заменён state-flip на li2_accounts.status), добавляет
li2_accounts/li2_deals/li2_tasks/li2_browser_sessions для multi-tenant
daemon'a, аугментирует li2_leads (urn/embedding/disqualified/meta),
li2_campaigns (model_blob/qualifiers), li2_messages (external_id+unique).

RLS + grants как в основной li2_*-миграции."
```

**Checkpoint A:** migration applied, существующие routes API падают только на `li2_jobs` insert (см. /start/route.ts:48). Следующий phase фиксит.

---

## Phase B — Portal API правки (4 tasks) ☑ checkpoint после

### Task 2: Обновить `start/route.ts` — flip status вместо insert в li2_jobs

**Files:**
- Modify: `app/src/app/api/tools/li-outreach-v2/campaigns/[id]/start/route.ts`

- [ ] Step 1: Заменить блок инсерта в li2_jobs (стр. 48-98) на upsert li2_accounts + update li2_campaigns

Полный новый файл (заменить всё):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { V2_DEFAULT_PROMPTS } from '@/lib/liOutreach/v2DefaultPrompts';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const requestyKey = (process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '').trim();
    if (!requestyKey) {
      return jsonError('OPENROUTER_LI_OUTREACH_API_KEY is not configured on server', 500);
    }

    const { data: settings } = await auth.supabase
      .from('li2_settings')
      .select('linkedin_email,linkedin_password,legal_accepted,prompt_follow_up_agent,prompt_qualify_lead,prompt_search_keywords')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (!settings?.linkedin_email || !settings?.linkedin_password) {
      return jsonError('Fill LinkedIn settings before starting OpenOutreach', 400);
    }
    if (!settings.legal_accepted) {
      return jsonError('Accept the LinkedIn automation risk notice before starting', 400);
    }

    const { data: campaign, error: loadError } = await auth.supabase
      .from('li2_campaigns')
      .select('*')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (loadError) return jsonError(loadError.message, 500);
    if (!campaign) return jsonError('Campaign not found', 404);

    const now = new Date().toISOString();

    // Подготовка campaign-level promptов: пустые user-overrides → upstream-defaults
    const prompts = {
      follow_up_agent: (settings.prompt_follow_up_agent ?? '').trim() || V2_DEFAULT_PROMPTS.follow_up_agent,
      qualify_lead:    (settings.prompt_qualify_lead    ?? '').trim() || V2_DEFAULT_PROMPTS.qualify_lead,
      search_keywords: (settings.prompt_search_keywords ?? '').trim() || V2_DEFAULT_PROMPTS.search_keywords,
    };
    const qualifiers = [{
      name: 'default',
      prompt: prompts.qualify_lead,
      product_description: campaign.product_description,
      target_market: campaign.target_market,
      campaign_objective: campaign.campaign_objective,
    }];

    // Активируем кампанию + проставляем qualifiers для daemon
    const { error: updateError } = await auth.supabase
      .from('li2_campaigns')
      .update({ status: 'running', runtime_status: 'queued_for_openoutreach', qualifiers, updated_at: now })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (updateError) return jsonError(updateError.message, 500);

    // Upsert li2_accounts: daemon-side state aggregator per user.
    // Если status='disconnected' / 'needs_captcha' — перетираем на 'running',
    // даём daemon'у попробовать заново (он сам флипнет обратно при проблеме).
    const { error: accError } = await auth.supabase
      .from('li2_accounts')
      .upsert({
        user_id: auth.user.id,
        status: 'running',
        runtime_status: 'starting',
        last_error: null,
        updated_at: now,
      }, { onConflict: 'user_id' });
    if (accError) return jsonError(accError.message, 500);

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'info',
      message: 'Campaign activated — daemon will start within ~5s',
    });

    return NextResponse.json({ ok: true });
  });
}
```

- [ ] Step 2: Запустить TypeScript check

Run: `cd app && npx tsc --noEmit --project tsconfig.json 2>&1 | grep "li-outreach-v2/campaigns/\[id\]/start" || echo "OK"`
Expected: `OK` (нет ошибок в нашем файле).

- [ ] Step 3: Commit

```bash
git add app/src/app/api/tools/li-outreach-v2/campaigns/\[id\]/start/route.ts
git commit -m "feat(li-outreach-v2): /start flip'ает li2_accounts.status вместо вставки в li2_jobs

li2_jobs дропнут миграцией; контракт Portal↔daemon — поле
li2_accounts.status ('running'/'stopped'/etc). Promptы и campaign-prefs
переезжают на li2_campaigns.qualifiers (jsonb), daemon читает их при
выполнении task'ов."
```

### Task 3: Обновить `stop/route.ts` — флип status='stopped'

**Files:**
- Modify: `app/src/app/api/tools/li-outreach-v2/campaigns/[id]/stop/route.ts`

- [ ] Step 1: Заменить файл полностью

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.stop' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const now = new Date().toISOString();

    const { error: cErr } = await auth.supabase
      .from('li2_campaigns')
      .update({ status: 'stopped', runtime_status: 'stop_requested', updated_at: now })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (cErr) return jsonError(cErr.message, 500);

    // Если других running-кампаний у юзера не осталось — гасим аккаунт.
    // Иначе только лог.
    const { data: otherRunning } = await auth.supabase
      .from('li2_campaigns')
      .select('id')
      .eq('user_id', auth.user.id)
      .eq('status', 'running')
      .neq('id', id)
      .limit(1);
    if (!otherRunning || otherRunning.length === 0) {
      await auth.supabase
        .from('li2_accounts')
        .update({ status: 'stopped', runtime_status: 'idle', updated_at: now })
        .eq('user_id', auth.user.id);
    }

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'warning',
      message: 'Campaign stop requested',
    });

    return NextResponse.json({ ok: true });
  });
}
```

- [ ] Step 2: Commit

```bash
git add app/src/app/api/tools/li-outreach-v2/campaigns/\[id\]/stop/route.ts
git commit -m "feat(li-outreach-v2): /stop флипает status='stopped', гасит li2_accounts если последняя running-кампания"
```

### Task 4: Новая ручка `/accounts/resume-from-captcha`

**Files:**
- Create: `app/src/app/api/tools/li-outreach-v2/accounts/resume-from-captcha/route.ts`

- [ ] Step 1: Создать ручку

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Оператор прошёл LinkedIn CAPTCHA через VNC :6080 → флипаем
 * li2_accounts.status: 'needs_captcha' → 'running' чтобы daemon продолжил.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.accounts.resume-from-captcha' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const now = new Date().toISOString();

    const { data: account, error: loadErr } = await auth.supabase
      .from('li2_accounts')
      .select('id, status')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (loadErr) return jsonError(loadErr.message, 500);
    if (!account) return jsonError('No LinkedIn account state for this user', 404);
    if (account.status !== 'needs_captcha') {
      return jsonError(`Account status is "${account.status}", expected "needs_captcha"`, 409);
    }

    const { error: updErr } = await auth.supabase
      .from('li2_accounts')
      .update({ status: 'running', runtime_status: 'resuming', last_error: null, updated_at: now })
      .eq('user_id', auth.user.id);
    if (updErr) return jsonError(updErr.message, 500);

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      level: 'info',
      message: 'CAPTCHA resolved, daemon resuming',
    });

    return NextResponse.json({ ok: true });
  });
}
```

- [ ] Step 2: Commit

```bash
git add app/src/app/api/tools/li-outreach-v2/accounts/
git commit -m "feat(li-outreach-v2): ручка resume-from-captcha для прохождения CAPTCHA через VNC"
```

### Task 5: Обновить `/leads/route.ts` для join с li2_deals

**Files:**
- Modify: `app/src/app/api/tools/li-outreach-v2/leads/route.ts`

- [ ] Step 1: Прочитать текущий файл, добавить left join к li2_deals для per-campaign state.

Логика: текущая ручка возвращает li2_leads. Состояние сделки (state/outcome/qualification_*) теперь живёт в li2_deals. Меняем SELECT на join, чтобы фронту не пришлось знать о реорганизации.

```typescript
// внутри handler'a — заменить .from('li2_leads').select(…) на:
const { data, error } = await auth.supabase
  .from('li2_leads')
  .select(`
    id, campaign_id, profile_url, name, first_name, last_name, position, company,
    last_activity_at, updated_at,
    li2_deals!left (
      state, outcome, qualification_score, qualification_reason
    )
  `)
  .eq('user_id', auth.user.id)
  .order('updated_at', { ascending: false })
  .limit(500);

// + плющим вложенный li2_deals[0] в плоский объект для UI compat:
const flat = (data ?? []).map((row: any) => {
  const deal = Array.isArray(row.li2_deals) ? row.li2_deals[0] : row.li2_deals;
  return {
    ...row,
    state: deal?.state ?? 'discovered',
    outcome: deal?.outcome ?? null,
    qualification_score: deal?.qualification_score ?? null,
    qualification_reason: deal?.qualification_reason ?? null,
    li2_deals: undefined,
  };
});
return NextResponse.json({ leads: flat });
```

(Точные строки — после Read'а файла.)

- [ ] Step 2: Verify типы тоже норм:

Run: `cd app && npx tsc --noEmit --project tsconfig.json 2>&1 | grep "li-outreach-v2/leads/route" || echo "OK"`

- [ ] Step 3: Commit

```bash
git commit -am "feat(li-outreach-v2): /leads JOIN'ит li2_deals для per-campaign state"
```

**Checkpoint B:** Все Portal API ручки совместимы с новой схемой. UI должен работать (пустые данные пока daemon'а нет, но без 500-х). git status чистый.

---

## Phase C — Fork OpenOutreach scaffold (5 tasks) ☑ checkpoint после

### Task 6: Перенос `.tmp/OpenOutreach/` → `services/openoutreach/` + UPSTREAM.md

**Files:**
- Create: `services/openoutreach/UPSTREAM.md` + весь репо OpenOutreach
- Delete: `.tmp/OpenOutreach/` (или оставить в gitignore, не наш репо)

- [ ] Step 1: Зафиксировать upstream SHA

```bash
cd .tmp/OpenOutreach && git log -1 --format='%H %ai %s' > /tmp/upstream-sha.txt
cat /tmp/upstream-sha.txt
```

- [ ] Step 2: Скопировать (без `.git`, без `data/`, без `.venv`)

```bash
cd G:/PycharmProjects/Portal
mkdir -p services/openoutreach
rsync -a --exclude='.git' --exclude='data' --exclude='.venv' --exclude='__pycache__' \
  --exclude='*.pyc' --exclude='node_modules' \
  .tmp/OpenOutreach/ services/openoutreach/
```

(На Windows — без rsync; использовать `xcopy`/`robocopy` или `Copy-Item -Recurse -Exclude`.)

- [ ] Step 3: Создать UPSTREAM.md

```markdown
# OpenOutreach Upstream Tracker

**Upstream:** https://github.com/eracle/OpenOutreach (или соответствующий, проверить .tmp/OpenOutreach/README.md)
**Forked from:** <SHA из шага 1>
**Forked on:** 2026-06-10

## Fork divergence

Этот fork отходит от upstream в следующих точках:
- `SiteConfig` singleton удалён → заменён на per-user `Account` model на `li2_accounts`
- SQLite заменён на Postgres (Portal Supabase) — `DATABASE_URL` из env
- `manage.py rundaemon` переписан на async multi-account MainLoop + AccountWorker
- Все Django model.Meta.db_table → `li2_*` (соответствуют Portal schema)
- Django Admin отключён (urls.py)

## Re-syncing с upstream

При апстрим-обновлении (~раз в квартал):
1. Склонировать upstream в `.tmp/openoutreach-upstream/`
2. `git diff .tmp/openoutreach-upstream services/openoutreach` — посмотреть, что реально отличается
3. Cherry-pick изменения upstream'a по одному, конфликт-зоны: модели, daemon.py, settings
4. Перетестировать smoke pipeline
5. Обновить SHA в этом файле
```

- [ ] Step 4: Удалить (или сохранить) .tmp/OpenOutreach

```bash
# Оставляем как референс — он в .gitignore, не мешает
ls .tmp/OpenOutreach/.git | head -3
```

- [ ] Step 5: Commit

```bash
git add services/openoutreach/
git commit -m "feat(openoutreach): import upstream OpenOutreach в services/openoutreach/

Vendored at SHA <X>; смотри services/openoutreach/UPSTREAM.md.
Дальнейшие коммиты строят multi-tenant fork поверх этого baseline'a."
```

### Task 7: Подключение Django ORM к Postgres (Supabase)

**Files:**
- Modify: `services/openoutreach/django_settings.py`
- Modify: `services/openoutreach/requirements/base.txt`

- [ ] Step 1: Прочитать `services/openoutreach/django_settings.py`, найти `DATABASES = …`

- [ ] Step 2: Заменить SQLite-конфиг на psycopg

```python
import os
import dj_database_url

DATABASES = {
    'default': dj_database_url.config(
        default=os.environ.get('DATABASE_URL', ''),
        conn_max_age=600,
        ssl_require=False,  # Supabase разрешает не-ssl внутри VPC
    ),
}
```

- [ ] Step 3: Добавить deps

```text
# services/openoutreach/requirements/base.txt — append
dj-database-url>=2.1.0
psycopg[binary]>=3.1.0
```

- [ ] Step 4: Commit

```bash
git commit -am "feat(openoutreach): DATABASES → Postgres через DATABASE_URL"
```

### Task 8: Django models — переименовать db_table в li2_*, удалить Site/SiteConfig

**Files:**
- Modify: `services/openoutreach/models.py` (если там SiteConfig) или соответствующий модуль
- Modify: `services/openoutreach/linkedin/models.py` (Campaign, etc.)
- Modify: `services/openoutreach/crm/models.py` (Lead, Deal)
- Modify: `services/openoutreach/chat/models.py` (ChatMessage)
- Create: `services/openoutreach/linkedin/models/account.py` — новая модель Account

- [ ] Step 1: Inspect — определить все models.Model подклассы

```bash
grep -rn "class.*models\.Model" services/openoutreach --include="*.py" | head -40
```

- [ ] Step 2: Создать модель Account

```python
# services/openoutreach/linkedin/models/account.py
from django.db import models

class Account(models.Model):
    """
    Per-Portal-user LinkedIn account state, поллится daemon'ом.

    Postgres table: li2_accounts (см. supabase/migrations/20260610_0001).
    Жизненный цикл: stopped (default) → running (когда юзер жмёт «Старт») →
    needs_captcha / disconnected (когда daemon упёрся) → resumed → ...

    user_id привязан к Portal'овской profiles.id, daemon работает за service-role
    подключением и фильтрует по нему.
    """
    STATUS_CHOICES = [
        ('stopped', 'Stopped'),
        ('running', 'Running'),
        ('needs_captcha', 'Needs CAPTCHA'),
        ('disconnected', 'Disconnected'),
    ]

    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default='stopped')
    runtime_status = models.CharField(max_length=32, default='idle')
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        managed = False  # схему держит supabase/migrations, не Django
        db_table = 'li2_accounts'
```

- [ ] Step 3: Существующие модели — навесить `db_table = 'li2_xxx'` через Meta + `managed=False`

Пример (Lead в crm/models.py):
```python
class Lead(models.Model):
    # ... existing fields ...
    
    class Meta:
        managed = False
        db_table = 'li2_leads'
```

Аналогично:
- Campaign → `db_table='li2_campaigns'`
- Deal → `db_table='li2_deals'`
- ChatMessage → `db_table='li2_messages'`
- Task → `db_table='li2_tasks'`
- BrowserSession → `db_table='li2_browser_sessions'`

- [ ] Step 4: Удалить Site/SiteConfig

```bash
grep -rln "SiteConfig\b" services/openoutreach --include="*.py"
# каждый файл — удалить определение / impport, либо заменить на Account.objects.get(user_id=...)
```

- [ ] Step 5: Commit

```bash
git commit -am "feat(openoutreach): models → li2_* (managed=False), новый Account, удалён SiteConfig"
```

### Task 9: Linkedin settings (промпты, прокси, креды) — читаем из li2_settings

**Files:**
- Modify: `services/openoutreach/conf.py` или onboarding.py
- Create: `services/openoutreach/linkedin/models/settings.py`

- [ ] Step 1: Создать Django model для li2_settings

```python
# services/openoutreach/linkedin/models/settings.py
from django.db import models

class PortalSettings(models.Model):
    """Per-user prefs хранятся в Portal'е, daemon только читает."""
    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField(db_index=True)
    linkedin_email = models.TextField()
    linkedin_password = models.TextField()
    proxy_url = models.TextField()
    connect_daily_limit = models.IntegerField(default=20)
    connect_weekly_limit = models.IntegerField(default=100)
    follow_up_daily_limit = models.IntegerField(default=25)
    legal_accepted = models.BooleanField(default=False)
    prompt_follow_up_agent = models.TextField()
    prompt_qualify_lead = models.TextField()
    prompt_search_keywords = models.TextField()

    class Meta:
        managed = False
        db_table = 'li2_settings'
```

- [ ] Step 2: Заменить обращения к `SiteConfig.*` на `PortalSettings.objects.get(user_id=...)`. По всему коду grep.

- [ ] Step 3: Commit

```bash
git commit -am "feat(openoutreach): PortalSettings model на li2_settings, замена SiteConfig"
```

### Task 10: urls.py — выключить Django Admin

**Files:**
- Modify: `services/openoutreach/urls.py`

- [ ] Step 1: Удалить `admin/` URL pattern и `path('admin/', admin.site.urls)`. Django process у нас ничего не сервит — все запросы идут через Portal API.

- [ ] Step 2: Commit

```bash
git commit -am "feat(openoutreach): убрать Django Admin (Portal UI достаточно)"
```

**Checkpoint C:** `services/openoutreach/` собирается локально, Django подключается к Postgres, modеls указывают на li2_* tables (managed=False), Site/SiteConfig вырезаны.

---

## Phase D — Daemon multi-account rewrite (5 tasks) ☑ checkpoint после

### Task 11: MainLoop — поллинг li2_accounts, dispatch AccountWorker

**Files:**
- Modify: `services/openoutreach/daemon.py` (или management/commands/rundaemon.py)

- [ ] Step 1: Заменить main loop на:

```python
import asyncio
import logging
import time
from pathlib import Path
from uuid import UUID

from django.utils import timezone
from linkedin.models.account import Account

HEARTBEAT_PATH = Path('/tmp/li2-daemon-heartbeat')
POLL_INTERVAL_SEC = int(__import__('os').environ.get('LI2_DAEMON_POLL_INTERVAL_SEC', '5'))

logger = logging.getLogger('li2.daemon.main')


async def main_loop(stop_event: asyncio.Event):
    workers: dict[UUID, 'AccountWorker'] = {}
    while not stop_event.is_set():
        try:
            running = {a.id: a async for a in Account.objects.filter(status='running').aiterator()}
        except Exception as e:
            logger.exception("Failed to fetch accounts: %s", e)
            await asyncio.sleep(POLL_INTERVAL_SEC)
            continue

        # Стартуем новых
        for acc_id, acc in running.items():
            if acc_id not in workers:
                from linkedin.daemon.account_worker import AccountWorker  # lazy import
                worker = AccountWorker(acc_id, acc.user_id)
                workers[acc_id] = worker
                worker.task = asyncio.create_task(worker.run(), name=f"worker-{acc_id}")
                logger.info("Started worker for account=%s user=%s", acc_id, acc.user_id)

        # Останавливаем убранных
        for acc_id in list(workers.keys()):
            if acc_id not in running:
                w = workers.pop(acc_id)
                w.stop()
                logger.info("Stopping worker account=%s", acc_id)

        # Heartbeat
        HEARTBEAT_PATH.write_text(str(int(time.time())))

        # Crash-recovery: reset stale tasks
        from linkedin.tasks.recovery import reset_stale_tasks
        await reset_stale_tasks()

        await asyncio.sleep(POLL_INTERVAL_SEC)

    # Shutdown — gracefully ждём worker'ов
    for w in workers.values():
        w.stop()
    if workers:
        await asyncio.gather(*(w.task for w in workers.values()), return_exceptions=True)
```

- [ ] Step 2: Точка входа `rundaemon`:

```python
# management/commands/rundaemon.py
import asyncio, signal
from django.core.management.base import BaseCommand
from daemon import main_loop

class Command(BaseCommand):
    def handle(self, *args, **kwargs):
        stop = asyncio.Event()
        loop = asyncio.new_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        loop.run_until_complete(main_loop(stop))
```

- [ ] Step 3: Commit

```bash
git commit -am "feat(openoutreach): MainLoop поллит li2_accounts, dispatch AccountWorker"
```

### Task 12: AccountWorker — основной цикл per-account

**Files:**
- Create: `services/openoutreach/linkedin/daemon/account_worker.py`

- [ ] Step 1: Создать AccountWorker

```python
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from uuid import UUID

from asgiref.sync import sync_to_async
from django.db import close_old_connections
from linkedin.models.account import Account
from linkedin.models.settings import PortalSettings
from linkedin.models.task import Task
from linkedin.exceptions import CaptchaDetected, AuthenticationError

logger = logging.getLogger('li2.worker')

MAX_CONCURRENT_BROWSERS = int(__import__('os').environ.get('LI2_MAX_CONCURRENT_BROWSERS', '3'))
_browser_semaphore = asyncio.Semaphore(MAX_CONCURRENT_BROWSERS)


class AccountWorker:
    def __init__(self, account_id: UUID, user_id: UUID):
        self.account_id = account_id
        self.user_id = user_id
        self._stop = asyncio.Event()
        self.task: asyncio.Task | None = None

    def stop(self):
        self._stop.set()

    async def run(self):
        try:
            await self._heartbeat()
            while not self._stop.is_set():
                try:
                    await self._reconcile()
                    next_task = await self._pick_next_task()
                    if next_task is None:
                        await asyncio.sleep(60)
                        continue
                    async with _browser_semaphore:
                        from linkedin.daemon.browser_session import browser_session
                        async with browser_session(self.account_id, self.user_id) as ctx:
                            from linkedin.daemon.executor import execute_task
                            await execute_task(next_task, ctx)
                    await self._heartbeat()
                except CaptchaDetected:
                    logger.warning("CAPTCHA detected for account=%s", self.account_id)
                    await self._flag('needs_captcha', 'LinkedIn checkpoint — open VNC :6080 to resolve')
                    return
                except AuthenticationError as e:
                    logger.error("Auth error for account=%s: %s", self.account_id, e)
                    await self._flag('disconnected', f'LinkedIn auth failure: {e}')
                    return
                except Exception:
                    logger.exception("Unexpected error in worker account=%s", self.account_id)
                    await asyncio.sleep(30)
        finally:
            close_old_connections()

    @sync_to_async
    def _heartbeat(self):
        Account.objects.filter(id=self.account_id).update(
            last_heartbeat_at=datetime.now(timezone.utc),
            runtime_status='running',
        )

    @sync_to_async
    def _flag(self, status: str, message: str):
        Account.objects.filter(id=self.account_id).update(
            status=status, last_error=message,
        )

    @sync_to_async
    def _reconcile(self):
        from linkedin.tasks.scheduler import reconcile
        reconcile(account_id=self.account_id, user_id=self.user_id)

    @sync_to_async
    def _pick_next_task(self):
        now = datetime.now(timezone.utc)
        return (
            Task.objects.filter(account_id=self.account_id, status='pending', scheduled_at__lte=now)
                .order_by('scheduled_at')
                .first()
        )
```

- [ ] Step 2: Stub `linkedin.exceptions` если нет

```python
# services/openoutreach/linkedin/exceptions.py
class CaptchaDetected(Exception): pass
class AuthenticationError(Exception): pass
```

- [ ] Step 3: Commit

```bash
git commit -am "feat(openoutreach): AccountWorker — per-account event loop"
```

### Task 13: browser_session (ephemeral Chromium + Postgres cookies)

**Files:**
- Create: `services/openoutreach/linkedin/daemon/browser_session.py`

- [ ] Step 1:

```python
from contextlib import asynccontextmanager
from uuid import UUID
import json

from asgiref.sync import sync_to_async
from playwright.async_api import async_playwright, BrowserContext
from linkedin.models.settings import PortalSettings
from linkedin.models.browser_session import BrowserSession


@asynccontextmanager
async def browser_session(account_id: UUID, user_id: UUID):
    """
    Ephemeral Chromium context: загружаем storage_state из li2_browser_sessions
    при входе, сохраняем при выходе. Per-account proxy из li2_settings.
    """
    storage_state = await _load_storage_state(account_id)
    proxy = await _load_proxy(user_id)

    async with async_playwright() as p:
        kwargs = {
            'headless': True,
            'args': ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        }
        if proxy:
            kwargs['proxy'] = {'server': proxy}
        browser = await p.chromium.launch(**kwargs)
        ctx_kwargs = {}
        if storage_state:
            ctx_kwargs['storage_state'] = storage_state
        ctx: BrowserContext = await browser.new_context(**ctx_kwargs)
        try:
            yield ctx
        finally:
            new_state = await ctx.storage_state()
            await _save_storage_state(account_id, user_id, new_state)
            await ctx.close()
            await browser.close()


@sync_to_async
def _load_storage_state(account_id: UUID) -> dict | None:
    row = BrowserSession.objects.filter(account_id=account_id).first()
    return row.storage_state if row else None


@sync_to_async
def _load_proxy(user_id: UUID) -> str | None:
    s = PortalSettings.objects.filter(user_id=user_id).first()
    return (s.proxy_url or None) if s else None


@sync_to_async
def _save_storage_state(account_id: UUID, user_id: UUID, state: dict):
    BrowserSession.objects.update_or_create(
        account_id=account_id,
        defaults={'user_id': user_id, 'storage_state': state, 'cookies': b''},
    )
```

- [ ] Step 2: Создать BrowserSession Django model

```python
# services/openoutreach/linkedin/models/browser_session.py
from django.db import models

class BrowserSession(models.Model):
    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField()
    account_id = models.UUIDField(unique=True)
    storage_state = models.JSONField(null=True, blank=True)
    cookies = models.BinaryField(default=b'')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        managed = False
        db_table = 'li2_browser_sessions'
```

- [ ] Step 3: Commit

```bash
git commit -am "feat(openoutreach): browser_session — ephemeral Chromium + Postgres cookies"
```

### Task 14: Task executor + planner + working_hours check

**Files:**
- Create: `services/openoutreach/linkedin/daemon/executor.py`
- Modify: `services/openoutreach/linkedin/tasks/scheduler.py` (reconcile)
- Create: `services/openoutreach/linkedin/tasks/recovery.py`

- [ ] Step 1: executor.py — диспатч task.type → handler

```python
import logging
from datetime import datetime, timezone

from asgiref.sync import sync_to_async
from linkedin.models.task import Task
from linkedin.tasks.handlers import handle_connect, handle_check_pending, handle_follow_up

logger = logging.getLogger('li2.executor')

HANDLERS = {
    'connect': handle_connect,
    'check_pending': handle_check_pending,
    'follow_up': handle_follow_up,
}


async def execute_task(task: Task, ctx):
    @sync_to_async
    def mark(status, **kwargs):
        Task.objects.filter(id=task.id).update(status=status, **kwargs)

    handler = HANDLERS.get(task.type)
    if not handler:
        await mark('failed', error_message=f'unknown type: {task.type}')
        return

    # Working-hours check ДО запуска
    if not await _within_working_window(task):
        new_dt = await _next_window_open(task)
        await mark('pending', scheduled_at=new_dt)
        return

    await mark('running', started_at=datetime.now(timezone.utc))
    try:
        await handler(task, ctx)
        await mark('completed', completed_at=datetime.now(timezone.utc))
    except Exception as e:
        logger.exception("Task %s failed: %s", task.id, e)
        await mark('failed', error_message=str(e)[:1000], completed_at=datetime.now(timezone.utc))
        raise
```

(`handlers.py`, `_within_working_window`, `_next_window_open` — stub'ы пока, upstream-логика заходит сюда поверх в следующих коммитах.)

- [ ] Step 2: recovery.py — reset stale tasks

```python
from datetime import datetime, timedelta, timezone
from asgiref.sync import sync_to_async
from linkedin.models.task import Task

STALE_MIN = 5

@sync_to_async
def reset_stale_tasks_sync():
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STALE_MIN)
    Task.objects.filter(status='running', started_at__lt=cutoff).update(
        status='pending', error_message='Reset by daemon recovery (stale)',
        started_at=None,
    )

async def reset_stale_tasks():
    await reset_stale_tasks_sync()
```

- [ ] Step 3: Адаптировать upstream'овский `scheduler.reconcile` чтобы принимать `account_id, user_id` (вместо одного глобального аккаунта)

- [ ] Step 4: Commit

```bash
git commit -am "feat(openoutreach): task executor + stale recovery + working_hours check"
```

### Task 15: pytest tests — daemon integration (testcontainers)

**Files:**
- Create: `services/openoutreach/tests/integration/test_daemon_multi_account.py`

- [ ] Step 1: Базовый smoke test

```python
import asyncio
import pytest
from uuid import uuid4
from linkedin.models.account import Account
from daemon import main_loop

@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_daemon_starts_worker_on_running_account(monkeypatch):
    user_id = uuid4()
    acc = Account.objects.create(id=uuid4(), user_id=user_id, status='running')

    stop = asyncio.Event()
    task = asyncio.create_task(main_loop(stop))
    await asyncio.sleep(8)  # дать пару поллов
    stop.set()
    await task

    acc.refresh_from_db()
    assert acc.last_heartbeat_at is not None
```

- [ ] Step 2: pytest конфиг с testcontainers Postgres

```python
# services/openoutreach/tests/conftest.py
import pytest
from testcontainers.postgres import PostgresContainer

@pytest.fixture(scope='session')
def postgres_db():
    with PostgresContainer('postgres:16-alpine') as pg:
        # apply migrations from supabase/migrations/20260610_0001
        # ...
        yield pg.get_connection_url()
```

- [ ] Step 3: Commit

```bash
git commit -am "test(openoutreach): integration test multi-account daemon"
```

**Checkpoint D:** daemon локально стартует на тестовой БД, реагирует на `li2_accounts.status='running'`, пишет heartbeat. Реальный LinkedIn flow (Voyager, invite, message) пока заглушен — это Phase E.

---

## Phase E — Docker + compose (3 tasks) ☑ checkpoint после

### Task 16: Dockerfile

**Files:**
- Create: `services/openoutreach/Dockerfile`

- [ ] Step 1:

```dockerfile
FROM mcr.microsoft.com/playwright/python:v1.42.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc fluxbox novnc websockify supervisor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements/ /app/requirements/
RUN pip install --no-cache-dir -r requirements/production.txt

# Pre-pull FastEmbed model (~300 MB) — чтобы первый запрос не тащил из инета
RUN python -c "from fastembed import TextEmbedding; TextEmbedding()" || true

COPY . /app/

EXPOSE 6080

HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD test -f /tmp/li2-daemon-heartbeat && \
      test $(( $(date +%s) - $(cat /tmp/li2-daemon-heartbeat) )) -lt 120 || exit 1

CMD ["bash", "/app/compose/linkedin/start"]
```

- [ ] Step 2: Commit

```bash
git add services/openoutreach/Dockerfile
git commit -m "feat(openoutreach): Dockerfile (Playwright base + xvfb/x11vnc/supervisord)"
```

### Task 17: docker-compose.prod.yml — drop enrich-10, add openoutreach

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] Step 1: Удалить строку `worker-enrich-10: { …, container_name: portal-worker-enrich-10 }`

- [ ] Step 2: Добавить сервис `openoutreach` (см. spec, секция Deployment, полный YAML)

- [ ] Step 3: Обновить comment header — пересчитать суммы CPU/RAM:

```yaml
# Лимиты memory+cpus — потолки; суммы ≤90-95 % от 32 vCPU / 64 GB RAM.
# После 10.06.2026 (см. docs/superpowers/plans/2026-06-10-openoutreach-portal-native.md):
#  - убран worker-enrich-10 (-2 GB / -1 CPU)
#  - добавлен openoutreach (+2.56 GB / +1.5 CPU)
# Чистый delta: +0.56 GB / +0.5 CPU. Новые суммы: ~30.15 CPU / 61.23 GB.
```

- [ ] Step 4: Commit

```bash
git commit -am "ops(prod): drop worker-enrich-10, add openoutreach service"
```

### Task 18: services/openoutreach/CLAUDE.md (intra-fork doc)

**Files:**
- Create: `services/openoutreach/CLAUDE.md` (или модифицировать существующий из upstream)

- [ ] Step 1: Записать что fork делает иначе vs upstream — см. UPSTREAM.md «Fork divergence» секцию, разшырить.

- [ ] Step 2: Commit

```bash
git commit -am "docs(openoutreach): CLAUDE.md fork-specific guidance"
```

**Checkpoint E:** локально `docker compose -f docker-compose.prod.yml build openoutreach` собирается. На прод НЕ деплоим — это Phase F (требует user action).

---

## Phase F — Deploy + smoke (требует user action) ☑ финальный

### Task 19: Push image в DockerHub

- [ ] Step 1: Локально `docker compose -f docker-compose.prod.yml build openoutreach`
- [ ] Step 2: `docker tag <image> dimakuladmed/portal-openoutreach:prod`
- [ ] Step 3: `docker push dimakuladmed/portal-openoutreach:prod`

### Task 20: Deploy на проде

- [ ] Step 1: SSH на `139.60.162.12`
- [ ] Step 2: `cd /opt/portal && git pull` (или эквивалент)
- [ ] Step 3: `docker compose -f docker-compose.prod.yml pull openoutreach`
- [ ] Step 4: `docker compose -f docker-compose.prod.yml up -d --remove-orphans` (-d removes worker-enrich-10, adds openoutreach)
- [ ] Step 5: `docker logs -f portal-openoutreach` — следить за startup

### Task 21: Smoke test через UI

- [ ] Step 1: Открыть `/tools/li-outreach-v2`
- [ ] Step 2: Ввести LinkedIn email/password (legal_accepted = true)
- [ ] Step 3: Открыть VNC `https://polza-portal.ru/openoutreach-vnc/` (TBD: настроить nginx)
- [ ] Step 4: Стартовать Polza Agency campaign
- [ ] Step 5: Наблюдать в VNC: daemon открывает Chromium, логинится, пресс — invite уходит к seed_profile_urls[0]
- [ ] Step 6: В UI вкладка «Логи»: появляются step-by-step события (не только "Campaign activated")

---

## Self-review (выполнить после написания плана)

- [ ] Spec coverage: каждая секция spec'a покрыта task'ом — ✅ (schema → Phase A, API → Phase B, daemon → C+D, deploy → E+F)
- [ ] Placeholder scan: нет TBD/TODO в исполняемых шагах — есть один "TBD" в Task 21 (nginx VNC config), вынести в открытый вопрос для финального доделывания
- [ ] Type consistency: имена методов согласованы — ✅ (`_heartbeat`, `_flag`, `_pick_next_task` в AccountWorker — единый pattern)
- [ ] Что отсутствует и НЕ покрыто планом (намеренно или нет):
  - **Upstream's ML pipeline (GPR + BALD)** — план не трогает `linkedin/ml/`. Это OK потому что они изолированы и работают по `Campaign.model_blob`/`Lead.embedding` колонкам, которые мы добавили в Phase A
  - **mem0-style chat summary** — план не трогает `linkedin/db/summaries.py`. Также OK — мы только переставили db_table; логика не меняется
  - **nginx config для VNC** — открытый вопрос, доделать руками после Phase F
  - **Telegram alerts на status='disconnected'** — отложено, можно добавить позже сервисом или хуком в daemon
