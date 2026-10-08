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
  SEED_PROVIDERS,
  pickJunkFolder,
  pickSeedBox,
  type SeedProvider,
} from './seedBoxRules';

/**
 * Контрольные ящики «Рассылки» — входящие или спам (спека
 * docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md).
 *
 * Раз в рабочий день каждый ящик идущих рассылок шлёт на контрольные ящики
 * Яндекса, Gmail и Mail.ru по одному нейтральному письму; ведущий воркер
 * заходит в контрольный ящик по IMAP и смотрит, во «Входящих» письмо или в
 * спаме. Health score ящика — доля «Входящих» за 7 дней.
 *
 * Ежедневная отправка выключена, пока не включат SENDER_SEED_PROBES_ENABLED=1:
 * сначала подключаем купленные ящики и убеждаемся, что вход есть. Проверка
 * входа по кнопке на экране работает всегда.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export function seedProbesEnabled(): boolean {
  return process.env.SENDER_SEED_PROBES_ENABLED === '1';
}

/** Окно отправки проб по Москве: письма расходятся по дню, а не пачкой. */
const WINDOW_START_MSK_HOUR = 10;
const WINDOW_END_MSK_HOUR = 17;
const MSK_OFFSET_HOURS = 3;
/** Первую проверку папки делаем через полчаса: доставка и фильтры не мгновенны. */
const FIRST_CHECK_DELAY_MS = 30 * 60 * 1000;
/** Не нашли за два часа — «не дошло». */
const MISSING_AFTER_MS = 2 * 60 * 60 * 1000;
/** Не вошли в контрольный ящик за шесть часов — проба не засчитывается. */
const CHECK_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SEND_PER_TICK = 3;

/** Нейтральные деловые письма без ссылок: не копия боевого и не реклама. */
const PROBE_LETTERS: Array<{ subject: string; body: string }> = [
  { subject: 'Короткий вопрос', body: 'Добрый день!\n\nПодскажите, пожалуйста, актуален ли ещё наш вопрос по срокам? Если удобнее обсудить позже — дайте знать.' },
  { subject: 'Уточнение по срокам', body: 'Здравствуйте!\n\nХотел уточнить, остаются ли в силе договорённости по срокам, которые мы обсуждали. Буду благодарен за короткий ответ.' },
  { subject: 'По нашему разговору', body: 'Добрый день!\n\nВозвращаюсь к нашему разговору. Если появились вопросы или нужны дополнительные материалы — напишите, подготовлю.' },
  { subject: 'Встреча на следующей неделе', body: 'Здравствуйте!\n\nПредлагаю созвониться на следующей неделе и сверить планы. Какие дни и время вам удобны?' },
  { subject: 'Документы по проекту', body: 'Добрый день!\n\nПодскажите, получили ли вы документы, которые я отправлял ранее? Если что-то не дошло — пришлю повторно.' },
  { subject: 'Вопрос по сотрудничеству', body: 'Здравствуйте!\n\nХотел бы уточнить пару деталей по сотрудничеству. Когда вам удобно ответить на несколько вопросов?' },
];

function mskParts(now: Date): { day: string; weekday: number; hour: number } {
  const msk = new Date(now.getTime() + MSK_OFFSET_HOURS * 3_600_000);
  return {
    day: msk.toISOString().slice(0, 10),
    weekday: msk.getUTCDay(),
    hour: msk.getUTCHours(),
  };
}

function mskHourToDate(day: string, hour: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - MSK_OFFSET_HOURS));
}

function humanImapError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const auth = (error as { authenticationFailed?: boolean })?.authenticationFailed
    || /auth|login|credential|invalid|password/i.test(text);
  // Ответ сервера отличает неверный пароль от блокировки ящика или входа с нового адреса
  const server = (error as { responseText?: string })?.responseText?.trim();
  if (auth) {
    const hint = 'Не вошли: проверьте пароль приложения (пароль IMAP) и что в ящике включён доступ по IMAP';
    return (server ? `${hint}. Ответ сервера: ${server}` : hint).slice(0, 300);
  }
  return `Не подключились по IMAP: ${server || text}`.slice(0, 300);
}

interface SeedBoxRow {
  id: string;
  provider: SeedProvider;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  secret_encrypted: string;
  enabled: boolean;
  status: 'pending' | 'ok' | 'failed';
  junk_folder: string | null;
}

