# Контрольные ящики «Рассылки» — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** раз в рабочий день каждый ящик идущих рассылок шлёт по короткому письму на контрольный ящик каждого сервиса (Яндекс, Gmail, Mail.ru, Outlook); портал смотрит, во «Входящих» письмо или в «Спаме», и показывает это во вкладке «Статистика».

**Architecture:** две новые таблицы (`sender_seed_boxes`, `sender_seed_probes`) и SQL-функция сводки. Ведущий sender-воркер раз в 2 минуты фоном проверяет вход в новые контрольные ящики, раскладывает пробы на день и читает папки контрольных ящиков по IMAP. Отправка идёт тиком воркера своего адреса, как у старой проверочной отправки. Экран: подблок в карточке «Доставляемость», окно «Контрольные ящики», колонка «Контроль» в разрезе «Ящики».

**Tech Stack:** Next.js route handlers, Supabase (Postgres), `imapflow`, `nodemailer` через `sendSenderMail`, React (client components).

**Спека:** `docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md`.

**Правила проекта:** новых `*.test.ts` не заводим (CLAUDE.md); тяжёлые проверки локально не гоняем — типы проверяет CI ветки (`npm run typecheck:fast`). Коммиты — в `dmitriy_kuladmed_new`.

---

## Файлы

| Файл | Что делает |
|---|---|
| Create `supabase/migrations/20261007_0010_sender_seed_boxes.sql` | таблицы, функция сводки, права |
| Create `app/src/lib/sender/seedPlacement.ts` | чистые функции и константы: сервисы, IMAP по умолчанию, папка спама, выбор контрольного ящика, время пробы, тексты писем, язык. Без `server-only` — подписи берёт и экран |
| Create `app/src/lib/sender/seedWorker.ts` | воркер: проверка входа, план дня, отправка, чтение папок |
| Modify `app/worker/sender.ts` | подключить воркер |
| Create `app/src/app/api/tools/sender/seeds/route.ts` | GET список, POST добавить |
| Create `app/src/app/api/tools/sender/seeds/[id]/route.ts` | PATCH (вкл/выкл, перепроверить), DELETE |
| Modify `app/src/app/api/tools/sender/stats/route.ts` | приклеить сводку контрольных ящиков |
| Modify `app/src/components/sender/api.ts` | типы и запросы |
| Create `app/src/components/sender/SeedBoxesModal.tsx` | окно «Контрольные ящики» |
| Modify `app/src/components/sender/StatsTab.tsx` | подблок в «Доставляемости», колонка «Контроль» |

---

### Task 1: Миграция

**Files:**
- Create: `supabase/migrations/20261007_0010_sender_seed_boxes.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- Контрольные ящики «Рассылки»: входящие или спам
-- (docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md).

-- ── Контрольные ящики ──────────────────────────────────────────────────────
create table if not exists public.sender_seed_boxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('yandex', 'gmail', 'mailru', 'outlook')),
  email text not null unique,
  imap_host text not null,
  imap_port int not null default 993,
  imap_user text not null,
  -- Пароль приложения, запечатан sealMailboxSecret (BYO_MAILBOX_CRED_KEY).
  secret_encrypted text,
  enabled boolean not null default true,
  -- pending: ждёт проверки входа; ok: вход и папка спама найдены;
  -- failed: не вошли / нет папки спама; needs_oauth: Outlook до второго этапа.
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'failed', 'needs_oauth')),
  last_error text,
  junk_folder text,
  checked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.sender_seed_boxes enable row level security;
grant all on public.sender_seed_boxes to service_role;

-- ── Пробы: одна в день на ящик и сервис ────────────────────────────────────
create table if not exists public.sender_seed_probes (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  mailbox_id uuid not null references public.sender_mailboxes (id) on delete cascade,
  seed_box_id uuid not null references public.sender_seed_boxes (id) on delete cascade,
  provider text not null,
  subject text not null,
  body text not null,
  message_id text,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  -- planned → sent → inbox | spam | missing; send_failed, check_failed — не в счёт.
  status text not null default 'planned'
    check (status in ('planned', 'sent', 'inbox', 'spam', 'missing', 'send_failed', 'check_failed')),
  folder text,
  checked_at timestamptz,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  unique (day, mailbox_id, provider)
);

create index if not exists idx_sender_seed_probes_due
  on public.sender_seed_probes (status, scheduled_at);
create index if not exists idx_sender_seed_probes_mailbox
  on public.sender_seed_probes (mailbox_id, day desc);
create index if not exists idx_sender_seed_probes_seed
  on public.sender_seed_probes (seed_box_id, day desc);

alter table public.sender_seed_probes enable row level security;
grant all on public.sender_seed_probes to service_role;

-- ── Сводка для «Статистики» ────────────────────────────────────────────────
-- providers — итог проб с p_since по сервисам; boxes — рабочих контрольных
-- ящиков на сервис; latest — последний итог каждого ящика по каждому сервису.
-- p_campaign_id — только ящики этой кампании.
create or replace function public.sender_seed_placement(p_since timestamptz, p_campaign_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with probes as (
    select p.*
      from public.sender_seed_probes p
     where p.sent_at >= p_since
       and p.status in ('inbox', 'spam', 'missing')
       and (p_campaign_id is null or p.mailbox_id in (
         select cm.mailbox_id from public.sender_campaign_mailboxes cm where cm.campaign_id = p_campaign_id
       ))
  )
  select jsonb_build_object(
    'providers', coalesce((
      select jsonb_agg(row_to_json(t))
        from (
          select provider,
                 count(*) filter (where status = 'inbox') as inbox,
                 count(*) filter (where status = 'spam') as spam,
                 count(*) filter (where status = 'missing') as missing
            from probes
           group by provider
        ) t
    ), '[]'::jsonb),
    'boxes', coalesce((
      select jsonb_object_agg(provider, n)
        from (
          select provider, count(*) as n
            from public.sender_seed_boxes
           where enabled and status = 'ok'
           group by provider
        ) b
    ), '{}'::jsonb),
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mailbox_id', mailbox_id, 'provider', provider, 'status', status, 'day', day, 'folder', folder
      ))
        from (
          select distinct on (mailbox_id, provider) mailbox_id, provider, status, day, folder
            from probes
           order by mailbox_id, provider, day desc
        ) l
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.sender_seed_placement(timestamptz, uuid) from public;
grant execute on function public.sender_seed_placement(timestamptz, uuid) to service_role;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20261007_0010_sender_seed_boxes.sql
git commit -m "feat(sender): таблицы контрольных ящиков и сводка «входящие/спам»"
```

