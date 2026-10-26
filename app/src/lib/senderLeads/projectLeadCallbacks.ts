import type { SupabaseClient } from '@supabase/supabase-js';
import { INTERNAL_ROLES } from '@/lib/roles';
import { enqueueSenderHandoff, HandoffAlreadyQueuedError, loadSenderHandoffContext } from '@/lib/sender/clientHandoff';
import type { Log } from './process';
import {
  activeHandoff,
  CARD_SELECT,
  handoffCcIssue,
  handoffQuotesCardReply,
  loadCard,
  markNotificationsRead,
  renderCard,
  setBoardReview,
  type CardStatus,
  type ProjectLeadCardRow,
} from './projectLeadCards';
import {
  answerSenderLeadCallback,
  editSenderProjectLeadCard,
  isSenderLeadActionData,
  verifySenderLeadAction,
} from './projectLeadTelegram';

/**
 * Кнопки карточки лида «Рассылки» в чате лид-алертов: «Передать клиенту» (p)
 * и «Не лид» (x). Вызывается вебхуком бота лид-алертов до разбора кнопок
 * Instantly; чужие кнопки — false, вебхук разбирает их как раньше.
 *
 * Решение принимает ответственный за проект (или лид проекта, если проект
 * просит его отмечать). Переход статуса — сравнением с ожидаемым: из двух
 * одновременных нажатий проходит одно.
 */

export interface SenderLeadCallbackUpdate {
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
}

export interface SenderLeadCallbackDeps {
  main: SupabaseClient | null;
  instantlyDb: SupabaseClient | null;
  log?: Log;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  edit?: typeof editSenderProjectLeadCard;
  answer?: typeof answerSenderLeadCallback;
}

/** Пользователь Portal, нажавший кнопку, если ему можно решать за эту карточку. */
export async function senderLeadActor(
  main: SupabaseClient,
  card: Pick<ProjectLeadCardRow, 'project_id' | 'responsible_user_id'>,
  telegramId: number | null | undefined,
): Promise<string | null> {
  if (telegramId == null || !card.responsible_user_id) return null;
  const { data: link, error } = await main.from('telegram_links').select('user_id').eq('telegram_id', telegramId).maybeSingle();
  const userId = (link as { user_id?: string } | null)?.user_id;
  if (error || !userId) return null;
  if (userId === card.responsible_user_id) return userId;

  // Лид проекта (PM) — только если проект просит его отмечать и ответственный тот же.
  const { data: project, error: projectError } = await main.from('projects')
    .select('manager, specialist_user_id, tag_project_lead_in_telegram').eq('id', card.project_id).maybeSingle();
  const row = project as { manager: string | null; specialist_user_id: string | null; tag_project_lead_in_telegram: boolean | null } | null;
  if (projectError || !row || row.tag_project_lead_in_telegram !== true || row.specialist_user_id !== card.responsible_user_id) return null;
  const managerName = row.manager?.trim() ?? '';
  if (!managerName) return null;
  const { data: managers, error: managerError } = await main.from('profiles').select('id, full_name')
    .in('role', INTERNAL_ROLES).ilike('full_name', managerName);
  if (managerError) return null;
  const exact = ((managers ?? []) as Array<{ id: string; full_name: string | null }>)
    .filter((profile) => profile.full_name?.trim().toLocaleLowerCase('ru-RU') === managerName.toLocaleLowerCase('ru-RU'));
  return exact.length === 1 && exact[0].id === userId ? userId : null;
}

function statusAnswer(status: CardStatus): string {
  if (status === 'queued' || status === 'sent') return 'Уже передано';
  if (status === 'rejected') return 'Уже отмечено «Не лид»';
  return 'Недоступно';
}

