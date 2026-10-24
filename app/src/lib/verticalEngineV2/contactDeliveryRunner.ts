/**
 * Contract-aware contact upload for Vertical Engine v2.
 *
 * The main DB owns the exact row reservation and Moscow/local business date.
 * This runner deliberately performs no read-then-send quota calculation: it
 * verifies campaign ownership first, asks the DB for a frozen row batch,
 * fences every provider attempt, and persists exact accepted/uncertain row ids.
 * `projects/project_periods.contacts_done` remains the fulfillment fact; an
 * accepted upload here is only a technical delivery event. A plan bound to a
 * Portal project without periods uses the project card as its term and the
 * first-contacted count of its own campaigns as the plan fact.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createVeDeliveryExclusionGuard } from './projectExclusionDelivery';
import {
  AppendLeadsPartialError,
  appendLeadsToClientCampaign,
  type AppendLeadsResult,
  type AppendLeadsToClientCampaignInput,
} from '@/lib/clientLaunch/appendLeads';
import {
  checkCampaignProjectOwnershipConflicts,
  claimCampaignProjectOwnership,
  reservePeriodCampaignLinks,
  type CampaignProjectOwnershipResult,
  type PeriodCampaignReservation,
} from '@/lib/instantly/campaignProjectOwnership';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { loadVeContactDeliveryCampaignInventory } from './contactDeliveryInventory';
import { activateDeliveredContactCampaigns } from './contactDeliveryActivation';
import { reserveSenderCampaignLinks, type SenderCampaignLinkResult } from './senderTransport/senderDelivery';
import { transportOf, type VeLaunchTransport } from './senderTransport/transport';
import {
  claimProjectCampaignLinks,
  describeOwnershipConflicts,
  describePortalProjectTerm,
  loadPortalProjectTerm,
  localIsoDate,
} from './portalDeliveryTerm';

interface BoundVeProject {
  id: string;
  portal_project_id: string | null;
  portal_period_id: string | null;
  target_contacts: number | null;
  delivery_schedule_days: number[] | null;
  delivery_timezone: string | null;
  sender_daily_capacity: number | null;
  launch_preset_id: string | null;
  launch_instantly_account_id: string | null;
  contact_upload_mode?: 'daily' | 'all_ready';
}

interface ActivePeriod {
  id: string;
  project_id: string;
  status: string;
  contacts_done: string | null;
  deadline: string | null;
}

interface DeliveryBatch {
  campaign_id: string;
  row_ids: string[];
  leads: LeadCreatePayload[];
}

type ReserveStatus =
  | 'capacity_blocked'
  | 'reserved'
  | 'replayed'
  | 'not_scheduled'
  | 'fulfilled'
  | 'awaiting_delivery'
  | 'no_ready_rows';

interface DeliveryReservation {
  status: ReserveStatus;
  run_id: string | null;
  run_date: string | null;
  batches: DeliveryBatch[];
}

interface AttemptFinalizeInput {
  accepted: string[];
  skipped: string[];
  uncertain: string[];
  released: string[];
  error: string | null;
}

export interface ContactDeliveryRunnerDeps {
  reservePeriodCampaignLinks: (
    db: Parameters<typeof reservePeriodCampaignLinks>[0],
    projectId: string,
    links: PeriodCampaignReservation[],
  ) => Promise<CampaignProjectOwnershipResult>;
  appendLeads: typeof appendLeadsToClientCampaign;
  createAttemptId: () => string;
  /** Plans without a period own campaigns through the legacy project link. */
  checkCampaignProjectOwnershipConflicts?: typeof checkCampaignProjectOwnershipConflicts;
  claimCampaignProjectOwnership?: typeof claimCampaignProjectOwnership;
  /** Launches with transport='sender' upload into «Рассылка» instead of Instantly. */
  appendSenderLeads?: (
    input: AppendLeadsToClientCampaignInput,
    ctx: { veProjectId: string; portalDb: SupabaseClient },
  ) => Promise<AppendLeadsResult>;
  reserveSenderLinks?: typeof reserveSenderCampaignLinks;
}