---

### Task 2: Чистые функции `seedPlacement.ts`

**Files:**
- Create: `app/src/lib/sender/seedPlacement.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Контрольные ящики «Рассылки»: входящие или спам
 * (docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md).
 *
 * Чистые функции и константы без обращений к базе: их берут и воркер
 * (seedWorker.ts), и экран (подписи сервисов).
 */

export type SeedProvider = 'yandex' | 'gmail' | 'mailru' | 'outlook';
export type SeedBoxStatus = 'pending' | 'ok' | 'failed' | 'needs_oauth';
export type SeedProbeStatus = 'planned' | 'sent' | 'inbox' | 'spam' | 'missing' | 'send_failed' | 'check_failed';

export const SEED_PROVIDERS: { id: SeedProvider; label: string; letter: string; imapHost: string }[] = [
  { id: 'yandex', label: 'Яндекс', letter: 'Я', imapHost: 'imap.yandex.ru' },
  { id: 'gmail', label: 'Gmail', letter: 'G', imapHost: 'imap.gmail.com' },
  { id: 'mailru', label: 'Mail.ru', letter: 'M', imapHost: 'imap.mail.ru' },
  { id: 'outlook', label: 'Outlook', letter: 'O', imapHost: 'outlook.office365.com' },
];

export function isSeedProvider(value: unknown): value is SeedProvider {
  return SEED_PROVIDERS.some((p) => p.id === value);
}

export function seedProviderLabel(id: string): string {
  return SEED_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** Через сколько после отправки первый раз ищем письмо. */
export const SEED_FIRST_CHECK_MS = 30 * 60 * 1000;
/** Пауза между повторными поисками. */
export const SEED_RECHECK_MS = 15 * 60 * 1000;
/** Не нашли за это время — «не дошло». */
export const SEED_MISSING_AFTER_MS = 2 * 60 * 60 * 1000;
/** Окно отправки проб по Москве: с 10:00 до 17:00. */
export const SEED_HOUR_FROM_MSK = 10;
export const SEED_HOUR_TO_MSK = 17;

const MSK_MS = 3 * 60 * 60 * 1000;

/** День по Москве «2026-10-07» и день недели 1 = пн … 7 = вс. */
export function mskDayOf(now: Date): { day: string; weekday: number; hour: number } {
  const msk = new Date(now.getTime() + MSK_MS);
  const weekday = msk.getUTCDay() === 0 ? 7 : msk.getUTCDay();
  return { day: msk.toISOString().slice(0, 10), weekday, hour: msk.getUTCHours() };
}

/**
 * Случайное время пробы в окне 10:00–17:00 МСК дня `day`; не раньше `now`,
 * чтобы ящик, попавший в рассылку днём, не отправил всё разом в прошлое.
 */
export function randomSeedSlot(day: string, now: Date, rand: () => number = Math.random): Date {
  const start = Date.parse(`${day}T00:00:00Z`) - MSK_MS + SEED_HOUR_FROM_MSK * 3_600_000;
  const end = Date.parse(`${day}T00:00:00Z`) - MSK_MS + SEED_HOUR_TO_MSK * 3_600_000;
  const from = Math.max(start, now.getTime());
  if (from >= end) return new Date(end);
  return new Date(from + Math.floor(rand() * (end - from)));
}

/**
 * Контрольный ящик сервиса «по очереди»: меньше всего проб за 7 дней (вместе
 * с уже разложенными в этом проходе); при равенстве — не вчерашний ящик этого
 * отправителя. `usage` меняется на месте: следующий выбор видит этот.
 */
export function pickSeedBox(
  seeds: { id: string }[],
  usage: Map<string, number>,
  yesterdaySeedId: string | null,
): string | null {
  if (!seeds.length) return null;
  const sorted = [...seeds].sort((a, b) => {
    const diff = (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0);
    if (diff !== 0) return diff;
    return Number(a.id === yesterdaySeedId) - Number(b.id === yesterdaySeedId);
  });
  const chosen = sorted[0].id;
  usage.set(chosen, (usage.get(chosen) ?? 0) + 1);
  return chosen;
}

const JUNK_NAMES = ['spam', 'спам', 'junk', 'junk e-mail', 'junk email', '[gmail]/spam', '[gmail]/спам', 'нежелательная почта'];

/**
 * Папка спама из списка папок IMAP: сначала по отметке \Junk, затем по имени.
 * Пути сравниваются без регистра; возвращается путь как есть.
 */
export function findJunkFolder(folders: { path: string; specialUse?: string | null }[]): string | null {
  const flagged = folders.find((f) => (f.specialUse ?? '').toLowerCase() === '\\junk');
  if (flagged) return flagged.path;
  const named = folders.find((f) => {
    const path = f.path.toLowerCase();
    const leaf = path.split(/[/.]/).pop() ?? path;
    return JUNK_NAMES.includes(path) || JUNK_NAMES.includes(leaf);
  });
  return named?.path ?? null;
}

/** Язык пробы: английский, если ящик работает в рассылке с американским поясом. */
export function seedLanguage(campaignTimezones: string[]): 'ru' | 'en' {
  return campaignTimezones.some((tz) => tz.startsWith('America/')) ? 'en' : 'ru';
}

const LETTERS: Record<'ru' | 'en', { subject: string; body: string }[]> = {
  ru: [
    { subject: 'Вопрос по сотрудничеству', body: 'Добрый день!\n\nПодскажите, пожалуйста, кто у вас отвечает за развитие продаж? Хотел бы коротко обсудить одну идею.\n\nСпасибо!' },
    { subject: 'Короткий вопрос', body: 'Здравствуйте!\n\nПишу уточнить, актуален ли для вас сейчас поиск новых клиентов. Если да — расскажу, как мы с этим помогаем.\n\nХорошего дня!' },
    { subject: 'Знакомство', body: 'Добрый день!\n\nХотел познакомиться и понять, с кем у вас можно обсудить привлечение заявок.\n\nБуду признателен за ответ.' },
    { subject: 'По поводу заявок', body: 'Здравствуйте!\n\nМы помогаем компаниям получать заявки от новых клиентов. Подскажите, кому лучше написать по этому вопросу?\n\nСпасибо.' },
    { subject: 'Уточнение', body: 'Добрый день!\n\nПодскажите, удобно ли обсудить на этой неделе пару идей по продажам? Займёт не больше пятнадцати минут.\n\nС уважением.' },
    { subject: 'Идея для отдела продаж', body: 'Здравствуйте!\n\nЕсть идея, как добавить вашему отделу продаж встреч с новыми клиентами. Интересно было бы обсудить?\n\nВсего доброго!' },
  ],
  en: [
    { subject: 'Quick question', body: 'Hi,\n\nWho on your team looks after sales growth? I have a short idea I would like to share.\n\nThanks!' },
    { subject: 'Introduction', body: 'Hello,\n\nI wanted to introduce myself and find the right person to talk to about new client acquisition.\n\nBest regards.' },
    { subject: 'About new clients', body: 'Hi,\n\nAre you looking for more meetings with new clients this quarter? Happy to share how we help.\n\nCheers.' },
    { subject: 'Short idea', body: 'Hello,\n\nWould you be open to a fifteen-minute chat about your outbound sales this week?\n\nThank you.' },
    { subject: 'Right person?', body: 'Hi,\n\nCould you point me to whoever handles business development? I have a quick question.\n\nThanks a lot.' },
    { subject: 'Sales meetings', body: 'Hello,\n\nWe help companies book more first calls with potential clients. Is this relevant for you right now?\n\nKind regards.' },
  ],
};

/** Случайное нейтральное письмо без ссылок; подпись — имя отправителя ящика. */
export function seedLetter(lang: 'ru' | 'en', senderName: string | null, rand: () => number = Math.random): { subject: string; body: string } {
  const list = LETTERS[lang];
  const letter = list[Math.floor(rand() * list.length) % list.length];
  const name = (senderName ?? '').trim();
  return { subject: letter.subject, body: name ? `${letter.body}\n${name}` : letter.body };
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/sender/seedPlacement.ts
git commit -m "feat(sender): правила контрольных ящиков — очередь, окно, папка спама, тексты"
```

