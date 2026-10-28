import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchNewReplies, type ReplyMailboxRow } from '@/lib/byoMailbox/imap';
import { authForMailbox } from './mailboxAuth';
import {
  bounceIsPermanent,
  classifyReply,
  corporateDomain,
  extractBouncedRecipient,
  extractBounceStatus,
  isOwnMailboxReply,
  isStopRequest,
} from './replyClassify';
import type { MailboxRow, ReplyKind } from './types';
import { cancelPendingMessages, unsubscribeRecipient } from './unsubscribe';

/**
 * Опрос входящих по подключённым ящикам: складываем ответы, связываем их с
 * получателями кампаний и обрываем цепочку тем, кто ответил.
 *
 * IMAP-движок переиспользуется из контура byoMailbox (там же SSRF-проверка
 * хоста и курсор по UID), чтобы не держать две реализации чтения почты.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const MAILBOXES_PER_PASS = 30;

function toImapRow(mailbox: MailboxRow, accessToken?: string): ReplyMailboxRow {
  return {
    accessToken,
    id: mailbox.id,
    // Ящики инструмента не принадлежат клиенту портала — поле нужно только
    // сигнатуре общего IMAP-модуля.
    client_user_id: '',
    email: mailbox.email,
    username: mailbox.username,
    // У ящика на служебном аккаунте секрета нет — вместо него приходит ключ.
    secret_encrypted: mailbox.secret_encrypted ?? '',
    auth_type: 'password',
    imap_host: mailbox.imap_host,
    imap_port: mailbox.imap_port,
    imap_last_uid: mailbox.imap_last_uid,
    imap_uidvalidity: mailbox.imap_uidvalidity,
  };
}

/** Кампании, которые ведутся с этого ящика: в них ищем автора ответа. */
async function campaignIdsOfMailbox(mailboxId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('sender_campaign_mailboxes')
    .select('campaign_id')
    .eq('mailbox_id', mailboxId);
  return (data ?? []).map((row) => String(row.campaign_id));
}

/**
 * Message-ID из заголовка In-Reply-To. Обычно он один, но тикет-системы
 * пишут туда несколько: «<наше письмо> <их тикет>». Сравнение строки целиком
 * такой ответ не узнавало — 14–19.10.2026 «Сравни» ответили на каждое из
 * четырёх писем с другого адреса (m_service@ вместо service@), ответ не
 * привязался к получателю, и цепочка дошла до конца.
 */
export function threadMessageIds(inReplyTo: string | null): string[] {
  if (!inReplyTo) return [];
  const ids = inReplyTo.match(/<[^<>\s]+>/g);
  if (ids?.length) return [...new Set(ids)];
  const trimmed = inReplyTo.trim();
  return trimmed ? [trimmed] : [];
}

async function findRecipientByThread(inReplyTo: string | null): Promise<string | null> {
  const ids = threadMessageIds(inReplyTo);
  if (!supabaseAdmin || !ids.length) return null;
  const { data } = await supabaseAdmin
    .from('sender_messages')
    .select('recipient_id')
    .in('message_id', ids)
    .limit(1)
    .maybeSingle();
  if (data) return String(data.recipient_id);
  // Ответ на наше ручное письмо: новый контакт из ответа лида или тот, кто был
  // в копии, пишет с адреса, которого нет в базе кампании, — только по треду.
  const { data: manual } = await supabaseAdmin
    .from('sender_manual_messages')
    .select('recipient_id')
    .in('message_id', ids)
    .not('recipient_id', 'is', null)
    .limit(1)
    .maybeSingle();
  return manual ? String(manual.recipient_id) : null;
}

async function findRecipientByEmail(email: string | null, campaignIds: string[]): Promise<string | null> {
  if (!supabaseAdmin || !email || !campaignIds.length) return null;
  const { data } = await supabaseAdmin
    .from('sender_recipients')
    .select('id')
    .in('campaign_id', campaignIds)
    .eq('email', email.toLowerCase())
    .limit(1)
    .maybeSingle();
  return data ? String(data.id) : null;
}

/**
 * Получатель по корпоративному домену отправителя — когда ответил не тот,
 * кому мы писали, а коллега: переслал письмо («FW:») или ответил с другого
 * адреса. Ссылки на наше письмо в пересылке нет, адреса в базе нет, и ответ
 * оставался ничьим: 20.10.2026 CMO «Рускона» (kutateladze.d@) предложил
 * встречу в ответ на письмо на lk@ruscon.ru — ни оценки, ни чата, ни сделки,
 * а цепочка дошла до конца.
 *
 * Только среди тех, кому из этого ящика уже ушло письмо, и только по
 * корпоративному домену: бесплатные почты (gmail, mail.ru…) компанию не
 * определяют. Если в компании писали нескольким, берём последнего, кому
 * писали именно с этого ящика.
 */