export type ContactDeliveryDayStatus =
  | 'capacity_blocked'
  | 'completed'
  | 'uncertain'
  | 'failed'
  | 'replayed'
  | 'not_scheduled'
  | 'fulfilled'
  | 'awaiting_delivery'
  | 'no_ready_rows';

export interface ContactDeliveryDayResult {
  status: ContactDeliveryDayStatus;
  runId: string | null;
  runDate: string | null;
  accepted: number;
  skipped: number;
  uncertain: number;
  error?: string;
}

const DEFAULT_DEPS: ContactDeliveryRunnerDeps = {
  reservePeriodCampaignLinks,
  appendLeads: appendLeadsToClientCampaign,
  createAttemptId: randomUUID,
  checkCampaignProjectOwnershipConflicts,
  claimCampaignProjectOwnership,
};

function asObject(value: unknown): Record<string, unknown> | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBatches(value: unknown): DeliveryBatch[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('delivery reservation returned an invalid batch');
    const row = raw as Record<string, unknown>;
    const campaignId = nonEmptyString(row.campaign_id);
    const rowIds = Array.isArray(row.row_ids) ? row.row_ids.map(nonEmptyString) : [];
    const leads = Array.isArray(row.leads) ? row.leads : [];
    if (!campaignId || rowIds.some((id) => id === null) || rowIds.length !== leads.length) {
      throw new Error('delivery reservation returned a mismatched campaign batch');
    }
    return {
      campaign_id: campaignId,
      row_ids: rowIds as string[],
      leads: leads.map((lead) => {
        if (!lead || typeof lead !== 'object' || !nonEmptyString((lead as Record<string, unknown>).email)) {
          throw new Error('delivery reservation returned a lead without email');
        }
        return lead as LeadCreatePayload;
      }),
    };
  });
}

function parseReservation(data: unknown): DeliveryReservation {
  const row = asObject(data);
  const status = row?.status;
  if (
    status !== 'reserved' &&
    status !== 'capacity_blocked' &&
    status !== 'replayed' &&
    status !== 'not_scheduled' &&
    status !== 'fulfilled' &&
    status !== 'awaiting_delivery' &&
    status !== 'no_ready_rows'
  ) {
    throw new Error('delivery reservation returned an invalid status');
  }
  const batches = parseBatches(row?.batches);
  if (status !== 'reserved' && batches.length > 0) {
    throw new Error('terminal delivery reservation unexpectedly returned provider work');
  }
  return {
    status,
    run_id: nonEmptyString(row?.run_id),
    run_date: nonEmptyString(row?.run_date),
    batches,
  };
}

function parseMarked(data: unknown): boolean {
  return asObject(data)?.marked === true;
}

function normalizeIndexes(indexes: readonly number[], size: number): number[] {
  const unique = [...new Set(indexes)];
  if (
    unique.length !== indexes.length ||
    unique.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= size)
  ) {
    throw new Error('append returned an invalid contact identity snapshot');
  }
  return unique.sort((left, right) => left - right);
}

