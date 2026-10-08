import type { SupabaseClient } from '@supabase/supabase-js';
import { loadVeContactDeliveryCampaignInventory } from './contactDeliveryInventory';
import type { ContactTargetState } from './contactDeliveryTarget';

export class ContactTargetError extends Error {}

export async function contactTargetState(portalDb: SupabaseClient, instantlyDb: SupabaseClient, projectId: string): Promise<ContactTargetState> {
  const inventory = await loadVeContactDeliveryCampaignInventory(portalDb, instantlyDb, projectId);
  const { data, error } = await portalDb.rpc('ve_contact_target_state', {
    p_project_id: projectId, p_observed_first_contacted: inventory.observedFirstContacted,
  });
  if (error || !data) throw new ContactTargetError(error?.code === 'P0001' ? error.message : 'Не удалось прочитать общий план проекта. Обновите страницу.');
  return data as ContactTargetState;
}

export async function changeContactTarget(portalDb: SupabaseClient, instantlyDb: SupabaseClient, input: {
  projectId: string; target: number; expectedTarget: number; expectedRevision: number; actorId: string;
}): Promise<ContactTargetState> {
  // Only read the provider/catalog. The atomic DB operation alone changes the
  // plan; this endpoint never calls campaign creation, upload, Start or Pause.
  const inventory = await loadVeContactDeliveryCampaignInventory(portalDb, instantlyDb, input.projectId);
  const { data, error } = await portalDb.rpc('ve_change_contact_target', {
    p_project_id: input.projectId, p_target_contacts: input.target,
    p_expected_target: input.expectedTarget, p_expected_revision: input.expectedRevision,
    p_actor_id: input.actorId, p_observed_first_contacted: inventory.observedFirstContacted,
  });
  if (error || !data) throw new ContactTargetError(error?.code === 'P0001' ? error.message : 'Не удалось сохранить цель. Обновите план перед повтором.');
  return data as ContactTargetState;
}