async function findRecipientByDomain(
  email: string | null,
  campaignIds: string[],
  mailboxId: string,
): Promise<string | null> {
  const domain = corporateDomain(email);
  if (!supabaseAdmin || !domain || !campaignIds.length) return null;
  const { data } = await supabaseAdmin
    .from('sender_recipients')
    .select('id, mailbox_id')
    .in('campaign_id', campaignIds)
    .eq('email_domain', domain)
    .gte('last_step_sent', 1)
    .order('updated_at', { ascending: false })
    .limit(20);
  const rows = (data ?? []) as Array<{ id: string; mailbox_id: string | null }>;
  const own = rows.find((row) => row.mailbox_id === mailboxId) ?? rows[0];
  return own ? String(own.id) : null;
}

/**
 * Писали ли мы когда-нибудь этому человеку или в его компанию — в любой
 * кампании. Нет — значит, письмо не ответ на рассылку, а прогрев чужой сети
 * Instantly: те ящики переписываются с нашими, но в базах их нет. Коллега лида
 * с того же корпоративного домена проходит и остаётся живым ответом.
 */
async function wasEverContacted(email: string | null): Promise<boolean> {
  if (!supabaseAdmin || !email) return false;
  const address = email.toLowerCase();
  const { data: exact } = await supabaseAdmin
    .from('sender_recipients')
    .select('id')
    .eq('email', address)
    .limit(1);
  if (exact?.length) return true;
  const domain = corporateDomain(address);
  if (!domain) return false;
  const { data: sameCompany } = await supabaseAdmin
    .from('sender_recipients')
    .select('id')
    .eq('email_domain', domain)
    .limit(1);
  return Boolean(sameCompany?.length);
}

async function applyReply(params: {
  kind: ReplyKind;
  recipientId: string | null;
  bouncedEmail: string | null;
  /** Код из Status: отчёта о недоставке — по нему мягкий отбойник отличается от вечного. */
  bounceStatus: string | null;
  /** Текст ответа: в нём ищем просьбу больше не писать. */
  replyBody: string | null;
  replySubject: string | null;
  replyFrom: string | null;
  campaignIds: string[];
  log: Log;
}): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const nowIso = new Date().toISOString();

  if (params.kind === 'human' && params.recipientId) {
    // «Стоп»/«отпишитесь» — это отказ, а не диалог: обрываем цепочку и уносим
    // адрес в глобальный стоп-лист, иначе следующая кампания напишет снова.
    const stop = isStopRequest(params.replyBody, params.replySubject);
    const stopEmail = params.replyFrom?.toLowerCase() ?? null;
    if (stop && stopEmail) {
      await unsubscribeRecipient(db, {
        recipientId: params.recipientId,
        emails: [stopEmail],
        note: 'попросил больше не писать',
      });
      return;
    }
    await db
      .from('sender_recipients')
      .update({ status: 'replied', replied_at: nowIso, next_step_at: null, updated_at: nowIso })
      .eq('id', params.recipientId);
    await cancelPendingMessages(db, params.recipientId);
    return;
  }

  if (params.kind === 'bounce') {
    // Мягкий отбойник (ящик переполнен, greylisting, временная недоступность)
    // не выжигает адрес: suppress и 'bounced' — только за «адреса нет» (5.1.x).
    if (!bounceIsPermanent(params.bounceStatus)) {
      params.log('info', `Мягкий отбойник (${params.bounceStatus ?? 'без кода'}) для ${params.bouncedEmail ?? 'неизвестного'} — адрес не подавляем`);
      return;
    }
    const email = params.bouncedEmail;
    if (email) {
      await db
        .from('sender_suppressions')
        .upsert(
          { email, reason: 'hard_bounce', note: `отбойник из входящего письма${params.bounceStatus ? ` (${params.bounceStatus})` : ''}` },
          { onConflict: 'email' },
        );
    }
    const recipientId = params.recipientId ?? (await findRecipientByEmail(email, params.campaignIds));
    if (recipientId) {
      await db
        .from('sender_recipients')
        .update({ status: 'bounced', next_step_at: null, updated_at: nowIso })
        .eq('id', recipientId);
      await cancelPendingMessages(db, recipientId);
    }
  }
}

/**
 * Почему не прочитались входящие — человеческим языком.
 *
 * Сообщение видит менеджер в списке ящиков, а IMAP-движок отдаёт свой текст
 * по-английски и про себя: «Failed to establish connection in required time»
 * не говорит ни что это про чтение ответов, ни что письма при этом уходят.
 * Незнакомую ошибку оставляем как есть — лучше непонятный текст, чем
 * потерянная причина.
 */
