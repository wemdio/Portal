import type { AgentUser, ConversationMessage } from './types';
import { buildSystemPrompt } from './prompt';
import { ALL_TOOLS, WRITE_TOOL_NAMES } from './tools';
import { toolHandlers } from './handlers';
import { writeToolHandlers } from './writeHandlers';
import { callLlm } from './llm';
import { getHistory, pushMessages } from './memory';
import { sendMessage, sendChatAction, sendDocument, answerCallbackQuery, editMessageReplyMarkup } from './telegram';
import type { InlineButton } from './telegram';
import { identifyUser } from './auth';
import { handleLinkCommand } from './link';
import { addPendingItem, getPending, clearPending } from './pendingActions';
import { exportParserResults } from './exportCsv';
import { logError, logAudit } from '@/lib/loggerServer';
import { transcribeVoiceMessage } from './voice';

const MAX_TOOL_ITERATIONS = 3;
const CONFIRM_DATA = 'confirm';
const CANCEL_DATA = 'cancel';

const CONFIRM_BUTTONS: InlineButton[][] = [
  [
    { text: '✅ Подтвердить', callback_data: CONFIRM_DATA },
    { text: '❌ Отменить', callback_data: CANCEL_DATA },
  ],
];

function describeAction(tool: string, args: Record<string, unknown>): string {
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
    launch_search_parser: (a) => `Запустить поисковый парсер${a.queries ? `: ${String(a.queries).split('\n').length} запрос(ов)` : ''}${a.brief ? ` по брифу` : ''}`,
    launch_yandex_maps_parser: (a) => `Запустить парсер Яндекс.Карт: ${String(a.search_urls ?? '').split('\n').filter(Boolean).length} URL`,
    launch_email_search: (a) => `Найти email на ${String(a.urls ?? '').split('\n').filter(Boolean).length} сайтах`,
    launch_email_validation: (a) => `Валидировать ${String(a.emails ?? '').split(/[\n,;]+/).filter(Boolean).length} email`,
    launch_lpr_search: (a) => `Найти ЛПР: ${a.domain ?? a.company_name ?? a.linkedin_url ?? ''}`,
    launch_brief_scoring: (a) => `Скоринг ЦА по брифу: «${String(a.brief_text ?? '').slice(0, 50)}...»`,
    clean_company_names: (a) => `Очистить названия компаний (job: ${String(a.job_id ?? '').slice(0, 8)}...)`,
    deduplicate_results: (a) => {
      const parts = [`Убрать дубликаты по «${a.field ?? 'email'}»`];
      if (a.remove_empty) parts.push('+ удалить строки без значения');
      parts.push(`(job: ${String(a.job_id ?? '').slice(0, 8)}...)`);
      return parts.join(' ');
    },
    create_pipeline: (a) => {
      const steps = (a.steps as { type: string }[] | undefined) ?? [];
      const labels: Record<string, string> = {
        parse_hh: 'HH', parse_search: 'Поиск', parse_yandex_maps: 'Яндекс.Карты',
        clean_names: 'Очистка', enrich_emails: 'Email', validate_emails: 'Валидация',
        deduplicate: 'Дедупликация', export: 'Экспорт',
      };
      const chain = steps.map((s) => labels[s.type] ?? s.type).join(' → ');
      return `Создать пайплайн: ${chain}`;
    },
  };

  const fn = descriptions[tool];
  return fn ? fn(args) : `Выполнить ${tool}`;
}