---

### Task 3: Воркер `seedWorker.ts`

**Files:**
- Create: `app/src/lib/sender/seedWorker.ts`

- [ ] **Step 1: Написать воркер**

```ts
import 'server-only';

import { ImapFlow } from 'imapflow';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { assertSafeImapTarget } from '@/lib/byoMailbox/netGuard';
import { unsealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { buildMessageId } from '@/lib/mail/message';
import { authForMailbox } from './mailboxAuth';
import { sendSenderMail } from './smtp';
import type { MailboxRow } from './types';
import {
  SEED_FIRST_CHECK_MS,
  SEED_HOUR_TO_MSK,
  SEED_MISSING_AFTER_MS,
  SEED_RECHECK_MS,
  findJunkFolder,
  mskDayOf,
  pickSeedBox,
  randomSeedSlot,
  seedLanguage,
  seedLetter,
  type SeedProvider,
} from './seedPlacement';

/**
 * Контрольные ящики «Рассылки»: входящие или спам
 * (docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md).
 *
 * Ведущий воркер: проверяет вход в новые контрольные ящики, раскладывает пробы
 * на день и ищет доставленные письма. Отправляет пробы воркер своего адреса —
 * с того же IP, что и боевые письма ящика.
 *
 * Письма в контрольных ящиках только ищутся (EXAMINE, без флагов): прочитанное
 * или перенесённое из спама письмо учит фильтр, и следующие пробы врут.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

interface SeedBoxRow {
  id: string;
  provider: SeedProvider;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  secret_encrypted: string | null;
  junk_folder: string | null;
}

/** Сколько проб шлёт воркер адреса за тик: не забивать тик рассылки. */
const SEND_PER_TICK = 4;

function db() {
  if (!supabaseAdmin) throw new Error('Сервис не настроен: нет сервисного ключа базы');
  return supabaseAdmin;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withSeedImap<T>(box: SeedBoxRow, job: (client: ImapFlow) => Promise<T>): Promise<T> {
  const guard = await assertSafeImapTarget(box.imap_host, box.imap_port);
  if (!guard.ok) throw new Error(`IMAP контрольного ящика отклонён (${guard.reason})`);
  if (!box.secret_encrypted) throw new Error('нет пароля приложения');
  const password = unsealMailboxSecret(box.secret_encrypted).imapPassword;
  if (!password) throw new Error('нет пароля приложения');

  const client = new ImapFlow({
    host: box.imap_host,
    port: box.imap_port,
    secure: true,
    auth: { user: box.imap_user, pass: password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await client.connect();
    return await job(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function detectJunk(client: ImapFlow): Promise<string | null> {
  const folders = await client.list();
  return findJunkFolder(folders.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null })));
}

// ── Проверка входа ─────────────────────────────────────────────────────────

export async function verifyPendingSeedBoxes(log: Log): Promise<void> {
  const { data } = await db()
    .from('sender_seed_boxes')
    .select('id, provider, email, imap_host, imap_port, imap_user, secret_encrypted, junk_folder')
    .eq('status', 'pending')
    .limit(5);
  for (const box of (data ?? []) as SeedBoxRow[]) {
    const nowIso = new Date().toISOString();
    try {
      const junk = await withSeedImap(box, detectJunk);
      if (!junk) {
        await db().from('sender_seed_boxes')
          .update({ status: 'failed', last_error: 'Вход есть, но папка «Спам» не найдена', checked_at: nowIso })
          .eq('id', box.id);
        continue;
      }
      await db().from('sender_seed_boxes')
        .update({ status: 'ok', junk_folder: junk, last_error: null, checked_at: nowIso })
        .eq('id', box.id);
      log('info', `Контрольный ящик ${box.email}: вход есть, спам — «${junk}»`);
    } catch (e) {
      await db().from('sender_seed_boxes')
        .update({ status: 'failed', last_error: `Не вошли: ${errorText(e)}`.slice(0, 400), checked_at: nowIso })
        .eq('id', box.id);
      log('warn', `Контрольный ящик ${box.email}: не вошли (${errorText(e)})`);
    }
  }
}

// ── План дня ───────────────────────────────────────────────────────────────

let plannedDay: string | null = null;
let plannedAt = 0;
/** Раскладываем заново раз в 30 минут: ящик, попавший в рассылку днём, получает пробы в тот же день. */
const REPLAN_MS = 30 * 60 * 1000;

export async function planSeedProbes(log: Log, now = new Date()): Promise<void> {
  const { day, weekday, hour } = mskDayOf(now);
  if (weekday > 5 || hour >= SEED_HOUR_TO_MSK) return;
  if (plannedDay === day && Date.now() - plannedAt < REPLAN_MS) return;

  const { data: seedRows } = await db()
    .from('sender_seed_boxes')
    .select('id, provider')
    .eq('enabled', true)
    .eq('status', 'ok');
  const seedsByProvider = new Map<string, { id: string }[]>();
  for (const s of (seedRows ?? []) as { id: string; provider: string }[]) {
    seedsByProvider.set(s.provider, [...(seedsByProvider.get(s.provider) ?? []), { id: s.id }]);
  }
  plannedDay = day;
  plannedAt = Date.now();
  if (!seedsByProvider.size) return;

  // Ящики идущих рассылок и пояса их кампаний (для языка письма).
  const { data: links } = await db()
    .from('sender_campaign_mailboxes')
    .select('mailbox_id, sender_campaigns!inner(status, timezone)')
    .eq('sender_campaigns.status', 'running');
  const zones = new Map<string, string[]>();
  for (const row of (links ?? []) as unknown as { mailbox_id: string; sender_campaigns: { timezone: string } | { timezone: string }[] }[]) {
    const campaigns = Array.isArray(row.sender_campaigns) ? row.sender_campaigns : [row.sender_campaigns];
    zones.set(row.mailbox_id, [...(zones.get(row.mailbox_id) ?? []), ...campaigns.map((c) => c.timezone)]);
  }
  if (!zones.size) return;

  const { data: boxRows } = await db()
    .from('sender_mailboxes')
    .select('id, display_name')
    .in('id', [...zones.keys()])
    .eq('status', 'verified')
    .eq('enabled', true);
  const mailboxes = (boxRows ?? []) as { id: string; display_name: string | null }[];
  if (!mailboxes.length) return;

  // Уже разложенное сегодня и нагрузка на контрольные ящики за 7 дней.
  const weekAgo = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data: recent } = await db()
    .from('sender_seed_probes')
    .select('day, mailbox_id, provider, seed_box_id')
    .gte('day', weekAgo);
  const usage = new Map<string, number>();
  const today = new Set<string>();
  const yesterday = new Map<string, string>();
  const prevDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  for (const p of (recent ?? []) as { day: string; mailbox_id: string; provider: string; seed_box_id: string }[]) {
    usage.set(p.seed_box_id, (usage.get(p.seed_box_id) ?? 0) + 1);
    if (p.day === day) today.add(`${p.mailbox_id}|${p.provider}`);
    if (p.day === prevDay) yesterday.set(`${p.mailbox_id}|${p.provider}`, p.seed_box_id);
  }

  const rows: Record<string, unknown>[] = [];
  for (const mailbox of mailboxes) {
    const lang = seedLanguage(zones.get(mailbox.id) ?? []);
    for (const [provider, seeds] of seedsByProvider) {
      const key = `${mailbox.id}|${provider}`;
      if (today.has(key)) continue;
      const seedId = pickSeedBox(seeds, usage, yesterday.get(key) ?? null);
      if (!seedId) continue;
      const letter = seedLetter(lang, mailbox.display_name);
      rows.push({
        day,
        mailbox_id: mailbox.id,
        seed_box_id: seedId,
        provider,
        subject: letter.subject,
        body: letter.body,
        scheduled_at: randomSeedSlot(day, now).toISOString(),
      });
    }
  }
  if (!rows.length) return;

  const { error } = await db()
    .from('sender_seed_probes')
    .upsert(rows, { onConflict: 'day,mailbox_id,provider', ignoreDuplicates: true });
  if (error) throw new Error(`пробы не разложены: ${error.message}`);
  log('info', `Контрольные ящики: на ${day} разложено ${rows.length} проб`);
}

// ── Отправка (воркер своего адреса) ────────────────────────────────────────

export async function sendDueSeedProbes(opts: { egressIp: string; log: Log }): Promise<void> {
  const { data: due } = await db()
    .from('sender_seed_probes')
    .select('id, mailbox_id, subject, body, sender_seed_boxes!inner(email)')
    .eq('status', 'planned')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(50);
  const probes = (due ?? []) as unknown as {
    id: string; mailbox_id: string; subject: string; body: string;
    sender_seed_boxes: { email: string } | { email: string }[];
  }[];
  if (!probes.length) return;

  const { data: owned } = await db()
    .from('sender_mailboxes')
    .select('*')
    .in('id', [...new Set(probes.map((p) => p.mailbox_id))])
    .eq('egress_ip', opts.egressIp);
  const mine = new Map(((owned ?? []) as MailboxRow[]).map((m) => [m.id, m]));

  for (const probe of probes.filter((p) => mine.has(p.mailbox_id)).slice(0, SEND_PER_TICK)) {
    const mailbox = mine.get(probe.mailbox_id)!;
    const seed = Array.isArray(probe.sender_seed_boxes) ? probe.sender_seed_boxes[0] : probe.sender_seed_boxes;
    const fail = (error: string) => db().from('sender_seed_probes')
      .update({ status: 'send_failed', error: error.slice(0, 400) })
      .eq('id', probe.id);

    if (!mailbox.enabled || mailbox.status !== 'verified') {
      await fail('ящик выключен или не проверен');
      continue;
    }
    const auth = await authForMailbox(mailbox);
    if (!auth.ok) {
      await fail(`ящик не вошёл: ${auth.error}`);
      continue;
    }
    const messageId = buildMessageId(mailbox.email);
    const name = (mailbox.display_name ?? '').trim();
    const result = await sendSenderMail(
      {
        host: mailbox.smtp_host,
        port: mailbox.smtp_port,
        tlsMode: mailbox.smtp_tls_mode,
        username: mailbox.username,
        auth: auth.smtp,
      },
      {
        from: name ? `${name} <${mailbox.email}>` : mailbox.email,
        to: seed.email,
        subject: probe.subject,
        text: probe.body,
        messageId,
      },
    );
    if (!result.ok) {
      await fail(`отправка не прошла (${result.code}): ${result.error ?? ''}`);
      opts.log('warn', `Проба ${mailbox.email} → ${seed.email}: отправка не прошла (${result.code})`);
      continue;
    }
    await db().from('sender_seed_probes')
      .update({ status: 'sent', message_id: messageId, sent_at: new Date().toISOString() })
      .eq('id', probe.id);
  }
}

// ── Где лежит письмо ───────────────────────────────────────────────────────

async function searchIn(client: ImapFlow, folder: string, messageIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  await client.mailboxOpen(folder, { readOnly: true });
  for (const id of messageIds) {
    const uids = await client.search({ header: { 'message-id': id } });
    if (Array.isArray(uids) && uids.length) found.add(id);
  }
  return found;
}

export async function checkSeedProbes(log: Log): Promise<void> {
  const now = Date.now();
  const { data } = await db()
    .from('sender_seed_probes')
    .select('id, seed_box_id, message_id, sent_at, checked_at, attempts')
    .eq('status', 'sent')
    .lt('sent_at', new Date(now - SEED_FIRST_CHECK_MS).toISOString())
    .order('sent_at')
    .limit(200);
  const probes = ((data ?? []) as {
    id: string; seed_box_id: string; message_id: string | null; sent_at: string; checked_at: string | null; attempts: number;
  }[]).filter((p) => !p.checked_at || now - Date.parse(p.checked_at) >= SEED_RECHECK_MS);
  if (!probes.length) return;

  const bySeed = new Map<string, typeof probes>();
  for (const p of probes) bySeed.set(p.seed_box_id, [...(bySeed.get(p.seed_box_id) ?? []), p]);

  const { data: seedRows } = await db()
    .from('sender_seed_boxes')
    .select('id, provider, email, imap_host, imap_port, imap_user, secret_encrypted, junk_folder')
    .in('id', [...bySeed.keys()]);

  for (const box of (seedRows ?? []) as SeedBoxRow[]) {
    const list = bySeed.get(box.id) ?? [];
    const ids = list.map((p) => p.message_id).filter((v): v is string => Boolean(v));
    const nowIso = new Date().toISOString();
    try {
      const { inbox, spam, junk } = await withSeedImap(box, async (client) => {
        const junkFolder = box.junk_folder ?? (await detectJunk(client));
        const inInbox = await searchIn(client, 'INBOX', ids);
        const rest = ids.filter((id) => !inInbox.has(id));
        const inSpam = junkFolder && rest.length ? await searchIn(client, junkFolder, rest) : new Set<string>();
        return { inbox: inInbox, spam: inSpam, junk: junkFolder };
      });
      for (const p of list) {
        const id = p.message_id ?? '';
        const status = inbox.has(id) ? 'inbox' : spam.has(id) ? 'spam'
          : now - Date.parse(p.sent_at) >= SEED_MISSING_AFTER_MS ? 'missing' : null;
        await db().from('sender_seed_probes')
          .update(status
            ? { status, folder: status === 'inbox' ? 'INBOX' : status === 'spam' ? junk : null, checked_at: nowIso, attempts: p.attempts + 1 }
            : { checked_at: nowIso, attempts: p.attempts + 1 })
          .eq('id', p.id);
      }
    } catch (e) {
      log('warn', `Контрольный ящик ${box.email}: не прочитан (${errorText(e)})`);
      await db().from('sender_seed_boxes')
        .update({ status: 'failed', last_error: `Не вошли: ${errorText(e)}`.slice(0, 400), checked_at: nowIso })
        .eq('id', box.id);
      for (const p of list) {
        const expired = now - Date.parse(p.sent_at) >= SEED_MISSING_AFTER_MS;
        await db().from('sender_seed_probes')
          .update(expired
            ? { status: 'check_failed', error: errorText(e).slice(0, 400), checked_at: nowIso }
            : { checked_at: nowIso, attempts: p.attempts + 1 })
          .eq('id', p.id);
      }
    }
  }
}

/** Всё, что делает ведущий воркер: вход, план, поиск писем. */
export async function runSeedFleetJobs(log: Log): Promise<void> {
  await verifyPendingSeedBoxes(log);
  await planSeedProbes(log);
  await checkSeedProbes(log);
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/sender/seedWorker.ts
git commit -m "feat(sender): воркер контрольных ящиков — вход, план дня, отправка, поиск папки"
```

