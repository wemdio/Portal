import { randomUUID } from 'node:crypto';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { signHandoffEdit, verifyHandoffEdit } from './handoffCallback';
import { answerCallback, postHandoffEditor } from './handoffTelegram';
import { HANDOFF_AUTO_SEND_MARKER, sendHandoffNow, type PendingHandoffRow } from './handoffSender';

interface Message {
  message_id?: number; message_thread_id?: number; text?: string;
  chat?: { id?: number }; from?: { id?: number; is_bot?: boolean };
  reply_to_message?: { message_id?: number };
}
export interface HandoffEditUpdate {
  message?: Message;
  callback_query?: { id: string; data?: string; from?: { id?: number }; message?: Message };
}
type Row = PendingHandoffRow & {
  status: string; tg_chat_id: number; tg_message_id: number;
  edit_token: string | null; edit_user_id: number | null; edit_chat_id: number | null;
  edit_prompt_id: number | null; edit_preview_id: number | null; edit_expires_at: string | null;
  manual_send_claimed_at: string | null;
};
const clear = { edit_token: null, edit_user_id: null, edit_chat_id: null,
  edit_prompt_id: null, edit_preview_id: null, edit_text: null, edit_expires_at: null };
const MAX_TEXT = 3000;

/** The caller must verify Telegram's webhook secret before entering here. */
export async function handleHandoffEditor(update: HandoffEditUpdate, token: string): Promise<boolean> {
  const cq = update.callback_query;
  const action = cq ? verifyHandoffEdit(cq.data ?? '', token) : null;
  const message = update.message;
  if (!action && !message?.reply_to_message?.message_id) return false;
  const db = supabaseInstantly;
  const main = supabaseAdmin;
  if (!db || !main) return true;
  const from = cq?.from?.id ?? message?.from?.id;
  const context = cq?.message ?? message;
  const chat = context?.chat?.id;
  if (from == null || chat == null || message?.from?.is_bot) return true;
  const tell = async (text: string) => {
    if (cq) await answerCallback(token, cq.id, text, true);
    else await postHandoffEditor(token, chat, text, { threadId: context?.message_thread_id });
  };
  let lookup = db.from('instantly_pending_handoffs').select('*');
  if (action) lookup = action.action === 'e'
    ? lookup.eq('qualification_id', action.id) : lookup.eq('edit_token', action.id);
  else lookup = lookup.eq('edit_chat_id', chat).eq('edit_prompt_id', message!.reply_to_message!.message_id!);
  const { data, error } = await lookup.maybeSingle();
  if (error) { await tell('Редактор временно недоступен. Ничего не отправлено.'); return true; }
  if (!data) { if (cq) await tell('Кнопка устарела. Откройте редактор из карточки лида.'); return true; }
  const row = data as Row;
  const { data: link, error: linkError } = await main.from('telegram_links').select('telegram_id')
    .eq('user_id', row.responsible_user_id ?? '').maybeSingle();
  if (linkError || !link || String(link.telegram_id) !== String(from) || String(row.tg_chat_id) !== String(chat)) {
    await tell('Изменить ответ может только ответственный специалист в чате передачи.'); return true;
  }
  const { data: qual, error: qualError } = await db.from('instantly_lead_qualifications')
    .select('status, queue_archived_at').eq('id', row.qualification_id).maybeSingle();
  if (qualError || !qual || qual.queue_archived_at != null || qual.status !== 'lead' ||
    row.status !== 'pending' || row.manual_send_claimed_at || row.auto_send !== false ||
    row.error_message?.startsWith(HANDOFF_AUTO_SEND_MARKER)) {
    await tell('Передача недоступна: уже начата, завершена, автоматическая или лид в архиве.'); return true;
  }
  // Every operation is a CAS against this session, so send/cancel/reply races
  // cannot overwrite each other; old prompts and previews cannot be reused.
  const change = (values: Record<string, unknown>) => {
    let query = db.from('instantly_pending_handoffs').update(values).eq('id', row.id)
      .eq('status', 'pending').eq('auto_send', false).is('manual_send_claimed_at', null);
    query = row.edit_token ? query.eq('edit_token', row.edit_token) : query.is('edit_token', null);
    return query.select('id').maybeSingle();
  };
  const matchesSession = row.edit_token && String(row.edit_user_id) === String(from) &&
    String(row.edit_chat_id) === String(chat);
  if (action?.action !== 'e' && !matchesSession) {
    await tell('Сессия редактирования устарела.'); return true;
  }
  if (action?.action === 'c' || (!action && message?.text?.trim() === '/cancel')) {
    const result = await change(clear);
    await tell(result.error || !result.data ? 'Черновик уже изменён.' : 'Редактирование отменено. Исходный ответ сохранён; кнопка передачи снова доступна.');
    return true;
  }
  if (action?.action !== 'e' && (!row.edit_expires_at || Date.parse(row.edit_expires_at) <= Date.now())) {
    await tell('Прошло 30 минут. Откройте «Изменить ответ» заново из карточки лида.'); return true;
  }
  if (action && ['s', 'u'].includes(action.action) && row.edit_preview_id !== context?.message_id) {
    await tell('Это не актуальный предпросмотр.'); return true;
  }
  if (action?.action === 's') {
    await answerCallback(token, cq!.id, 'Отправляю подтверждённый ответ…');
    const result = await sendHandoffNow(db, row, { sentByTelegramId: from, editToken: row.edit_token! });
    await postHandoffEditor(token, chat, result.ok ? '✅ Исправленный ответ отправлен лиду, клиент добавлен в копию.'
      : 'Отправку не удалось подтвердить. Повторно не отправляем: сначала нужно проверить результат передачи.',
    { threadId: context?.message_thread_id });
    return true;
  }
  if (action?.action === 'e' || action?.action === 'u') {
    const session = randomUUID();
    const result = await change({ ...clear, edit_token: session, edit_user_id: from, edit_chat_id: chat,
      edit_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() });
    if (result.error || !result.data) { await tell('Черновик уже изменён. Попробуйте снова.'); return true; }
    await answerCallback(token, cq!.id, 'Пришлите новый текст ответом на сообщение бота.');
    const draft = row.edit_text ?? row.draft_text;
    const prompt = await postHandoffEditor(token, chat,
      `✏️ Ответ для передачи лида. Клиент в копии: ${row.client_email.slice(0, 200)}\n\n${draft.length > 2500 ? 'Фрагмент исходного текста:\n' : ''}${draft.slice(0, 2500)}\n\nОтветьте на ЭТО сообщение полным исправленным текстом (до ${MAX_TEXT} символов). Сам ответ ничего не отправляет. Для отмены — /cancel. Сессия: 30 минут.`,
      { threadId: context?.message_thread_id, forceReply: true });
    if (prompt == null) {
      await db.from('instantly_pending_handoffs').update(clear).eq('id', row.id).eq('edit_token', session).is('manual_send_claimed_at', null);
      await tell('Не удалось открыть редактор. Попробуйте снова.'); return true;
    }
    const saved = await db.from('instantly_pending_handoffs').update({ edit_prompt_id: prompt })
      .eq('id', row.id).eq('edit_token', session).is('manual_send_claimed_at', null).select('id').maybeSingle();
    if (saved.error || !saved.data) await tell('Сессия не сохранена. Откройте редактор заново.');
    return true;
  }
  const text = message?.text?.trim();
  if (!text || text.length > MAX_TEXT) { await tell(`Нужен непустой текст до ${MAX_TEXT} символов, без вложений.`); return true; }
  const revision = randomUUID();
  const saved = await change({ edit_token: revision, edit_text: text, edit_prompt_id: null, edit_preview_id: null });
  if (saved.error || !saved.data) { await tell('Этот ответ уже обработан или сессия изменена.'); return true; }
  const preview = await postHandoffEditor(token, chat,
    `Предпросмотр ответа. Клиент в копии: ${row.client_email.slice(0, 200)}\n\n${text}\n\nПисьмо ещё не отправлено.`,
    { threadId: context?.message_thread_id, buttons: [
      [{ text: '✅ Отправить', callback_data: signHandoffEdit('s', revision, token) }],
      [{ text: '✏️ Изменить ещё', callback_data: signHandoffEdit('u', revision, token) },
        { text: 'Отмена', callback_data: signHandoffEdit('c', revision, token) }],
    ] });
  if (preview == null) { await tell('Не удалось показать предпросмотр. Ничего не отправлено. Откройте редактор из карточки ещё раз.'); return true; }
  const bound = await db.from('instantly_pending_handoffs').update({ edit_preview_id: preview })
    .eq('id', row.id).eq('edit_token', revision).is('manual_send_claimed_at', null).select('id').maybeSingle();
  if (bound.error || !bound.data) await tell('Предпросмотр устарел. Откройте редактор заново.');
  return true;
}
