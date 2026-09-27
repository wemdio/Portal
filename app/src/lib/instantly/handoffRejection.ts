import type { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import { canActOnManualHandoff } from './handoffAuthorization';
import { HANDOFF_AUTO_SEND_MARKER, type PendingHandoffRow } from './handoffSender';

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