---

### Task 4: Подключить в `worker/sender.ts`

**Files:**
- Modify: `app/worker/sender.ts`

- [ ] **Step 1: Импорт** — рядом с импортом `probeWorker`:

```ts
import { runSeedFleetJobs, sendDueSeedProbes } from '@/lib/sender/seedWorker';
```

- [ ] **Step 2: Состояние** — рядом с `let lastDomainHealthAt = 0;`:

```ts
// Контрольные ящики: IMAP-поиск по двадцати ящикам идёт минуту-другую —
// фоном, как DNS-проверка доменов, не дольше одного прохода сразу.
const SEED_INTERVAL_MS = 2 * 60 * 1000;
let lastSeedAt = 0;
let seedRunning = false;
```

- [ ] **Step 3: В `runFleetJobs`** — после блока `domainHealth`:

```ts
  if (!seedRunning && Date.now() - lastSeedAt >= SEED_INTERVAL_MS) {
    lastSeedAt = Date.now();
    seedRunning = true;
    void guarded('Контрольные ящики не отработали', () => runSeedFleetJobs(log)).finally(() => {
      seedRunning = false;
    });
  }
```

- [ ] **Step 4: В `tick`** — после `sendPendingProbes`:

```ts
    await guarded('Пробы на контрольные ящики не ушли', () => sendDueSeedProbes({ log, egressIp }));
```

