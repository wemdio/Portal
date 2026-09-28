import type { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import { canActOnManualHandoff } from './handoffAuthorization';
import { HANDOFF_AUTO_SEND_MARKER, type PendingHandoffRow } from './handoffSender';
import { handoffChatId } from './handoffTelegram';
import { INTERNAL_ROLES } from '@/lib/roles';

/** Authorization is shared with send/edit; the DB serializes rejection with
 * their existing pending-row CAS. Never calls Instantly or a model. */
export async function rejectManualHandoff(
  main: NonNullable<typeof supabaseAdmin>,
  db: NonNullable<typeof supabaseInstantly>,
  pending: PendingHandoffRow & { tg_chat_id?: number | null },
  actor: { telegramId?: number; chatId?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (actor.telegramId == null || actor.chatId == null || pending.tg_chat_id == null ||
    String(pending.tg_chat_id) !== String(actor.chatId) ||
    !await canActOnManualHandoff(main, db, pending, actor.telegramId)) {
    return { ok: false, error: 'Отметить «Не лид» может только ответственный специалист или лид проекта с разрешением.' };
  }
  if (pending.auto_send !== false || pending.error_message?.startsWith(HANDOFF_AUTO_SEND_MARKER)) {
    return { ok: false, error: '«Не лид» доступно только при передаче через специалиста.' };
  }
  const qualification = await db.from('instantly_lead_qualifications')
    .select('qualified_project_id').eq('id', pending.qualification_id).maybeSingle();
  if (qualification.error || !qualification.data?.qualified_project_id) {
    return { ok: false, error: 'Не удалось проверить проект. Попробуйте ещё раз.' };
  }
  const project = await main.from('projects').select('handoff_auto_send')
    .eq('id', qualification.data.qualified_project_id).maybeSingle();
  if (project.error || !project.data) return { ok: false, error: 'Не удалось проверить режим передачи. Попробуйте ещё раз.' };
  if (project.data.handoff_auto_send !== false) {
    return { ok: false, error: 'В проекте включена автопередача. «Не лид» недоступно.' };
  }
  const { data, error } = await db.rpc('reject_instantly_handoff', {
    p_qualification_id: pending.qualification_id, p_telegram_id: actor.telegramId,
  });
  if (error) return { ok: false, error: 'Не удалось сохранить решение. Попробуйте ещё раз.' };
  if (data !== 'rejected' && data !== 'already_rejected') {
    return { ok: false, error: 'Передача уже начата или открыт редактор. Отклонение недоступно.' };
  }
  return { ok: true };
}

/** Reject the original alert even when no handoff is configured/materialized.
 * The RPC reserves the same unique qualification row as the handoff worker;
 * no draft, model call or external send is needed to record a rejection. */
export async function rejectLeadFromAlert(
  main: NonNullable<typeof supabaseAdmin>,
  db: NonNullable<typeof supabaseInstantly>,
  qualificationId: string,
  actor: { telegramId?: number; chatId?: number; messageId?: number },
): Promise<{ ok: true; handoffMessage?: { chatId: number; messageId: number } } | { ok: false; error: string }> {
  if (actor.telegramId == null || actor.chatId == null || actor.messageId == null ||
      String(actor.chatId) !== handoffChatId()) {
    return { ok: false, error: 'Недоступно в этом чате.' };
  }
  // A copied/forwarded button is not authority to act on another lead card.
  const alert = await main.from('deadline_notification_log').select('id')
    .eq('entity_type', 'lead_qualification').eq('entity_id', qualificationId)
    .eq('level', 'specialist').eq('tg_sent', true).eq('tg_message_id', actor.messageId)
    .limit(1).maybeSingle();
  if (alert.error || !alert.data) return { ok: false, error: 'Не удалось проверить карточку. Попробуйте ещё раз.' };
  const qualification = await db.from('instantly_lead_qualifications')
    .select('qualified_project_id').eq('id', qualificationId).maybeSingle();
  const projectId = qualification.data?.qualified_project_id;
  if (qualification.error || !projectId) return { ok: false, error: 'Не удалось проверить проект. Попробуйте ещё раз.' };
  const projectLookup = await main.from('projects').select('handoff_auto_send, specialist_user_id, specialist')
    .eq('id', projectId).maybeSingle();
  const project = projectLookup.data;
  if (projectLookup.error || !project) return { ok: false, error: 'Не удалось проверить режим передачи. Попробуйте ещё раз.' };
  if (project.handoff_auto_send !== false) return { ok: false, error: 'В проекте включена автопередача или режим не подтверждён. «Не лид» недоступно.' };

  let responsibleId = project.specialist_user_id as string | null;
  if (!responsibleId && typeof project.specialist === 'string' && project.specialist.trim()) {
    const name = project.specialist.trim();
    const matches = await main.from('profiles').select('id, full_name').in('role', INTERNAL_ROLES).eq('full_name', name);
    const exact = (matches.data ?? []).filter(profile => profile.full_name === name);
    if (!matches.error && exact.length === 1) responsibleId = exact[0].id;
  }
  if (!responsibleId || !await canActOnManualHandoff(main, db, {
    qualification_id: qualificationId, responsible_user_id: responsibleId,
  }, actor.telegramId)) {
    return { ok: false, error: 'Отметить «Не лид» может только ответственный специалист или лид проекта с разрешением.' };
  }
  const pendingLookup = await db.from('instantly_pending_handoffs')
    .select('tg_chat_id, tg_message_id').eq('qualification_id', qualificationId).maybeSingle();
  if (pendingLookup.error) return { ok: false, error: 'Не удалось проверить передачу. Попробуйте ещё раз.' };
  const { data, error } = await db.rpc('reject_instantly_lead_from_alert', {
    p_qualification_id: qualificationId, p_project_id: projectId,
    p_telegram_id: actor.telegramId, p_responsible_user_id: responsibleId, p_chat_id: actor.chatId,
  });
  if (error) return { ok: false, error: 'Не удалось сохранить решение. Попробуйте ещё раз.' };
  if (data !== 'rejected' && data !== 'already_rejected') {
    return { ok: false, error: 'Передача уже начата, завершена или открыт редактор. Отклонение недоступно.' };
  }
  const pending = pendingLookup.data;
  return { ok: true, ...(pending?.tg_message_id != null && String(pending.tg_chat_id) === String(actor.chatId)
    ? { handoffMessage: { chatId: actor.chatId, messageId: Number(pending.tg_message_id) } } : {}) };
}
