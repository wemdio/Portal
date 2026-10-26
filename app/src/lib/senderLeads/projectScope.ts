import type { SupabaseClient } from '@supabase/supabase-js';
import { isFreeProvider } from '@/lib/emailValidation/shared';
import { splitHandoffEmails } from '@/lib/sender/clientHandoff';
import { LEAD_CRITERIA_MAX, type CampaignLeadSettings, type LeadSettings } from './settings';

/**
 * Кампании Движка вертикалей в «Рассылке» (source_kind 've2') оцениваются как
 * лиды Instantly: по брифу и «Что считать лидом» проекта Portal, а не по
 * правилу папки — папки у них нет. Сторона клиента — адреса «Передачи лида»
 * проекта: после передачи клиент в копии и может ответить в ту же переписку.
 */

export interface VeProjectLeadSettings {
  briefText: string;
  criteria: string | null;
  clientParty: { addresses: string[]; domains: string[] };
}

/** Адреса и корпоративные домены клиента: домен бесплатной почты отрезал бы настоящих лидов. */
export function clientPartyFromHandoffEmail(handoffEmail: string | null | undefined): VeProjectLeadSettings['clientParty'] {
  const addresses = splitHandoffEmails(handoffEmail).map((email) => email.toLowerCase());
  const domains = [...new Set(addresses.map((email) => email.split('@')[1] ?? '').filter((domain) => domain && !isFreeProvider(domain)))];
  return { addresses, domains };
}

/** Письмо от стороны клиента проекта, а не от лида. */
export function isClientPartyReply(from: string | null | undefined, party: VeProjectLeadSettings['clientParty'] | undefined): boolean {
  const email = (from ?? '').trim().toLowerCase();
  if (!email || !party) return false;
  const domain = email.split('@')[1] ?? '';
  return party.addresses.includes(email) || (Boolean(domain) && party.domains.includes(domain));
}

/** Бриф, критерий и сторона клиента проектов. Ошибка чтения — исключение. */
export async function loadVeProjectLeadSettings(
  db: SupabaseClient,
  projectIds: string[],
): Promise<Map<string, VeProjectLeadSettings>> {
  const out = new Map<string, VeProjectLeadSettings>();
  const ids = [...new Set(projectIds)];
  if (!ids.length) return out;
  const { data, error } = await db.from('projects').select('id, brief_text, lead_criteria, handoff_email').in('id', ids);
  if (error) throw new Error(`projects: ${error.message}`);
  for (const row of (data ?? []) as Array<{ id: string; brief_text: string | null; lead_criteria: string | null; handoff_email: string | null }>) {
    const criteria = row.lead_criteria?.trim() ?? '';
    out.set(row.id, {
      briefText: row.brief_text?.trim() ?? '',
      criteria: criteria ? criteria.slice(0, LEAD_CRITERIA_MAX) : null,
      clientParty: clientPartyFromHandoffEmail(row.handoff_email),
    });
  }
  return out;
}

/** Настройки кампании проекта поверх настроек «без папки». */
export function projectLeadSettings(
  base: LeadSettings,
  projectId: string,
  project: VeProjectLeadSettings | undefined,
  projectError: string | null,
): LeadSettings {
  if (projectError) return { ...base, route: 'project', projectId, projectError };
  // Проекта нет (удалён) — оцениваем по общим правилам, как кампанию без папки.
  if (!project) return { ...base, route: 'project', projectId, briefText: '' };
  return {
    ...base,
    enabled: true,
    telegram: false,
    criteria: project.criteria,
    route: 'project',
    projectId,
    briefText: project.briefText,
    clientParty: project.clientParty,
  };
}

/**
 * Наложить настройки проекта на кампании Движка вертикалей. Проект не
 * прочитан — у этих кампаний projectError (ответы ждут повтора), остальные
 * кампании идут как шли.
 */
export async function withProjectLeadSettings(
  db: SupabaseClient,
  campaigns: Map<string, CampaignLeadSettings>,
): Promise<Map<string, CampaignLeadSettings>> {
  const projectIds = [...campaigns.values()].map((campaign) => campaign.veProjectId).filter((id): id is string => Boolean(id));
  if (!projectIds.length) return campaigns;
  let projects = new Map<string, VeProjectLeadSettings>();
  let projectError: string | null = null;
  try {
    projects = await loadVeProjectLeadSettings(db, projectIds);
  } catch (err) {
    projectError = `проект не прочитан: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
  }
  const out = new Map(campaigns);
  for (const [id, campaign] of campaigns) {
    if (!campaign.veProjectId) continue;
    out.set(id, { ...campaign, settings: projectLeadSettings(campaign.settings, campaign.veProjectId, projects.get(campaign.veProjectId), projectError) });
  }
  return out;
}