- [ ] **Step 5: Commit**

```bash
git add app/worker/sender.ts
git commit -m "feat(sender): воркер рассылки шлёт и проверяет пробы контрольных ящиков"
```

---

### Task 5: API списка контрольных ящиков

**Files:**
- Create: `app/src/app/api/tools/sender/seeds/route.ts`
- Create: `app/src/app/api/tools/sender/seeds/[id]/route.ts`

- [ ] **Step 1: `seeds/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { SEED_PROVIDERS, isSeedProvider } from '@/lib/sender/seedPlacement';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Контрольные ящики «Рассылки» (спека 2026-10-07-sender-seed-inbox-placement).
 * GET — список с числом проб за 7 дней; пароли наружу не отдаются.
 * POST — добавить: вход проверит ведущий sender-воркер за пару минут.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.seeds.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('sender_seed_boxes')
      .select('id, provider, email, enabled, status, last_error, checked_at')
      .order('provider')
      .order('email');
    if (error) return jsonError(error.message, 500);

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: probes } = await supabaseAdmin
      .from('sender_seed_probes')
      .select('seed_box_id')
      .gte('sent_at', since);
    const counts = new Map<string, number>();
    for (const p of probes ?? []) counts.set(String(p.seed_box_id), (counts.get(String(p.seed_box_id)) ?? 0) + 1);

    return NextResponse.json({
      seeds: (data ?? []).map((row) => ({ ...row, probes7d: counts.get(String(row.id)) ?? 0 })),
    });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.seeds.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as { provider?: unknown; email?: unknown; password?: unknown } | null;
    const provider = body?.provider;
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '').replace(/\s+/g, '');
    if (!isSeedProvider(provider)) return jsonError('Выберите сервис', 400);
    if (!EMAIL_RE.test(email)) return jsonError('Неверный адрес', 400);
    if (!password) return jsonError('Укажите пароль приложения', 400);

    const host = SEED_PROVIDERS.find((p) => p.id === provider)!.imapHost;
    const { data, error } = await supabaseAdmin
      .from('sender_seed_boxes')
      .insert({
        provider,
        email,
        imap_host: host,
        imap_port: 993,
        imap_user: email,
        secret_encrypted: sealMailboxSecret({ imapPassword: password }),
        // Outlook по паролю не пускает — ждёт второго этапа (вход через Microsoft).
        status: provider === 'outlook' ? 'needs_oauth' : 'pending',
        created_by: auth.user.id,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') return jsonError('Этот ящик уже добавлен', 409);
      return jsonError(error.message, 500);
    }
    return NextResponse.json({ id: String(data.id) });
  });
}
```