async function openSeedBox(box: SeedBoxRow): Promise<ImapFlow> {
  const guard = await assertSafeImapTarget(box.imap_host, box.imap_port);
  if (!guard.ok) throw new Error(`IMAP-адрес отклонён (${guard.reason})`);
  const secret = unsealMailboxSecret(box.secret_encrypted);
  const client = new ImapFlow({
    host: box.imap_host,
    port: box.imap_port,
    secure: true,
    auth: { user: box.imap_user, pass: secret.imapPassword ?? '' },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  // Без слушателя событие 'error' роняет процесс (byoMailbox/imap.ts); ошибку получает await.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/**
 * Проверка контрольного ящика: вход по IMAP и поиск папки спама. Результат
 * сразу пишется в строку ящика.
 */
export async function checkSeedBox(boxId: string): Promise<{ ok: boolean; error: string | null; junkFolder: string | null }> {
  if (!supabaseAdmin) return { ok: false, error: 'Сервис не настроен', junkFolder: null };
  const db = supabaseAdmin;
  const { data } = await db.from('sender_seed_boxes').select('*').eq('id', boxId).maybeSingle();
  const box = data as SeedBoxRow | null;
  if (!box) return { ok: false, error: 'Ящик не найден', junkFolder: null };

  let result: { ok: boolean; error: string | null; junkFolder: string | null };
  let client: ImapFlow | null = null;
  try {
    client = await openSeedBox(box);
    const folders = await client.list();
    const junk = pickJunkFolder(folders.map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse ?? null })));
    result = junk
      ? { ok: true, error: null, junkFolder: junk }
      : { ok: false, error: 'Вошли, но не нашли папку «Спам» — напишите, как она называется в этом ящике', junkFolder: null };
  } catch (e) {
    result = { ok: false, error: humanImapError(e), junkFolder: null };
  } finally {
    await client?.logout().catch(() => {});
  }

  await db.from('sender_seed_boxes').update({
    status: result.ok ? 'ok' : 'failed',
    last_error: result.error,
    junk_folder: result.junkFolder ?? box.junk_folder,
    checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', box.id);
  return result;
}

/**
 * Пробы с дня `fromDay` целиком: база отдаёт не больше тысячи строк за запрос,
 * а за неделю их тысячи (ящики × 3 сервиса × 5 дней). Страницы — по id.
 */
export async function readSeedProbesSince<T>(fromDay: string, columns: string): Promise<T[]> {
  if (!supabaseAdmin) return [];
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from('sender_seed_probes')
      .select(columns).gte('day', fromDay).order('id').range(from, from + 999);
    if (error) throw new Error(`пробы не прочитались: ${error.message}`);
    rows.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < 1000) return rows;
  }
}

let plannedDay: string | null = null;

/**
 * План на день (ведущий воркер): каждому ящику идущих рассылок — по пробе на
 * каждый сервис с рабочими контрольными ящиками. Контрольный ящик — по
 * очереди (меньше всего проб за 7 дней, не вчерашний). Время — случайно в
 * окне 10:00–17:00 МСК. Повторный запуск дублей не даёт: (day, mailbox, provider).
 */
