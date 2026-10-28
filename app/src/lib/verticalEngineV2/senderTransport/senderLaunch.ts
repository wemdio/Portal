import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { createCampaign, type CampaignStepInput } from '@/lib/sender/campaignOps';
import { placeholderKeys, varKey } from '@/lib/sender/templateVars';
import { buildLaunchSequence, type VeTemplateLaunchCampaign } from '../launchHandoff';
import { withVeDeliveryCompanyIdentity } from '../projectExclusionDelivery';
import type { VeTemplate } from '../types';
import { reserveSenderCampaignLinks } from './senderDelivery';
import {
  veSenderScheduleFromPreset,
  veSenderSourceRef,
  veSenderSyntaxIssue,
  veSequenceToSenderSteps,
  type VeSenderRefusal,
  type VeSenderSchedule,
} from './senderLaunchPlan';
import { parseSenderSteps, senderLetterProblems, senderTemplateFault, veLeadToRecipient } from './senderTemplate';
import { senderCampaignUrl } from './transport';

/**
 * Запуск VE2 в «Рассылку» (transport='sender'): вместо кампании Instantly —
 * черновик кампании «Рассылки» на каждую группу запуска, с ящиками пресета,
 * его окном отправки и письмами шаблона. Подключается из launchTemplate
 * динамически: campaignOps — серверный модуль, Instantly-запуску он не нужен.
 *
 * prepare — только чтение, до первой записи запуска: всё, чего «Рассылка» не
 * сможет, — отказ здесь, а не после резервирования. create — после
 * резервирования: черновики и привязка к проекту; ошибка — откат
 * (senderRecovery.rollbackVeSenderReservation) делает launchTemplate.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VeSenderLaunchGroup {
  segment: string | null;
  leadIdx: number[];
  steps: CampaignStepInput[];
}

export interface VeSenderLaunchPlan {
  /** id рабочих ящиков «Рассылки» из пресета. */
  mailboxIds: string[];
  presetMailboxes: number;
  schedule: VeSenderSchedule;
  /** Группы без контактов, которых «Рассылка» не отправит. */
  groups: VeSenderLaunchGroup[];
  /** Сколько контактов не пойдёт: первое письмо у них выходит пустым или адрес «Рассылка» не принимает. */
  droppedLeads: number;
}

interface PrepareInput {
  preset: ClientCampaignPreset;
  /** Адреса ящиков пресета, строчными (launchTemplate.normalizedMailboxIds). */
  mailboxEmails: string[];
  groups: Array<{ segment: string | null; leadIdx: number[] }>;
  letters: VeTemplate['letters'];
  leads: LeadCreatePayload[];
  rows: Record<string, unknown>[];
  portalProjectId: string;
  clientUserId: string;
  force: boolean;
}

/** Контакт запуска так, как его увидит подача: тот же lead_payload, что в резерве. */
function dripPayload(leads: LeadCreatePayload[], rows: Record<string, unknown>[], index: number) {
  return withVeDeliveryCompanyIdentity(leads[index], rows[index]);
}

/** Рабочие ящики пресета в «Рассылке»: проверены и включены. */
async function readSenderPool(
  db: SupabaseClient,
  emails: string[],
): Promise<{ ok: true; ids: string[]; found: number } | VeSenderRefusal> {
  const { data, error } = await db.rpc('ve_sender_pool_for_emails', { p_emails: emails });
  if (error) {
    return { ok: false, status: 503, code: 'VE_SENDER_POOL_UNAVAILABLE', error: 'Не удалось проверить ящики пресета в «Рассылке». Повторите.' };
  }
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: unknown; email: unknown; status: unknown; enabled: unknown }>;
  const found = new Set<string>();
  const byEmail = new Map<string, string>();
  for (const row of rows) {
    const email = String(row.email ?? '').trim().toLowerCase();
    if (!email) continue;
    found.add(email);
    // Адрес в «Рассылке» не уникален: один ящик на адрес, иначе ему двойная нагрузка.
    if (row.status === 'verified' && row.enabled === true && !byEmail.has(email)) byEmail.set(email, String(row.id));
  }
  if (!byEmail.size) {
    return {
      ok: false, status: 409, code: 'VE_SENDER_POOL_EMPTY',
      error: `В «Рассылке» нет рабочих ящиков пресета: найдено ${found.size} из ${emails.length}, проверенных и включённых — 0.`,
    };
  }
  return { ok: true, ids: [...byEmail.values()], found: found.size };
}