Пароль приложения Gmail показывается группами через пробел — пробелы убираются (`replace(/\s+/g, '')`).

- [ ] **Step 2: `seeds/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** PATCH {enabled} — включить/выключить; {recheck: true} — проверить вход заново. DELETE — удалить с историей проб. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seeds.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { enabled?: unknown; recheck?: unknown } | null;
    const { data: box } = await supabaseAdmin.from('sender_seed_boxes').select('id, provider').eq('id', id).maybeSingle();
    if (!box) return jsonError('Контрольный ящик не найден', 404);

    const patch: Record<string, unknown> = {};
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
    if (body?.recheck === true && box.provider !== 'outlook') {
      patch.status = 'pending';
      patch.last_error = null;
    }
    if (!Object.keys(patch).length) return jsonError('Нечего менять', 400);

    const { error } = await supabaseAdmin.from('sender_seed_boxes').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seeds.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { error } = await supabaseAdmin.from('sender_seed_boxes').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/sender/seeds
git commit -m "feat(sender): API контрольных ящиков — список, добавить, вкл/выкл, перепроверить, удалить"
```

---

### Task 6: Сводка в API статистики

**Files:**
- Modify: `app/src/app/api/tools/sender/stats/route.ts`

- [ ] **Step 1:** перед `return NextResponse.json({` добавить:

```ts
    // Контрольные ящики — всегда за 7 дней, независимо от периода экрана:
    // это «как сейчас», а не история. Функции нет (миграция не применена) —
    // блок просто не показывается.
    const { data: seedPlacement } = await supabaseAdmin.rpc('sender_seed_placement', {
      p_since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      p_campaign_id: campaign,
    });
```