export async function handleSenderProjectLeadCallback(
  update: SenderLeadCallbackUpdate,
  token: string,
  input: SenderLeadCallbackDeps,
): Promise<boolean> {
  const cq = update.callback_query;
  if (!cq?.id || !isSenderLeadActionData(cq.data)) return false;
  const answer = input.answer ?? answerSenderLeadCallback;
  const reply = (text: string, alert = false) => answer(token, cq.id!, text, alert);
  const log: Log = input.log ?? ((level, msg, extra) => console[level](`[sender-lead-card] ${msg}`, extra ?? ''));
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());

  const verified = verifySenderLeadAction(cq.data, token);
  if (!verified) { await reply('Некорректная кнопка'); return true; }
  const { main, instantlyDb } = input;
  if (!main) { await reply('Сервис недоступен — попробуйте позже'); return true; }

  try {
    const card = await loadCard(main, verified.recipientId);
    if (!card) { await reply('Карточка не найдена'); return true; }
    const chatId = cq.message?.chat?.id;
    if (!card.tg_message_id || card.tg_message_id !== cq.message?.message_id || String(card.tg_chat_id) !== String(chatId)) {
      await reply('Недоступно');
      return true;
    }
    const userId = await senderLeadActor(main, card, cq.from?.id);
    if (!userId) { await reply('Нажать может ответственный за проект', true); return true; }

    const decided = { decided_by_user_id: userId, decided_by_telegram_id: cq.from?.id ?? null, decided_at: now().toISOString() };
    const transition = async (from: CardStatus, to: CardStatus, patch: Record<string, unknown>): Promise<ProjectLeadCardRow | null> => {
      const { data, error } = await main.from('sender_project_lead_cards')
        .update({ ...patch, status: to, updated_at: now().toISOString() })
        .eq('recipient_id', card.recipient_id).eq('status', from).select(CARD_SELECT).maybeSingle();
      if (error) throw new Error(`sender_project_lead_cards: ${error.message}`);
      return (data as ProjectLeadCardRow | null) ?? null;
    };
    const undo = (from: CardStatus) => transition(from, 'card_sent', { decided_by_user_id: null, decided_by_telegram_id: null, decided_at: null });
    const render = async (next: ProjectLeadCardRow, handoff: { error: string | null; cc: string[] | null }) => {
      try {
        await renderCard({ db: main, log, edit: input.edit, env, now }, next, handoff);
      } catch (error) {
        // Карточку перерисует следующий круг воркера (статус и текст разошлись).
        log('warn', `Карточка лида ${next.reply_id}: правка не удалась: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (verified.action === 'x') {
      if (card.handoff_mode === 'auto') { await reply('Автопередача включена — «Не лид» недоступен', true); return true; }
      const { data: project } = await main.from('projects').select('handoff_auto_send').eq('id', card.project_id).maybeSingle();
      if ((project as { handoff_auto_send?: boolean } | null)?.handoff_auto_send === true) {
        await reply('Автопередача включена — «Не лид» недоступен', true);
        return true;
      }
      const rejected = await transition('card_sent', 'rejected', decided);
      if (!rejected) { await reply(statusAnswer(card.status)); return true; }
      try {
        // Передачу успели поставить из «Писем» — решение уже принято там.
        if (await activeHandoff(main, card.recipient_id)) {
          await undo('rejected');
          await reply('Уже передано');
          return true;
        }
        // Сначала итог переписки, потом строка доски. Оборвётся после — воркер
        // допишет: карточка «Не лид» с неперерисованным текстом (шаг render)
        // получает итог и скрытую строку.
        const { error: verdictError } = await main.from('sender_recipients').update({
          lead_verdict: 'not_lead', lead_verdict_source: 'manual', lead_verdict_at: now().toISOString(), lead_verdict_by: userId,
        }).eq('id', card.recipient_id);
        if (verdictError) throw new Error(`итог переписки не записан: ${verdictError.message}`);
      } catch (error) {
        await undo('rejected').catch(() => null);
        throw error;
      }
      if (rejected.board_written_at) {
        try {
          await setBoardReview(instantlyDb, rejected.recipient_id, true);
        } catch (error) {
          // Карточку не перерисовываем — воркер скроет строку и перерисует её сам.
          log('warn', `Карточка лида ${card.reply_id}: строка доски не скрыта, доделает воркер: ${error instanceof Error ? error.message : String(error)}`);
          await markNotificationsRead(main, card.reply_id, log);
          await reply('Сохранено: не лид — строку скроем автоматически');
          return true;
        }
      }
      await markNotificationsRead(main, card.reply_id, log);
      await render(rejected, { error: null, cc: null });
      await reply('Сохранено: не лид');
      return true;
    }

    // «Передать клиенту»: сначала занять карточку, потом ставить письмо.
    // Любой сбой до постановки письма возвращает кнопки; оборвись и это —
    // воркер вернёт их сам (шаг stuck).
    if (card.handoff_mode !== 'manual') { await reply('Недоступно'); return true; }
    const claimed = await transition('card_sent', 'queued', decided);
    if (!claimed) { await reply(statusAnswer(card.status)); return true; }
    let enqueued = false;
    let messageId: string | null = null;
    let cc: string[] = [];
    try {
      const ctx = await loadSenderHandoffContext(main, instantlyDb, card.recipient_id);
      const text = (card.draft_text || ctx?.draft || '').trim();
      const refusal = !ctx ? 'Переписка не найдена'
        : ctx.blocked ? ctx.blocked
          : !(await handoffQuotesCardReply(main, card, ctx)) ? 'Лид ответил ещё раз — откройте переписку и передайте из «Писем» «Рассылки»'
            : handoffCcIssue(ctx) ?? (!text ? 'Нет текста передачи — передайте из «Писем» «Рассылки»' : null);
      if (refusal || !ctx) {
        await undo('queued');
        await reply(refusal ?? 'Переписка не найдена', true);
        return true;
      }
      cc = ctx.cc;
      try {
        messageId = (await enqueueSenderHandoff({ db: main, ctx, text, cc: ctx.cc, userId })).messageId;
      } catch (error) {
        if (!(error instanceof HandoffAlreadyQueuedError)) throw error;
        messageId = (await activeHandoff(main, card.recipient_id))?.id ?? null;
      }
      enqueued = true;
    } catch (error) {
      if (!enqueued) await undo('queued').catch(() => null);
      throw error;
    }
    const { data: updated, error: updateError } = await main.from('sender_project_lead_cards')
      .update({ manual_message_id: messageId, updated_at: now().toISOString() })
      .eq('recipient_id', card.recipient_id).select(CARD_SELECT).maybeSingle();
    if (updateError) log('warn', `Карточка лида ${card.reply_id}: письмо передачи не привязано: ${updateError.message}`);
    await markNotificationsRead(main, card.reply_id, log);
    await render((updated as ProjectLeadCardRow | null) ?? claimed, { error: null, cc });
    await reply('Передача в очереди — письмо уйдёт из «Рассылки», клиент в копии');
    return true;
  } catch (error) {
    log('error', `Кнопка карточки лида: ${error instanceof Error ? error.message : String(error)}`);
    await reply('Не удалось — повторите', true);
    return true;
  }
}
