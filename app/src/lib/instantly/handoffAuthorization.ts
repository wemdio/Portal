import type { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { PendingHandoffRow } from './handoffSender';

type MainDb = NonNullable<typeof supabaseAdmin>;
type InstantlyDb = NonNullable<typeof supabaseInstantly>;
type HandoffOwner = Pick<PendingHandoffRow, 'qualification_id' | 'responsible_user_id'>;

/** A project lead may act only when the project opted in to tagging them. */
export async function canActOnManualHandoff(
  main: MainDb,
  instantlyDb: InstantlyDb,
  pending: HandoffOwner,
  telegramId: number | null | undefined,
): Promise<boolean> {
  if (telegramId == null || !pending.responsible_user_id) return false;

  const responsibleLink = await main.from('telegram_links').select('telegram_id')
    .eq('user_id', pending.responsible_user_id).maybeSingle();
  if (responsibleLink.error) return false;
  if (responsibleLink.data?.telegram_id != null &&
    String(responsibleLink.data.telegram_id) === String(telegramId)) return true;

  // The qualification carries the resolved project snapshot. Never infer PM
  // authority from a campaign name, free-text specialist, or Telegram mention.
  const qualification = await instantlyDb.from('instantly_lead_qualifications')
    .select('qualified_project_id').eq('id', pending.qualification_id).maybeSingle();
  const projectId = qualification.data?.qualified_project_id;
  if (qualification.error || !projectId) return false;

  const projectLookup = await main.from('projects')
    .select('manager, specialist_user_id, tag_project_lead_in_telegram')
    .eq('id', projectId).maybeSingle();
  const project = projectLookup.data;
  if (projectLookup.error || !project || project.tag_project_lead_in_telegram !== true ||
    project.specialist_user_id !== pending.responsible_user_id) return false;

  const managerName = typeof project.manager === 'string' ? project.manager.trim() : '';
  if (!managerName) return false;
  const managerLookup = await main.from('profiles').select('id, full_name')
    .ilike('full_name', managerName);
  if (managerLookup.error) return false;
  const exactManagers = (managerLookup.data ?? []).filter((profile) =>
    typeof profile.full_name === 'string' &&
    profile.full_name.trim().toLocaleLowerCase('ru-RU') === managerName.toLocaleLowerCase('ru-RU'));
  if (exactManagers.length !== 1) return false;

  const leadLink = await main.from('telegram_links').select('telegram_id')
    .eq('user_id', exactManagers[0].id).maybeSingle();
  return !leadLink.error && leadLink.data?.telegram_id != null &&
    String(leadLink.data.telegram_id) === String(telegramId);
}
