import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { chunkForInFilter } from './inFilter';
import { applyVars, buildMessageId, followUpSubject, recipientVars } from './template';
import { nextGapMs, nextWindowSlot, type SendWindow } from './sendWindow';
import type { CampaignRow, MailboxRow, RecipientRow, StepRow } from './types';

/**
 * Планировщик цепочки: решает, кому пора слать следующий шаг, с какого ящика
 * и в какую минуту, и кладёт письмо в очередь. Сама отправка — в sendWorker.
 *
 * Правила, которые здесь держатся:
 *   • лид закреплён за одним ящиком на всю цепочку (sticky sender);
 *   • дневной лимит ящика считается вместе с уже запланированными письмами,
 *     иначе очередь за один проход выберет недельный объём;
 *   • письма ставятся с паузой друг от друга и только внутрь окна отправки;
 *   • адрес из стоп-листа не получает письмо, а лид закрывается;
 *   • письмо, пустое после подстановки переменных, не ставится в очередь.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const RECIPIENTS_PER_CAMPAIGN = 500;
/**
 * Ящиков пула за один запрос. in-фильтр уезжает в адрес запроса, а шлюз перед
 * PostgREST режет адреса длиннее ~9–13 КБ (414): пул папки на 200+ ящиков
 * (~8 КБ id) в один запрос не влезает. Адреса почты разной длины — их пачки
 * набираются по весу (inFilter.ts): стоп-лист на все 500 получателей прохода
 * одним запросом — это ~16 КБ.
 */
const MAILBOX_CHUNK = 50;

interface MailboxSlot {
  mailbox: MailboxRow;
  remaining: number;
  /** Время, на которое уже поставлено последнее письмо этого ящика. */
  cursor: Date;
}

function windowOf(campaign: CampaignRow): SendWindow {
  return {
    timezone: campaign.timezone,
    sendHourFrom: campaign.send_hour_from,
    sendHourTo: campaign.send_hour_to,
    sendWeekdays: campaign.send_weekdays,
  };
}

/**
 * Остаток дневного лимита ящика: отправленное сегодня плюс уже запланированное.
 * Не прочитали — ноль на этот проход: раньше ошибка запроса считалась «ничего
 * не отправлено», и ящику давали весь дневной лимит сверх уже ушедшего.
 * Перелимит бьёт по репутации ящика, пропуск одного тика — нет.
 */
async function remainingQuota(mailbox: MailboxRow, log: Log): Promise<number> {
  if (!supabaseAdmin) return 0;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const [sent, pending] = await Promise.all([
    supabaseAdmin
      .from('sender_messages')
      .select('id', { count: 'exact', head: true })
      .eq('mailbox_id', mailbox.id)
      .eq('status', 'sent')
      .gte('sent_at', dayStart.toISOString()),
    supabaseAdmin
      .from('sender_messages')
      .select('id', { count: 'exact', head: true })
      .eq('mailbox_id', mailbox.id)
      .in('status', ['scheduled', 'sending']),
  ]);
  const error = sent.error ?? pending.error;
  if (error) {
    log('error', `Ящик ${mailbox.email}: лимит не прочитан — в этот проход с него не пишем`, error.message);
    return 0;
  }

  return Math.max(0, mailbox.daily_campaign_limit - (sent.count ?? 0) - (pending.count ?? 0));
}

/**
 * Адреса прохода, стоящие в стоп-листе. Не прочитали — исключение, а не
 * пустой список: раньше сбой запроса (в том числе 414 на длинном адресе)
 * молча давал «стоп-лист пуст», и письмо уходило тому, кто просил не писать.
 * Вызывающий пропускает проход кампании.
 */
async function loadSuppressed(emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (!supabaseAdmin || !emails.length) return suppressed;
  for (const part of chunkForInFilter(emails)) {
    const { data, error } = await supabaseAdmin.from('sender_suppressions').select('email').in('email', part);
    if (error) throw new Error(`стоп-лист не прочитан: ${error.message}`);
    for (const row of data ?? []) suppressed.add(String(row.email).toLowerCase());
  }
  return suppressed;
}

/**
 * Адреса, которые прямо сейчас едут в другой кампании (задача 5.5): уникальность
 * есть только внутри кампании, и один лид в двух запущенных получал бы два
 * первых письма с двух разных ящиков одновременно. Занят = чужая активная
 * цепочка, которая трогала лида за последний месяц; закончится — этот адрес
 * поедет со следующего прохода. Не прочитали — исключение, как у стоп-листа:
 * иначе сбой запроса выдавал бы второе первое письмо.
 */
