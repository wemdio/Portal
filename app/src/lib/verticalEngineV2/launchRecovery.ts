import type { SupabaseClient } from '@supabase/supabase-js';
import { filterBlockedLeads, getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { reservePeriodCampaignLinks } from '@/lib/instantly/campaignProjectOwnership';
import { getCampaignAnalytics, listLeads } from '@/lib/instantly/client';
import { CampaignStatus, type Campaign, type CampaignSequence } from '@/lib/instantly/types';
import { buildLaunchSequence, type VeTemplateLaunchCampaign } from './launchHandoff';
import { launchMailboxScopesEqual } from './launchPortfolio';
import { loadVeContactDeliveryRows, readContactDeliveryPages } from './contactDeliveryInventory';
import { estimatedBundleRunDays } from './launchTemplate';
import { buildSegmentationLaunchGroups, stableJson } from './segmentationAudit';
import { validateStoredAuditSnapshot, type StoredAuditValidationInput } from './stages/segmentationAudit';

export class ContactDeliveryRecoveryError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) {
    super(message);
  }
}

function blocked(message: string, code = 'CONTACT_DELIVERY_RECOVERY_UNSAFE'): never {
  throw new ContactDeliveryRecoveryError(message, code);
}

/** Compare sending content, not provider-added ids or analytics fields. */
function sequenceSignature(sequences: CampaignSequence[] | undefined): string {
  return stableJson((sequences ?? []).map((sequence) => ({
    steps: sequence.steps.map((step) => ({
      type: step.type ?? 'email', delay: step.delay, delay_unit: step.delay_unit ?? 'days',
      variants: (step.variants ?? []).map((variant) => ({
        subject: variant.subject ?? '', body: (variant.body ?? '').replace(/<br\s*\/?>/gi, '<br>'),
      })),
    })),
  })));
}

export async function prepareBoundContactDeliveryRecovery(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  template: StoredAuditValidationInput['template'];
  base: StoredAuditValidationInput['base'];
  audit: StoredAuditValidationInput['audit'];
  presetId: string;
  campaignIds: string[];
}) {
  const { data: project, error } = await input.portalDb.from('ve_projects')
    .select('portal_project_id, portal_period_id, target_contacts, launch_preset_id, launch_instantly_account_id')
    .eq('id', input.base.project_id).maybeSingle();
  if (error || !project) blocked('Не удалось проверить привязку проекта для восстановления.');
  // Historical unbound launches keep their existing reconciliation path.
  if (!project.portal_project_id && !project.portal_period_id && project.target_contacts == null) return null;
  if (!project.portal_project_id || !project.portal_period_id ||
      !Number.isSafeInteger(project.target_contacts) || project.target_contacts <= 0 ||
      project.launch_preset_id !== input.presetId || !project.launch_instantly_account_id) {
    blocked('Привязка плана ежедневной загрузки неполна или изменилась.');
  }
  const validation = validateStoredAuditSnapshot(input);
  if (validation.state !== 'current') {
    blocked('База или аудит изменились после запуска. Автоматическое восстановление остановлено.',
      'SEGMENTATION_AUDIT_STALE');
  }
  const { data: presetRow, error: presetError } = await input.instantlyDb
    .from('client_campaign_presets').select('*').eq('id', input.presetId).maybeSingle();
  if (presetError || !presetRow) blocked('Не удалось загрузить пресет исходного запуска.');
  const preset = presetRow as ClientCampaignPreset;
  const accountId = resolveInstantlyAccountId(preset.instantly_account_id);
  if (accountId !== project.launch_instantly_account_id || !preset.client_user_id) {
    blocked('Клиент или workspace исходного запуска не подтверждены.');
  }
  const { audience, segments } = validation.snapshot;
  let allowedEmails: Set<string>;
  try {
    const blocklist = await getBlockedEmailSet(input.instantlyDb, preset.client_user_id);
    allowedEmails = new Set(filterBlockedLeads(audience.leads, blocklist).kept
      .map((lead) => lead.email.trim().toLowerCase()));
  } catch {
    throw new ContactDeliveryRecoveryError('Не удалось проверить чёрный список клиента.',
      'CONTACT_DELIVERY_BLOCKLIST_UNAVAILABLE', 500);
  }
  // Other hypotheses already owning an email win. The exact same recovered
  // bundle is exempt so a lost response may safely replay its immutable rows.
  const [inventory, ownCampaignRows] = await Promise.all([
    loadVeContactDeliveryRows(input.portalDb, input.base.project_id),
    readContactDeliveryPages<{ id: string }>('recovered campaign identities', (from, to) =>
      input.portalDb.from('ve_launch_queue_campaigns').select('id', { count: 'exact' })
        .in('campaign_id', input.campaignIds).order('id', { ascending: true }).range(from, to)),
  ]);
  const ownCampaignRowIds = new Set(ownCampaignRows.map((row) => row.id));
  for (const row of inventory) {
    if (!ownCampaignRowIds.has(row.campaign_row_id)) allowedEmails.delete(row.email_normalized);
  }
  const groups = buildSegmentationLaunchGroups({ segments, leadCount: audience.leads.length,
    classification: { assignments: validation.assignments, unclassifiedRows: [], failedBatches: 0,
      totalBatches: 0, usage: { tokensUsed: 0, costUsd: 0 } },
  }).map((group) => {
    const sequence = buildLaunchSequence(input.template.letters, { segmentWhen: group.segment });
    if (!sequence) blocked('Цепочка писем исходного запуска больше не подтверждена.');
    return { segment: group.segment,
      leadIndices: group.leadIndices.filter((index) => allowedEmails.has(audience.leads[index].email.trim().toLowerCase())),
      signature: sequenceSignature(buildCampaignPayloadFromPreset({ preset,
        sequence: { name: 'Recovery', steps: sequence.steps } }).sequences),
    };
  });
  if (!groups.some((group) => group.leadIndices.length)) blocked('В проверенной базе не осталось разрешённых контактов.');
  const estimatedRunDays = estimatedBundleRunDays({ preset, letters: input.template.letters,
    campaigns: groups.map((group) => ({ campaign_id: '', campaign_name: '', campaign_url: '',
      segment: group.segment, leads_count: 0, ready_leads_count: group.leadIndices.length })),
  });
  return { project, preset, accountId, groups, leads: audience.leads, estimatedRunDays };
}