export async function planSeedProbes(opts: { log: Log; now?: Date }): Promise<void> {
  if (!seedProbesEnabled() || !supabaseAdmin) return;
  const db = supabaseAdmin;
  const now = opts.now ?? new Date();
  const { day, weekday, hour } = mskParts(now);
  if (plannedDay === day) return;
  if (weekday === 0 || weekday === 6 || hour >= WINDOW_END_MSK_HOUR) return;

  const { data: campaigns } = await db.from('sender_campaigns').select('id').eq('status', 'running');
  const campaignIds = (campaigns ?? []).map((c) => String(c.id));
  if (!campaignIds.length) {
    plannedDay = day;
    return;
  }
  const linked = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data: links, error } = await db.from('sender_campaign_mailboxes').select('mailbox_id')
      .in('campaign_id', campaignIds).order('mailbox_id').order('campaign_id').range(from, from + 999);
    if (error) throw new Error(`ящики кампаний не прочитались: ${error.message}`);
    for (const link of links ?? []) linked.add(String(link.mailbox_id));
    if (!links || links.length < 1000) break;
  }
  const linkedIds = [...linked];
  const mailboxIds: string[] = [];
  for (let i = 0; i < linkedIds.length; i += 200) {
    const { data: rows } = await db.from('sender_mailboxes').select('id')
      .in('id', linkedIds.slice(i, i + 200)).eq('status', 'verified').eq('enabled', true);
    mailboxIds.push(...(rows ?? []).map((r) => String(r.id)));
  }

  const { data: boxRows } = await db.from('sender_seed_boxes').select('id, provider').eq('status', 'ok').eq('enabled', true);
  const boxes = (boxRows ?? []) as { id: string; provider: SeedProvider }[];
  if (!mailboxIds.length || !boxes.length) {
    plannedDay = day;
    return;
  }

  // Нагрузка на контрольные ящики за 7 дней и вчерашние пары — для очереди.
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const recent = await readSeedProbesSince<{ mailbox_id: string; seed_box_id: string | null; provider: string; day: string }>(
    weekAgo, 'mailbox_id, seed_box_id, provider, day');
  const load = new Map<string, number>();
  const lastPair = new Map<string, { day: string; seed: string }>();
  for (const row of recent) {
    if (!row.seed_box_id || row.day >= day) continue;
    load.set(row.seed_box_id, (load.get(row.seed_box_id) ?? 0) + 1);
    const key = `${row.mailbox_id}|${row.provider}`;
    const prev = lastPair.get(key);
    if (!prev || row.day > prev.day) lastPair.set(key, { day: row.day, seed: row.seed_box_id });
  }

  const startMs = Math.max(mskHourToDate(day, WINDOW_START_MSK_HOUR).getTime(), now.getTime() + 60_000);
  const endMs = mskHourToDate(day, WINDOW_END_MSK_HOUR).getTime();
  const rows: Record<string, unknown>[] = [];
  for (const mailboxId of mailboxIds) {
    for (const provider of Object.keys(SEED_PROVIDERS) as SeedProvider[]) {
      const candidates = boxes.filter((b) => b.provider === provider).map((b) => ({ id: b.id, load: load.get(b.id) ?? 0 }));
      const seedId = pickSeedBox(candidates, lastPair.get(`${mailboxId}|${provider}`)?.seed ?? null);
      if (!seedId) continue;
      load.set(seedId, (load.get(seedId) ?? 0) + 1);
      const letter = PROBE_LETTERS[Math.floor(Math.random() * PROBE_LETTERS.length)];
      rows.push({
        day,
        mailbox_id: mailboxId,
        seed_box_id: seedId,
        provider,
        subject: letter.subject,
        scheduled_at: new Date(startMs + Math.random() * Math.max(0, endMs - startMs)).toISOString(),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('sender_seed_probes')
      .upsert(rows.slice(i, i + 500), { onConflict: 'day,mailbox_id,provider', ignoreDuplicates: true });
    if (error) throw new Error(`план проб не записался: ${error.message}`);
  }
  plannedDay = day;
  opts.log('info', `Контрольные ящики: на ${day} запланировано проб ${rows.length} (ящиков ${mailboxIds.length})`);
}

/**
 * Отправка проб с наступившим временем — только с ящиков своего адреса, как
 * боевые письма: тот же IP, те же заголовки. Лимиты ящика не тратят.
 */
export async function sendDueSeedProbes(opts: { egressIp: string; log: Log }): Promise<void> {
  if (!seedProbesEnabled() || !supabaseAdmin) return;
  const db = supabaseAdmin;
  const { data: due } = await db.from('sender_seed_probes')
    .select('id, mailbox_id, seed_box_id, subject')
    .eq('status', 'planned').lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at').limit(100);
  const probes = (due ?? []) as { id: string; mailbox_id: string; seed_box_id: string | null; subject: string }[];
  if (!probes.length) return;

  const { data: owned } = await db.from('sender_mailboxes').select('*')
    .in('id', [...new Set(probes.map((p) => p.mailbox_id))]).eq('egress_ip', opts.egressIp);
  const mailboxes = new Map(((owned ?? []) as MailboxRow[]).map((m) => [m.id, m]));
  const mine = probes.filter((p) => mailboxes.has(p.mailbox_id)).slice(0, SEND_PER_TICK);
  if (!mine.length) return;

  const { data: seedRows } = await db.from('sender_seed_boxes').select('id, email, enabled, status')
    .in('id', mine.map((p) => p.seed_box_id).filter((id): id is string => Boolean(id)));
  const seeds = new Map(((seedRows ?? []) as { id: string; email: string; enabled: boolean; status: string }[]).map((s) => [s.id, s]));

  for (const probe of mine) {
    const mailbox = mailboxes.get(probe.mailbox_id)!;
    const seed = probe.seed_box_id ? seeds.get(probe.seed_box_id) : undefined;
    const fail = async (error: string) => {
      await db.from('sender_seed_probes').update({ status: 'send_failed', error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', probe.id);
    };
    if (!seed || !seed.enabled || seed.status !== 'ok') {
      await fail('Контрольный ящик выключен или без входа');
      continue;
    }
    if (!mailbox.enabled || mailbox.status !== 'verified') {
      await fail('Ящик рассылки выключен или не прошёл проверку');
      continue;
    }
    const auth = await authForMailbox(mailbox);
    if (!auth.ok) {
      await fail(`Ящик не вошёл: ${auth.error}`);
      continue;
    }
    const letter = PROBE_LETTERS.find((l) => l.subject === probe.subject) ?? PROBE_LETTERS[0];
    const name = (mailbox.display_name ?? '').trim();
    const messageId = buildMessageId(mailbox.email);
    const result = await sendSenderMail(
      { host: mailbox.smtp_host, port: mailbox.smtp_port, tlsMode: mailbox.smtp_tls_mode, username: mailbox.username, auth: auth.smtp },
      {
        from: name ? `${name} <${mailbox.email}>` : mailbox.email,
        to: seed.email,
        subject: letter.subject,
        text: name ? `${letter.body}\n\n${name}` : letter.body,
        messageId,
      },
    );
    if (!result.ok) {
      await fail(`Отправка не прошла (${result.code}): ${result.error ?? ''}`);
      opts.log('warn', `Контрольная проба ${mailbox.email} → ${seed.email}: отправка не прошла (${result.code})`);
      continue;
    }
    const nowIso = new Date().toISOString();
    await db.from('sender_seed_probes').update({ status: 'sent', message_id: messageId, sent_at: nowIso, updated_at: nowIso }).eq('id', probe.id);
  }
}

let lastCheckAt = 0;

/**
 * Проверка папки (ведущий воркер, раз в 5 минут): одно IMAP-подключение на
 * контрольный ящик, поиск каждой пробы по Message-ID во «Входящих» и в спаме.
 * Ящик открывается только на чтение: письма не открываем, не помечаем и не
 * переносим — иначе сервис «научится» на наших действиях и начнёт врать.
 */
export async function checkSeedProbes(opts: { log: Log }): Promise<void> {
  if (!supabaseAdmin) return;
  if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return;
  lastCheckAt = Date.now();
  const db = supabaseAdmin;
  const { data } = await db.from('sender_seed_probes')
    .select('id, seed_box_id, message_id, sent_at, attempts')
    .eq('status', 'sent')
    .lt('sent_at', new Date(Date.now() - FIRST_CHECK_DELAY_MS).toISOString())
    .order('sent_at').limit(300);
  const probes = (data ?? []) as { id: string; seed_box_id: string | null; message_id: string | null; sent_at: string; attempts: number }[];
  if (!probes.length) return;

  const bySeed = new Map<string, typeof probes>();
  for (const probe of probes) {
    if (!probe.seed_box_id) continue;
    bySeed.set(probe.seed_box_id, [...(bySeed.get(probe.seed_box_id) ?? []), probe]);
  }

  for (const [seedId, list] of bySeed) {
    const { data: boxRow } = await db.from('sender_seed_boxes').select('*').eq('id', seedId).maybeSingle();
    const box = boxRow as SeedBoxRow | null;
    const nowIso = () => new Date().toISOString();
    const age = (p: (typeof list)[number]) => Date.now() - new Date(p.sent_at).getTime();
    if (!box) continue;

    let client: ImapFlow | null = null;
    try {
      client = await openSeedBox(box);
      if (box.status === 'failed') {
        await db.from('sender_seed_boxes').update({ status: 'ok', last_error: null, checked_at: nowIso(), updated_at: nowIso() }).eq('id', box.id);
      }
      const found = new Map<string, 'inbox' | 'spam'>();
      const folders: Array<{ path: string; kind: 'inbox' | 'spam' }> = [{ path: 'INBOX', kind: 'inbox' }];
      if (box.junk_folder) folders.push({ path: box.junk_folder, kind: 'spam' });
      for (const folder of folders) {
        await client.mailboxOpen(folder.path, { readOnly: true });
        for (const probe of list) {
          if (!probe.message_id || found.has(probe.id)) continue;
          const uids = await client.search({ header: { 'message-id': probe.message_id } }, { uid: true });
          if (Array.isArray(uids) && uids.length) found.set(probe.id, folder.kind);
        }
      }
      for (const probe of list) {
        const kind = found.get(probe.id);
        if (kind) {
          await db.from('sender_seed_probes').update({
            status: kind, folder: kind === 'inbox' ? 'INBOX' : box.junk_folder, checked_at: nowIso(), attempts: probe.attempts + 1, updated_at: nowIso(),
          }).eq('id', probe.id);
        } else if (age(probe) > MISSING_AFTER_MS) {
          await db.from('sender_seed_probes').update({ status: 'missing', checked_at: nowIso(), attempts: probe.attempts + 1, updated_at: nowIso() }).eq('id', probe.id);
        } else {
          await db.from('sender_seed_probes').update({ checked_at: nowIso(), attempts: probe.attempts + 1, updated_at: nowIso() }).eq('id', probe.id);
        }
      }
    } catch (e) {
      const error = humanImapError(e);
      opts.log('warn', `Контрольный ящик ${box.email}: ${error}`);
      await db.from('sender_seed_boxes').update({ status: 'failed', last_error: error, checked_at: nowIso(), updated_at: nowIso() }).eq('id', box.id);
      for (const probe of list) {
        if (age(probe) > CHECK_GIVE_UP_MS) {
          await db.from('sender_seed_probes').update({ status: 'check_failed', error, updated_at: nowIso() }).eq('id', probe.id);
        }
      }
    } finally {
      await client?.logout().catch(() => {});
    }
  }
}