async function loadCrossCampaignBusy(emails: string[], campaignId: string): Promise<Set<string>> {
  const busy = new Set<string>();
  if (!supabaseAdmin || !emails.length) return busy;
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const part of chunkForInFilter(emails)) {
    const { data, error } = await supabaseAdmin
      .from('sender_recipients')
      .select('email')
      .in('email', part)
      .neq('campaign_id', campaignId)
      .eq('status', 'active')
      .not('mailbox_id', 'is', null)
      .gt('updated_at', monthAgo);
    if (error) throw new Error(`занятость адресов в других кампаниях не прочитана: ${error.message}`);
    for (const row of data ?? []) busy.add(String(row.email).toLowerCase());
  }
  return busy;
}

/**
 * Ящики пула, с которых можно слать: проверены и с галочкой. Пачками — пул
 * папки бывает на 200+ ящиков. Не прочитали — исключение: пустой ответ
 * значил бы «ящиков нет» и молчаливый пропуск без причины в логе.
 */
async function loadWorkingMailboxes(mailboxIds: string[]): Promise<MailboxRow[]> {
  const mailboxes: MailboxRow[] = [];
  if (!supabaseAdmin) return mailboxes;
  for (let i = 0; i < mailboxIds.length; i += MAILBOX_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('*')
      .in('id', mailboxIds.slice(i, i + MAILBOX_CHUNK))
      .eq('status', 'verified')
      // Снятая галочка — это «не шлём с него», даже если ящик в пуле кампании.
      .eq('enabled', true);
    if (error) throw new Error(`ящики пула не прочитаны: ${error.message}`);
    mailboxes.push(...((data ?? []) as MailboxRow[]));
  }
  return mailboxes;
}

function pickSlot(slots: MailboxSlot[], recipient: RecipientRow): MailboxSlot | null {
  // Уже закреплённый ящик: если он ещё в пуле и лимит не выбран — только он,
  // иначе лид ждёт следующего окна. Менять отправителя посреди цепочки нельзя:
  // для получателя это выглядит как письмо от другого человека.
  if (recipient.mailbox_id) {
    const own = slots.find((s) => s.mailbox.id === recipient.mailbox_id);
    return own && own.remaining > 0 ? own : null;
  }
  const free = slots.filter((s) => s.remaining > 0);
  if (!free.length) return null;
  return free.reduce((best, slot) => (slot.remaining > best.remaining ? slot : best));
}

