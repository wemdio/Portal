# TG-outreach Dialog Sync + Message Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three interlocking capabilities to the tg-outreach worker — (1) mark every outgoing message with its author (`portal` / `external` / `unknown`), (2) batch-import dialogs by username list, (3) auto-sync dialogs when an account is first connected.

**Architecture:** Additive on top of the existing worker pipeline. New DB table `tg_outreach_sent_messages` for durable message-ID tracking. Extended `DialogMessage` JSONB with `sent_by` + `tg_msg_id`. Two new job kinds (`import_dialogs`, `autosync_dialogs`) handled by the existing worker. New UI in `CampaignAccountsTab` for manual import + sync status chip.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Supabase (self-hosted Postgres at `144.31.54.166`), Docker Compose, gramJS (`telegram` npm package), Tailwind CSS, Vitest.

**Reference spec:** [docs/superpowers/specs/2026-07-22-tg-outreach-dialog-sync-design.md](../specs/2026-07-22-tg-outreach-dialog-sync-design.md)

---

## File Structure

### Phase 1 — Message provenance markers

**Database:**
- Create: `supabase/migrations/20260722_0001_tg_outreach_sent_messages.sql`

**Types:**
- Modify: `app/src/lib/tgOutreach/types.ts` — extend `DialogMessage`, add `SentByKind`

**Worker code:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts`
  - `extractMessagesFromHistory` (line 510-542) — reconcile with `tg_outreach_sent_messages`
  - Three `client.sendMessage` sites (lines 941, 1071, 1199) — record `sent.id` into new table + include markers in JSONB

**Tests:**
- Create: `app/tests/lib/tgOutreach/messageProvenance.test.ts`

### Phase 2 — Batch import by username list

**Database:**
- Create: `supabase/migrations/20260722_0002_tg_outreach_jobs_import.sql` — relax `action` check, add `payload jsonb`, add `progress jsonb`

**Types:**
- Modify: `app/src/lib/tgOutreach/types.ts` — add `'import_dialogs'` to `JobAction`

**API routes:**
- Create: `app/src/app/api/tools/tg-outreach/accounts/[id]/import-dialogs/route.ts`

**Worker code:**
- Create: `app/src/lib/tgOutreach/dialogImport.ts` — `runImportDialogsJob(client, account, campaign, payload, db, log, shouldStop)`
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts` — dispatch `import_dialogs` jobs

**UI:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx` — add `ImportDialogsModal` inside `CampaignAccountsTab`

**Tests:**
- Create: `app/tests/lib/tgOutreach/dialogImport.test.ts`

### Phase 3 — Autosync on account connect

**Database:**
- Create: `supabase/migrations/20260722_0003_tg_outreach_accounts_autosync.sql` — add `initial_sync_state`, `initial_sync_started_at`, `initial_sync_finished_at`, `initial_sync_stats`

**Types:**
- Modify: `app/src/lib/tgOutreach/types.ts` — add `autosync_days_lookback` to `TelegramSettings`, extend `OutreachAccount`, add `'autosync_dialogs'` to `JobAction`

**API routes:**
- Modify: `app/src/app/api/tools/tg-outreach/accounts/route.ts` — auto-enqueue autosync on POST
- Modify: `app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts` — auto-enqueue autosync for each uploaded account
- Create: `app/src/app/api/tools/tg-outreach/accounts/[id]/resync/route.ts` — manual re-trigger

**Worker code:**
- Modify: `app/src/lib/tgOutreach/dialogImport.ts` — add `runAutosyncJob(client, account, campaign, db, log, shouldStop)` (reuses core loop)
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts` — dispatch `autosync_dialogs` jobs, gate account processing on `initial_sync_state`

**UI:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx` — sync status chip on each account row, "Пересинхронизировать" button

**Tests:**
- Modify: `app/tests/lib/tgOutreach/dialogImport.test.ts` — add autosync scenarios

---

# Phase 1 — Message Provenance Markers

## Task 1.1: Migration for `tg_outreach_sent_messages`

**Files:**
- Create: `supabase/migrations/20260722_0001_tg_outreach_sent_messages.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Durable per-message record of every outgoing message the tg-outreach worker
-- sent through an account. Lets the parser distinguish "we sent this" from
-- "somebody else sent this via the same account" when it re-reads Telegram
-- history — the JSONB messages array on tg_outreach_dialogs gets overwritten
-- on every sync cycle, so we need a separate immutable log.

create table if not exists public.tg_outreach_sent_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  tg_user_id bigint not null,
  tg_msg_id bigint not null,
  text text not null,
  sent_at timestamptz not null default now()
);

-- Reconciliation lookup: given (account, peer, msg_id) from a getHistory scan,
-- was this message sent by us?
create unique index if not exists tg_outreach_sent_messages_account_peer_msg_uk
  on public.tg_outreach_sent_messages (account_id, tg_user_id, tg_msg_id);

create index if not exists tg_outreach_sent_messages_campaign_idx
  on public.tg_outreach_sent_messages (campaign_id);

alter table public.tg_outreach_sent_messages enable row level security;

-- Same ownership model as tg_outreach_dialogs: campaign owner + shared_read.
create policy tg_outreach_sent_messages_select_own on public.tg_outreach_sent_messages
  for select using (
    exists (
      select 1 from public.tg_outreach_campaigns c
      where c.id = tg_outreach_sent_messages.campaign_id
        and c.user_id = auth.uid()
    )
  );

create policy tg_outreach_sent_messages_insert_own on public.tg_outreach_sent_messages
  for insert with check (
    exists (
      select 1 from public.tg_outreach_campaigns c
      where c.id = tg_outreach_sent_messages.campaign_id
        and c.user_id = auth.uid()
    )
  );

-- Service role bypasses RLS; the worker writes with service key.

comment on table public.tg_outreach_sent_messages is
  'Immutable log of every message the tg-outreach worker sent through an account. Used to reconcile "ours vs external" when re-reading Telegram history. See docs/superpowers/specs/2026-07-22-tg-outreach-dialog-sync-design.md.';
```

- [ ] **Step 2: Apply migration locally**

Run: `cd app && npm run db:migrate:local`
Expected: migration `20260722_0001_tg_outreach_sent_messages` applied, no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260722_0001_tg_outreach_sent_messages.sql
git commit -m "feat(tg-outreach): add tg_outreach_sent_messages table for message provenance"
```

