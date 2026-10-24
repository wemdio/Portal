import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkForInFilter } from './inFilter';

/**
 * Лиды упавших ящиков (решение владельца 23.10.2026).
 *
 * Письма цепочки уходят с одного ящика (закреплённый отправитель), поэтому
 * лиды упавшего ящика стоят: планировщик не даёт им другой ящик, а письма на
 * упавшем никто не забирает. Пока ящик перепроверяется (mailboxRecheck):
 *  - тем, кому с него ещё ничего не ушло, через 30 минут подбирается другой
 *    ящик кампании: первое письмо, на каком ящике его ни отправь, — начало
 *    переписки;
 *  - тем, кому уже писали, письма с чужого адреса не шлём: если ящик не
 *    поднялся за 3 дня, цепочка завершается, а лид записывается в стоп-лист
 *    кампании с причиной «ящик переписки не работает» (mailbox_lost) — по ней
 *    health-check присылает сводку. Так же завершаются и те, кого отдать не
 *    вышло (письмо первого шага отвергнуто провайдером или ушло неясно).
 *
 * Только база, без входа в ящики: идёт у держателя аренды, до планировщика.
 */

export const RELEASE_UNWRITTEN_AFTER_MS = 30 * 60_000;
export const STOP_CHAIN_AFTER_MS = 3 * 24 * 3600_000;

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

interface DeadMailbox {
  id: string;
  email: string;
  failed_at: string;
}

interface PinnedRecipient {
  id: string;
  campaign_id: string;
  email: string;
  mailbox_id: string;
  last_step_sent: number;
}

/** Письмо первого шага, которое можно убрать без следа: ещё не уходило и не уходит. */
const REMOVABLE_STEP_STATUSES = ['scheduled', 'canceled'];

/**
 * Кого из лидов упавших ящиков куда: отдать другому ящику (ещё не писали,
 * ящик лежит дольше 30 минут) или завершить цепочку (ящик лежит дольше
 * 3 дней — все его лиды, кроме тех, кого в этот проход удалось отдать).
 * Остальные ждут перепроверки.
 */
export function planDeadMailboxRelease(
  boxes: DeadMailbox[],
  recipients: PinnedRecipient[],
  now: number,
): { release: PinnedRecipient[]; stop: PinnedRecipient[] } {
  const failedAt = new Map(boxes.map((box) => [box.id, Date.parse(box.failed_at)]));
  const release: PinnedRecipient[] = [];
  const stop: PinnedRecipient[] = [];
  for (const recipient of recipients) {
    const since = failedAt.get(recipient.mailbox_id);
    if (since === undefined || !Number.isFinite(since)) continue;
    const down = now - since;
    if (recipient.last_step_sent <= 0 && down >= RELEASE_UNWRITTEN_AFTER_MS) release.push(recipient);
    if (down >= STOP_CHAIN_AFTER_MS) stop.push(recipient);
  }
  return { release, stop };
}

export async function releaseDeadMailboxRecipients(opts: {
  db: SupabaseClient;
  log?: Log;
  now?: number;
}): Promise<{ released: number; stopped: number }> {
  const { db } = opts;
  const log: Log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();

  const { data: boxRows, error: boxError } = await db
    .from('sender_mailboxes')
    .select('id, email, failed_at')
    .eq('status', 'failed')
    .lte('failed_at', new Date(now - RELEASE_UNWRITTEN_AFTER_MS).toISOString());
  if (boxError) throw new Error(`упавшие ящики не прочитаны: ${boxError.message}`);
  const boxes = (boxRows ?? []) as DeadMailbox[];
  if (!boxes.length) return { released: 0, stopped: 0 };

  const recipients: PinnedRecipient[] = [];
  for (const part of chunkForInFilter(boxes.map((box) => box.id))) {
    const { data, error } = await db
      .from('sender_recipients')
      .select('id, campaign_id, email, mailbox_id, last_step_sent')
      .eq('status', 'active')
      .in('mailbox_id', part);
    if (error) throw new Error(`лиды упавших ящиков не прочитаны: ${error.message}`);
    recipients.push(...((data ?? []) as PinnedRecipient[]));
  }
  if (!recipients.length) return { released: 0, stopped: 0 };

  const { release, stop } = planDeadMailboxRelease(boxes, recipients, now);
  const failures: string[] = [];
  const releasedIds = await releaseUnwritten(db, release, failures);
  const released = releasedIds.size;
  const stopped = await stopChains(db, boxes, stop.filter((recipient) => !releasedIds.has(recipient.id)), failures);

  if (released || stopped) {
    log('info', `Упавшие ящики: отдано другим ящикам ${released} лидов, завершено цепочек ${stopped}`);
  }
  if (failures.length) throw new Error(`сбоев записи ${failures.length}: ${failures[0]}`);
  return { released, stopped };
}

