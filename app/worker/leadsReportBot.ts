/**
 * Telegram-бот для управления получателями пятничного отчёта продаж.
 *
 * Команды:
 *   /start, /whoami, /add <chat_id>, /remove <chat_id>, /list
 */
import {
  createWorkerLogger,
  requireSupabaseAdmin,
  setupGracefulShutdown,
  sleep,
} from './_shared';
import {
  getUpdates,
  sendMessage,
  type TelegramUpdate,
} from '@/lib/tgBot/telegramClient';
import {
  addSubscriber,
  getAllRecipients,
  isAdmin,
  listSubscribers,
  removeSubscriber,
} from '@/lib/leadsReport/subscribers';

const WORKER_ID = 'leads-report-bot';
const TOKEN = process.env.LEADS_REPORT_TG_BOT_TOKEN ?? '';

export async function handleUpdate(
  db: ReturnType<typeof requireSupabaseAdmin>,
  update: TelegramUpdate,
  log: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const message = update.message;
  if (!message?.text || !message.from) return;

  const senderId = message.from.id;
  const chatId = message.chat.id;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.toLocaleLowerCase('ru-RU').split('@')[0];
  const reply = (text: string) => sendMessage(TOKEN, { chatId, text });

  log('info', 'command received', { command, senderId, chatId });

  if (command === '/start' || command === '/whoami') {
    const subscribers = await listSubscribers(db);
    const role = isAdmin(senderId)
      ? 'admin'
      : subscribers.some((subscriber) => subscriber.chat_id === senderId)
        ? 'subscriber'
        : 'none';

    if (command === '/whoami') {
      await reply(`Твой chat_id: ${senderId}\nСтатус: ${role}`);
      return;
    }
    if (role === 'admin') {
      await reply(
        'Ты администратор и будешь получать пятничный отчёт продаж в 18:00 МСК.',
      );
      return;
    }
    if (role === 'subscriber') {
      await reply(
        'Ты подписан на пятничный отчёт продаж в 18:00 МСК.',
      );
      return;
    }
    await reply(
      `Нет доступа. Передай администратору свой chat_id: ${senderId}`,
    );
    return;
  }

  if (command === '/add') {
    if (!isAdmin(senderId)) {
      await reply('Только администратор может добавлять получателей.');
      return;
    }
    const targetId = Number(args[0]);
    if (!Number.isSafeInteger(targetId) || targetId === 0) {
      await reply('Использование: /add <chat_id>');
      return;
    }
    await addSubscriber(db, targetId, senderId);
    await reply(`Получатель ${targetId} добавлен.`);
    return;
  }

  if (command === '/remove') {
    if (!isAdmin(senderId)) {
      await reply('Только администратор может удалять получателей.');
      return;
    }
    const targetId = Number(args[0]);
    if (!Number.isSafeInteger(targetId) || targetId === 0) {
      await reply('Использование: /remove <chat_id>');
      return;
    }
    const removed = await removeSubscriber(db, targetId);
    await reply(
      removed
        ? `Получатель ${targetId} удалён.`
        : `Получатель ${targetId} не найден.`,
    );
    return;
  }

  if (command === '/list') {
    if (!isAdmin(senderId)) {
      await reply('Только администратор может смотреть список получателей.');
      return;
    }
    const recipients = await getAllRecipients(db);
    await reply(
      recipients.length
        ? `Получатели (${recipients.length}):\n${recipients.join('\n')}`
        : 'Получатели пока не настроены.',
    );
  }
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  if (!TOKEN) {
    log('error', 'LEADS_REPORT_TG_BOT_TOKEN is not set');
    process.exit(1);
  }

  const db = requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  let offset = 0;
  log('info', 'long polling started');

  while (!shouldStop()) {
    try {
      const updates = await getUpdates(TOKEN, offset);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await handleUpdate(db, update, log);
        } catch (error) {
          log('error', 'update handler failed', error);
        }
      }
    } catch (error) {
      log('error', 'getUpdates failed; retrying in 5 seconds', error);
      await sleep(5_000);
    }
  }

  log('info', 'long polling stopped');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[leadsReportBot] fatal', error);
    process.exit(1);
  });
}
