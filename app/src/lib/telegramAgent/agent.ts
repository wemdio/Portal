import type { AgentUser, ConversationMessage } from './types';
import { buildSystemPrompt } from './prompt';
import { AGENT_TOOLS } from './tools';
import { toolHandlers } from './handlers';
import { callLlm } from './llm';
import { getHistory, pushMessages } from './memory';
import { sendMessage, sendChatAction } from './telegram';
import { identifyUser } from './auth';
import { handleLinkCommand } from './link';
import { logError, logAudit } from '@/lib/loggerServer';

const MAX_TOOL_ITERATIONS = 3;

async function executeToolCalls(
  toolCalls: { id: string; function: { name: string; arguments: string } }[],
): Promise<ConversationMessage[]> {
  const results: ConversationMessage[] = [];

  for (const call of toolCalls) {
    const handler = toolHandlers[call.function.name];
    let content: string;

    if (!handler) {
      content = `Неизвестный инструмент: ${call.function.name}`;
    } else {
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        content = await handler(args);
      } catch (err) {
        content = `Ошибка: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }

    results.push({ role: 'tool', tool_call_id: call.id, content });
  }

  return results;
}

export async function processMessage(chatId: number, user: AgentUser, text: string): Promise<void> {
  await sendChatAction(chatId);

  const history = getHistory(chatId);
  const systemMsg: ConversationMessage = { role: 'system', content: buildSystemPrompt(user) };
  const userMsg: ConversationMessage = { role: 'user', content: text };

  const messages: ConversationMessage[] = [systemMsg, ...history, userMsg];
  const newMessages: ConversationMessage[] = [userMsg];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const response = await callLlm(messages, AGENT_TOOLS);

    if (response.toolCalls.length > 0) {
      const assistantMsg: ConversationMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      messages.push(assistantMsg);
      newMessages.push(assistantMsg);

      if (i < MAX_TOOL_ITERATIONS - 1) {
        await sendChatAction(chatId);
      }

      const toolResults = await executeToolCalls(response.toolCalls);
      messages.push(...toolResults);
      newMessages.push(...toolResults);
      continue;
    }

    const finalText = response.content || 'Не удалось сформировать ответ.';
    const assistantFinal: ConversationMessage = { role: 'assistant', content: finalText };
    newMessages.push(assistantFinal);
    pushMessages(chatId, newMessages);
    await sendMessage(chatId, finalText);
    return;
  }

  const fallback = 'Извините, запрос оказался слишком сложным. Попробуйте переформулировать.';
  newMessages.push({ role: 'assistant', content: fallback });
  pushMessages(chatId, newMessages);
  await sendMessage(chatId, fallback);
}

export async function handleAgentMessage(msg: {
  chat: { id: number };
  from?: { id: number };
  text?: string;
}): Promise<void> {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;
  const text = msg.text?.trim();

  if (!text || !telegramId) return;

  const linkPrefix = '/start lnk';
  if (text.startsWith(linkPrefix)) {
    await handleLinkCommand(chatId, telegramId, text.slice(linkPrefix.length));
    return;
  }

  try {
    const user = await identifyUser(telegramId);

    if (!user) {
      await sendMessage(
        chatId,
        '⚠️ Ваш Telegram-аккаунт не привязан к порталу.\n\n'
        + 'Чтобы привязать, откройте портал → Профиль → «Привязать Telegram».',
      );
      return;
    }

    if (text === '/start') {
      await sendMessage(
        chatId,
        `Привет, <b>${user.fullName}</b>! Я AI-ассистент портала.\n\n`
        + 'Спросите меня о проектах, задачах, нагрузке команды или попросите сводку.',
      );
      return;
    }

    await processMessage(chatId, user, text);

    await logAudit('telegram-agent.message', `User ${user.fullName} asked: ${text.slice(0, 100)}`, {
      userId: user.userId,
      telegramId,
      chatId,
    });
  } catch (err) {
    await logError('telegram-agent.error', err);
    await sendMessage(chatId, '❌ Произошла ошибка при обработке запроса. Попробуйте позже.').catch(() => {});
  }
}
