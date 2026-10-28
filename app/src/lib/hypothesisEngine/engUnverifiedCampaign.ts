/**
 * Кампании непроверенных адресов ENG (решение владельца 26.10.2026): адреса,
 * которые компания опубликовала на своём сайте, а её почтовый сервер не дал
 * проверить. Запуск создаёт такую кампанию черновиком
 * (launchTemplate.ts, шаг 6b; launch_info.unverified_campaign): клиент её не
 * видит и не стартует, не больше HE_ENG_UNVERIFIED_DAILY_NEW_LEADS новых
 * контактов в день.
 *
 * Этот проход держит её в ногу с запуском. Она отправляет, только когда:
 *  - выключатель HE_ENG_UNVERIFIED_SEND не выключен;
 *  - аккаунту отправлять можно и клиент хочет отправку (he_eng_launch_sending);
 *  - каждая основная кампания запуска с адресами отправляет или закончила, а не
 *    стоит (пауза клиента, выключение, остановка у рассыльщика, не прочиталась).
 * Основные кампании прошли все проверки старта (engCampaignSending.ts), а у
 * этой те же письма и ящики, поэтому сверх этого она проверяет только свои
 * ящики против выдачи пула. Иначе — пауза. Защита рассыльщика от bounce и
 * другие остановки у рассыльщика проход не снимает: зовёт команду.
 *
 * Чтения и действия — по одному, через GET/POST кампаний (не LIST /emails).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateCampaign, getCampaign, pauseCampaign } from '@/lib/instantly/client';
import { CampaignStatus } from '@/lib/instantly/types';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { HE_ENG_SENDING_CONSUMER, launchWorkspace } from './engCampaignSending';
import {
  heEngLaunchCampaigns,
  heEngStatusIsSending,
  heEngStatusIsStartable,
  heEngStatusIsStopped,
  readHeEngClientStates,
  writeHeEngCampaignStatus,
} from './engCampaignStatus';
import { notifyHeEngSending } from './engSendingAlert';
import { heEngSendingAccessAllows, readHeEngSendingAccess } from './engSendingAccess';
import { heEngUnverifiedSendEnabled, parseLaunchInfo, type HeTemplateLaunchInfo } from './launchHandoff';
import { checkHeCampaignAgainstAssignment, readHeSendingPoolAssignment } from './sendingPool';

export type HeEngUnverifiedAction = 'start' | 'pause' | 'keep' | 'alert_stopped';

/**
 * Что сделать с кампанией непроверенных адресов. `mainStatuses` — живые статусы
 * основных кампаний запуска с адресами (null — не прочиталась), `status` — её
 * собственный (null — не прочитался). Чистая функция.
 */
export function decideHeEngUnverifiedCampaign(input: {
  enabled: boolean;
  accessAllows: boolean;
  clientWantsSending: boolean;
  mainStatuses: ReadonlyArray<number | null>;
  status: number | null;
}): HeEngUnverifiedAction {
  const { status } = input;
  if (status === null || status === CampaignStatus.Completed) return 'keep';
  if (heEngStatusIsStopped(status)) return 'alert_stopped';
  const mainGoes = input.mainStatuses.length > 0 && input.mainStatuses.every(
    (s) => s !== null && (heEngStatusIsSending(s) || s === CampaignStatus.Completed),
  );
  const wanted = input.enabled && input.accessAllows && input.clientWantsSending && mainGoes;
  if (wanted && heEngStatusIsStartable(status)) return 'start';
  if (!wanted && heEngStatusIsSending(status)) return 'pause';
  return 'keep';
}