## Task 1.2: Extend `DialogMessage` type

**Files:**
- Modify: `app/src/lib/tgOutreach/types.ts:157-161`

- [ ] **Step 1: Add SentByKind + extend DialogMessage**

Replace the existing `DialogMessage` block with:

```ts
export type SentByKind = 'portal' | 'external' | 'unknown';

export interface DialogMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** Populated for role='assistant' only. 'portal' = our worker sent it (we
   *  recorded tg_msg_id at send time); 'external' = someone else sent it via
   *  the same account (usually tg ninja or manual reply); 'unknown' = we can't
   *  tell (imported from Telegram history without a matching tg_outreach_sent_messages
   *  record). Older data pre-migration is treated as 'unknown'. */
  sent_by?: SentByKind;
  /** Telegram message ID. Used to reconcile against tg_outreach_sent_messages. */
  tg_msg_id?: number;
}
```

- [ ] **Step 2: Type-check**

Run: `cd app && npm run typecheck`
Expected: PASS (only additive fields, all existing code compiles).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/tgOutreach/types.ts
git commit -m "feat(tg-outreach): extend DialogMessage with sent_by + tg_msg_id"
```

## Task 1.3: Record `tg_msg_id` at every sendMessage site

**Files:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts:941`, `:1071`, `:1199`

- [ ] **Step 1: Add helper `recordSentMessage`**

Insert after the `markProcessed` helper (line ~570 area, before `upsertDialog`):

```ts
async function recordSentMessage(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  tgUserId: number,
  tgMsgId: number,
  text: string,
) {
  const { error } = await db.from('tg_outreach_sent_messages').insert({
    campaign_id: campaignId,
    account_id: accountId,
    tg_user_id: tgUserId,
    tg_msg_id: tgMsgId,
    text,
  });
  if (error && !error.message.includes('duplicate key')) {
    // Non-duplicate errors are worth logging but must not block the send —
    // sending already succeeded; provenance is best-effort.
    throw new Error(`recordSentMessage failed: ${error.message}`);
  }
}
```

- [ ] **Step 2: Update handleChat send site (line ~941)**

Replace:
```ts
const sent = await client.sendMessage(entity, { message: replyText });
log('info', `${displayName}: ответ отправлен (${replyText.length} символов)`);

chatMessages.push({
  role: 'assistant',
  content: replyText,
  timestamp: new Date().toISOString(),
});
```

With:
```ts
const sent = await client.sendMessage(entity, { message: replyText });
log('info', `${displayName}: ответ отправлен (${replyText.length} символов)`);

try {
  await recordSentMessage(db, campaign.id, account.id, tgUserId, Number(sent.id), replyText);
} catch (err) {
  log('warning', `${displayName}: не смог записать provenance отправленного сообщения — ${err instanceof Error ? err.message : String(err)}`);
}

chatMessages.push({
  role: 'assistant',
  content: replyText,
  timestamp: new Date().toISOString(),
  sent_by: 'portal',
  tg_msg_id: Number(sent.id),
});
```

- [ ] **Step 3: Update handleFollowUp send site (line ~1071)**

Locate the block:
```ts
await client.sendMessage(entity, { message: reply });
```

Just before it, capture the sent object; after it, record + mark. The block becomes:

```ts
const sent = await client.sendMessage(entity, { message: reply });
try {
  await recordSentMessage(db, campaign.id, account.id, tgUserId, Number(sent.id), reply);
} catch (err) {
  log('warning', `Follow-up: не смог записать provenance для ${tgUsername ?? tgUserId} — ${err instanceof Error ? err.message : String(err)}`);
}

messages.push({
  role: 'assistant',
  content: reply,
  timestamp: new Date().toISOString(),
  sent_by: 'portal',
  tg_msg_id: Number(sent.id),
});
```

Update the existing `messages.push` above to match (add sent_by, tg_msg_id).

- [ ] **Step 4: Update handleMissedRepliesLastDays send site (line ~1199)**

Same pattern as Step 3 — replace the current send + push block with:

```ts
const sent = await client.sendMessage(entity, { message: reply });
try {
  await recordSentMessage(db, campaign.id, account.id, tgUserId, Number(sent.id), reply);
} catch (err) {
  log('warning', `Catch-up: не смог записать provenance для ${tgUsername ?? tgUserId} — ${err instanceof Error ? err.message : String(err)}`);
}

messages.push({
  role: 'assistant',
  content: reply,
  timestamp: new Date().toISOString(),
  sent_by: 'portal',
  tg_msg_id: Number(sent.id),
});
```

- [ ] **Step 5: Type-check**

Run: `cd app && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/tgOutreach/campaignLoop.ts
git commit -m "feat(tg-outreach): tag outgoing messages with sent_by='portal' + tg_msg_id"
```

## Task 1.4: Reconcile history reads with sent-messages log

**Files:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts:510-542` (`extractMessagesFromHistory`)

- [ ] **Step 1: Write the failing test**

Create `app/tests/lib/tgOutreach/messageProvenance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Import the pure reconciliation helper (to be extracted in Step 2).
import { reconcileOutgoingProvenance } from '@/lib/tgOutreach/messageProvenance';

