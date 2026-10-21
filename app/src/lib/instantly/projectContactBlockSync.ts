import { deleteLead, getLead, listLeads } from './client';
import { InstantlyApiError } from './errors';
import { projectBlockDb } from './projectContactBlocks';
import type { Lead } from './types';

const normalize = (value: string) => value.trim().toLowerCase();

async function links(projectId: string) {
  const db = projectBlockDb();
  const results = await Promise.all([
    db.from('project_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
    db.from('project_period_instantly_campaigns').select('campaign_id').eq('project_id', projectId),
  ]);
  if (results.some((result) => result.error)) throw new Error('Не удалось прочитать кампании проекта');
  return [...new Set(results.flatMap((result) => (result.data ?? []).map((row) => row.campaign_id as string)))];
}

async function stillOwned(projectId: string, campaignId: string) {
  const db = projectBlockDb();
  const results = await Promise.all([
    db.from('project_instantly_campaigns').select('project_id').eq('campaign_id', campaignId),
    db.from('project_period_instantly_campaigns').select('project_id').eq('campaign_id', campaignId),
  ]);
  if (results.some((result) => result.error)) throw new Error('Не удалось подтвердить владельца кампании');
  const owners = results.flatMap((result) => result.data ?? []);
  if (!owners.length || owners.some((row) => row.project_id !== projectId)) {
    throw new Error('Привязка кампании изменилась; остановка отложена');
  }
}

function verifyLead(lead: Lead, campaignId: string, email: string) {
  if (normalize(lead.email ?? '') !== email || (lead.campaign ?? lead.campaign_id) !== campaignId || !lead.id) {
    throw new Error('Instantly вернул контакт другой кампании или другой email');
  }
}

async function findLeads(campaignId: string, email: string, accountId: string) {
  const found = new Map<string, Lead>();
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await listLeads({ campaign_id: campaignId, contacts: [email], limit: 100, starting_after: after }, {
      accountId, consumer: 'project_contact_blocks', retryRateLimits: false,
    });
    if (!Array.isArray(result.items)) throw new Error('Не удалось подтвердить результат поиска контакта');
    for (const lead of result.items) {
      verifyLead(lead, campaignId, email);
      found.set(lead.id, lead);
    }
    if (!result.next_starting_after) return [...found.values()];
    if (cursors.has(result.next_starting_after)) break;
    cursors.add(result.next_starting_after);
    after = result.next_starting_after;
  }
  throw new Error('Instantly вернул неполный список контактов');
}

/** One leased request per pass; retries survive process/container restarts. */
export async function syncOneProjectContactBlock(): Promise<boolean> {
  const db = projectBlockDb();
  const { data: job, error } = await db.rpc('project_contact_block_claim');
  if (error) throw new Error(`Не удалось прочитать очередь блокировок: ${error.message}`);
  if (!job) return false;
  const row = job as { project_id: string; email: string; version: number };
  try {
    const campaignIds = await links(row.project_id);
    const { data: catalog, error: catalogError } = campaignIds.length
      ? await db.from('instantly_campaign_catalog').select('id, instantly_account_id').in('id', campaignIds)
      : { data: [], error: null };
    if (catalogError) throw new Error('Не удалось определить аккаунты кампаний');
    const accounts = new Map((catalog ?? []).map((entry) => [entry.id as string, (entry.instantly_account_id as string) || 'main']));
    for (const campaignId of campaignIds) {
      const accountId = accounts.get(campaignId) ?? 'main';
      const options = { accountId, consumer: 'project_contact_blocks', retryRateLimits: false };
      for (const lead of await findLeads(campaignId, row.email, accountId)) {
        await stillOwned(row.project_id, campaignId);
        try {
          const current = await getLead(lead.id, options);
          if (current.id !== lead.id) throw new Error('Instantly вернул другой id контакта');
          verifyLead(current, campaignId, row.email);
          await stillOwned(row.project_id, campaignId);
          await deleteLead(lead.id, options);
        } catch (error) {
          if (!(error instanceof InstantlyApiError && error.status === 404)) throw error;
        }
      }
      if ((await findLeads(campaignId, row.email, accountId)).length) {
        throw new Error('Остановка контакта ещё не подтверждена Instantly');
      }
    }
    const { error: saved } = await db.from('project_contact_blocks')
      .update({ synced_version: row.version, last_error: null }).eq('project_id', row.project_id).eq('email', row.email).eq('version', row.version);
    if (saved) throw new Error('Не удалось сохранить результат остановки');
  } catch (error) {
    const { error: saved } = await db.from('project_contact_blocks').update({
      last_error: error instanceof Error ? error.message.slice(0, 400) : 'Ошибка остановки',
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    }).eq('project_id', row.project_id).eq('email', row.email).eq('version', row.version);
    if (saved) throw new Error('Не удалось сохранить повторную попытку блокировки');
    throw error;
  }
  return true;
}
