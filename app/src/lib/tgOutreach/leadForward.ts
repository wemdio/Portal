/**
 * Исполнение ручной передачи лида или партнёра.
 *
 * Оператор жмёт кнопку в интерфейсе — задача ложится в
 * `tg_outreach_lead_forwards`. Отправить оттуда нельзя: живое соединение с
 * Telegram есть только у воркера, а второе подключение к той же сессии даёт
 * AUTH_KEY_DUPLICATED и выключенный аккаунт. Поэтому отправляет круг кампании,
 * дойдя до нужного аккаунта, — тем же клиентом, что вёл переписку.
 *
 * Порядок: сначала карточка по шаблону, следом нативная пересылка переписки.
 * Карточка отвечает на «кто это и откуда», пересылка даёт оригиналы сообщений,
 * на которые менеджер может ответить прямо из своего чата.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { splitTelegramMessage } from './leadMessage';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface PendingForward {
  id: string;
  kind: string;
  target_chat: string;
  message_text: string;
  dialog_id: string;
}

export interface ForwardDialogRef {
  tg_user_id: number | null;
  tg_username: string | null;
}

/** Сколько сообщений диалога тянем для нативной пересылки. */
const HISTORY_LIMIT = 200;

const KIND_LABEL: Record<string, string> = {
  lead: 'лид',
  partner: 'кандидат в партнёры',
};

function targetPeer(target: string): string {
  return target.startsWith('@') ? target.slice(1) : target;
}

/**
 * Выполнить все задачи, накопившиеся для этого аккаунта.
 *
 * Ошибка одной задачи не мешает остальным: у каждой свой получатель и свой
 * собеседник, и общего у них только аккаунт.
 */
export async function processLeadForwards(args: {
  db: SupabaseClient;
  client: TelegramClient;
  accountId: string;
  accountName: string;
  log: LogFn;
  shouldStop?: () => boolean;
}): Promise<{ sent: number; failed: number }> {
  const { db, client, accountId, accountName, log } = args;
  const result = { sent: 0, failed: 0 };

  const { data: rows } = await db
    .from('tg_outreach_lead_forwards')
    .select('id, kind, target_chat, message_text, dialog_id')
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(20);

  const pending = (rows ?? []) as PendingForward[];
  if (!pending.length) return result;

  for (const task of pending) {
    if (args.shouldStop?.()) break;

    const label = KIND_LABEL[task.kind] ?? task.kind;
    try {
      const { data: dialogRow } = await db
        .from('tg_outreach_dialogs')
        .select('tg_user_id, tg_username')
        .eq('id', task.dialog_id)
        .maybeSingle();
      const dialog = dialogRow as ForwardDialogRef | null;
      if (!dialog) throw new Error('диалог удалён');

      const peer = dialog.tg_username ? `@${dialog.tg_username}` : dialog.tg_user_id;
      if (!peer) throw new Error('у диалога нет ни юзернейма, ни id');

      const target = targetPeer(task.target_chat);

      // Карточка идёт первой: менеджер сначала понимает, что перед ним, и
      // только потом читает переписку.
      for (const part of splitTelegramMessage(task.message_text)) {
        await client.sendMessage(target, { message: part });
      }

      // Пересылка — лучшее усилие. Карточка уже ушла и содержит переписку
      // текстом, поэтому сбой здесь не повод считать передачу несостоявшейся:
      // менеджер получил всё нужное.
      try {
        const entity = await client.getEntity(peer as string | number);
        const history = await client.getMessages(entity, { limit: HISTORY_LIMIT });
        const ids = history.map((m) => m.id).sort((a, b) => a - b);
        if (ids.length) {
          await client.forwardMessages(target, { fromPeer: entity, messages: ids });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('warning', `Передача (${label}) ушла карточкой, но оригиналы переписки переслать не удалось — ${msg}`);
      }

      await db
        .from('tg_outreach_lead_forwards')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
        .eq('id', task.id);

      log('info', `Аккаунт ${accountName}: передан ${label} в ${task.target_chat}`);
      result.sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .from('tg_outreach_lead_forwards')
        .update({ status: 'failed', error_message: msg.slice(0, 500) })
        .eq('id', task.id);
      log('error', `Аккаунт ${accountName}: не смог передать ${label} в ${task.target_chat} — ${msg}`);
      result.failed++;
    }
  }

  return result;
}