export interface HeEngUnverifiedRunResult {
  launches: number;
  started: number;
  paused: number;
  alerts: number;
  failed: number;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;

const READ_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_LAUNCHES_PER_RUN = 200;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function liveStatus(id: string, options: Parameters<typeof getCampaign>[1]): Promise<{ status: number | null; emailList: unknown }> {
  try {
    const live = await getCampaign(id, options);
    if (!live || live.id !== id) return { status: null, emailList: null };
    return { status: typeof live.status === 'number' ? live.status : null, emailList: live.email_list };
  } catch {
    return { status: null, emailList: null };
  }
}

/** Один проход по всем запускам с кампанией непроверенных адресов. */
export async function runHeEngUnverifiedCampaigns(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: Log;
  shouldStop?: () => boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeEngUnverifiedRunResult> {
  const out: HeEngUnverifiedRunResult = { launches: 0, started: 0, paused: 0, alerts: 0, failed: 0 };
  if (!opts.instantlyDb) return out;
  const enabled = heEngUnverifiedSendEnabled(opts.env);
  const { data: templates, error } = await opts.portalDb
    .from('he_templates')
    .select('id, vertical_id, launch_campaign_id:launch_info->>campaign_id, launch_campaigns:launch_info->campaigns, '
      + 'launch_leads:launch_info->leads_count, launch_preset_id:launch_info->>preset_id, launch_unverified:launch_info->unverified_campaign')
    .not('launch_info->unverified_campaign', 'is', null)
    .limit(MAX_LAUNCHES_PER_RUN);
  if (error) {
    opts.log('warn', `[eng-unverified] he_templates read failed: ${error.message}`);
    return out;
  }
  const rows = (templates ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return out;

  const verticalIds = [...new Set(rows.map((r) => text(r.vertical_id)).filter(Boolean))];
  const { data: verticals } = await opts.portalDb.from('he_verticals').select('id, project_id').in('id', verticalIds);
  const projectOf = new Map((verticals ?? []).map((v) => [text((v as { id?: unknown }).id), text((v as { project_id?: unknown }).project_id)]));
  const projectIds = [...new Set([...projectOf.values()].filter(Boolean))];
  const { data: projects } = projectIds.length
    ? await opts.portalDb.from('he_projects').select('id, created_by').in('id', projectIds).eq('market', 'us')
    : { data: [] };
  const ownerOf = new Map((projects ?? []).map((p) => [text((p as { id?: unknown }).id), text((p as { created_by?: unknown }).created_by)]));
  const states = await readHeEngClientStates(opts.portalDb, rows.map((r) => text(r.id)));

  for (const row of rows) {
    if (opts.shouldStop?.()) break;
    const templateId = text(row.id);
    const projectId = projectOf.get(text(row.vertical_id)) ?? '';
    const ownerUserId = ownerOf.get(projectId) ?? '';
    const launch: HeTemplateLaunchInfo | null = parseLaunchInfo({
      campaign_id: row.launch_campaign_id,
      campaigns: row.launch_campaigns,
      leads_count: row.launch_leads,
      preset_id: row.launch_preset_id,
      unverified_campaign: row.launch_unverified,
    });
    const hidden = launch?.unverified_campaign;
    if (!launch || !hidden || !projectId || !ownerUserId) continue;
    out.launches += 1;
    try {
      const workspace = await launchWorkspace(opts.instantlyDb, ownerUserId, launch.preset_id);
      if (workspace.kind !== 'ok') continue;
      const options = { accountId: workspace.accountId, retryRateLimits: false, timeoutMs: READ_TIMEOUT_MS, consumer: HE_ENG_SENDING_CONSUMER };
      const own = await liveStatus(hidden.campaign_id, options);
      if (own.status !== null) {
        await writeHeEngCampaignStatus(opts.portalDb, projectId, hidden.campaign_id, { status: own.status, readError: null, workspace: workspace.accountId });
      }
      const access = await readHeEngSendingAccess(opts.portalDb, ownerUserId);
      const mainStatuses: Array<number | null> = [];
      for (const c of heEngLaunchCampaigns(launch).filter((c) => c.leads > 0)) {
        mainStatuses.push((await liveStatus(c.campaignId, options)).status);
      }
      const action = decideHeEngUnverifiedCampaign({
        enabled,
        accessAllows: heEngSendingAccessAllows(access.state),
        clientWantsSending: states?.get(templateId)?.state === 'sending',
        mainStatuses,
        status: own.status,
      });
      if (action === 'alert_stopped') {
        out.alerts += 1;
        void notifyHeEngSending({ kind: 'needs_attention', projectId, templateId, campaigns: [{ id: hidden.campaign_id, status: own.status }] });
        continue;
      }
      if (action === 'start') {
        const assignment = await readHeSendingPoolAssignment(opts.portalDb, projectId);
        if (assignment.kind !== 'assigned') continue;
        const check = checkHeCampaignAgainstAssignment(assignment, { instantlyAccountId: workspace.accountId, emailList: own.emailList });
        if (!check.ok) {
          void notifyHeEngSending({ kind: 'mailboxes_mismatch', projectId, templateId, campaignIds: [hidden.campaign_id], reason: check.reason });
          continue;
        }
        const res = await activateCampaign(hidden.campaign_id, { ...options, timeoutMs: ACTION_TIMEOUT_MS }).catch(() => null);
        const after = typeof res?.status === 'number' ? res.status : (await liveStatus(hidden.campaign_id, options)).status;
        if (heEngStatusIsSending(after)) {
          out.started += 1;
          await writeHeEngCampaignStatus(opts.portalDb, projectId, hidden.campaign_id, { status: after, readError: null, startError: null, workspace: workspace.accountId });
          void logAudit('he.eng_unverified.started', 'staff-only unverified campaign started with its launch', { projectId, templateId, campaignId: hidden.campaign_id });
        } else {
          out.failed += 1;
          void logWarn('he.eng_unverified.start_failed', 'staff-only unverified campaign did not start', { projectId, templateId, campaignId: hidden.campaign_id, status: after });
        }
      } else if (action === 'pause') {
        const res = await pauseCampaign(hidden.campaign_id, { ...options, timeoutMs: ACTION_TIMEOUT_MS }).catch(() => null);
        const after = typeof res?.status === 'number' ? res.status : (await liveStatus(hidden.campaign_id, options)).status;
        if (after !== null && !heEngStatusIsSending(after)) {
          out.paused += 1;
          await writeHeEngCampaignStatus(opts.portalDb, projectId, hidden.campaign_id, { status: after, readError: null, workspace: workspace.accountId });
          void logAudit('he.eng_unverified.paused', 'staff-only unverified campaign paused with its launch', { projectId, templateId, campaignId: hidden.campaign_id });
        } else {
          out.failed += 1;
          void notifyHeEngSending({ kind: 'pause_failed', projectId, templateId, campaignIds: [hidden.campaign_id], stateRecorded: false });
        }
      }
    } catch (e) {
      out.failed += 1;
      opts.log('warn', `[eng-unverified] template ${templateId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Не чаще раза в HE_ENG_UNVERIFIED_TICK_MS (по умолчанию 5 мин); один прогон за раз. */
export function createHeEngUnverifiedCampaignTicker(opts: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log: Log;
  shouldStop?: () => boolean;
  env?: NodeJS.ProcessEnv;
}): { maybeRun: () => Promise<void> } {
  const env = opts.env ?? process.env;
  const raw = Number(env.HE_ENG_UNVERIFIED_TICK_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 5 * 60_000;
  let nextAtMs = 0;
  let inFlight: Promise<void> | null = null;
  return {
    maybeRun: async () => {
      const nowMs = Date.now();
      if (inFlight || nowMs < nextAtMs) return;
      nextAtMs = nowMs + intervalMs;
      const current = runHeEngUnverifiedCampaigns({ ...opts, env })
        .then((r) => {
          if (r.started || r.paused || r.alerts || r.failed) {
            opts.log('info', `[eng-unverified] кампаний ${r.launches}: старт ${r.started}, пауза ${r.paused}, алерт ${r.alerts}, сбой ${r.failed}`);
          }
        })
        .catch((e: unknown) => {
          opts.log('warn', `[eng-unverified] прогон бросил: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          if (inFlight === current) inFlight = null;
        });
      inFlight = current;
    },
  };
}
