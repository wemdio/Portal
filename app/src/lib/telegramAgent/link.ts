import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyLinkToken } from './linkToken';
import { sendMessage } from './telegram';
import { logAudit, logError } from '@/lib/loggerServer';

export async function handleLinkCommand(chatId: number, telegramId: number, token: string): Promise<void> {
  try {
    const botToken = process.env.TG_AGENT_BOT_TOKEN;
    if (!botToken || !supabaseAdmin) {
      await sendMessage(chatId, '❌ Привязка временно недоступна.');
      return;
    }

    const result = verifyLinkToken(token, botToken);

    if (!result.ok) {
      const messages: Record<string, string> = {
        invalid_format: '❌ Неверная ссылка привязки.',
        invalid_signature: '❌ Неверная ссылка привязки.',
        expired: '⏰ Ссылка привязки истекла. Сгенерируйте новую в профиле портала.',
      };
      await sendMessage(chatId, messages[result.error] ?? '❌ Ошибка привязки.');
      return;
    }

    const { data: existing } = await supabaseAdmin
      .from('telegram_links')
      .select('user_id')
      .eq('telegram_id', String(telegramId))
      .maybeSingle();

    if (existing) {
      if (existing.user_id === result.userId) {
        await sendMessage(chatId, '✅ Ваш аккаунт уже привязан к порталу.');
      } else {
        await sendMessage(chatId, '⚠️ Этот Telegram-аккаунт уже привязан к другому пользователю портала.');
      }
      return;
    }

    const { data: existingUser } = await supabaseAdmin
      .from('telegram_links')
      .select('telegram_id')
      .eq('user_id', result.userId)
      .maybeSingle();

    if (existingUser) {
      await sendMessage(chatId, '⚠️ К этому пользователю портала уже привязан другой Telegram-аккаунт.');
      return;
    }

    const { error: insertError } = await supabaseAdmin
      .from('telegram_links')
      .insert({ user_id: result.userId, telegram_id: String(telegramId) });

    if (insertError) {
      await logError('telegram-agent.link.insert-failed', insertError);
      await sendMessage(chatId, '❌ Не удалось привязать аккаунт. Попробуйте позже.');
      return;
    }

    await logAudit('telegram-agent.link.success', 'Telegram account linked', {
      userId: result.userId,
      telegramId,
    });

    await sendMessage(
      chatId,
      '✅ <b>Telegram привязан к порталу!</b>\n\n'
      + 'Теперь вы можете задавать вопросы о проектах, задачах и данных портала прямо здесь.',
    );
  } catch (err) {
    await logError('telegram-agent.link.error', err);
    await sendMessage(chatId, '❌ Произошла ошибка при привязке. Попробуйте позже.').catch(() => {});
  }
}