function classifyAppendResult(
  rowIds: readonly string[],
  result: AppendLeadsResult,
  ambiguous: boolean,
): AttemptFinalizeInput {
  const attemptedIndexes = normalizeIndexes(result.attemptedIndexes, rowIds.length);
  const attempted = new Set(attemptedIndexes);
  const knownSkippedIndexes = normalizeIndexes(result.skippedIndexes ?? [], rowIds.length);
  const knownSkipped = new Set(knownSkippedIndexes);
  const deferred = new Set(normalizeIndexes(result.deferredIndexes ?? [], rowIds.length));
  if ([...deferred].some((index) => knownSkipped.has(index))) throw new Error('append deferred a permanently skipped contact');
  const skipped = knownSkippedIndexes.map((index) => rowIds[index]);
  const released = rowIds.filter((_, index) => deferred.has(index) || (!attempted.has(index) && !knownSkipped.has(index)));

  if (!result.identityComplete || result.acceptedIndexes === null) {
    return {
      accepted: [],
      skipped,
      uncertain: attemptedIndexes.filter((index) => !knownSkipped.has(index) && !deferred.has(index)).map((index) => rowIds[index]),
      released,
      error: ambiguous ? 'provider outcome is ambiguous' : 'provider identity is incomplete',
    };
  }

  const acceptedIndexes = normalizeIndexes(result.acceptedIndexes, rowIds.length);
  if (acceptedIndexes.some((index) => !attempted.has(index))) {
    throw new Error('append accepted a contact whose provider request was not attempted');
  }
  if (acceptedIndexes.some((index) => knownSkipped.has(index) || deferred.has(index))) {
    throw new Error('append classified the same contact as both accepted and skipped');
  }
  const acceptedSet = new Set(acceptedIndexes);
  const accepted = acceptedIndexes.map((index) => rowIds[index]);
  const remainder = attemptedIndexes
    .filter((index) => !acceptedSet.has(index) && !knownSkipped.has(index) && !deferred.has(index))
    .map((index) => rowIds[index]);
  return {
    accepted,
    skipped: ambiguous ? skipped : [...skipped, ...remainder],
    uncertain: ambiguous ? remainder : [],
    released,
    error: null,
  };
}

async function loadPreflight(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  veProjectId: string,
  now: Date,
): Promise<{
  project: BoundVeProject;
  period: ActivePeriod | null;
  clientUserId: string;
  observedFirstContacted: number;
  instantlyAccountId: string;
  activeCampaignIds: string[];
  instantlyCampaignIds: string[];
  senderCampaignIds: string[];
  campaignTransports: Record<string, VeLaunchTransport>;
  links: PeriodCampaignReservation[];
}> {
  const { data: projectData, error: projectError } = await portalDb
    .from('ve_projects')
    .select(
      'id, portal_project_id, portal_period_id, target_contacts, delivery_schedule_days, delivery_timezone, sender_daily_capacity, launch_preset_id, launch_instantly_account_id, contact_upload_mode',
    )
    .eq('id', veProjectId)
    .maybeSingle();
  if (projectError) throw new Error(`delivery project read failed: ${projectError.message}`);
  const project = projectData as BoundVeProject | null;
  if (
    !project ||
    !project.portal_project_id ||
    !project.launch_preset_id ||
    !nonEmptyString(project.launch_instantly_account_id) ||
    !Number.isSafeInteger(project.target_contacts) ||
    (project.target_contacts ?? 0) <= 0
  ) {
    throw new Error('VE2 delivery plan is not explicitly bound');
  }

  let period: ActivePeriod | null = null;
  if (project.portal_period_id) {
    const { data: periodData, error: periodError } = await portalDb
      .from('project_periods')
      .select('id, project_id, status, contacts_done, deadline')
      .eq('id', project.portal_period_id)
      .eq('project_id', project.portal_project_id)
      .eq('status', 'active')
      .maybeSingle();
    if (periodError) throw new Error(`delivery period read failed: ${periodError.message}`);
    period = periodData as ActivePeriod | null;
    if (!period) throw new Error('bound Portal project period is not active');
  } else {
    // Stop before ownership and reservation when the project card no longer
    // authorizes delivery; the reason is the specialist-facing text.
    const { project: portalProject, periods } = await loadPortalProjectTerm(portalDb, project.portal_project_id);
    if (!portalProject) throw new Error('Проект Portal не найден. Загрузка новых контактов остановлена.');
    const term = describePortalProjectTerm(portalProject, periods, {
      bound: true,
      today: localIsoDate(now, project.delivery_timezone?.trim() || 'Europe/Moscow'),
    });
    if (!term.ok) throw new Error(term.error);
  }

  const periodId = period?.id ?? null;
  const inventory = await loadVeContactDeliveryCampaignInventory(portalDb, instantlyDb, veProjectId);
  if (inventory.activeCampaignIds.length === 0) throw new Error('VE2 project has no active launch bundle');

  const { data: presetData, error: presetError } = await instantlyDb
    .from('client_campaign_presets')
    .select('client_user_id, instantly_account_id')
    .eq('id', project.launch_preset_id)
    .maybeSingle();
  if (presetError) throw new Error(`delivery preset read failed: ${presetError.message}`);
  const clientUserId = nonEmptyString(
    (presetData as { client_user_id?: unknown } | null)?.client_user_id,
  );
  if (!clientUserId) throw new Error('delivery preset has no client owner');
  const instantlyAccountId = resolveInstantlyAccountId(
    (presetData as { instantly_account_id?: string | null } | null)?.instantly_account_id,
  );
  if (instantlyAccountId !== project.launch_instantly_account_id) {
    throw new Error('delivery preset workspace differs from the immutable launch workspace');
  }

  // Кампании «Рассылки» не попадают в связи проекта с кампаниями Instantly:
  // их проект и период держит project_sender_campaigns.
  const campaignTransports = inventory.campaignTransports ?? {};
  const senderCampaignIds = inventory.activeCampaignIds.filter((id) => campaignTransports[id] === 'sender');
  const instantlyCampaignIds = inventory.activeCampaignIds.filter((id) => campaignTransports[id] !== 'sender');
  return {
    project,
    period,
    clientUserId,
    observedFirstContacted: inventory.observedFirstContacted,
    instantlyAccountId,
    activeCampaignIds: inventory.activeCampaignIds,
    instantlyCampaignIds,
    senderCampaignIds,
    campaignTransports,
    links: !periodId ? [] : instantlyCampaignIds.map((campaignId) => ({
      periodId,
      campaignId,
      matchSource: 'manual',
      baselineContacts: 0,
      matchConfidence: 1,
      matchReason: `Vertical Engine v2 delivery · ${veProjectId}`,
    })),
  };
}