function describeImapFailure(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? '');
  const code = (e as { code?: string } | null)?.code ?? '';
  const known = `${code} ${text}`.toLowerCase();

  if (known.includes('required time') || known.includes('timeout') || known.includes('etimedout')) {
    return 'IMAP: почта ящика не ответила вовремя — входящие в этот раз не прочитались. Отправка при этом работает';
  }
  if (known.includes('authenticationfailed') || known.includes('invalid credentials') || known.includes('auth')) {
    return 'IMAP: ящик не принял пароль — ответы читаться не будут, пока пароль не обновят';
  }
  if (known.includes('enotfound') || known.includes('eai_again')) {
    return 'IMAP: сервер ящика не найден — проверьте IMAP-хост в выгрузке провайдера';
  }
  if (known.includes('econnrefused') || known.includes('econnreset')) {
    return 'IMAP: сервер ящика отклонил подключение — это обычно временно';
  }
  return `IMAP: ${text.slice(0, 400)}`;
}

/** Сколько адресов ящиков читать за запрос: PostgREST отдаёт не больше 1000 строк. */
const OWN_EMAILS_PAGE = 1000;

/**
 * Кого опрашивать в этот проход. С 24.10.2026 — только работающие ящики (пул
 * кампании, недавние отправки, закреплённые лиды) не чаще minGapSeconds, а
 * остальные раз в сутки: из 901 ящика на «Рассылку» работали 59, а круг по всем
 * шёл до получаса (миграция 20261024_0010). Без функции в базе (почтовый хост
 * обновился раньше портала) — как раньше, все ящики адреса по очереди.
 */
async function mailboxesToPoll(db: SupabaseClient, egressIp: string, minGapSeconds: number, log: Log): Promise<MailboxRow[]> {
  const { data, error } = await db.rpc('sender_reply_poll_mailboxes', {
    p_egress_ip: egressIp,
    p_limit: MAILBOXES_PER_PASS,
    p_min_gap_seconds: minGapSeconds,
  });
  if (!error) return (data ?? []) as MailboxRow[];
  if (!/sender_reply_poll_mailboxes|PGRST202|42883/.test(`${error.code ?? ''} ${error.message}`)) {
    log('warn', `Ящики для опроса входящих не выбраны: ${error.message}`);
    return [];
  }
  const { data: rows } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'verified')
    .eq('enabled', true)
    // IMAP-вход — такой же вход в ящик, как отправка: только со своего адреса.
    .eq('egress_ip', egressIp)
    .not('imap_host', 'is', null)
    .order('imap_checked_at', { ascending: true, nullsFirst: true })
    .limit(MAILBOXES_PER_PASS);
  return (rows ?? []) as MailboxRow[];
}

/** Адреса всех наших ящиков — постранично: их больше тысячи, а запрос без страниц обрезался на ней. */
async function loadOwnEmails(db: SupabaseClient): Promise<Set<string>> {
  const emails = new Set<string>();
  for (let from = 0; ; from += OWN_EMAILS_PAGE) {
    const { data, error } = await db
      .from('sender_mailboxes')
      .select('email')
      .order('id')
      .range(from, from + OWN_EMAILS_PAGE - 1);
    if (error) throw new Error(`адреса своих ящиков не прочитаны: ${error.message}`);
    for (const row of data ?? []) emails.add(String(row.email).toLowerCase());
    if (!data || data.length < OWN_EMAILS_PAGE) return emails;
  }
}

/**
 * Один проход опроса входящих. true — если что-то новое нашли. Идёт фоном,
 * параллельно отправке: shouldContinue сверяется между ящиками, чтобы
 * остановка воркера не ждала весь проход.
 */
