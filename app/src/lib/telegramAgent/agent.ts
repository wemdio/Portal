import type { AgentUser, ConversationMessage } from './types';
import { buildSystemPrompt } from './prompt';
import { ALL_TOOLS, WRITE_TOOL_NAMES } from './tools';
import { toolHandlers } from './handlers';
import { writeToolHandlers } from './writeHandlers';
import { callLlm } from './llm';
import { getHistory, pushMessages } from './memory';
import { sendMessage, sendChatAction } from './telegram';
import { identifyUser } from './auth';
import { handleLinkCommand } from './link';
import { setPending, getPending, clearPending, isConfirmation, isCancellation } from './pendingActions';
import { logError, logAudit } from '@/lib/loggerServer';

const MAX_TOOL_ITERATIONS = 3;

function buildConfirmationText(tool: string, args: Record<string, unknown>): string {
  const descriptions: Record<string, (a: Record<string, unknown>) => string> = {
    update_project_status: (a) => `Изменить статус проекта → <b>${a.new_status}</b>`,
    update_project_fields: (a) => {
      const fields = Object.keys(a).filter((k) => k !== 'project_id');
      return `Обновить поля проекта: ${fields.join(', ')}`;
    },
    create_project: (a) => `Создать проект «${a.name}»${a.client ? ` для клиента ${a.client}` : ''}`,
    create_task: (a) => `Создать задачу «${a.title}»${a.specialist ? ` для ${a.specialist}` : ''}`,
    update_task_status: (a) => `Изменить статус задачи → <b>${a.new_status}</b>`,
    update_task_fields: (a) => {
      const fields = Object.keys(a).filter((k) => k !== 'task_id');
      return `Обновить поля задачи: ${fields.join(', ')}`;
    },
    update_review_status: (a) => `Изменить статус ревью → <b>${a.new_status}</b>`,
    launch_hh_parser: (a) => `Запустить HH-парсер: «${a.text}»${a.area ? ` (регион: ${a.area})` : ''}${a.salary_from ? ` от ${a.salary_from}₽` : ''}`,
  };

  const fn = descriptions[tool];
  const desc = fn ? fn(args) : `Выполнить ${tool}`;
  return `⚠️ <b>Подтверждение</b>\n\n${desc}\n\nОтветьте <b>Да</b> для подтверждения или <b>Нет</b> для отмены.`;
}

async function executeToolCalls(
  chatId: number,
  user: AgentUser,
  toolCalls: { id: string; function: { name: string; arguments: string } }[],
): Promise<{ results: ConversationMessage[]; pendingSet: boolean }> {
  const results: ConversationMessage[] = [];
  let pendingSet = false;

  for (const call of toolCalls) {
    const isWrite = WRITE_TOOL_NAMES.has(call.function.name);
    const handler = isWrite ? writeToolHandlers[call.function.name] : toolHandlers[call.function.name];
    let content: string;

    if (!handler) {
      content = `Неизвестный инструмент: ${call.function.name}`;
    } else if (isWrite) {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const desc = buildConfirmationText(call.function.name, args);
      setPending(chatId, { tool: call.function.name, args, description: desc, user, createdAt: Date.now() });
      pendingSet = true;
      content = `[PENDING_CONFIRMATION] ${desc}`;
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

  return { results, pendingSet };
}

export async function processMessage(chatId: number, user: AgentUser, text: string): Promise<void> {
  await sendChatAction(chatId);

  const history = getHistory(chatId);
  const systemMsg: ConversationMessage = { role: 'system', content: buildSystemPrompt(user) };
  const userMsg: ConversationMessage = { role: 'user', content: text };

  const messages: ConversationMessage[] = [systemMsg, ...history, userMsg];
  const newMessages: ConversationMessage[] = [userMsg];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const response = await callLlm(messages, ALL_TOOLS);

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

      const { results: toolResults, pendingSet } = await executeToolCalls(chatId, user, response.toolCalls);
      messages.push(...toolResults);
      newMessages.push(...toolResults);

      if (pendingSet) {
        const pending = getPending(chatId);
        if (pending) {
          pushMessages(chatId, newMessages);
          await sendMessage(chatId, pending.description);
          return;
        }
      }

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

async function handleConfirmation(chatId: number, user: AgentUser, confirmed: boolean): Promise<void> {
  const pending = getPending(chatId);
  if (!pending) {
    await sendMessage(chatId, 'Нет действия, ожидающего подтверждения.');
    return;
  }

  clearPending(chatId);

  if (!confirmed) {
    await sendMessage(chatId, '❌ Действие отменено.');
    return;
  }

  const handler = writeToolHandlers[pending.tool];
  if (!handler) {
    await sendMessage(chatId, '❌ Неизвестное действие.');
    return;
  }

  await sendChatAction(chatId);

  try {
    const result = await handler(pending.args, pending.user);
    await logAudit('telegram-agent.write.confirmed', `User ${user.fullName} confirmed: ${pending.tool}`, {
      userId: user.userId,
      tool: pending.tool,
      args: pending.args,
    });
    await sendMessage(chatId, `✅ ${result}`);
  } catch (err) {
    await logError('telegram-agent.write.error', err);
    await sendMessage(chatId, '❌ Ошибка при выполнении действия. Попробуйте позже.');
  }
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
        + 'Я могу показать информацию о проектах, задачах, нагрузке команды, а также создавать и обновлять данные.',
      );
      return;
    }

    if (getPending(chatId)) {
      if (isConfirmation(text)) {
        await handleConfirmation(chatId, user, true);
        return;
      }
      if (isCancellation(text)) {
        await handleConfirmation(chatId, user, false);
        return;
      }
      clearPending(chatId);
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
