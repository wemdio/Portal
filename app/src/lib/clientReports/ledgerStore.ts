import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  buildAcceptedIdentitySnapshot,
  buildContactLedgerEvents,
  inferBatchScoreCode,
} from './ledger';

type Db = Pick<SupabaseClient, 'from'>;
type LedgerLead = Pick<LeadCreatePayload, 'email' | 'company_name' | 'custom_variables'>;

type AppendContext = {
  clientUserId: string;
  campaignId: string;
  campaignName?: string | null;
  sourceKind: string;
  sourceRunId?: string | null;
  sourceJobId?: string | null;
  leads: readonly LedgerLead[];
};

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error ?? 'unknown error');
}

async function insertEvents(db: Db, rows: ReturnType<typeof buildContactLedgerEvents>) {
  if (rows.length === 0) return;
  const { error } = await db.from('client_campaign_contact_ledger').insert(rows);
  if (error) throw new Error(`Contact ledger write failed: ${error.message}`);
}

async function transitionAppendBatch(
  db: Db,
  batchId: string,
  patch: Record<string, unknown>,
  label: 'completion' | 'failure',
): Promise<void> {
  const { data, error } = await db
    .from('client_campaign_append_batches')
    .update(patch)
    .eq('id', batchId)
    .eq('status', 'submitted')
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Append batch ${label} write failed: ${error?.message ?? 'no row updated'}`);
  }
}

export async function startAppendLedgerBatch(db: Db, input: AppendContext & {
  blockedCount: number;
  tariffSkippedCount: number;
  startedAt: string;
}): Promise<{ batchId: string }> {
  const batchId = crypto.randomUUID();
  const submittedEvents = buildContactLedgerEvents({
    appendBatchId: batchId,
    clientUserId: input.clientUserId,
    campaignId: input.campaignId,
    campaignName: input.campaignName,
    sourceKind: input.sourceKind,
    sourceRunId: input.sourceRunId,
    sourceJobId: input.sourceJobId,
    status: 'submitted',
    leads: input.leads,
    occurredAt: input.startedAt,
  });
  if (submittedEvents.length !== input.leads.length) {
    throw new Error(
      `Contact identity journal mismatch: ${submittedEvents.length} durable identities for ${input.leads.length} requested leads`,
    );
  }

  const scoreCode = inferBatchScoreCode(input.leads);
  const { data, error } = await db
    .from('client_campaign_append_batches')
    .insert({
      id: batchId,
      client_user_id: input.clientUserId,
      campaign_id: input.campaignId,
      campaign_name_snapshot: input.campaignName?.trim() || null,
      source_kind: input.sourceKind,
      source_run_id: input.sourceRunId ?? null,
      source_job_id: input.sourceJobId ?? null,
      score_code: scoreCode,
      requested_count: input.leads.length,
      accepted_count: 0,
      skipped_count: 0,
      blocked_count: input.blockedCount,
      tariff_skipped_count: input.tariffSkippedCount,
      status: 'submitted',
      identity_complete: false,
      accepted_identities: [],
      started_at: input.startedAt,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Append batch ledger write failed: ${error?.message ?? 'no row returned'}`);

  try {
    await insertEvents(db, submittedEvents);
  } catch (ledgerError) {
    await db.from('client_campaign_append_batches').update({
      status: 'failed',
      error_message: errorMessage(ledgerError).slice(0, 500),
      identity_complete: true,
      finished_at: input.startedAt,
    }).eq('id', batchId);
    throw ledgerError;
  }

  return { batchId };
}

export async function completeAppendLedgerBatch(db: Db, input: AppendContext & {
  batchId: string;
  accepted: number;
  skipped: number;
  createdLeads?: ReadonlyArray<{ id: string; email: string; index: number }>;
  finishedAt: string;
}): Promise<void> {
  const identity = buildAcceptedIdentitySnapshot({
    requested: input.leads,
    accepted: input.accepted,
    createdLeads: input.createdLeads,
  });
  await transitionAppendBatch(db, input.batchId, {
    accepted_count: input.accepted,
    skipped_count: input.skipped,
    status: 'completed',
    identity_complete: identity.identityComplete,
    accepted_identities: identity.acceptedIdentities,
    finished_at: input.finishedAt,
  }, 'completion');
}

export async function failAppendLedgerBatch(db: Db, input: AppendContext & {
  batchId: string;
  error: unknown;
  finishedAt: string;
}): Promise<void> {
  const message = errorMessage(input.error).slice(0, 500);
  await transitionAppendBatch(db, input.batchId, {
    status: 'failed',
    error_message: message,
    identity_complete: true,
    finished_at: input.finishedAt,
  }, 'failure');
}
