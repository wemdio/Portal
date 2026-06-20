import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { verifyLinkToken } from '@/lib/telegramAgent/linkToken';
import { logAudit, logError } from '@/lib/loggerServer';
import { getClientRepliesBotToken, sendClientReplyPlain } from './bot';

export interface ClientReplyBotMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  text?: string;
}

/**
 * Handles an incoming update for the dedicated "client replies" bot.
 *
 * The ONLY meaningful command is the linking deep-link `/start lnk<token>`,
 * where <token> is the stateless HMAC link token minted by
 * `/api/client/telegram/link-token` (signed with this bot's token, encoding the
 * client's user id). Everything else just gets a polite hint — this is a
 * send-only notification bot, not a conversational agent.
 */
export async function handleClientReplyBotMessage(msg: ClientReplyBotMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();

  const botToken = getClientRepliesBotToken();
  if (!botToken || !supabaseInstantly) {
    await sendClientReplyPlain(chatId, '⚠️ Уведомления временно недоступны.');
    return;
  }
  const db = supabaseInstantly;

  if (!text.startsWith('/start')) {
    await sendClientReplyPlain(
      chatId,
      'Этот бот присылает ответы лидов по вашим кампаниям. Подключение — в портале: раздел «Ответы» → «Подключить Telegram».',
    );
    return;
  }

  const param = text.slice('/start'.length).trim();
  const tokenStr = param.startsWith('lnk') ? param.slice(3) : '';
  if (!tokenStr) {
    await sendClientReplyPlain(
      chatId,
      'Чтобы получать ответы здесь, откройте портал → «Ответы» → «Подключить Telegram».',
    );
    return;
  }

  const verified = verifyLinkToken(tokenStr, botToken);
  if (!verified.ok) {
    const messages: Record<string, string> = {
      invalid_format: '❌ Неверная ссылка привязки.',
      invalid_signature: '❌ Неверная ссылка привязки.',
      expired: '⏰ Ссылка устарела. Сгенерируйте новую в портале.',
    };
    await sendClientReplyPlain(chatId, messages[verified.error] ?? '❌ Ошибка привязки.');
    return;
  }

  const username = msg.from?.username ? `@${msg.from.username}` : null;
  const firstName = msg.from?.first_name ?? null;

  // Guard: this chat must not already belong to a different client.
  const { data: byChat } = await db
    .from('client_reply_telegram_links')
    .select('client_user_id')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (byChat && byChat.client_user_id !== verified.userId) {
    await sendClientReplyPlain(chatId, '⚠️ Этот чат уже привязан к другому аккаунту.');
    return;
  }

  // Upsert by client_user_id (PK): re-linking from a new Telegram account just
  // updates chat_id; re-/start from the same chat is idempotent.
  const { error } = await db
    .from('client_reply_telegram_links')
    .upsert(
      {
        client_user_id: verified.userId,
        chat_id: chatId,
        telegram_username: username,
        telegram_first_name: firstName,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_user_id' },
    );

  if (error) {
    await logError('client-replies-bot.link.upsert-failed', error, { clientUserId: verified.userId });
    await sendClientReplyPlain(chatId, '❌ Не удалось подключить. Попробуйте позже.');
    return;
  }

  await logAudit('client-replies-bot.link.success', 'Client linked replies Telegram', {
    clientUserId: verified.userId,
    chatId,
  });
  await sendClientReplyPlain(
    chatId,
    '✅ Готово! Сюда будут приходить ответы лидов по вашим кампаниям. Отключить можно в портале.',
  );
}