/**
 * Всё, что нужно запуску в «Рассылку», — без записей. Контакты, которым
 * первое письмо выходит пустым (пустая колонка под переменной темы), из
 * запуска убираются, как контакты чёрного списка: «Рассылка» их не
 * отправит, а в резерве они навсегда стали бы пропуском. Поломка шаблона
 * (переменная, которой нет у контактов, письмо пустое у большинства) —
 * отказ всего запуска.
 */
export async function prepareVeSenderLaunch(
  portalDb: SupabaseClient,
  input: PrepareInput,
): Promise<{ ok: true; plan: VeSenderLaunchPlan } | VeSenderRefusal> {
  if (input.force) {
    return { ok: false, status: 409, code: 'VE_SENDER_FORCE_UNSUPPORTED', error: 'Повторный запуск поверх прежнего через «Рассылку» не поддерживается.' };
  }
  if (!UUID_RE.test(input.portalProjectId) || !UUID_RE.test(input.clientUserId)) {
    return { ok: false, status: 409, code: 'VE_SENDER_PROJECT_INVALID', error: 'У проекта или клиента пресета нет корректного идентификатора для «Рассылки».' };
  }
  const schedule = veSenderScheduleFromPreset(input.preset);
  if (!schedule.ok) return schedule;

  const groups: VeSenderLaunchGroup[] = [];
  let droppedLeads = 0;
  for (const group of input.groups) {
    let sequence: ReturnType<typeof buildLaunchSequence>;
    try {
      sequence = buildLaunchSequence(input.letters, { segmentWhen: group.segment });
    } catch (error) {
      return { ok: false, status: 409, code: 'VE_SENDER_TEMPLATE_UNSUPPORTED', error: error instanceof Error ? error.message : 'Письма шаблона не собрались' };
    }
    if (!sequence) return { ok: false, status: 400, code: 'VE_SENDER_TEMPLATE_UNSUPPORTED', error: 'У шаблона нет писем для запуска' };
    const mapped = veSequenceToSenderSteps(sequence);
    if (!mapped.ok) return mapped;
    const syntax = veSenderSyntaxIssue(mapped.steps);
    if (syntax) return syntax;

    const { variants, spellings } = parseSenderSteps(mapped.steps.flatMap((step, index) =>
      (step.variants ?? []).map((variant) => ({ step_no: index + 1, subject: variant.subject ?? '', body: variant.body ?? '' }))));
    const rows = group.leadIdx.map((index) => {
      const payload = dripPayload(input.leads, input.rows, index);
      return veLeadToRecipient(payload, (payload as { _ve_company_identity?: unknown })._ve_company_identity, spellings);
    });
    const fault = senderTemplateFault(variants, rows);
    if (fault) return { ok: false, status: 409, code: 'VE_SENDER_TEMPLATE_UNSUPPORTED', error: `${fault[0].toUpperCase()}${fault.slice(1)}.` };
    // В follow-up переменной, которой нет ни у одного контакта, «Рассылка»
    // подставит пусто; проверка подачи смотрит только первое письмо.
    const provided = new Set(rows.flatMap((row) => [...Object.keys(row.vars).map(varKey), 'email', ...(row.name ? ['name', 'first_name'] : [])]));
    const missing = [...new Set(mapped.steps.flatMap((step) => (step.variants ?? [])
      .flatMap((variant) => placeholderKeys(`${variant.subject ?? ''}\n${variant.body ?? ''}`))))].filter((key) => !provided.has(key));
    if (missing.length) {
      return { ok: false, status: 409, code: 'VE_SENDER_TEMPLATE_UNSUPPORTED', error: `В письмах есть переменные, которых нет у контактов: ${missing.map((key) => `{{${key}}}`).join(', ')}` };
    }
    const problems = senderLetterProblems(variants, rows);
    const dropped = new Set([...problems.invalid, ...problems.empty]);
    droppedLeads += dropped.size;
    const leadIdx = group.leadIdx.filter((_, position) => !dropped.has(position));
    if (leadIdx.length) groups.push({ segment: group.segment, leadIdx, steps: mapped.steps });
  }
  if (!groups.length) {
    return { ok: false, status: 409, code: 'VE_SENDER_EMPTY_FIRST_LETTER', error: 'Первое письмо выходит пустым у всех контактов запуска — проверьте переменные темы и текста.' };
  }
  const pool = await readSenderPool(portalDb, input.mailboxEmails);
  if (!pool.ok) return pool;
  return { ok: true, plan: { mailboxIds: pool.ids, presetMailboxes: input.mailboxEmails.length, schedule: schedule.schedule, groups, droppedLeads } };
}