describe('reconcileOutgoingProvenance', () => {
  it('marks outgoing msg with matching tg_msg_id as portal', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ tg_msg_id: 100 }, { tg_msg_id: 101 }], error: null }),
      })),
    } as unknown as SupabaseClient;

    const incoming = [
      { role: 'assistant' as const, content: 'ours', tg_msg_id: 100 },
      { role: 'assistant' as const, content: 'theirs', tg_msg_id: 200 },
      { role: 'user' as const, content: 'reply' },
    ];

    const result = await reconcileOutgoingProvenance(db, 'acc-id', 12345, incoming);

    expect(result[0].sent_by).toBe('portal');
    expect(result[1].sent_by).toBe('external');
    expect(result[2].sent_by).toBeUndefined();
  });

  it('handles empty tg_msg_id (no reconciliation possible)', async () => {
    const db = {} as SupabaseClient;
    const incoming = [{ role: 'assistant' as const, content: 'old', /* no tg_msg_id */ }];
    const result = await reconcileOutgoingProvenance(db, 'acc-id', 12345, incoming);
    expect(result[0].sent_by).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run tests/lib/tgOutreach/messageProvenance.test.ts`
Expected: FAIL with "Cannot find module '@/lib/tgOutreach/messageProvenance'"

- [ ] **Step 3: Create helper module**

Create `app/src/lib/tgOutreach/messageProvenance.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DialogMessage } from './types';

/**
 * Given a batch of freshly-parsed history messages, look up which outgoing
 * ones we (portal) actually sent (by tg_msg_id in tg_outreach_sent_messages)
 * and tag each accordingly. Runs one bulk query per call (not per message).
 *
 * Outgoing messages WITHOUT a tg_msg_id (imported from historical data
 * before this migration existed) are tagged 'unknown' — we cannot retroactively
 * determine authorship without the msg id.
 */
export async function reconcileOutgoingProvenance(
  db: SupabaseClient,
  accountId: string,
  tgUserId: number,
  messages: DialogMessage[],
): Promise<DialogMessage[]> {
  const outgoingIds = messages
    .filter(m => m.role === 'assistant' && typeof m.tg_msg_id === 'number')
    .map(m => m.tg_msg_id as number);

  let portalIds = new Set<number>();
  if (outgoingIds.length > 0) {
    const { data, error } = await db
      .from('tg_outreach_sent_messages')
      .select('tg_msg_id')
      .eq('account_id', accountId)
      .eq('tg_user_id', tgUserId)
      .in('tg_msg_id', outgoingIds);
    if (!error && data) {
      portalIds = new Set(data.map((r: { tg_msg_id: number }) => r.tg_msg_id));
    }
  }

  return messages.map((m): DialogMessage => {
    if (m.role !== 'assistant') return m;
    if (typeof m.tg_msg_id !== 'number') return { ...m, sent_by: 'unknown' };
    return { ...m, sent_by: portalIds.has(m.tg_msg_id) ? 'portal' : 'external' };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run tests/lib/tgOutreach/messageProvenance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire helper into `extractMessagesFromHistory`**

Modify `campaignLoop.ts:510-542`. The function currently returns plain `DialogMessage[]`. Change it to also capture `tg_msg_id` per message, then let the caller reconcile (since caller has `db`, `account.id`, `tgUserId`).

Replace lines 517-541 (inside the `for (const msg of history)` loop and return):

```ts
  const chatMessages: DialogMessage[] = [];
  for (const msg of history) {
    const isOut = msg.out ?? false;
    const role = isOut ? 'assistant' : 'user';
    const timestamp = msg.date ? new Date(msg.date * 1000).toISOString() : undefined;
    const mediaTag = describeMediaType(msg);
    const tgMsgId = typeof msg.id === 'number' ? msg.id : Number(msg.id ?? 0) || undefined;

    if (msg.message) {
      const content = mediaTag ? `[${mediaTag}] ${msg.message}` : msg.message;
      chatMessages.push({ role, content, timestamp, ...(isOut && tgMsgId ? { tg_msg_id: tgMsgId } : {}) });
      continue;
    }

    if (!isOut && isVoiceOrAudioMessage(msg)) {
      const text = await transcribeVoice(client, msg, log, label);
      if (text) {
        chatMessages.push({ role: 'user', content: `[Голосовое сообщение]: ${text}`, timestamp });
        continue;
      }
    }

    if (mediaTag) {
      chatMessages.push({ role, content: `[${mediaTag}]`, timestamp, ...(isOut && tgMsgId ? { tg_msg_id: tgMsgId } : {}) });
    }
  }
  return chatMessages;
```

At every call site of `extractMessagesFromHistory` (lines ~878, ~883, ~1285, ~2005), wrap the result with `reconcileOutgoingProvenance`. Example for line 878:

Before:
```ts
history = await client.getMessages(entity, { limit: tg.history_limit });
// ... uses history directly downstream to extractMessagesFromHistory
```

The extracted array flows to `chatMessages`. After `extractMessagesFromHistory` returns, add:

```ts
const rawMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, refetchLabel);
const chatMessages = await reconcileOutgoingProvenance(db, account.id, tgUserId, rawMessages);
```

Do the same for the other three call sites. Import `reconcileOutgoingProvenance` at the top of the file.

- [ ] **Step 6: Type-check + full test suite**

Run: `cd app && npm run typecheck && npx vitest run tests/lib/tgOutreach/`
Expected: PASS all.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/tgOutreach/messageProvenance.ts app/src/lib/tgOutreach/campaignLoop.ts app/tests/lib/tgOutreach/messageProvenance.test.ts
git commit -m "feat(tg-outreach): reconcile outgoing history with sent-messages log"
```

**Phase 1 checkpoint** — deploy to staging, verify a live campaign cycle:
1. Send one reply → check `tg_outreach_sent_messages` has a row with `tg_msg_id`.
2. Wait for next scan cycle → check `tg_outreach_dialogs.messages` shows `sent_by:'portal'` on that message.
3. From tg ninja (or manually), send another message via same account → next scan should tag it `sent_by:'external'`.

---

# Phase 2 — Batch Import by Username List

## Task 2.1: Migration — extend jobs table with `payload` + `progress`, add new action

**Files:**
- Create: `supabase/migrations/20260722_0002_tg_outreach_jobs_import.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Extend tg_outreach_jobs to support the new import_dialogs job kind.
-- Adds a JSONB payload for the input list and a JSONB progress field the
-- worker updates as it iterates, so the UI can show "45 / 120" style status.

alter table public.tg_outreach_jobs
  drop constraint if exists tg_outreach_jobs_action_check;

alter table public.tg_outreach_jobs
  add constraint tg_outreach_jobs_action_check
    check (action in ('start','stop','restart','refetch_messages','import_dialogs'));

alter table public.tg_outreach_jobs
  add column if not exists payload jsonb;

alter table public.tg_outreach_jobs
  add column if not exists progress jsonb;

alter table public.tg_outreach_jobs
  add column if not exists account_id uuid references public.tg_outreach_accounts(id) on delete cascade;

create index if not exists tg_outreach_jobs_account_idx
  on public.tg_outreach_jobs (account_id) where account_id is not null;

comment on column public.tg_outreach_jobs.payload is
  'Job-specific input (e.g. import_dialogs: {"usernames": ["@foo", "@bar"]}). NULL for legacy start/stop jobs.';
comment on column public.tg_outreach_jobs.progress is
  'Worker-updated {"done": N, "total": M, "failed": K}. NULL until the job starts running.';
```

- [ ] **Step 2: Apply + commit**

Run: `cd app && npm run db:migrate:local`
Expected: applied, no errors.

```bash
git add supabase/migrations/20260722_0002_tg_outreach_jobs_import.sql
git commit -m "feat(tg-outreach): add import_dialogs job kind + payload/progress fields"
```

## Task 2.2: Extend `JobAction` type + `TgOutreachJob` shape

**Files:**
- Modify: `app/src/lib/tgOutreach/types.ts:69`

- [ ] **Step 1: Update type**

Find:
```ts
export type JobAction = 'start' | 'stop' | 'restart' | 'refetch_messages';
```

Replace with:
```ts
export type JobAction = 'start' | 'stop' | 'restart' | 'refetch_messages' | 'import_dialogs' | 'autosync_dialogs';

export interface ImportDialogsPayload {
  usernames?: string[];
  tg_user_ids?: number[];
}

export interface JobProgress {
  done: number;
  total: number;
  failed: number;
}
```

Locate the `TgOutreachJob` interface (search for `campaign_id: string;\n  user_id: string;` near line ~200). Add:
```ts
  account_id?: string | null;
  payload?: ImportDialogsPayload | null;
  progress?: JobProgress | null;
```

- [ ] **Step 2: Type-check + commit**

Run: `cd app && npm run typecheck`
Expected: PASS.

```bash
git add app/src/lib/tgOutreach/types.ts
git commit -m "feat(tg-outreach): add import_dialogs job types"
```

## Task 2.3: Extract dialog-fetch helper (foundation for import + autosync)

**Files:**
- Create: `app/src/lib/tgOutreach/dialogImport.ts`

- [ ] **Step 1: Write failing test**

Create `app/tests/lib/tgOutreach/dialogImport.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchAndStoreDialogHistory } from '@/lib/tgOutreach/dialogImport';

const makeClient = () => ({
  getEntity: vi.fn(async (id: string | number) => ({
    id: typeof id === 'number' ? id : 999,
    className: 'User',
    username: typeof id === 'string' ? id.replace('@', '') : undefined,
  })),
  getMessages: vi.fn(async () => [
    { id: 100, out: true, message: 'hi', date: 1700000000 },
    { id: 101, out: false, message: 'hello', date: 1700000010 },
  ]),
});

const makeDb = () => {
  const state = { upsertedRows: [] as unknown[] };
  return {
    state,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn(async (row) => { state.upsertedRows.push(row); return { data: row, error: null }; }),
      update: vi.fn().mockReturnThis(),
    })),
  };
};