/**
 * Лидам без единого ушедшего письма — другой ящик: письмо первого шага с
 * упавшего ящика убирается, закрепление снимается, и планировщик в тот же
 * проход ставит письмо на рабочий ящик кампании (со своими лимитами,
 * стоп-листом и новым Message-ID). Письмо, которое уже ушло, уходит или
 * завершилось неясно, не трогаем — такой лид остаётся ждать ящик.
 */
async function releaseUnwritten(db: SupabaseClient, recipients: PinnedRecipient[], failures: string[]): Promise<Set<string>> {
  const released = new Set<string>();
  for (const part of chunkForInFilter(recipients.map((recipient) => recipient.id))) {
    const { data: steps, error: stepsError } = await db
      .from('sender_messages')
      .select('recipient_id, status')
      .eq('step_no', 1)
      .in('recipient_id', part);
    if (stepsError) {
      failures.push(`письма первого шага не прочитаны: ${stepsError.message}`);
      continue;
    }
    const stepStatus = new Map((steps ?? []).map((row) => [String(row.recipient_id), String(row.status)]));
    const withRemovable = part.filter((id) => REMOVABLE_STEP_STATUSES.includes(stepStatus.get(id) ?? ''));
    const withoutStep = part.filter((id) => !stepStatus.has(id));

    // Убранное письмо — подтверждение, что его никто не забрал в отправку.
    let removed: string[] = [];
    if (withRemovable.length) {
      const { data: deleted, error: deleteError } = await db
        .from('sender_messages')
        .delete()
        .eq('step_no', 1)
        .in('recipient_id', withRemovable)
        .in('status', REMOVABLE_STEP_STATUSES)
        .select('recipient_id');
      if (deleteError) {
        failures.push(`письма первого шага не убраны: ${deleteError.message}`);
        continue;
      }
      removed = (deleted ?? []).map((row) => String(row.recipient_id));
    }

    const ids = [...withoutStep, ...removed];
    if (!ids.length) continue;
    const pinnedTo = [...new Set(recipients.filter((recipient) => ids.includes(recipient.id)).map((r) => r.mailbox_id))];
    const nowIso = new Date().toISOString();
    const { data: updated, error: updateError } = await db
      .from('sender_recipients')
      .update({ mailbox_id: null, next_step_at: nowIso, updated_at: nowIso })
      .in('id', ids)
      .eq('status', 'active')
      .eq('last_step_sent', 0)
      .in('mailbox_id', pinnedTo)
      .select('id');
    if (updateError) {
      // Письма уже убраны, а лид закреплён и без письма: следующий проход
      // увидит его снова (без письма первого шага) и доделает.
      failures.push(`лиды не откреплены: ${updateError.message}`);
      continue;
    }
    for (const row of updated ?? []) released.add(String(row.id));
  }
  return released;
}

/**
 * Лидам, которым уже писали с упавшего ящика, — конец цепочки: стоп-лист
 * кампании с причиной (сначала он — его видят и планировщик, и claim), затем
 * «стоп» получателю и отмена его ждущих писем.
 */
async function stopChains(
  db: SupabaseClient,
  boxes: DeadMailbox[],
  recipients: PinnedRecipient[],
  failures: string[],
): Promise<number> {
  if (!recipients.length) return 0;
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  let stopped = 0;
  for (const part of chunkForInFilter(recipients.map((recipient) => recipient.id))) {
    const rows = recipients.filter((recipient) => part.includes(recipient.id));
    const { error: suppressError } = await db.from('sender_campaign_suppressions').upsert(
      rows.map((recipient) => {
        const box = boxById.get(recipient.mailbox_id);
        const since = box ? new Date(box.failed_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
        return {
          campaign_id: recipient.campaign_id,
          email: recipient.email,
          reason: 'mailbox_lost',
          note: `Ящик переписки ${box?.email ?? ''} не работает с ${since} — цепочка завершена`,
        };
      }),
      { onConflict: 'campaign_id,email', ignoreDuplicates: true },
    );
    if (suppressError) {
      failures.push(`стоп-лист кампании не записан: ${suppressError.message}`);
      continue;
    }

    const nowIso = new Date().toISOString();
    // Только пока лид всё ещё за упавшим ящиком: открепленного уже ведёт другой.
    const pinnedTo = [...new Set(rows.map((recipient) => recipient.mailbox_id))];
    const { data: updated, error: stopError } = await db
      .from('sender_recipients')
      .update({ status: 'stopped', next_step_at: null, updated_at: nowIso })
      .in('id', part)
      .eq('status', 'active')
      .in('mailbox_id', pinnedTo)
      .select('id');
    if (stopError) {
      failures.push(`цепочки не завершены: ${stopError.message}`);
      continue;
    }
    stopped += (updated ?? []).length;

    const { error: cancelError } = await db
      .from('sender_messages')
      .update({ status: 'canceled' })
      .in('recipient_id', part)
      .eq('status', 'scheduled');
    if (cancelError) failures.push(`письма завершённых цепочек не отменены: ${cancelError.message}`);
  }
  return stopped;
}