export type BoundContactDeliveryRecovery = NonNullable<Awaited<ReturnType<typeof prepareBoundContactDeliveryRecovery>>>;

/** No remote writes: accept only empty paused campaigns with proven segment text. */
export async function materializeRecoveredContactDelivery(input: {
  instantlyDb: SupabaseClient;
  prepared: BoundContactDeliveryRecovery;
  liveCampaigns: Campaign[];
  recoveredCampaigns: VeTemplateLaunchCampaign[];
  knownCampaigns: VeTemplateLaunchCampaign[];
}) {
  const { prepared } = input;
  const usedSegments = new Set<string | null>();
  const knownById = new Map(input.knownCampaigns.map((campaign) => [campaign.campaign_id, campaign]));
  const liveById = new Map(input.liveCampaigns.map((campaign) => [campaign.id, campaign]));
  const dripRows: Array<{ campaign_id: string; source_row_index: number; drip_order: number;
    email_normalized: string; lead_payload: Record<string, unknown> }> = [];
  const campaigns: VeTemplateLaunchCampaign[] = [];
  for (const campaign of input.recoveredCampaigns) {
    const live = liveById.get(campaign.campaign_id);
    if (!live || live.status !== CampaignStatus.Paused ||
        !launchMailboxScopesEqual(live.email_list, prepared.preset.email_account_ids)) {
      blocked('Для ежедневной загрузки нужна подтверждённая кампания на паузе с исходными отправителями.');
    }
    const known = knownById.get(campaign.campaign_id);
    const signature = sequenceSignature(live.sequences);
    const matches = prepared.groups.filter((group) => !usedSegments.has(group.segment) &&
      group.signature === signature && (!known || known.segment === group.segment));
    if (matches.length !== 1) blocked('Не удалось однозначно сопоставить кампанию с проверенным сегментом.');
    const group = matches[0];
    let remoteLeads: Awaited<ReturnType<typeof listLeads>>;
    try {
      remoteLeads = await listLeads({ campaign_id: live.id, limit: 1 }, {
        accountId: prepared.accountId, timeoutMs: 10_000, retryRateLimits: false,
      });
    } catch {
      throw new ContactDeliveryRecoveryError('Не удалось подтвердить пустую кампанию перед восстановлением.',
        'CONTACT_DELIVERY_REMOTE_PROOF_FAILED', 502);
    }
    if (!Array.isArray(remoteLeads.items) || remoteLeads.items.length || remoteLeads.next_starting_after) {
      blocked('В кампании уже есть контакты. Требуется ручная сверка, чтобы не загрузить их повторно.');
    }
    // An empty current list is insufficient: previously sent contacts may have
    // been deleted manually. Zero baseline ownership requires zero history.
    let analytics: Awaited<ReturnType<typeof getCampaignAnalytics>>;
    try {
      analytics = await getCampaignAnalytics({ id: live.id }, {
        accountId: prepared.accountId, timeoutMs: 10_000, retryRateLimits: false,
      });
    } catch {
      throw new ContactDeliveryRecoveryError('Не удалось подтвердить отсутствие прошлых отправок кампании.',
        'CONTACT_DELIVERY_REMOTE_PROOF_FAILED', 502);
    }
    const history = analytics.filter((row) => row.campaign_id === live.id);
    if (history.length !== 1 || history[0].emails_sent_count !== 0 ||
        history[0].contacted_count !== 0 || (history[0].new_leads_contacted_count ?? 0) !== 0) {
      blocked('История кампании не подтверждает ноль отправленных контактов. Нужна ручная сверка.');
    }
    usedSegments.add(group.segment);
    campaigns.push({ ...campaign, segment: group.segment, leads_count: 0, ready_leads_count: group.leadIndices.length });
    for (const index of group.leadIndices) {
      const lead = prepared.leads[index];
      dripRows.push({ campaign_id: live.id, source_row_index: index, drip_order: dripRows.length,
        email_normalized: lead.email.trim().toLowerCase(), lead_payload: { ...lead } });
    }
  }
  if (prepared.groups.some((group) => group.leadIndices.length && !usedSegments.has(group.segment))) {
    blocked('Не все сегменты базы сопоставлены с найденными кампаниями.');
  }
  try {
    const ownership = await reservePeriodCampaignLinks(input.instantlyDb, prepared.project.portal_project_id,
      campaigns.map((campaign) => ({ periodId: prepared.project.portal_period_id,
        campaignId: campaign.campaign_id, matchSource: 'manual', baselineContacts: 0,
        matchConfidence: 1, matchReason: 'Vertical Engine v2 recovered contact-delivery plan' })));
    if (ownership.status === 'conflict') blocked('Кампания уже принадлежит другому Portal-проекту.');
  } catch (error) {
    if (error instanceof ContactDeliveryRecoveryError) throw error;
    throw new ContactDeliveryRecoveryError('Не удалось закрепить кампании за периодом Portal-проекта.',
      'CONTACT_DELIVERY_OWNERSHIP_FAILED', 500);
  }
  return { campaigns, dripRows };
}