describe('fetchAndStoreDialogHistory', () => {
  it('stores dialog with sent_by=external for outgoing without matching sent-message record', async () => {
    const client = makeClient();
    const { from, state } = makeDb();
    await fetchAndStoreDialogHistory({
      client: client as any,
      db: { from } as any,
      campaignId: 'camp-1',
      accountId: 'acc-1',
      target: { username: 'foo' },
      historyLimit: 20,
      log: () => {},
    });
    expect(client.getEntity).toHaveBeenCalledWith('foo');
    expect(client.getMessages).toHaveBeenCalled();
    const inserted = state.upsertedRows[0] as { messages: { sent_by?: string; role: string }[] };
    expect(inserted.messages.find(m => m.role === 'assistant')?.sent_by).toBe('external');
  });
});
```

- [ ] **Step 2: Run test — expect fail**

Run: `cd app && npx vitest run tests/lib/tgOutreach/dialogImport.test.ts`
Expected: FAIL "Cannot find module '@/lib/tgOutreach/dialogImport'"

- [ ] **Step 3: Implement `fetchAndStoreDialogHistory`**

Create `app/src/lib/tgOutreach/dialogImport.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import type { DialogMessage } from './types';
import { reconcileOutgoingProvenance } from './messageProvenance';

export type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface FetchTarget {
  username?: string;
  tg_user_id?: number;
}

export interface FetchOptions {
  client: TelegramClient;
  db: SupabaseClient;
  campaignId: string;
  accountId: string;
  target: FetchTarget;
  historyLimit: number;
  log: LogFn;
}

