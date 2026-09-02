import type { SupabaseClient } from '@supabase/supabase-js';
import {
  filterBlockedLeads,
  getBlockedEmailSet,
} from '@/lib/clientBlocklist/blockedContacts';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { buildContactDeliveryPlan } from './contactDeliveryPlanner';
import { loadContactDeliverySettings } from './contactDeliveryConfig';
import { loadVeContactDeliveryCampaignInventory, loadVeContactDeliveryRows } from './contactDeliveryInventory';
import { validateStoredAuditSnapshot } from './stages/segmentationAudit';
import type { VeBase, VeSegmentationAudit, VeTemplate } from './types';

export type ContactDeliveryPreviewRequest = {
  templateId: string;
  portalProjectId: string;
  expectedPortalPeriodId: string;
  targetContacts: number;
  presetId: string;
  segmentationAuditId?: string | null;
  now?: Date;
};

export type ContactDeliveryPreviewOutcome = {
  status: number;
  body: Record<string, unknown>;
};

type PortalProjectRow = {
  id: string;
  client?: string | null;
  name?: string | null;
  status?: string | null;
};

type PortalPeriodRow = {
  id: string;
  project_id: string;
  name?: string | null;
  status: string;
  contacts_obligation?: string | null;
  contacts_done?: string | number | null;
  deadline?: string | null;
};