и в ответ — поле `seedPlacement: seedPlacement ?? null,`.

- [ ] **Step 2: Commit**

```bash
git add app/src/app/api/tools/sender/stats/route.ts
git commit -m "feat(sender): статистика отдаёт сводку контрольных ящиков за 7 дней"
```

---

### Task 7: Клиентские типы и запросы

**Files:**
- Modify: `app/src/components/sender/api.ts`

- [ ] **Step 1:** в `SenderStatsDto` добавить поле:

```ts
  /** Контрольные ящики за 7 дней; null — функция ещё не применена. */
  seedPlacement?: SeedPlacementDto | null;
```

- [ ] **Step 2:** после `fetchSenderStats` добавить:

```ts
export type SeedProviderId = 'yandex' | 'gmail' | 'mailru' | 'outlook';

export interface SeedPlacementDto {
  providers: { provider: SeedProviderId; inbox: number; spam: number; missing: number }[];
  /** Рабочих контрольных ящиков на сервис. */
  boxes: Partial<Record<SeedProviderId, number>>;
  latest: { mailbox_id: string; provider: SeedProviderId; status: 'inbox' | 'spam' | 'missing'; day: string; folder: string | null }[];
}

export interface SeedBoxDto {
  id: string;
  provider: SeedProviderId;
  email: string;
  enabled: boolean;
  status: 'pending' | 'ok' | 'failed' | 'needs_oauth';
  last_error: string | null;
  checked_at: string | null;
  probes7d: number;
}

export function fetchSeedBoxes() {
  return authFetchJson<{ seeds: SeedBoxDto[] }>(`${BASE}/seeds`);
}

export function addSeedBox(body: { provider: SeedProviderId; email: string; password: string }) {
  return authFetchJson<{ id: string }>(`${BASE}/seeds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchSeedBox(id: string, body: { enabled?: boolean; recheck?: true }) {
  return authFetchJson<{ ok: true }>(`${BASE}/seeds/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteSeedBox(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/seeds/${id}`, { method: 'DELETE' });
}
```

Перед вставкой свериться, как соседние `createMailboxTag`/`patchMailbox` передают заголовки: повторить их форму, если отличается.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/sender/api.ts
git commit -m "feat(sender): клиентские запросы контрольных ящиков"
```

---

### Task 8: Окно «Контрольные ящики»

**Files:**
- Create: `app/src/components/sender/SeedBoxesModal.tsx`

- [ ] **Step 1: Компонент**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { SEED_PROVIDERS, seedProviderLabel } from '@/lib/sender/seedPlacement';
import { addSeedBox, deleteSeedBox, fetchSeedBoxes, patchSeedBox, type SeedBoxDto, type SeedProviderId } from './api';
import { SenderModal } from './SenderModal';

const STATUS_TEXT: Record<SeedBoxDto['status'], string> = {
  pending: 'проверяю вход…',
  ok: 'работает',
  failed: 'не вошли',
  needs_oauth: 'нужен вход через Microsoft',
};

/**
 * Контрольные ящики: куда «Рассылка» раз в день шлёт пробы, чтобы видеть
 * входящие или спам. Вход проверяет sender-воркер — список обновляется сам.
 */
export function SeedBoxesModal({ onClose }: { onClose: () => void }) {
  const [seeds, setSeeds] = useState<SeedBoxDto[] | null>(null);
  const [provider, setProvider] = useState<SeedProviderId>('yandex');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSeeds((await fetchSeedBoxes()).seeds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока есть ящики «проверяю вход», опрашиваем раз в 15 секунд.
  const waiting = seeds?.some((s) => s.status === 'pending') ?? false;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const act = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => act(async () => {
    await addSeedBox({ provider, email, password });
    setEmail('');
    setPassword('');
  });

  return (
    <SenderModal title="Контрольные ящики" subtitle="Куда раз в день уходят пробы — смотрим, входящие или спам" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as SeedProviderId)}
            aria-label="Сервис"
            className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
          >
            {SEED_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="адрес"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="пароль приложения"
            type="password"
            autoComplete="new-password"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !email.trim() || !password.trim()}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Добавить
          </button>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {!seeds ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-zinc-400" /></div>
        ) : seeds.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">Ящиков пока нет</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {seeds.map((s) => (
                <tr key={s.id} className="border-b border-zinc-100 last:border-0">
                  <td className="py-2 pr-2 text-zinc-500">{seedProviderLabel(s.provider)}</td>
                  <td className="py-2 pr-2 font-medium text-zinc-900">{s.email}</td>
                  <td
                    className={`py-2 pr-2 text-xs ${s.status === 'ok' ? 'text-emerald-600' : s.status === 'failed' ? 'text-red-600' : 'text-zinc-400'}`}
                    title={s.last_error ?? undefined}
                  >
                    {s.enabled ? STATUS_TEXT[s.status] : 'выключен'}
                  </td>
                  <td className="py-2 pr-2 text-right text-xs tabular-nums text-zinc-400" title="Проб за 7 дней">{s.probes7d}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <label className="mr-2 inline-flex items-center gap-1 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={busy}
                        onChange={(e) => void act(() => patchSeedBox(s.id, { enabled: e.target.checked }))}
                      />
                      в работе
                    </label>
                    <button
                      type="button"
                      title="Проверить вход"
                      disabled={busy || s.provider === 'outlook'}
                      onClick={() => void act(() => patchSeedBox(s.id, { recheck: true }))}
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Удалить вместе с историей проб"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Удалить ${s.email}?`)) void act(() => deleteSeedBox(s.id));
                      }}
                      className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SenderModal>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/sender/SeedBoxesModal.tsx