export async function fetchAndStoreDialogHistory(opts: FetchOptions): Promise<'ok' | 'not_user' | 'error'> {
  const { client, db, campaignId, accountId, target, historyLimit, log } = opts;
  const label = target.username ? `@${target.username}` : `ID:${target.tg_user_id}`;

  let entity;
  try {
    entity = target.tg_user_id
      ? await client.getEntity(target.tg_user_id)
      : await client.getEntity(target.username!);
  } catch (err) {
    log('warning', `Импорт: не нашёл ${label} — ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }

  if (!(entity instanceof Api.User)) {
    log('info', `Импорт: ${label} — не пользователь (группа/канал), пропускаю`);
    return 'not_user';
  }

  const tgUserId = Number(entity.id);
  const tgUsername = entity.username ?? null;
  const tgIsBot = Boolean(entity.bot);

  const history = await client.getMessages(entity, { limit: historyLimit });

  const rawMessages: DialogMessage[] = [];
  for (const msg of [...history].reverse()) {
    const isOut = msg.out ?? false;
    const role = isOut ? 'assistant' : 'user';
    const timestamp = msg.date ? new Date(msg.date * 1000).toISOString() : undefined;
    if (msg.message) {
      const tgMsgId = typeof msg.id === 'number' ? msg.id : Number(msg.id ?? 0) || undefined;
      rawMessages.push({
        role,
        content: msg.message,
        timestamp,
        ...(isOut && tgMsgId ? { tg_msg_id: tgMsgId } : {}),
      });
    }
  }

  const chatMessages = await reconcileOutgoingProvenance(db, accountId, tgUserId, rawMessages);
  const lastTs = chatMessages[chatMessages.length - 1]?.timestamp ?? new Date().toISOString();

  const { data: existing } = await db
    .from('tg_outreach_dialogs')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();

  if (existing) {
    await db.from('tg_outreach_dialogs').update({
      messages: chatMessages,
      tg_username: tgUsername,
      tg_is_bot: tgIsBot,
      last_message_at: lastTs,
    }).eq('id', existing.id);
  } else {
    await db.from('tg_outreach_dialogs').insert({
      campaign_id: campaignId,
      account_id: accountId,
      tg_user_id: tgUserId,
      tg_username: tgUsername,
      tg_is_bot: tgIsBot,
      can_send: !tgIsBot,
      messages: chatMessages,
      last_message_at: lastTs,
      status: 'none',
    });
  }

  log('info', `Импорт: ${label} — сохранил ${chatMessages.length} сообщений`);
  return 'ok';
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `cd app && npx vitest run tests/lib/tgOutreach/dialogImport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tgOutreach/dialogImport.ts app/tests/lib/tgOutreach/dialogImport.test.ts
git commit -m "feat(tg-outreach): fetchAndStoreDialogHistory helper for one-shot dialog imports"
```

## Task 2.4: Implement `runImportDialogsJob` + wire into worker dispatcher

**Files:**
- Modify: `app/src/lib/tgOutreach/dialogImport.ts`
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts` (job dispatcher — find where `refetch_messages` is handled)

- [ ] **Step 1: Add `runImportDialogsJob` to dialogImport.ts**

Append to `app/src/lib/tgOutreach/dialogImport.ts`:

```ts
export interface ImportJobOptions {
  client: TelegramClient;
  db: SupabaseClient;
  campaignId: string;
  accountId: string;
  jobId: string;
  payload: { usernames?: string[]; tg_user_ids?: number[] };
  historyLimit: number;
  log: LogFn;
  shouldStop?: () => boolean;
  /** Seconds between fetches to avoid FloodWait. Default 1.5s. */
  delayMs?: number;
}

export async function runImportDialogsJob(opts: ImportJobOptions): Promise<void> {
  const { client, db, campaignId, accountId, jobId, payload, historyLimit, log, shouldStop, delayMs = 1500 } = opts;

  const targets: FetchTarget[] = [
    ...(payload.usernames ?? []).map(u => ({ username: u.replace(/^@/, '').trim() })).filter(t => t.username),
    ...(payload.tg_user_ids ?? []).map(id => ({ tg_user_id: id })),
  ];

  const total = targets.length;
  let done = 0;
  let failed = 0;

  log('info', `Импорт диалогов: начинаю обработку ${total} целей`);
  await db.from('tg_outreach_jobs').update({ progress: { done: 0, total, failed: 0 } }).eq('id', jobId);

  for (const target of targets) {
    if (shouldStop?.()) {
      log('warning', 'Импорт диалогов: получен сигнал остановки, прерываю');
      break;
    }
    try {
      const result = await fetchAndStoreDialogHistory({
        client, db, campaignId, accountId, target, historyLimit, log,
      });
      if (result === 'error' || result === 'not_user') failed++;
    } catch (err) {
      failed++;
      log('warning', `Импорт: ошибка при ${target.username ?? target.tg_user_id} — ${err instanceof Error ? err.message : String(err)}`);
    }
    done++;
    await db.from('tg_outreach_jobs').update({ progress: { done, total, failed } }).eq('id', jobId);
    await new Promise(res => setTimeout(res, delayMs));
  }

  log('info', `Импорт диалогов завершён: успешно ${done - failed} / ${total}, ошибок ${failed}`);
}
```

- [ ] **Step 2: Locate job dispatcher in `campaignLoop.ts`**

Search: `grep -n "refetch_messages" app/src/lib/tgOutreach/campaignLoop.ts` — find the `switch` or `if` chain that dispatches on `job.action`.

- [ ] **Step 3: Add `import_dialogs` branch**

In the dispatcher, alongside the existing action branches, add:

```ts
if (job.action === 'import_dialogs') {
  if (!job.account_id) {
    await db.from('tg_outreach_jobs').update({ status: 'failed', error_message: 'account_id required for import_dialogs' }).eq('id', job.id);
    continue;
  }
  const { data: account } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .eq('id', job.account_id)
    .single();
  if (!account) {
    await db.from('tg_outreach_jobs').update({ status: 'failed', error_message: 'account not found' }).eq('id', job.id);
    continue;
  }
  const client = await getOrCreateClient(account); // reuse existing helper
  await runImportDialogsJob({
    client,
    db,
    campaignId: job.campaign_id,
    accountId: job.account_id,
    jobId: job.id,
    payload: job.payload ?? {},
    historyLimit: (campaign.telegram_settings as TelegramSettings).history_limit ?? 20,
    log: perCampaignLog,
    shouldStop,
  });
  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
  continue;
}
```

(Adapt `getOrCreateClient` and `perCampaignLog` names to match what's actually in `campaignLoop.ts` — the plan executor should search the file for the equivalent helpers before pasting.)

- [ ] **Step 4: Type-check**

Run: `cd app && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tgOutreach/dialogImport.ts app/src/lib/tgOutreach/campaignLoop.ts
git commit -m "feat(tg-outreach): worker dispatch for import_dialogs jobs"
```

## Task 2.5: API route to enqueue import job

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/accounts/[id]/import-dialogs/route.ts`

- [ ] **Step 1: Write the route**

Create the file:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabaseRoute';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const db = createRouteClient(req);
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const usernames = Array.isArray(body.usernames) ? body.usernames.filter((s: unknown) => typeof s === 'string' && s.trim().length > 0) : [];
  const tgUserIds = Array.isArray(body.tg_user_ids) ? body.tg_user_ids.filter((n: unknown) => typeof n === 'number') : [];

  if (usernames.length === 0 && tgUserIds.length === 0) {
    return NextResponse.json({ error: 'usernames or tg_user_ids required' }, { status: 400 });
  }

  const { data: account, error: accErr } = await db
    .from('tg_outreach_accounts')
    .select('id, campaign_id')
    .eq('id', params.id)
    .single();
  if (accErr || !account) return NextResponse.json({ error: 'account not found' }, { status: 404 });

  const { data: job, error: jobErr } = await db
    .from('tg_outreach_jobs')
    .insert({
      campaign_id: account.campaign_id,
      account_id: account.id,
      user_id: user.id,
      action: 'import_dialogs',
      payload: { usernames, tg_user_ids: tgUserIds },
    })
    .select('id')
    .single();
  if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 500 });

  return NextResponse.json({ job_id: job.id, queued: usernames.length + tgUserIds.length });
}
```

- [ ] **Step 2: Manual smoke test**

Run: `cd app && npm run dev` in one terminal, then:

```bash
curl -X POST http://localhost:3000/api/tools/tg-outreach/accounts/<test-account-uuid>/import-dialogs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <test-jwt>" \
  -d '{"usernames": ["@testuser"]}'
```

Expected: `{"job_id": "...", "queued": 1}`. Then `SELECT * FROM tg_outreach_jobs WHERE action = 'import_dialogs' ORDER BY created_at DESC LIMIT 1;` should show the row.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/tg-outreach/accounts/[id]/import-dialogs/route.ts
git commit -m "feat(tg-outreach): API route to enqueue import_dialogs jobs"
```

## Task 2.6: UI — import modal in CampaignAccountsTab

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx` (`CampaignAccountsTab` around line 1167)

- [ ] **Step 1: Add modal component + state**

Inside `CampaignAccountsTab`, after the existing `useState` block, add:

```tsx
const [importForAccount, setImportForAccount] = useState<OutreachAccount | null>(null);
const [importText, setImportText] = useState('');
const [importSubmitting, setImportSubmitting] = useState(false);
const [importResult, setImportResult] = useState<string | null>(null);

const submitImport = async () => {
  if (!importForAccount) return;
  const usernames = importText
    .split(/[\n,;]/)
    .map(s => s.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (usernames.length === 0) return;
  setImportSubmitting(true);
  setImportResult(null);
  try {
    const res = await authFetch(`${API_BASE}/accounts/${importForAccount.id}/import-dialogs`, {
      method: 'POST',
      body: JSON.stringify({ usernames }),
    });
    if (res.ok) {
      const d = await res.json() as { queued: number };
      setImportResult(`В очереди: ${d.queued} диалогов. Прогресс появится в логах кампании через минуту.`);
      setImportText('');
    } else {
      const d = await res.json() as { error?: string };
      setImportResult(`Ошибка: ${d.error ?? 'unknown'}`);
    }
  } finally {
    setImportSubmitting(false);
  }
};
```

- [ ] **Step 2: Add trigger button on each account row**

Find the account row rendering in `CampaignAccountsTab`. Next to the existing action buttons (proxy edit, delete), add:

```tsx
<button
  type="button"
  onClick={() => { setImportForAccount(acc); setImportText(''); setImportResult(null); }}
  title="Импортировать диалоги по списку @usernames"
  className="text-xs text-indigo-600 hover:underline"
>
  Импорт
</button>
```

- [ ] **Step 3: Add modal markup at end of `CampaignAccountsTab` return**

Before the closing `</div>`, add:

```tsx
{importForAccount && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setImportForAccount(null)}>
    <div className="bg-white rounded-lg shadow-xl p-5 w-[520px] max-w-[92vw]" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Импорт диалогов — {importForAccount.session_name}</h3>
        <button onClick={() => setImportForAccount(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
      </div>
      <p className="text-xs text-gray-500 mb-2">Вставь @usernames — по одному на строку (или через запятую). Воркер пройдёт по каждому и подтянет последние {'{'}history_limit{'}'} сообщений в этот аккаунт.</p>
      <textarea
        value={importText}
        onChange={e => setImportText(e.target.value)}
        rows={10}
        placeholder={'@user1\n@user2\n@user3'}
        className="w-full border rounded-md px-3 py-2 text-sm font-mono"
      />
      {importResult && (
        <div className="mt-2 text-xs rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-emerald-800">{importResult}</div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => setImportForAccount(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">Отмена</button>
        <button
          onClick={submitImport}
          disabled={importSubmitting || !importText.trim()}
          className="px-3 py-1.5 text-xs font-semibold rounded-full bg-indigo-600 text-white disabled:opacity-50"
        >
          {importSubmitting ? 'Отправка...' : 'Импортировать'}
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Manual test in browser**

Start dev server, open a campaign → Accounts tab → click "Импорт" on an account → paste `@some_test_username` → submit → verify success message + check `tg_outreach_jobs` in DB.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): UI modal for batch dialog import"
```

**Phase 2 checkpoint** — deploy to staging, run one real import of 5-10 known @usernames, verify:
- Job status flips `pending` → `running` → `completed`.
- `tg_outreach_jobs.progress` fills as it goes.
- `tg_outreach_dialogs` has rows for each imported target with `sent_by:'external'` on outgoing messages.

---

# Phase 3 — Autosync on Account Connect

## Task 3.1: Migration — autosync columns on accounts

**Files:**
- Create: `supabase/migrations/20260722_0003_tg_outreach_accounts_autosync.sql`

- [ ] **Step 1: Write migration**

```sql
alter table public.tg_outreach_accounts
  add column if not exists initial_sync_state text not null default 'pending'
    check (initial_sync_state in ('pending','running','done','failed'));
alter table public.tg_outreach_accounts
  add column if not exists initial_sync_started_at timestamptz;
alter table public.tg_outreach_accounts
  add column if not exists initial_sync_finished_at timestamptz;
alter table public.tg_outreach_accounts
  add column if not exists initial_sync_stats jsonb;

-- Existing rows created before autosync existed: mark them 'done' so the
-- worker doesn't try to re-sync them retroactively.
update public.tg_outreach_accounts
   set initial_sync_state = 'done',
       initial_sync_finished_at = created_at
 where initial_sync_state = 'pending'
   and created_at < now() - interval '1 hour';

comment on column public.tg_outreach_accounts.initial_sync_state is
  'One-time full-dialog sync status. New accounts default to pending; worker flips to running/done. See docs/superpowers/specs/2026-07-22-tg-outreach-dialog-sync-design.md';
```

- [ ] **Step 2: Apply + commit**

```bash
cd app && npm run db:migrate:local
git add supabase/migrations/20260722_0003_tg_outreach_accounts_autosync.sql
git commit -m "feat(tg-outreach): add initial_sync_state columns on accounts"
```

## Task 3.2: Add `autosync_days_lookback` to TelegramSettings

**Files:**
- Modify: `app/src/lib/tgOutreach/types.ts:96` (nearby `history_limit`) and `:258` (defaults)

- [ ] **Step 1: Extend interface + default**

Add near `history_limit`:
```ts
  /** How many days back to look during initial dialog autosync. */
  autosync_days_lookback: number;
```

In the defaults block (`DEFAULT_TELEGRAM_SETTINGS`):
```ts
  autosync_days_lookback: 30,
```

Also extend `OutreachAccount` interface:
```ts
  initial_sync_state?: 'pending' | 'running' | 'done' | 'failed';
  initial_sync_started_at?: string | null;
  initial_sync_finished_at?: string | null;
  initial_sync_stats?: { discovered?: number; imported?: number; skipped?: number; failed?: number } | null;
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/src/lib/tgOutreach/types.ts
git commit -m "feat(tg-outreach): types for autosync lookback + account sync state"
```

## Task 3.3: `runAutosyncJob` — iterate account's dialogs, filter by lookback, import each

**Files:**
- Modify: `app/src/lib/tgOutreach/dialogImport.ts`

- [ ] **Step 1: Add the function**

Append to `dialogImport.ts`:

```ts
export interface AutosyncOptions {
  client: TelegramClient;
  db: SupabaseClient;
  campaignId: string;
  accountId: string;
  jobId: string;
  lookbackDays: number;
  historyLimit: number;
  log: LogFn;
  shouldStop?: () => boolean;
  delayMs?: number;
}

export async function runAutosyncJob(opts: AutosyncOptions): Promise<void> {
  const { client, db, campaignId, accountId, jobId, lookbackDays, historyLimit, log, shouldStop, delayMs = 1500 } = opts;

  await db.from('tg_outreach_accounts').update({
    initial_sync_state: 'running',
    initial_sync_started_at: new Date().toISOString(),
  }).eq('id', accountId);

  const cutoffSec = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const stats = { discovered: 0, imported: 0, skipped: 0, failed: 0 };

  try {
    const dialogs = await client.getDialogs({ limit: 200, archived: false });
    stats.discovered = dialogs.length;

    const filtered = dialogs.filter(d => {
      if (!(d.entity instanceof Api.User)) return false;
      const last = d.message?.date ?? 0;
      return last >= cutoffSec;
    });

    log('info', `Автосинк: нашёл ${dialogs.length} диалогов, ${filtered.length} за последние ${lookbackDays} дней`);
    await db.from('tg_outreach_jobs').update({ progress: { done: 0, total: filtered.length, failed: 0 } }).eq('id', jobId);

    for (const [i, dialog] of filtered.entries()) {
      if (shouldStop?.()) { log('warning', 'Автосинк: получен сигнал остановки'); break; }
      const user = dialog.entity as Api.User;
      const tgUserId = Number(user.id);
      const result = await fetchAndStoreDialogHistory({
        client, db, campaignId, accountId,
        target: { tg_user_id: tgUserId },
        historyLimit,
        log,
      });
      if (result === 'ok') stats.imported++;
      else if (result === 'not_user') stats.skipped++;
      else stats.failed++;

      await db.from('tg_outreach_jobs').update({
        progress: { done: i + 1, total: filtered.length, failed: stats.failed },
      }).eq('id', jobId);
      await new Promise(res => setTimeout(res, delayMs));
    }

    await db.from('tg_outreach_accounts').update({
      initial_sync_state: 'done',
      initial_sync_finished_at: new Date().toISOString(),
      initial_sync_stats: stats,
    }).eq('id', accountId);
    log('info', `Автосинк завершён: импортировано ${stats.imported}, пропущено ${stats.skipped}, ошибок ${stats.failed}`);
  } catch (err) {
    await db.from('tg_outreach_accounts').update({
      initial_sync_state: 'failed',
      initial_sync_finished_at: new Date().toISOString(),
      initial_sync_stats: { ...stats, error: err instanceof Error ? err.message : String(err) },
    }).eq('id', accountId);
    log('error', `Автосинк упал: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
```

- [ ] **Step 2: Add test for lookback filter + state transition**

Append to `app/tests/lib/tgOutreach/dialogImport.test.ts`:

```ts
describe('runAutosyncJob', () => {
  it('filters dialogs by lookback and updates account state to done', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recent = { entity: { className: 'User', id: 111, username: 'recent' }, message: { date: nowSec - 3600 } };
    const stale  = { entity: { className: 'User', id: 222, username: 'stale' },  message: { date: nowSec - 86400 * 60 } };
    const notUser = { entity: { className: 'Channel', id: 333 }, message: { date: nowSec } };

    const client = {
      getDialogs: vi.fn().mockResolvedValue([recent, stale, notUser]),
      getEntity: vi.fn(async (id: number) => ({ id, className: 'User', username: `u${id}` })),
      getMessages: vi.fn().mockResolvedValue([]),
    };

    const dbCalls: { table: string; op: string; payload?: unknown }[] = [];
    const db = {
      from: (table: string) => ({
        update: (payload: unknown) => { dbCalls.push({ table, op: 'update', payload }); return { eq: () => Promise.resolve({ error: null }) }; },
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }), in: () => Promise.resolve({ data: [], error: null }) }),
        insert: (payload: unknown) => { dbCalls.push({ table, op: 'insert', payload }); return Promise.resolve({ data: payload, error: null }); },
        eq: () => ({}),
      }),
    };

    // Force Api.User instanceof check to be lenient in the mock — the real
    // check uses `dialog.entity instanceof Api.User`; here we monkey-patch
    // by setting className, so the runAutosyncJob code must be tolerant.
    // (If the executor keeps strict instanceof, adjust this test to import
    // Api.User and construct real instances.)

    await runAutosyncJob({
      client: client as any,
      db: db as any,
      campaignId: 'camp-1',
      accountId: 'acc-1',
      jobId: 'job-1',
      lookbackDays: 30,
      historyLimit: 20,
      log: () => {},
      delayMs: 0,
    });

    // Only the recent one should have been fetched.
    expect(client.getMessages).toHaveBeenCalledTimes(1);

    const finalUpdate = dbCalls.reverse().find(c => c.table === 'tg_outreach_accounts' && c.op === 'update' && (c.payload as any).initial_sync_state === 'done');
    expect(finalUpdate).toBeTruthy();
  });
});
```

Note: `runAutosyncJob` currently uses `dialog.entity instanceof Api.User`. For this test to pass with plain objects, the executor should change the check to `dialog.entity?.className === 'User'` (which also works against real gramJS `Api.User` instances — gramJS sets `className` on all TL classes). Update `runAutosyncJob` accordingly.

- [ ] **Step 3: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/src/lib/tgOutreach/dialogImport.ts app/tests/lib/tgOutreach/dialogImport.test.ts
git commit -m "feat(tg-outreach): runAutosyncJob for one-time dialog sync on account connect"
```