function outcome(status: number, code: string, error: string): ContactDeliveryPreviewOutcome {
  return { status, body: { code, error } };
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseExactNonNegativeContactCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const normalized = cleanString(value);
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function projectDisplayName(project: PortalProjectRow): string {
  return cleanString(project.client) || cleanString(project.name) || project.id;
}

export async function buildVeContactDeliveryPreview(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  input: ContactDeliveryPreviewRequest,
): Promise<ContactDeliveryPreviewOutcome> {
  if (!cleanString(input.templateId)) {
    return outcome(400, 'TEMPLATE_ID_REQUIRED', 'Не указан шаблон');
  }
  if (!cleanString(input.portalProjectId)) {
    return outcome(400, 'PORTAL_PROJECT_REQUIRED', 'Выберите проект Portal');
  }
  if (!cleanString(input.expectedPortalPeriodId)) {
    return outcome(400, 'PORTAL_PERIOD_REQUIRED', 'У проекта нет выбранного активного периода');
  }
  if (!Number.isSafeInteger(input.targetContacts) || input.targetContacts <= 0) {
    return outcome(400, 'TARGET_CONTACTS_INVALID', 'Укажите точное положительное число контактов');
  }
  if (!cleanString(input.presetId)) {
    return outcome(400, 'PRESET_REQUIRED', 'Выберите клиентский пресет');
  }

  const { data: templateRow, error: templateError } = await portalDb
    .from('ve_templates')
    .select('*')
    .eq('id', input.templateId)
    .maybeSingle();
  if (templateError) return outcome(500, 'TEMPLATE_LOAD_FAILED', templateError.message);
  if (!templateRow) return outcome(404, 'TEMPLATE_NOT_FOUND', 'Шаблон не найден');
  const template = templateRow as VeTemplate;
  if (template.status !== 'ready') {
    return outcome(409, 'TEMPLATE_NOT_READY', 'Шаблон ещё не готов к запуску');
  }

  const { data: baseRow, error: baseError } = await portalDb
    .from('ve_bases')
    .select('id, project_id, vertical_id, hypothesis_id, filename, columns, data, source')
    .eq('id', template.base_id)
    .maybeSingle();
  if (baseError) return outcome(500, 'BASE_LOAD_FAILED', baseError.message);
  if (!baseRow) return outcome(404, 'BASE_NOT_FOUND', 'База шаблона не найдена');
  const base = baseRow as Pick<
    VeBase,
    'id' | 'project_id' | 'vertical_id' | 'hypothesis_id' | 'filename' | 'columns' | 'data' | 'source'
  >;

  const { data: projectRow, error: projectError } = await portalDb
    .from('projects')
    .select('id, client, name, status')
    .eq('id', input.portalProjectId)
    .maybeSingle();
  if (projectError) return outcome(500, 'PORTAL_PROJECT_LOAD_FAILED', projectError.message);
  if (!projectRow) return outcome(404, 'PORTAL_PROJECT_NOT_FOUND', 'Проект Portal не найден');
  const project = projectRow as PortalProjectRow;

  // The explicit id + project FK + active status are one identity boundary.
  // Never infer this link from a client/project name.
  const { data: periodRow, error: periodError } = await portalDb
    .from('project_periods')
    .select('id, project_id, name, status, contacts_obligation, contacts_done, deadline')
    .eq('id', input.expectedPortalPeriodId)
    .eq('project_id', input.portalProjectId)
    .eq('status', 'active')
    .maybeSingle();
  if (periodError) return outcome(500, 'PORTAL_PERIOD_LOAD_FAILED', periodError.message);
  if (!periodRow) {
    return outcome(
      409,
      'PORTAL_PERIOD_NOT_ACTIVE',
      'Выбранный период больше не является активным периодом этого проекта',
    );
  }
  const period = periodRow as PortalPeriodRow;
  const contactsDone = parseExactNonNegativeContactCount(period.contacts_done);
  if (contactsDone === null) {
    return outcome(
      409,
      'CONTACTS_DONE_AMBIGUOUS',
      'В активном периоде факт первых контактов должен быть указан одним целым числом',
    );
  }
  const deadline = cleanString(period.deadline);
  if (!deadline || !isValidIsoDate(deadline)) {
    return outcome(
      409,
      'PERIOD_DEADLINE_REQUIRED',
      'В активном периоде должна быть указана корректная дата дедлайна',
    );
  }

  const { data: presetRow, error: presetError } = await instantlyDb
    .from('client_campaign_presets')
    .select('id, client_user_id, daily_limit, daily_max_leads, schedule_days, schedule_timezone')
    .eq('id', input.presetId)
    .maybeSingle();
  if (presetError) return outcome(500, 'PRESET_LOAD_FAILED', presetError.message);
  if (!presetRow) return outcome(404, 'PRESET_NOT_FOUND', 'Клиентский пресет не найден');
  const preset = presetRow as Pick<
    ClientCampaignPreset,
    | 'id'
    | 'client_user_id'
    | 'daily_limit'
    | 'daily_max_leads'
    | 'schedule_days'
    | 'schedule_timezone'
  >;
  const clientUserId = cleanString(preset.client_user_id);
  if (!clientUserId) {
    return outcome(409, 'PRESET_OWNER_REQUIRED', 'У клиентского пресета не указан владелец');
  }
  let settings;
  try {
    settings = await loadContactDeliverySettings(portalDb, base.project_id, {
      portalProjectId: input.portalProjectId, portalPeriodId: input.expectedPortalPeriodId,
      targetContacts: input.targetContacts, presetId: input.presetId,
    }, preset);
  } catch (error) {
    return outcome(409, 'CONTACT_DELIVERY_PLAN_INVALID', error instanceof Error ? error.message : 'Настройки плана недоступны');
  }
  const { dailyCapacity: senderCapacity, scheduleDays, timezone } = settings;

  let audits: VeSegmentationAudit[] = [];
  const auditId = cleanString(input.segmentationAuditId);
  if (auditId) {
    const { data: auditRow, error: auditError } = await portalDb
      .from('ve_segmentation_audits')
      .select('*')
      .eq('id', auditId)
      .maybeSingle();
    if (auditError) return outcome(500, 'SEGMENTATION_AUDIT_LOAD_FAILED', auditError.message);
    if (auditRow) audits = [auditRow as VeSegmentationAudit];
  } else {
    const { data: auditRows, error: auditError } = await portalDb
      .from('ve_segmentation_audits')
      .select('*')
      .eq('project_id', base.project_id)
      .eq('template_id', template.id)
      .eq('base_id', base.id)
      .eq('status', 'ready')
      .order('completed_at', { ascending: false })
      .limit(10);
    if (auditError) return outcome(500, 'SEGMENTATION_AUDIT_LOAD_FAILED', auditError.message);
    audits = (auditRows ?? []) as VeSegmentationAudit[];
  }
  if (audits.length === 0) {
    return outcome(
      409,
      'SEGMENTATION_AUDIT_REQUIRED',
      'Перед расчётом нужен свежий завершённый аудит сегментации',
    );
  }

  let currentValidation: ReturnType<typeof validateStoredAuditSnapshot> | null = null;
  let sawIncomplete = false;
  for (const audit of audits) {
    const validation = validateStoredAuditSnapshot({ audit, template, base });
    if (validation.state === 'current') {
      currentValidation = validation;
      break;
    }
    if (validation.state === 'incomplete') sawIncomplete = true;
  }
  if (!currentValidation || currentValidation.state !== 'current') {
    return outcome(
      409,
      sawIncomplete ? 'SEGMENTATION_AUDIT_INCOMPLETE' : 'SEGMENTATION_AUDIT_STALE',
      sawIncomplete
        ? 'Аудит сегментации ещё не завершён полностью'
        : 'Аудит сегментации устарел, пересоберите его перед запуском',
    );
  }

  let blockedEmails: Set<string>;
  try {
    blockedEmails = await getBlockedEmailSet(instantlyDb, clientUserId);
  } catch {
    return outcome(
      500,
      'CLIENT_BLOCKLIST_UNAVAILABLE',
      'Не удалось полностью проверить чёрный список клиента',
    );
  }
  const estimatedValid = currentValidation.snapshot.audience.leads.length;
  const candidateLeads = filterBlockedLeads(
    currentValidation.snapshot.audience.leads,
    blockedEmails,
  ).kept;
  let readyRemaining: number;
  let reserveRemaining: number;
  let outstandingCount: number;
  try {
    const [inventory, rows] = await Promise.all([
      loadVeContactDeliveryCampaignInventory(portalDb, instantlyDb, base.project_id),
      loadVeContactDeliveryRows(portalDb, base.project_id),
    ]);
    const existingEmails = new Set(rows.map((row) => row.email_normalized));
    const prospective = candidateLeads.filter((lead) => !existingEmails.has(lead.email.trim().toLowerCase())).length;
    const activeRows = new Set(inventory.activeCampaignRowIds);
    const readyRows = rows.filter((row) => row.status === 'ready' && !blockedEmails.has(row.email_normalized));
    readyRemaining = readyRows.filter((row) => activeRows.has(row.campaign_row_id)).length + prospective;
    reserveRemaining = readyRows.length + prospective;
    const committed = rows.filter((row) => ['accepted', 'attempting', 'uncertain'].includes(row.status)).length;
    outstandingCount = Math.max(0, committed - Math.min(inventory.observedFirstContacted, contactsDone));
  } catch {
    return outcome(500, 'DELIVERY_INVENTORY_UNAVAILABLE', 'Не удалось полностью сверить запас и уже загруженные контакты');
  }

  let plan;
  try {
    plan = buildContactDeliveryPlan({
      now: input.now ?? new Date(),
      timezone,
      deadline,
      scheduleDays,
      contactsObligation: input.targetContacts,
      contactsDone,
      dailyCapacity: senderCapacity,
      availableContacts: readyRemaining,
      outstandingContacts: outstandingCount,
    });
  } catch {
    return outcome(
      409,
      'DELIVERY_PLAN_INPUT_INVALID',
      'Не удалось рассчитать график: проверьте дедлайн и настройки отправки',
    );
  }

  const remainingWorkdays = plan.days.length;
  const requiredDaily = remainingWorkdays > 0
    ? Math.ceil(plan.remainingContacts / remainingWorkdays)
    : 0;
  const effectiveDaily = plan.days[0]?.quota ?? 0;
  const portalProjectName = projectDisplayName(project);
  const portalPeriodLabel = cleanString(period.name) || null;

  return {
    status: 200,
    body: {
      preview: {
        portal_project_id: project.id,
        portal_project_name: portalProjectName,
        portal_period_id: period.id,
        portal_period_label: portalPeriodLabel,
        deadline,
        contacts_done_count: contactsDone,
        contacts_obligation: input.targetContacts,
        target_contacts: input.targetContacts,
        remaining: plan.remainingContacts,
        remaining_workdays: remainingWorkdays,
        required_daily: requiredDaily,
        effective_daily: effectiveDaily,
        ready_remaining: readyRemaining,
        reserve_remaining: reserveRemaining,
        outstanding_count: outstandingCount,
        estimated_valid: estimatedValid,
        sender_capacity: senderCapacity,
        daily_capacity: senderCapacity,
        supply_deficit: plan.supplyShortfall,
        capacity_deficit: plan.capacityShortfall,
        total_shortfall: plan.totalShortfall,
        business_date: plan.businessDate,
        weekday_plan: plan.days,
        delivery_timezone: timezone,
        delivery_schedule_days: scheduleDays,
        project: {
          id: project.id,
          name: portalProjectName,
          status: cleanString(project.status) || null,
        },
        period: {
          id: period.id,
          label: portalPeriodLabel,
          status: period.status,
          deadline,
          contacts_obligation: period.contacts_obligation ?? null,
          contacts_done: contactsDone,
        },
      },
    },
  };
}
