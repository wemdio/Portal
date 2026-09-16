import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
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
 *   • адрес из стоп-листа не получает письмо, а лид закрывается.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const RECIPIENTS_PER_CAMPAIGN = 500;

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

/** Остаток дневного лимита ящика: отправленное сегодня плюс уже запланированное. */
async function remainingQuota(mailbox: MailboxRow): Promise<number> {
  if (!supabaseAdmin) return 0;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const [{ count: sent }, { count: pending }] = await Promise.all([
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

  return Math.max(0, mailbox.daily_campaign_limit - (sent ?? 0) - (pending ?? 0));
}

async function loadSuppressed(emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (!supabaseAdmin || !emails.length) return suppressed;
  const { data } = await supabaseAdmin
    .from('sender_suppressions')
    .select('email')
    .in('email', emails);
  for (const row of data ?? []) suppressed.add(String(row.email).toLowerCase());
  return suppressed;
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

  const { data: mailboxRows } = await db
    .from('sender_mailboxes')
    .select('*')
    .in('id', mailboxIds)
    .eq('status', 'verified');
  const mailboxes = (mailboxRows ?? []) as MailboxRow[];
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

  const suppressed = await loadSuppressed(recipients.map((r) => r.email));
  const now = new Date();
  const slots: MailboxSlot[] = [];
  for (const mailbox of mailboxes) {
    slots.push({ mailbox, remaining: await remainingQuota(mailbox), cursor: new Date(now) });
  }

  let planned = 0;
  for (const recipient of recipients) {
    if (suppressed.has(recipient.email)) {
      await db
        .from('sender_recipients')
        .update({ status: 'stopped', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', recipient.id);
      continue;
    }

    const stepNo = recipient.last_step_sent + 1;
    const step = steps.find((s) => s.step_no === stepNo);
    if (!step) {
      // Цепочка кончилась — лид отработан.
      await db
        .from('sender_recipients')
        .update({ status: 'finished', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', recipient.id);
      continue;
    }

    const slot = pickSlot(slots, recipient);
    if (!slot) continue; // лимиты выбраны — лид подождёт следующего прохода

    const vars = recipientVars(recipient);
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
      body: applyVars(step.body, vars),
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

  const { data } = await supabaseAdmin
    .from('sender_campaigns')
    .select('*')
    .eq('status', 'running')
    .order('created_at');

  let planned = 0;
  for (const campaign of (data ?? []) as CampaignRow[]) {
    planned += await planCampaign(campaign, log);
  }
  if (planned) log('info', `Запланировано писем: ${planned}`);
  return planned;
}
