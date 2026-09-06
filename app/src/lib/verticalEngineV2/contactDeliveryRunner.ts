/**
 * Contract-aware weekday drip for Vertical Engine v2.
 *
 * The main DB owns the exact row reservation and Moscow/local business date.
 * This runner deliberately performs no read-then-send quota calculation: it
 * verifies campaign ownership first, asks the DB for one frozen daily batch,
 * fences every provider attempt, and persists exact accepted/uncertain row ids.
 * `projects/project_periods.contacts_done` remains the fulfillment fact; an
 * accepted upload here is only a technical delivery event.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AppendLeadsPartialError,
  appendLeadsToClientCampaign,
  type AppendLeadsResult,
} from '@/lib/clientLaunch/appendLeads';
import {
  reservePeriodCampaignLinks,
  type CampaignProjectOwnershipResult,
  type PeriodCampaignReservation,
} from '@/lib/instantly/campaignProjectOwnership';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { loadVeContactDeliveryCampaignInventory } from './contactDeliveryInventory';
import { activateDeliveredContactCampaigns } from './contactDeliveryActivation';

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
}

export type ContactDeliveryDayStatus =
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
  const skipped = knownSkippedIndexes.map((index) => rowIds[index]);
  const released = rowIds.filter((_, index) => !attempted.has(index) && !knownSkipped.has(index));

  if (!result.identityComplete || result.acceptedIndexes === null) {
    return {
      accepted: [],
      skipped,
      uncertain: attemptedIndexes.filter((index) => !knownSkipped.has(index)).map((index) => rowIds[index]),
      released,
      error: ambiguous ? 'provider outcome is ambiguous' : 'provider identity is incomplete',
    };
  }

  const acceptedIndexes = normalizeIndexes(result.acceptedIndexes, rowIds.length);
  if (acceptedIndexes.some((index) => !attempted.has(index))) {
    throw new Error('append accepted a contact whose provider request was not attempted');
  }
  if (acceptedIndexes.some((index) => knownSkipped.has(index))) {
    throw new Error('append classified the same contact as both accepted and skipped');
  }
  const acceptedSet = new Set(acceptedIndexes);
  const accepted = acceptedIndexes.map((index) => rowIds[index]);
  const remainder = attemptedIndexes
    .filter((index) => !acceptedSet.has(index) && !knownSkipped.has(index))
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
): Promise<{
  project: BoundVeProject;
  period: ActivePeriod;
  clientUserId: string;
  observedFirstContacted: number;
  instantlyAccountId: string;
  links: PeriodCampaignReservation[];
}> {
  const { data: projectData, error: projectError } = await portalDb
    .from('ve_projects')
    .select(
      'id, portal_project_id, portal_period_id, target_contacts, delivery_schedule_days, delivery_timezone, sender_daily_capacity, launch_preset_id, launch_instantly_account_id',
    )
    .eq('id', veProjectId)
    .maybeSingle();
  if (projectError) throw new Error(`delivery project read failed: ${projectError.message}`);
  const project = projectData as BoundVeProject | null;
  if (
    !project ||
    !project.portal_project_id ||
    !project.portal_period_id ||
    !project.launch_preset_id ||
    !nonEmptyString(project.launch_instantly_account_id) ||
    !Number.isSafeInteger(project.target_contacts) ||
    (project.target_contacts ?? 0) <= 0
  ) {
    throw new Error('VE2 delivery plan is not explicitly bound');
  }

  const { data: periodData, error: periodError } = await portalDb
    .from('project_periods')
    .select('id, project_id, status, contacts_done, deadline')
    .eq('id', project.portal_period_id)
    .eq('project_id', project.portal_project_id)
    .eq('status', 'active')
    .maybeSingle();
  if (periodError) throw new Error(`delivery period read failed: ${periodError.message}`);
  const period = periodData as ActivePeriod | null;
  if (!period) throw new Error('bound Portal project period is not active');

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

  return {
    project,
    period,
    clientUserId,
    observedFirstContacted: inventory.observedFirstContacted,
    instantlyAccountId,
    links: inventory.activeCampaignIds.map((campaignId) => ({
      periodId: period.id,
      campaignId,
      matchSource: 'manual',
      baselineContacts: 0,
      matchConfidence: 1,
      matchReason: `Vertical Engine v2 delivery · ${veProjectId}`,
    })),
  };
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
  const { error } = await portalDb.rpc('ve_finalize_contact_delivery_attempt', {
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
  const preflight = await loadPreflight(input.portalDb, input.instantlyDb, input.veProjectId);

  // Cross-database ownership is established before the main DB can expose a
  // provider batch. A conflict therefore cannot consume or strand drip rows.
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

  const { data: reserveData, error: reserveError } = await input.portalDb.rpc(
    've_reserve_contact_delivery_day',
    {
      p_ve_project_id: input.veProjectId,
      p_now: (input.now ?? new Date()).toISOString(),
      p_observed_ve_first_contacted: preflight.observedFirstContacted,
    },
  );
  if (reserveError) throw new Error(`delivery day reservation failed: ${reserveError.message}`);
  const reservation = parseReservation(reserveData);
  if (reservation.status !== 'reserved') {
    // A process may have stopped after persisting an accepted batch but before
    // activation. The separate activation fence reconciles it without uploading
    // the batch again or blindly repeating an ambiguous activation request.
    const activation = await activateDeliveredContactCampaigns({
      portalDb: input.portalDb, veProjectId: input.veProjectId,
    });
    return {
      status: activation.errors.length > 0 ? 'uncertain' : reservation.status,
      runId: reservation.run_id,
      runDate: reservation.run_date,
      accepted: 0,
      skipped: 0,
      uncertain: 0,
      ...(activation.errors.length > 0 ? { error: activation.errors.join('; ').slice(0, 500) } : {}),
    };
  }
  if (!reservation.run_id) throw new Error('reserved delivery day has no run id');

  let accepted = 0;
  let skipped = 0;
  let uncertain = 0;
  const errors: string[] = [];

  for (const batch of reservation.batches) {
    const attemptId = deps.createAttemptId();
    const { data: markData, error: markError } = await input.portalDb.rpc(
      've_mark_contact_delivery_attempt',
      {
        p_run_id: reservation.run_id,
        p_attempt_id: attemptId,
        p_campaign_id: batch.campaign_id,
        p_row_ids: batch.row_ids,
      },
    );
    if (markError) throw new Error(`delivery attempt fence failed: ${markError.message}`);
    if (!parseMarked(markData)) continue;

    let outcome: AttemptFinalizeInput;
    try {
      const appendResult = await deps.appendLeads({
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
        ledgerSource: {
          kind: 've2_contact_delivery',
          runId: reservation.run_id,
          campaignName: batch.campaign_id,
        },
      });
      outcome = classifyAppendResult(batch.row_ids, appendResult, false);
    } catch (error) {
      if (error instanceof AppendLeadsPartialError) {
        outcome = classifyAppendResult(batch.row_ids, error.partialResult, true);
        outcome.error = error.message.slice(0, 500);
      } else {
        outcome = {
          accepted: [],
          skipped: [],
          uncertain: [],
          released: [...batch.row_ids],
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
      errors.push(outcome.error ?? 'delivery append failed');
    }

    await finalizeAttempt(input.portalDb, {
      runId: reservation.run_id,
      attemptId,
      campaignId: batch.campaign_id,
      outcome,
    });
    accepted += outcome.accepted.length;
    skipped += outcome.skipped.length;
    uncertain += outcome.uncertain.length;
  }

  const activation = await activateDeliveredContactCampaigns({
    portalDb: input.portalDb, veProjectId: input.veProjectId,
  });
  errors.push(...activation.errors);
  return {
    status: uncertain > 0 || activation.errors.length > 0 ? 'uncertain' : errors.length > 0 ? 'failed' : 'completed',
    runId: reservation.run_id,
    runDate: reservation.run_date,
    accepted,
    skipped,
    uncertain,
    ...(errors.length > 0 ? { error: errors.join('; ').slice(0, 500) } : {}),
  };
}