git commit -m "feat(sender): окно «Контрольные ящики»"
```

---

### Task 9: Экран «Статистики»

**Files:**
- Modify: `app/src/components/sender/StatsTab.tsx`

- [ ] **Step 1: Импорты**

```ts
import { SEED_PROVIDERS } from '@/lib/sender/seedPlacement';
import { SeedBoxesModal } from './SeedBoxesModal';
```

и `type SeedPlacementDto` в импорт из `./api`.

- [ ] **Step 2: Подблок** — новая функция перед `Deliverability`:

```tsx
function SeedPlacement({ placement, onOpen }: { placement: SeedPlacementDto | null | undefined; onOpen: () => void }) {
  const totalBoxes = Object.values(placement?.boxes ?? {}).reduce((s, n) => s + (n ?? 0), 0);
  return (
    <div className="mt-4 border-t border-zinc-100 pt-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-zinc-400">Входящие или спам · 7 дней</span>
        <button type="button" onClick={onOpen} className="text-xs text-blue-600 hover:underline">
          Контрольные ящики ({totalBoxes})
        </button>
      </div>
      {SEED_PROVIDERS.map((p) => {
        const row = placement?.providers.find((r) => r.provider === p.id);
        const boxes = placement?.boxes[p.id] ?? 0;
        const total = row ? row.inbox + row.spam + row.missing : 0;
        const value = !boxes && !total ? 'нет ящиков'
          : !total ? 'проверок не было'
          : `во входящих ${nf(row!.inbox)} из ${nf(total)} · спам ${nf(row!.spam)} · не дошло ${nf(row!.missing)}`;
        const tone = total && row!.spam * 3 > total ? 'bad' : total && row!.missing * 10 > total ? 'warn' : null;
        return <Row key={p.id} label={p.label} value={value} tone={tone} />;
      })}
    </div>
  );
}
```

- [ ] **Step 3: Вставить в `Deliverability`** — сигнатура становится `function Deliverability({ data, onOpenSeeds }: { data: SenderStatsDto; onOpenSeeds: () => void })`; сразу после `</div>` блока `divide-y` со строками (перед сеткой «Входящие / В стоп-лист») добавить:

```tsx
      <SeedPlacement placement={data.seedPlacement} onOpen={onOpenSeeds} />
```

- [ ] **Step 4: Окно в `StatsTab`** — состояние рядом с остальными:

```ts
  const [seedsOpen, setSeedsOpen] = useState(false);
```

вызов `<Deliverability data={data} onOpenSeeds={() => setSeedsOpen(true)} />`, а в конце разметки вкладки, перед последним закрывающим `</div>`:

```tsx
      {seedsOpen ? (
        <SeedBoxesModal
          onClose={() => {
            setSeedsOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
```

- [ ] **Step 5: Колонка «Контроль»** — в `BreakdownTable` после `rows`:

```ts
  // Последний итог проб ящика по сервисам — буквы «Я G M O».
  const seedLatest = useMemo(() => {
    const map = new Map<string, Map<string, { status: string; day: string; folder: string | null }>>();
    for (const l of data.seedPlacement?.latest ?? []) {
      const byProvider = map.get(l.mailbox_id) ?? new Map();
      byProvider.set(l.provider, l);
      map.set(l.mailbox_id, byProvider);
    }
    return map;
  }, [data.seedPlacement]);
```

в шапке таблицы после цикла `COLUMNS`:

```tsx
                {view === 'mailboxes' ? <th className="px-3 py-2 text-right font-medium">Контроль</th> : null}
```

в строке после ячейки «Отбои»:

```tsx
                    {view === 'mailboxes' ? (
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {SEED_PROVIDERS.map((p) => {
                          const r = seedLatest.get(row.key)?.get(p.id);
                          const cls = r?.status === 'inbox' ? 'text-emerald-600' : r?.status === 'spam' ? 'font-semibold text-red-600' : 'text-zinc-300';
                          const title = r
                            ? `${p.label}, ${r.day}: ${r.status === 'inbox' ? 'во входящих' : r.status === 'spam' ? 'в спаме' : 'не дошло'}`
                            : `${p.label}: не проверялось`;
                          return <span key={p.id} className={`ml-1 ${cls}`} title={title}>{p.letter}</span>;
                        })}
                      </td>
                    ) : null}
```

- [ ] **Step 6: Commit**

```bash
git add app/src/components/sender/StatsTab.tsx
git commit -m "feat(sender): «Статистика» — входящие/спам по сервисам и колонка «Контроль» у ящиков"
```

---

### Task 10: Проверка и выкладка

- [ ] **Step 1:** `git push origin dmitriy_kuladmed_new`; дождаться CI ветки (typecheck:fast, lint, связанные тесты). Красное — чинить по логу.
- [ ] **Step 2:** обновить память (`outreach`/`sender` заметки) — что сделано и что ждёт выкладки.
- [ ] **Step 3 (после выкладки, пользователь):** добавить по 1–2 ящика Яндекс/Gmail/Mail.ru; через 2–3 минуты статус «работает». На следующий рабочий день в 10–17 МСК пробы уходят; через 30 минут — первые итоги в «Статистике». Сверить 2–3 пробы глазами в самих контрольных ящиках.

---

## Self-review

- Спека §3.1 контрольные ящики → Task 1, 5, 8; проверка входа и папки спама → Task 3 `verifyPendingSeedBoxes`; Outlook `needs_oauth` → Task 5 POST.
- §3.2 план дня, очередь, окно 10–17, пн–пт → Task 2 `pickSeedBox`/`randomSeedSlot`, Task 3 `planSeedProbes`.
- §3.3 отправка с IP ящика, без лимитов, не в `sender_messages` → Task 3 `sendDueSeedProbes`, Task 4.
- §3.4 только поиск, `readOnly`, 30 мин / 15 мин / 2 ч → Task 3 `checkSeedProbes`.
- §4.1 подблок + окно → Task 8, 9; §4.2 колонка → Task 9.
- Outlook OAuth (второй этап) — вне этого плана, отдельная задача.