## Task 3.4: Worker dispatch + gate campaign processing on sync state

**Files:**
- Modify: `app/src/lib/tgOutreach/campaignLoop.ts`

- [ ] **Step 1: Add `autosync_dialogs` branch in job dispatcher**

Alongside the `import_dialogs` branch (Task 2.4 Step 3), add:

```ts
if (job.action === 'autosync_dialogs') {
  if (!job.account_id) {
    await db.from('tg_outreach_jobs').update({ status: 'failed', error_message: 'account_id required' }).eq('id', job.id);
    continue;
  }
  const { data: account } = await db.from('tg_outreach_accounts').select('*').eq('id', job.account_id).single();
  if (!account) {
    await db.from('tg_outreach_jobs').update({ status: 'failed', error_message: 'account not found' }).eq('id', job.id);
    continue;
  }
  const client = await getOrCreateClient(account);
  const tg = campaign.telegram_settings as TelegramSettings;
  await runAutosyncJob({
    client, db,
    campaignId: job.campaign_id,
    accountId: job.account_id,
    jobId: job.id,
    lookbackDays: tg.autosync_days_lookback ?? 30,
    historyLimit: tg.history_limit ?? 20,
    log: perCampaignLog,
    shouldStop,
  });
  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
  continue;
}
```

- [ ] **Step 2: Gate main-loop account processing on `initial_sync_state`**