export async function processSenderReplies(opts: {
  egressIp: string;
  log?: Log;
  minGapSeconds?: number;
  shouldContinue?: () => boolean;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const mailboxes = await mailboxesToPoll(db, opts.egressIp, opts.minGapSeconds ?? 300, log);
  if (!mailboxes.length) return false;

  // Прогревочная переписка ходит между нашими же ящиками: такие входящие
  // помечаются 'warmup' и не считаются ответами, иначе reply rate захлёбывается
  // шумом (на старте прода было 453 «ответа» при 7 отправленных письмах).
  const ownEmails = await loadOwnEmails(db);

  let found = false;

  for (const mailbox of mailboxes) {
    if (opts.shouldContinue && !opts.shouldContinue()) break;
    const nowIso = new Date().toISOString();
    try {
      const auth = await authForMailbox(mailbox);
      if (!auth.ok) {
        log('warn', `Ящик ${mailbox.email}: ${auth.error}`);
        // Опрос идёт параллельно отправке: ящик, который она только что
        // уронила, держит её причину — её не затираем.
        await db
          .from('sender_mailboxes')
          .update({ imap_checked_at: nowIso, last_error: auth.error })
          .eq('id', mailbox.id)
          .eq('status', 'verified');
        continue;
      }

      const result = await fetchNewReplies(
        toImapRow(mailbox, auth.imap.kind === 'oauth' ? auth.imap.accessToken : undefined),
      );
      if (!result) {
        await db.from('sender_mailboxes').update({ imap_checked_at: nowIso }).eq('id', mailbox.id);
        continue;
      }

      if (result.replies.length) {
        const campaignIds = await campaignIdsOfMailbox(mailbox.id);

        for (const reply of result.replies) {
          let kind = classifyReply({
            fromEmail: reply.fromEmail,
            subject: reply.subject,
            body: reply.body,
          });
          if (kind !== 'bounce' && isOwnMailboxReply(reply.fromEmail, ownEmails)) {
            kind = 'warmup';
          }
          const bouncedEmail = kind === 'bounce' ? extractBouncedRecipient(reply.body, mailbox.email) : null;
          const bounceStatus = kind === 'bounce' ? extractBounceStatus(reply.body) : null;
          const recipientId =
            kind === 'warmup'
              ? null
              : (await findRecipientByThread(reply.inReplyTo)) ??
              (kind === 'bounce'
                ? await findRecipientByEmail(bouncedEmail, campaignIds)
                : (await findRecipientByEmail(reply.fromEmail, campaignIds)) ??
                  (await findRecipientByDomain(reply.fromEmail, campaignIds, mailbox.id)));
          // Не ответ на наше письмо и не от того, кому мы писали, — прогрев
          // чужой сети. Иначе он копился бы во «Входящих без привязки» и в
          // метриках (453 «ответа» при 7 письмах на старте прода).
          if (
            !recipientId &&
            kind !== 'bounce' &&
            kind !== 'warmup' &&
            !(await wasEverContacted(reply.fromEmail))
          ) {
            kind = 'warmup';
          }

          await db.from('sender_replies').upsert(
            {
              mailbox_id: mailbox.id,
              uid: reply.uid,
              from_email: reply.fromEmail ? reply.fromEmail.toLowerCase() : null,
              from_name: reply.fromName,
              subject: reply.subject,
              body: reply.body,
              message_id: reply.messageId,
              in_reply_to: reply.inReplyTo,
              kind,
              recipient_id: recipientId,
              received_at: reply.receivedAt,
            },
            { onConflict: 'mailbox_id,uid', ignoreDuplicates: true },
          );
          // Адресаты ответа — для «ответить всем» при передаче лида. Отдельной
          // записью и без проверки ошибки: почтовый хост может обновиться
          // раньше, чем в базе появятся колонки, а ответ терять нельзя.
          if (kind === 'human' && (reply.toEmails.length || reply.ccEmails.length)) {
            await db
              .from('sender_replies')
              .update({ to_emails: reply.toEmails, cc_emails: reply.ccEmails })
              .eq('mailbox_id', mailbox.id)
              .eq('uid', reply.uid);
          }

          if (kind !== 'warmup') {
            await applyReply({
              kind,
              recipientId,
              bouncedEmail,
              bounceStatus,
              replyBody: reply.body,
              replySubject: reply.subject,
              replyFrom: reply.fromEmail,
              campaignIds,
              log,
            });
          }
        }

        found = true;
        log('info', `Ящик ${mailbox.email}: новых входящих ${result.replies.length}`);
      }

      await db
        .from('sender_mailboxes')
        .update({
          imap_last_uid: result.newLastUid,
          imap_uidvalidity: result.uidValidity,
          imap_checked_at: nowIso,
        })
        .eq('id', mailbox.id);
      // Опрос прошёл — значит, прошлая жалоба на почту ящика больше не
      // правда. Без этого одна секундная заминка на стороне провайдера
      // оставалась на экране навсегда: ящик работает и шлёт письма, а под
      // адресом всё висит ошибка чтения входящих. Только у подтверждённого:
      // опрос идёт параллельно отправке, и ящик, который она только что
      // уронила, держит её причину.
      if (mailbox.last_error) {
        await db
          .from('sender_mailboxes')
          .update({ last_error: null })
          .eq('id', mailbox.id)
          .eq('status', 'verified');
      }
    } catch (e) {
      log('warn', `Не удалось прочитать входящие ${mailbox.email}: ${e instanceof Error ? e.message : String(e)}`);
      await db
        .from('sender_mailboxes')
        .update({ imap_checked_at: nowIso, last_error: describeImapFailure(e) })
        .eq('id', mailbox.id)
        .eq('status', 'verified');
    }
  }

  return found;
}