export interface VeSenderLaunchDripRow {
  campaign_id: string;
  source_row_index: number;
  drip_order: number;
  lead_payload: Record<string, unknown>;
  email_normalized: string;
}

/**
 * Уже созданная этой попыткой кампания группы (ответ создания мог
 * потеряться) — только целая: с пулом и всеми письмами. Создание пишет
 * кампанию, пул и шаги тремя запросами; недоделанную берёт откат.
 */
async function findAttemptCampaign(
  db: SupabaseClient,
  input: { reservationId: string; sourceRef: string; mailboxes: number; stepRows: number },
): Promise<string | null> {
  const { data, error } = await db.from('sender_campaigns').select('id')
    .eq('source_kind', 've2').eq('source_job_id', input.reservationId).eq('source_ref', input.sourceRef).maybeSingle();
  if (error) throw new Error(`черновик «Рассылки» не прочитан: ${error.message}`);
  if (!data?.id) return null;
  const id = String(data.id);
  const [pool, steps] = await Promise.all([
    db.from('sender_campaign_mailboxes').select('mailbox_id', { count: 'exact', head: true }).eq('campaign_id', id),
    db.from('sender_campaign_steps').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
  ]);
  if (pool.error || steps.error) throw new Error(`черновик «Рассылки» не прочитан: ${(pool.error ?? steps.error)!.message}`);
  return pool.count === input.mailboxes && steps.count === input.stepRows ? id : null;
}

/**
 * Черновики «Рассылки» на каждую группу и привязка их к проекту Portal (и
 * периоду). Резерв контактов — те же строки, что у запуска Instantly.
 * Бросает при любой ошибке: решение об откате — за launchTemplate.
 */
export async function createVeSenderLaunchCampaigns(
  portalDb: SupabaseClient,
  input: {
    reservationId: string;
    plan: VeSenderLaunchPlan;
    campaignName: (segment: string | null) => string;
    leads: LeadCreatePayload[];
    rows: Record<string, unknown>[];
    portalProjectId: string;
    periodId: string | null;
    clientUserId: string;
    userId: string;
    heartbeat: () => Promise<void>;
  },
): Promise<{ campaigns: VeTemplateLaunchCampaign[]; dripRows: VeSenderLaunchDripRow[] }> {
  const campaigns: VeTemplateLaunchCampaign[] = [];
  const dripRows: VeSenderLaunchDripRow[] = [];
  for (const group of input.plan.groups) {
    const sourceRef = veSenderSourceRef(group.segment);
    const name = input.campaignName(group.segment);
    const attempt = {
      reservationId: input.reservationId,
      sourceRef,
      mailboxes: input.plan.mailboxIds.length,
      stepRows: group.steps.reduce((total, step) => total + (step.variants?.length ?? 0), 0),
    };
    await input.heartbeat();
    let campaignId = await findAttemptCampaign(portalDb, attempt);
    if (!campaignId) {
      try {
        campaignId = (await createCampaign({
          name,
          mailboxIds: input.plan.mailboxIds,
          steps: group.steps,
          ...input.plan.schedule,
          folderId: null,
          projectId: input.portalProjectId,
          clientUserId: input.clientUserId,
          sourceKind: 've2',
          sourceJobId: input.reservationId,
          sourceRef,
          createdBy: input.userId,
        })).id;
      } catch (error) {
        // Повтор той же попытки упирается в уникальность (резервирование, сегмент) —
        // кампания уже есть, берём её.
        campaignId = await findAttemptCampaign(portalDb, attempt);
        if (!campaignId) throw error;
      }
    }
    await input.heartbeat();
    campaigns.push({
      campaign_id: campaignId,
      campaign_name: name,
      campaign_url: senderCampaignUrl(campaignId),
      segment: group.segment,
      leads_count: 0,
      ready_leads_count: group.leadIdx.length,
    });
    for (const index of group.leadIdx) {
      dripRows.push({
        campaign_id: campaignId,
        source_row_index: index,
        drip_order: dripRows.length,
        lead_payload: dripPayload(input.leads, input.rows, index),
        email_normalized: input.leads[index].email.trim().toLowerCase(),
      });
    }
  }
  const links = await reserveSenderCampaignLinks(portalDb, {
    projectId: input.portalProjectId,
    periodId: input.periodId,
    campaignIds: campaigns.map((campaign) => campaign.campaign_id),
    reason: 'Vertical Engine v2 explicit contact-delivery plan',
  });
  if (links.status === 'conflict') {
    throw new Error(`campaign ownership conflict: ${links.conflictingProjectIds.join(', ') || 'кампания без проекта'}`);
  }
  return { campaigns, dripRows };
}