Find the per-account cycle inside `runCampaignLoop` (around line 1447 where accounts iterate). At the top of the per-account block, add:

```ts
if (account.initial_sync_state && account.initial_sync_state !== 'done') {
  log('info', `Аккаунт ${account.session_name}: пропускаю круг — идёт первичная синхронизация диалогов (${account.initial_sync_state}).`);
  continue;
}
```

- [ ] **Step 3: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/src/lib/tgOutreach/campaignLoop.ts
git commit -m "feat(tg-outreach): worker dispatch for autosync_dialogs + skip campaign cycle until sync done"
```

## Task 3.5: Auto-enqueue autosync on account create + bulk-files upload

**Files:**
- Modify: `app/src/app/api/tools/tg-outreach/accounts/route.ts`
- Modify: `app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts`
- Create: `app/src/app/api/tools/tg-outreach/accounts/[id]/resync/route.ts`

- [ ] **Step 1: Add enqueue helper**

At the top of `accounts/route.ts`, add (or import from a shared spot):

```ts
async function enqueueAutosync(db: SupabaseClient, campaignId: string, accountId: string, userId: string) {
  await db.from('tg_outreach_jobs').insert({
    campaign_id: campaignId,
    account_id: accountId,
    user_id: userId,
    action: 'autosync_dialogs',
    payload: null,
  });
}
```

- [ ] **Step 2: Call it after successful account insert (POST /accounts)**

Immediately after the `.insert(...).select().single()` returns a new row, call `enqueueAutosync(db, campaign_id, newAccount.id, user.id)`.

- [ ] **Step 3: Same for bulk-files upload**

In `accounts/bulk-files/route.ts`, after each account row is inserted successfully, call `enqueueAutosync(...)`.

- [ ] **Step 4: Manual resync route**

Create `app/src/app/api/tools/tg-outreach/accounts/[id]/resync/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabaseRoute';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const db = createRouteClient(req);
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data: acc } = await db.from('tg_outreach_accounts').select('id, campaign_id').eq('id', params.id).single();
  if (!acc) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.from('tg_outreach_accounts').update({
    initial_sync_state: 'pending',
    initial_sync_started_at: null,
    initial_sync_finished_at: null,
    initial_sync_stats: null,
  }).eq('id', acc.id);

  const { data: job } = await db.from('tg_outreach_jobs').insert({
    campaign_id: acc.campaign_id,
    account_id: acc.id,
    user_id: user.id,
    action: 'autosync_dialogs',
  }).select('id').single();

  return NextResponse.json({ job_id: job?.id });
}
```

- [ ] **Step 5: Commit**

```bash
git add app/src/app/api/tools/tg-outreach/accounts/route.ts app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts app/src/app/api/tools/tg-outreach/accounts/[id]/resync/route.ts
git commit -m "feat(tg-outreach): auto-enqueue autosync on account create + manual resync route"
```

## Task 3.6: UI — sync-state chip + resync button

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx` (`CampaignAccountsTab` — account row rendering)