/** Кампания появилась после чтения инвентаря — рассыльщик берём из её строки. */
async function readCampaignTransport(
  portalDb: SupabaseClient,
  instantlyAccountId: string,
  campaignId: string,
): Promise<VeLaunchTransport> {
  // (instantly_account_id, campaign_id) уникальна; у запусков «Рассылки» там
  // тот же воркспейс пресета.
  const { data, error } = await portalDb.from('ve_launch_queue_campaigns')
    .select('transport').eq('instantly_account_id', instantlyAccountId).eq('campaign_id', campaignId).maybeSingle();
  if (error) throw new Error(`delivery campaign transport read failed: ${error.message}`);
  return transportOf((data as { transport?: unknown } | null)?.transport);
}

async function finalizeAttempt(
  portalDb: SupabaseClient,
  input: {
    runId: string;
    attemptId: string;
    campaignId: string;
    outcome: AttemptFinalizeInput;
  },
): Promise<void> {
  const { error } = await portalDb.rpc(input.outcome.error === 'INSTANTLY_CONTACT_CAPACITY'
    ? 've_finalize_contact_delivery_capacity' : 've_finalize_contact_delivery_attempt', {
    p_run_id: input.runId,
    p_attempt_id: input.attemptId,
    p_campaign_id: input.campaignId,
    p_accepted_row_ids: input.outcome.accepted,
    p_skipped_row_ids: input.outcome.skipped,
    p_uncertain_row_ids: input.outcome.uncertain,
    p_released_row_ids: input.outcome.released,
    p_error: input.outcome.error,
  });
  if (error) throw new Error(`delivery attempt finalize failed: ${error.message}`);
}