async function planCampaign(campaign: CampaignRow, log: Log): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;

  const [{ data: stepRows }, { data: poolRows }] = await Promise.all([
    db.from('sender_campaign_steps').select('*').eq('campaign_id', campaign.id).order('step_no'),
    db.from('sender_campaign_mailboxes').select('mailbox_id').eq('campaign_id', campaign.id),
  ]);

  const steps = (stepRows ?? []) as StepRow[];
  const mailboxIds = (poolRows ?? []).map((r) => String(r.mailbox_id));
  if (!steps.length || !mailboxIds.length) {
    log('warn', `Кампания ${campaign.name}: нет шагов или ящиков — пропуск`);
    return 0;
  }

  let mailboxes: MailboxRow[];
  try {
    mailboxes = await loadWorkingMailboxes(mailboxIds);
  } catch (e) {
    log('error', `Кампания ${campaign.name}: не удалось прочитать ящики пула — проход пропущен`, e);
    return 0;
  }
  if (!mailboxes.length) {
    log('warn', `Кампания ${campaign.name}: нет подтверждённых ящиков — пропуск`);
    return 0;
  }

  const { data: recipientRows } = await db
    .from('sender_recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'active')
    .lte('next_step_at', new Date().toISOString())
    .order('next_step_at')
    .limit(RECIPIENTS_PER_CAMPAIGN);

  const recipients = (recipientRows ?? []) as RecipientRow[];
  if (!recipients.length) return 0;

  // Без стоп-листа и занятости адресов не пишем никому: проход кампании
  // пропускается целиком и повторится на следующем тике.
  let suppressed: Set<string>;
  let busy: Set<string>;
  try {
    suppressed = await loadSuppressed(recipients.map((r) => r.email));
    busy = await loadCrossCampaignBusy(recipients.map((r) => r.email), campaign.id);
  } catch (e) {
    log('error', `Кампания ${campaign.name}: стоп-лист или занятость адресов не проверены — проход пропущен`, e);
    return 0;
  }
  const now = new Date();
  const slots: MailboxSlot[] = [];
  for (const mailbox of mailboxes) {
    // Курсоры всех ящиков не должны стартовать с одной секунды: иначе тысяча
    // ящиков ставит первое письмо в один момент (всплеск в начале окна, потом
    // простой). Случайный сдвиг до 45 минут размазывает старт по окну.
    const startOffsetMs = Math.floor(Math.random() * 45 * 60 * 1000);
    slots.push({ mailbox, remaining: await remainingQuota(mailbox, log), cursor: new Date(now.getTime() + startOffsetMs) });
  }

  // Статус получателя меняем только у всё ещё активного (.eq('status',
  // 'active')): между чтением базы и этой записью обработчик ответов мог
  // отметить его «ответил», «отбой» или «отписался», и без условия планировщик
  // затёр бы ответ своим «пройден» или «стоп-лист».
  let planned = 0;
  for (const recipient of recipients) {
    if (suppressed.has(recipient.email)) {
      await db
        .from('sender_recipients')
        .update({ status: 'stopped', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', recipient.id)
        .eq('status', 'active');
      continue;
    }

    const stepNo = recipient.last_step_sent + 1;
    const step = steps.find((s) => s.step_no === stepNo);
    if (!step) {
      // Цепочка кончилась — лид отработан.
      await db
        .from('sender_recipients')
        .update({ status: 'finished', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', recipient.id)
        .eq('status', 'active');
      continue;
    }

    const vars = recipientVars(recipient);
    const body = applyVars(step.body, vars);
    if (!body.trim()) {
      // Пустое письмо не отправляем. Так бывает, когда шаг ссылается на
      // переменную, которой у получателя нет: у рассылки из автоаутрича тело
      // шага — целиком {{email_N}}, и пропущенное письмо цепочки превратилось
      // бы в письмо без единого слова с нашего ящика. Цепочка для лида
      // кончается — «пройден», и на первом шаге тоже: «стоп-лист» на экране
      // базы означал бы, что лид просил не писать, а это не так. Что первое
      // письмо не ушло вовсе, видно в логе.
      if (stepNo === 1) {
        log('warn', `Кампания ${campaign.name}: первое письмо для ${recipient.email} пустое — получатель закрыт без отправки`);
      }
      await db
        .from('sender_recipients')
        .update({ status: 'finished', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', recipient.id)
        .eq('status', 'active');
      continue;
    }

    // Первое касание не дублируем между кампаниями: пока адрес едет в другой
    // активной кампании, этот старт откладываем на сутки (задача 5.5).
    if (stepNo === 1 && !recipient.mailbox_id && busy.has(recipient.email)) {
      await db
        .from('sender_recipients')
        .update({ next_step_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), updated_at: now.toISOString() })
        .eq('id', recipient.id)
        .eq('status', 'active');
      continue;
    }

    const slot = pickSlot(slots, recipient);
    if (!slot) continue; // лимиты выбраны — лид подождёт следующего прохода

    const firstStep = steps[0];
    const subject = stepNo === 1
      ? applyVars(step.subject, vars)
      : followUpSubject(applyVars(step.subject, vars), applyVars(firstStep.subject, vars));

    const scheduledAt = nextWindowSlot(slot.cursor, windowOf(campaign));
    const messageId = buildMessageId(slot.mailbox.email);

    const { error } = await db.from('sender_messages').insert({
      campaign_id: campaign.id,
      recipient_id: recipient.id,
      mailbox_id: slot.mailbox.id,
      step_no: stepNo,
      to_email: recipient.email,
      subject,
      body,
      message_id: messageId,
      in_reply_to: stepNo === 1 ? null : recipient.thread_message_id,
      status: 'scheduled',
      scheduled_at: scheduledAt.toISOString(),
    });

    if (error) {
      // Уникальный индекс (recipient_id, step_no) — письмо уже запланировано
      // другим проходом. Это не ошибка, просто пропускаем.
      log('warn', `Не удалось запланировать письмо для ${recipient.email}: ${error.message}`);
      continue;
    }

    await db
      .from('sender_recipients')
      .update({
        mailbox_id: slot.mailbox.id,
        next_step_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', recipient.id);

    slot.remaining -= 1;
    slot.cursor = new Date(scheduledAt.getTime() + nextGapMs(campaign.gap_seconds, campaign.gap_jitter_seconds));
    planned += 1;
  }

  return planned;
}

/** Один проход планировщика по всем запущенным кампаниям. */
export async function planSenderMessages(opts?: { log?: Log }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const log: Log = opts?.log ?? (() => {});

  const { data, error } = await supabaseAdmin
    .from('sender_campaigns')
    .select('*')
    .eq('status', 'running')
    .order('created_at');
  if (error) {
    log('error', `Список идущих кампаний не прочитан: ${error.message}`);
    return 0;
  }

  let planned = 0;
  for (const campaign of (data ?? []) as CampaignRow[]) {
    // Каждая кампания — отдельно: исключение в одной (битые данные, сбой
    // запроса) раньше обрывало весь проход, и остальные кампании стояли,
    // пока её не починят.
    try {
      planned += await planCampaign(campaign, log);
    } catch (e) {
      log('error', `Кампания ${campaign.name} (${campaign.id}): проход планировщика упал — остальные идут дальше`, e);
    }
  }
  if (planned) log('info', `Запланировано писем: ${planned}`);
  return planned;
}
