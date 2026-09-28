import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaign, listAccounts, listCampaigns, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import type { Account, Campaign, PaginatedResponse } from '@/lib/instantly/types';
import { normalizeLaunchMailboxIds, launchMailboxScopesEqual } from './launchPortfolio';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { DeliveryRateError, calculateDeliveryRate, distributeDeliveryRate, isSendingCampaign, type DeliveryRatePolicy, type DeliveryRateRow } from './contactDeliveryRate';

const READ_OPTIONS = { timeoutMs: 10_000, timeoutIncludesBody: true, retryRateLimits: false };
async function allPages<T>(read: (cursor?: string) => Promise<PaginatedResponse<T>>): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await read(cursor);
    if (!Array.isArray(result.items)) throw new DeliveryRateError('Instantly вернул неполный список. Повторите расчёт.');
    rows.push(...result.items);
    cursor = result.next_starting_after || undefined;
    if (!cursor) return rows;
    if (seen.has(cursor)) throw new DeliveryRateError('Instantly повторил страницу списка. Повторите расчёт.');
    seen.add(cursor);
  }
  throw new DeliveryRateError('Список Instantly слишком большой для полного расчёта.');
}
export async function readDeliveryRate(db: SupabaseClient, projectId: string): Promise<DeliveryRateRow | null> {
  const { data, error } = await db.from('ve_contact_delivery_rates').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw new DeliveryRateError('Настройки темпа недоступны. Проверьте миграцию и повторите.');
  return data as DeliveryRateRow | null;
}
export async function previewDeliveryRate(portalDb: SupabaseClient, instantlyDb: SupabaseClient, input: {
  projectId: string; presetId: string; templateIds: string[]; policy: DeliveryRatePolicy;
}) {
  const { data: project, error: projectError } = await portalDb.from('ve_projects')
    .select('id, launch_preset_id, launch_instantly_account_id, portal_project_id').eq('id', input.projectId).maybeSingle();
  if (projectError || !project) throw new DeliveryRateError('Проект вертикалей не найден.');
  if (project.launch_preset_id && project.launch_preset_id !== input.presetId) throw new DeliveryRateError('Профиль отправки закреплён за другим клиентом.');
  const { data: preset, error } = await instantlyDb.from('client_campaign_presets')
    .select('id, instantly_account_id, email_account_ids, schedule_from, schedule_to, email_gap_minutes')
    .eq('id', input.presetId).maybeSingle();
  if (error || !preset) throw new DeliveryRateError('Профиль отправки недоступен.');
  const accountId = resolveInstantlyAccountId(preset.instantly_account_id);
  if (project.launch_instantly_account_id && project.launch_instantly_account_id !== accountId) throw new DeliveryRateError('Рабочее пространство профиля изменилось.');
  const mailboxes = normalizeLaunchMailboxIds(preset.email_account_ids);
  const items = await readContactDeliveryPages<{id: string; template_id: string; status: string; mailbox_ids: string[]; instantly_account_id: string}>(
    'rate launch items', (from, to) => portalDb.from('ve_launch_queue_items')
      .select('id, template_id, status, mailbox_ids, instantly_account_id', {count: 'exact'}).eq('project_id', input.projectId)
      .order('id', {ascending:true}).range(from,to));
  const activeItems = items.filter(item => item.status === 'active');
  for (const item of activeItems) {
    if (item.instantly_account_id !== accountId || !launchMailboxScopesEqual(item.mailbox_ids, mailboxes)) throw new DeliveryRateError('Отправители профиля изменились после запуска. Восстановите согласованный набор почт.');
  }
  const templateIds = [...new Set([...input.templateIds, ...activeItems.map(item => item.template_id)])].sort();
  if (!templateIds.length || templateIds.length > 100) throw new DeliveryRateError('Выберите готовые письма для расчёта темпа.');
  const { data: templates, error: templateError } = await portalDb.from('ve_templates')
    .select('id, base_id, status, letters').in('id', templateIds);
  if (templateError || templates?.length !== templateIds.length || templates.some(t => t.status !== 'ready' || !Array.isArray(t.letters) || !t.letters.length)) throw new DeliveryRateError('Итоговые письма ещё не готовы.');
  const { data: bases, error: baseError } = await portalDb.from('ve_bases').select('id, project_id').in('id', [...new Set(templates.map(t=>t.base_id))]);
  if (baseError || templates.some(t=>!bases?.some(b=>b.id===t.base_id && b.project_id===input.projectId))) throw new DeliveryRateError('Письма относятся к другому проекту.');
  const children = activeItems.length ? await readContactDeliveryPages<{id:string;campaign_id:string}>(
    'rate active campaigns', (from,to)=>portalDb.from('ve_launch_queue_campaigns').select('id, campaign_id',{count:'exact'})
      .in('item_id',activeItems.map(item=>item.id)).order('id',{ascending:true}).range(from,to)) : [];
  const ownIds = new Set(children.map(child=>child.campaign_id));
  const options = { ...READ_OPTIONS, accountId };
  const [accounts, campaigns] = await Promise.all([
    allPages<Account>(cursor=>listAccounts({limit:100,starting_after:cursor}, options)),
    allPages<Campaign>(cursor=>listCampaigns({limit:100,starting_after:cursor}, options)),
  ]);
  if (new Set(campaigns.map(c=>c.id)).size !== campaigns.length) throw new DeliveryRateError('Список кампаний Instantly изменился во время расчёта.');
  const own: Campaign[] = [];
  for (const id of ownIds) {
    const live = await getCampaign(id, options);
    isSendingCampaign(live); // Validate status even when this is our own paused/empty campaign.
    if (live.id !== id || !launchMailboxScopesEqual(live.email_list,mailboxes) || live.email_tag_list?.length) throw new DeliveryRateError('Отправители кампании изменились. Проверьте настройки запуска.');
    own.push(live);
  }
  const external: Campaign[] = [];
  for (const campaign of campaigns.filter(c=>!ownIds.has(c.id) && isSendingCampaign(c))) {
    const full = Array.isArray(campaign.email_list) ? campaign : await getCampaign(campaign.id,options);
    if (full.id !== campaign.id) throw new DeliveryRateError('Instantly вернул другую кампанию.');
    external.push(full);
  }
  // Instantly commonly selects senders through tags and returns email_list: [].
  // Resolve the union once, with pagination, rather than rejecting unrelated
  // campaigns or treating their empty explicit list as unoccupied mailboxes.
  const tagIds = [...new Set(external.filter(isSendingCampaign).flatMap(campaign => {
    if (campaign.email_tag_list != null && (!Array.isArray(campaign.email_tag_list) ||
      campaign.email_tag_list.some(tag => typeof tag !== 'string' || !tag.trim() || tag.includes(',')))) {
      throw new DeliveryRateError('Не удалось прочитать теги отправителей другой кампании.');
    }
    return campaign.email_tag_list ?? [];
  }))].sort();
  const tagMailboxes = new Set<string>();
  for (let offset = 0; offset < tagIds.length; offset += 50) {
    const tagAccounts = await allPages<Account>(cursor => listAccounts({
      limit: 100, starting_after: cursor, tag_ids: tagIds.slice(offset, offset + 50).join(','),
    }, options));
    const seen = new Set<string>();
    for (const account of tagAccounts) {
      const email = typeof account?.email === 'string' ? account.email.trim().toLowerCase() : '';
      if (!email || seen.has(email)) throw new DeliveryRateError('Не удалось полностью проверить почты по тегам. Обновите расчёт.');
      seen.add(email);
      tagMailboxes.add(email);
    }
  }
  const minutes = (time: unknown) => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    ? Number(time.slice(0,2))*60+Number(time.slice(3)) : Number.NaN;
  let windowMinutes = minutes(preset.schedule_to) - minutes(preset.schedule_from);
  if (windowMinutes < 0) windowMinutes += 24*60;
  const steps = Math.max(...templates.map(t=>t.letters.length), ...own.map(c=>{
    if (!c.sequences?.length || c.sequences.some(s=>!Array.isArray(s.steps) || !s.steps.length)) throw new DeliveryRateError('Не удалось прочитать цепочку действующей кампании.');
    return Math.max(...c.sequences.map(s=>s.steps.length));
  }));
  const snapshot = calculateDeliveryRate({mailboxIds:mailboxes,accounts,otherCampaigns:external,otherCampaignTagMailboxIds:[...tagMailboxes],sequenceSteps:steps,
    policy:input.policy,windowMinutes,gapMinutes:preset.email_gap_minutes});
  return { snapshot, own, accountId, bound: Boolean(project.portal_project_id), templateIds };
}

