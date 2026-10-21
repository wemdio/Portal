import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { LeadCreatePayload } from './types';

export function projectBlockDb() {
  if (!supabaseInstantly) throw new Error('База Instantly не настроена');
  return supabaseInstantly;
}

export async function getProjectContactBlock(projectId: string, email: string) {
  const { data, error } = await projectBlockDb().from('project_contact_blocks')
    .select('version, synced_version, last_error').eq('project_id', projectId).eq('email', email.trim().toLowerCase()).maybeSingle();
  if (error) throw new Error(`Не удалось проверить блокировку в проекте: ${error.message}`);
  return { blocked: Boolean(data), syncPending: Boolean(data && data.version !== data.synced_version) };
}

/** Per-campaign filtering preserves input indexes used by upload ledgers. */
export async function filterProjectBlockedLeads(leads: LeadCreatePayload[], campaignId: string | undefined) {
  const blockedByCampaign = new Map<string, Set<string>>();
  for (const id of new Set(leads.map((lead) => campaignId || lead.campaign_id).filter((id): id is string => Boolean(id)))) {
    const emails = [...new Set(leads.filter((lead) => (campaignId || lead.campaign_id) === id).map((lead) => lead.email.trim().toLowerCase()))];
    // Avoid oversized RPC bodies while keeping every candidate checked.
    const blocked = new Set<string>();
    for (let offset = 0; offset < emails.length; offset += 1000) {
      const { data, error } = await projectBlockDb().rpc('project_contact_blocked_emails', {
        p_campaign_ids: [id], p_emails: emails.slice(offset, offset + 1000),
      });
      if (error || !Array.isArray(data) || data.some((value) => typeof value !== 'string')) {
        throw new Error('Не удалось проверить стоп-лист проекта. Загрузка контактов остановлена.');
      }
      for (const email of data as string[]) blocked.add(email);
    }
    blockedByCampaign.set(id, blocked);
  }
  const indexes = leads.flatMap((lead, index) => blockedByCampaign.get(campaignId || lead.campaign_id || '')?.has(lead.email.trim().toLowerCase()) ? [] : [index]);
  return { leads: indexes.map((index) => leads[index]), indexes };
}

export async function recheckProjectBlocksAfterImport(leads: LeadCreatePayload[], campaignId: string | undefined) {
  for (const id of new Set(leads.map((lead) => campaignId || lead.campaign_id).filter((id): id is string => Boolean(id)))) {
    const emails = leads.filter((lead) => (campaignId || lead.campaign_id) === id).map((lead) => lead.email.trim().toLowerCase());
    for (let offset = 0; offset < emails.length; offset += 1000) {
      const { error } = await projectBlockDb().rpc('project_contact_blocks_after_import', {
        p_campaign_ids: [id], p_emails: emails.slice(offset, offset + 1000),
      });
      if (error) throw new Error('Контакты загружены, но повторная проверка блокировок проекта не подтверждена');
    }
  }
}