function buildConfirmationMessage(descriptions: string[]): string {
  const header = descriptions.length > 1
    ? `⚠️ <b>Подтверждение (${descriptions.length} действий)</b>`
    : '⚠️ <b>Подтверждение</b>';

  const body = descriptions.map((d, i) =>
    descriptions.length > 1 ? `${i + 1}. ${d}` : d,
  ).join('\n');

  return `${header}\n\n${body}`;
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

    if (call.function.name === 'export_parser_results') {
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        const result = await exportParserResults(
          args.job_id as string,
          args.parser_type as string | undefined,
        );
        if (typeof result === 'string') {
          content = result;
        } else {
          await sendDocument(chatId, result.filename, result.buffer, `${result.rowCount} записей`);
          content = `Файл ${result.filename} отправлен (${result.rowCount} записей).`;
        }
      } catch (err) {
        content = `Ошибка экспорта: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    } else if (!handler) {
      content = `Неизвестный инструмент: ${call.function.name}`;
    } else if (isWrite) {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      args._chatId = chatId;
      const desc = describeAction(call.function.name, args);
      addPendingItem(chatId, { tool: call.function.name, args, description: desc }, user);
      pendingSet = true;
      content = `[PENDING_CONFIRMATION] ${desc}`;
    } else {
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        args._userId = user.userId;
        const readHandler = handler as (params: Record<string, unknown>) => Promise<string>;
        content = await readHandler(args);
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
          const descriptions = pending.items.map((item) => item.description);
          const confirmText = buildConfirmationMessage(descriptions);
          await sendMessage(chatId, confirmText, CONFIRM_BUTTONS);
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

  await sendChatAction(chatId);

  const results: string[] = [];
  const errors: string[] = [];

  for (const item of pending.items) {
    const handler = writeToolHandlers[item.tool];
    if (!handler) {
      errors.push(`Неизвестное действие: ${item.tool}`);
      continue;
    }

    try {
      const result = await handler(item.args, pending.user);
      results.push(result);
      await logAudit('telegram-agent.write.confirmed', `User ${user.fullName} confirmed: ${item.tool}`, {
        userId: user.userId,
        tool: item.tool,
        args: item.args,
      });
    } catch (err) {
      await logError('telegram-agent.write.error', err);
      errors.push(`${item.description}: ошибка`);
    }
  }

  const parts: string[] = [];
  if (results.length > 0) parts.push(results.map((r) => `✅ ${r}`).join('\n\n'));
  if (errors.length > 0) parts.push(errors.map((e) => `❌ ${e}`).join('\n'));
  await sendMessage(chatId, parts.join('\n\n') || '❌ Не удалось выполнить действия.');
}

export async function handleCallbackQuery(callbackQuery: {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}): Promise<void> {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message?.chat.id;
  const messageId = callbackQuery.message?.message_id;
  const telegramId = callbackQuery.from.id;

  if (!chatId || !data) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  try {
    const user = await identifyUser(telegramId);
    if (!user) {
      await answerCallbackQuery(callbackQuery.id, 'Аккаунт не привязан');
      return;
    }

    if (messageId) {
      await editMessageReplyMarkup(chatId, messageId);
    }

    if (data === CONFIRM_DATA) {
      await answerCallbackQuery(callbackQuery.id, 'Выполняю...');
      await handleConfirmation(chatId, user, true);
    } else if (data === CANCEL_DATA) {
      await answerCallbackQuery(callbackQuery.id, 'Отменено');
      await handleConfirmation(chatId, user, false);
    } else {
      await answerCallbackQuery(callbackQuery.id);
    }
  } catch (err) {
    await logError('telegram-agent.callback.error', err);
    await answerCallbackQuery(callbackQuery.id, 'Ошибка');
  }
}

export async function handleAgentMessage(msg: {
  chat: { id: number };
  from?: { id: number };
  text?: string;
  voice?: { file_id: string; duration: number };
}): Promise<void> {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;
  if (!telegramId) return;

  let text = msg.text?.trim() ?? '';

  if (!text && msg.voice) {
    await sendChatAction(chatId);
    const transcribed = await transcribeVoiceMessage(msg.voice.file_id, msg.voice.duration);
    if (!transcribed) {
      await sendMessage(
        chatId,
        msg.voice.duration > 300
          ? '⚠️ Голосовое слишком длинное (макс. 5 минут). Попробуйте короче или текстом.'
          : '⚠️ Не удалось распознать голосовое. Попробуйте ещё раз или напишите текстом.',
      );
      return;
    }
    text = transcribed;
  }

  if (!text) return;

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