async function rateRpc(db: SupabaseClient, name: string, args: Record<string,unknown>) {
  const {data,error}=await db.rpc(name,args);
  if(error) throw new DeliveryRateError('Не удалось сохранить настройки темпа. Обновите расчёт: другой процесс мог изменить или начать применять настройки.');
  return data;
}
export async function saveDeliveryRate(portalDb:SupabaseClient, instantlyDb:SupabaseClient, input: {
  projectId:string; presetId:string; templateIds:string[]; policy:DeliveryRatePolicy; revision:number; actorId:string;
}) {
  const preview = await previewDeliveryRate(portalDb,instantlyDb,input);
  if (preview.snapshot.effective_capacity <= 0) throw new DeliveryRateError('Нет доступной мощности: проверьте почты, занятые кампании и длину цепочки.');
  distributeDeliveryRate(preview.snapshot.effective_capacity, preview.own.map(c => c.id));
  return rateRpc(portalDb,'ve_save_contact_delivery_rate',{
    p_project_id:input.projectId,p_preset_id:input.presetId,p_template_ids:preview.templateIds,
    p_mode:input.policy.mode,p_manual_limit:input.policy.mode==='manual'?input.policy.manual_limit:null,
    p_expected_revision:input.revision,p_snapshot:preview.snapshot,p_actor_id:input.actorId,
  });
}
/** Runs before delivery, never creates, activates or reuploads campaigns. */
export async function refreshDeliveryRate(portalDb:SupabaseClient, instantlyDb:SupabaseClient, projectId:string) {
  const rate=await readDeliveryRate(portalDb,projectId);
  if(!rate) return;
  const token=randomUUID();
  const claimed=await rateRpc(portalDb,'ve_claim_contact_delivery_rate',{p_project_id:projectId,p_revision:rate.revision,p_token:token});
  if(claimed!==true) throw new DeliveryRateError('Темп обновляется другим процессом. Следующий проход повторит проверку.');
  try {
    const current=await previewDeliveryRate(portalDb,instantlyDb,{projectId,presetId:rate.preset_id,templateIds:rate.template_ids,policy:rate});
    if(current.snapshot.effective_capacity<=0) throw new DeliveryRateError('Нет свободной мощности отправителей для новых контактов.');
    const ids=current.own.map(c=>c.id);
    const newLimits=distributeDeliveryRate(current.snapshot.effective_capacity,ids);
    const emailLimits=distributeDeliveryRate(current.snapshot.email_capacity,ids);
    const options={...READ_OPTIONS,accountId:current.accountId};
    const renew = async () => {
      const owned=await rateRpc(portalDb,'ve_claim_contact_delivery_rate',{p_project_id:projectId,p_revision:rate.revision,p_token:token});
      if(owned!==true) throw new DeliveryRateError('Настройки темпа изменились. Повторим с актуальными условиями.');
    };
    await renew();
    for(const campaign of current.own) {
      const desired={daily_limit:emailLimits[campaign.id],daily_max_leads:newLimits[campaign.id]};
      if(campaign.daily_limit===desired.daily_limit && campaign.daily_max_leads===desired.daily_max_leads) continue;
      await renew();
      await updateCampaign(campaign.id,desired,options);
      const verified=await getCampaign(campaign.id,options);
      if(verified.id!==campaign.id || verified.email_tag_list?.length || !launchMailboxScopesEqual(verified.email_list,campaign.email_list) ||
        verified.daily_limit!==desired.daily_limit || verified.daily_max_leads!==desired.daily_max_leads) throw new DeliveryRateError('Instantly не подтвердил новый лимит кампании. Загрузка отложена.');
    }
    await renew();
    const finished = await rateRpc(portalDb,'ve_finish_contact_delivery_rate',{p_project_id:projectId,p_revision:rate.revision,p_token:token,p_snapshot:current.snapshot,p_error:null});
    if (finished !== true) throw new DeliveryRateError('Не удалось подтвердить сохранение темпа.');
  } catch(error) {
    await rateRpc(portalDb,'ve_finish_contact_delivery_rate',{p_project_id:projectId,p_revision:rate.revision,p_token:token,p_snapshot:null,p_error:'Не удалось проверить или применить темп в Instantly. Повторим автоматически.'});
    throw error;
  }
}