export async function runContactDeliveryDay(input: {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  veProjectId: string;
  now?: Date;
  deps?: ContactDeliveryRunnerDeps;
}): Promise<ContactDeliveryDayResult> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const preflight = await loadPreflight(input.portalDb, input.instantlyDb, input.veProjectId, input.now ?? new Date());

  // Cross-database ownership is established before the main DB can expose a
  // provider batch. A conflict therefore cannot consume or strand drip rows.
  if (preflight.period) {
    if (preflight.links.length > 0) {
      const ownership = await deps.reservePeriodCampaignLinks(
      input.instantlyDb,
        preflight.project.portal_project_id as string,
        preflight.links,
      );
      if (ownership.status === 'conflict') {
        throw new Error(
          `delivery campaign ownership conflict: ${ownership.conflictingProjectIds.join(', ')}`,
        );
      }
    }
  } else if (preflight.instantlyCampaignIds.length > 0) {
    const conflicts = await claimProjectCampaignLinks(
      input.instantlyDb,
      preflight.project.portal_project_id as string,
      preflight.instantlyCampaignIds,
      `Vertical Engine v2 delivery · ${input.veProjectId}`,
      {
        check: deps.checkCampaignProjectOwnershipConflicts,
        claim: deps.claimCampaignProjectOwnership,
      },
    );
    if (conflicts.length > 0) {
      throw new Error(`delivery campaign ownership conflict: ${describeOwnershipConflicts(conflicts)}`);
    }
  }
  if (preflight.senderCampaignIds.length > 0) {
    const senderOwnership: SenderCampaignLinkResult = await (deps.reserveSenderLinks ?? reserveSenderCampaignLinks)(
      input.portalDb,
      {
        projectId: preflight.project.portal_project_id as string,
        periodId: preflight.period?.id ?? null,
        campaignIds: preflight.senderCampaignIds,
        reason: `Vertical Engine v2 delivery · ${input.veProjectId}`,
      },
    );
    if (senderOwnership.status === 'conflict') {
      throw new Error(
        `delivery campaign ownership conflict: ${senderOwnership.conflictingProjectIds.join(', ') || 'кампания без проекта'}`,
      );
    }
  }

  const { data: reserveData, error: reserveError } = await input.portalDb.rpc(
    preflight.project.contact_upload_mode === 'all_ready'
      ? 've_reserve_all_ready_contact_delivery_day'
      : 've_reserve_contact_delivery_day',
    {
      p_ve_project_id: input.veProjectId,
      p_now: (input.now ?? new Date()).toISOString(),
      p_observed_ve_first_contacted: preflight.observedFirstContacted,
    },
  );
  if (reserveError) throw new Error(`delivery day reservation failed: ${reserveError.message}`);
  const reservation = parseReservation(reserveData);
  if (reservation.status !== 'reserved') {
    // Refresh the provider state without starting or resuming sending.
    const activation = await activateDeliveredContactCampaigns({
      portalDb: input.portalDb, veProjectId: input.veProjectId,
    });
    // Сбой наблюдения «Рассылки» — в текст, но не в статус: у Instantly он
    // откладывает весь проект, здесь подачу закрывает устаревшее наблюдение.
    const notes = [...activation.errors, ...(activation.senderErrors ?? [])];
    return {
      status: activation.errors.length > 0 ? 'uncertain' : reservation.status,
      runId: reservation.run_id,
      runDate: reservation.run_date,
      accepted: 0,
      skipped: 0,
      uncertain: 0,
      ...(notes.length > 0 ? { error: notes.join('; ').slice(0, 500) } : {}),
    };
  }
  if (!reservation.run_id) throw new Error('reserved delivery day has no run id');

  let accepted = 0;
  let skipped = 0;
  let uncertain = 0;
  const errors: string[] = [];
  let capacityBlocked = false;

  for (const batch of reservation.batches) {
    const transport = preflight.campaignTransports[batch.campaign_id]
      ?? await readCampaignTransport(input.portalDb, preflight.instantlyAccountId, batch.campaign_id);
    const attemptId = deps.createAttemptId();
    const { data: markData, error: markError } = await input.portalDb.rpc(
      've_begin_recoverable_contact_delivery',
      {
        p_run_id: reservation.run_id,
        p_attempt_id: attemptId,
        p_campaign_id: batch.campaign_id,
        p_row_ids: batch.row_ids,
      },
    );
    if (markError) {
      // Пачка «Рассылки» с устаревшим наблюдением не должна останавливать
      // пачки Instantly того же дня: строки остаются в резерве.
      if (transport === 'sender') {
        errors.push(`sender campaign ${batch.campaign_id}: ${markError.message}`.slice(0, 500));
        continue;
      }
      throw new Error(`delivery attempt fence failed: ${markError.message}`);
    }
    if (!parseMarked(markData)) continue;

    let outcome: AttemptFinalizeInput;
    let receivedResult = false;
    try {
      const append = transport === 'sender'
        ? async (appendInput: AppendLeadsToClientCampaignInput) => {
          const appendSender = deps.appendSenderLeads
            ?? (await import('./senderTransport/senderAppend')).appendLeadsToVeSenderCampaign;
          return appendSender(appendInput, { veProjectId: input.veProjectId, portalDb: input.portalDb });
        }
        : deps.appendLeads;
      const appendResult = await append({
        userId: preflight.clientUserId,
        campaignId: batch.campaign_id,
        leads: batch.leads,
        contextLabel: `VE2 delivery · ${reservation.run_date ?? reservation.run_id}`,
        // This Instantly flag is workspace-wide despite its name. The exact
        // VE2 row ledger is our idempotency boundary, so do not suppress leads
        // merely because another client in the shared workspace has them.
        skipIfInCampaign: false,
        entitlementMode: 'managed_contract',
        expectedInstantlyAccountId: preflight.instantlyAccountId,
        pauseOnWorkspaceCapacity: true,
        prepareProviderChunk: createVeDeliveryExclusionGuard(input.portalDb, input.veProjectId),
        beforeProviderRequest: async () => {
          const { data, error } = await input.portalDb.rpc('ve_renew_contact_delivery_request', {
            p_run_id: reservation.run_id, p_attempt_id: attemptId,
          });
          if (error || data !== true) throw new Error(error?.message ?? 'Delivery attempt lease expired');
        },
        ledgerSource: {
          kind: 've2_contact_delivery',
          runId: reservation.run_id,
          campaignName: batch.campaign_id,
        },
      });
      receivedResult = true;
      outcome = classifyAppendResult(batch.row_ids, appendResult, false);
      capacityBlocked = appendResult.capacityBlocked === true;
    } catch (error) {
      if (error instanceof AppendLeadsPartialError) {
        outcome = classifyAppendResult(batch.row_ids, error.partialResult, true);
        capacityBlocked = error.partialResult.capacityBlocked === true;
        outcome.error = error.message.slice(0, 500);
      } else {
        outcome = {
          accepted: [],
          skipped: [],
          uncertain: receivedResult ? [...batch.row_ids] : [],
          released: receivedResult ? [] : [...batch.row_ids],
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
      errors.push(outcome.error ?? 'delivery append failed');
    }
    if (capacityBlocked) outcome.error = 'INSTANTLY_CONTACT_CAPACITY';

    await finalizeAttempt(input.portalDb, {
      runId: reservation.run_id,
      attemptId,
      campaignId: batch.campaign_id,
      outcome,
    });
    accepted += outcome.accepted.length;
    skipped += outcome.skipped.length;
    uncertain += outcome.uncertain.length;
    // Untouched sibling batches remain reserved. Explicit retry can resume
    // them after a crash as well, without creating fake provider attempts.
    if (capacityBlocked) break;
  }

  const activation = await activateDeliveredContactCampaigns({
    portalDb: input.portalDb, veProjectId: input.veProjectId,
  });
  errors.push(...activation.errors);
  const notes = [...errors, ...(activation.senderErrors ?? [])];
  return {
    status: uncertain > 0 || activation.errors.length > 0 ? 'uncertain' : capacityBlocked ? 'capacity_blocked'
      : errors.length > 0 ? 'failed' : 'completed',
    runId: reservation.run_id,
    runDate: reservation.run_date,
    accepted,
    skipped,
    uncertain,
    ...(notes.length > 0 ? { error: notes.join('; ').slice(0, 500) } : {}),
  };
}