- [ ] **Step 1: Render chip on each account row**

Find where `session_name` is rendered inside the account row. Next to it, add:

```tsx
{acc.initial_sync_state && acc.initial_sync_state !== 'done' && (
  <span className={`ml-2 text-[10px] font-medium px-2 py-0.5 rounded-full ${
    acc.initial_sync_state === 'running' ? 'bg-amber-100 text-amber-700 animate-pulse' :
    acc.initial_sync_state === 'failed' ? 'bg-rose-100 text-rose-700' :
    'bg-gray-100 text-gray-600'
  }`}>
    {acc.initial_sync_state === 'running' ? 'Синхронизация...' :
     acc.initial_sync_state === 'failed' ? 'Синк упал' : 'В очереди на синк'}
  </span>
)}
```

- [ ] **Step 2: Add resync button (only if state === 'done' or 'failed')**

Next to the delete button:

```tsx
{(acc.initial_sync_state === 'done' || acc.initial_sync_state === 'failed') && (
  <button
    type="button"
    onClick={async () => {
      if (!confirm('Пересинхронизировать диалоги этого аккаунта?')) return;
      await authFetch(`${API_BASE}/accounts/${acc.id}/resync`, { method: 'POST' });
      void load();
    }}
    title="Заново подтянуть диалоги за последние N дней"
    className="text-xs text-gray-500 hover:text-indigo-600"
  >
    <RefreshCw className="h-3.5 w-3.5" />
  </button>
)}
```

- [ ] **Step 3: Manual test**

Dev server → upload new account → verify chip shows "Синхронизация..." → wait → chip disappears + dialogs appear in Dialogs tab.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): UI chip + resync button for account initial sync state"
```

**Phase 3 checkpoint** — deploy to staging, upload one new test account, verify:
- `initial_sync_state` transitions `pending → running → done`.
- Dialogs from last 30 days appear in `tg_outreach_dialogs` with `sent_by:'external'` or `'unknown'` on outgoing.
- Main campaign loop skips this account until sync completes.
- Manual resync works.

---

## Post-Phase Rollout

- [ ] **Merge to main** after all 3 phases green on staging.
- [ ] **Watch first prod cycle** — monitor `portal-worker-tg-outreach` logs for `Импорт`, `Автосинк` lines. Verify `tg_outreach_sent_messages` starts filling.
- [ ] **Communicate to Egor**: new "Импорт" button on account rows, sync chips on newly-uploaded accounts.
