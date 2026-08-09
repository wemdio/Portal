import type { LeadCreatePayload } from '@/lib/instantly/types';
import { normalizeEmail, scoreToCode, type ClientReportScoreCode } from './filters';

const READY_EMAIL_STATUSES = new Set(['valid', 'role_address', 'free_provider', 'catch_all']);

type LedgerLead = Pick<LeadCreatePayload, 'email' | 'company_name' | 'custom_variables'>;

export type ContactLedgerEventInput = {
  appendBatchId: string;
  clientUserId: string;
  campaignId: string;
  campaignName?: string | null;
  sourceKind: string;
  sourceRunId?: string | null;
  sourceJobId?: string | null;
  sourceRowId?: string | null;
  status: 'submitted' | 'accepted' | 'skipped' | 'failed';
  skipReason?: string | null;
  leads: readonly LedgerLead[];
  occurredAt: string;
  legacyInferred?: boolean;
};

export type AcceptedIdentity = {
  externalContactId: string | null;
  email: string;
  index: number;
};

function customVariable(lead: LedgerLead, key: string): string | null {
  const value = lead.custom_variables?.[key];
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function leadScore(lead: LedgerLead): number | null {
  const raw = customVariable(lead, 'score');
  if (raw === null) return null;
  const score = Number(raw);
  return Number.isFinite(score) ? score : null;
}

function normalizeDomain(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return normalized || null;
}

export function inferBatchScoreCode(leads: readonly LedgerLead[]): ClientReportScoreCode | null {
  const codes = new Set<ClientReportScoreCode>();
  for (const lead of leads) {
    const score = leadScore(lead);
    if (score === null) return null;
    codes.add(scoreToCode(score));
  }
  return codes.size === 1 ? [...codes][0] : null;
}

export function buildAcceptedIdentitySnapshot(input: {
  requested: readonly LedgerLead[];
  accepted: number;
  createdLeads?: ReadonlyArray<{ id: string; email: string; index: number }>;
}): { identityComplete: boolean; acceptedIdentities: AcceptedIdentity[] } {
  if (input.accepted === 0) return { identityComplete: true, acceptedIdentities: [] };

  const byIndex = new Map<number, AcceptedIdentity>();
  for (const created of input.createdLeads ?? []) {
    if (!Number.isSafeInteger(created.index) || created.index < 0 || created.index >= input.requested.length) continue;
    const email = normalizeEmail(created.email);
    const requestedEmail = normalizeEmail(input.requested[created.index]?.email);
    if (!email || email !== requestedEmail || byIndex.has(created.index)) continue;
    byIndex.set(created.index, {
      externalContactId: created.id.trim() || null,
      email,
      index: created.index,
    });
  }

  if (byIndex.size === input.accepted) {
    return {
      identityComplete: true,
      acceptedIdentities: [...byIndex.values()].sort((a, b) => a.index - b.index),
    };
  }

  if (input.accepted === input.requested.length) {
    const acceptedIdentities = input.requested.flatMap((lead, index) => {
      const email = normalizeEmail(lead.email);
      if (!email) return [];
      return [byIndex.get(index) ?? { externalContactId: null, email, index }];
    });
    return {
      identityComplete: acceptedIdentities.length === input.accepted,
      acceptedIdentities: acceptedIdentities.length === input.accepted ? acceptedIdentities : [],
    };
  }

  return { identityComplete: false, acceptedIdentities: [] };
}

export function buildContactLedgerEvents(input: ContactLedgerEventInput) {
  return input.leads.flatMap((lead, batchIndex) => {
    const email = normalizeEmail(lead.email);
    if (!email) return [];
    const score = leadScore(lead);
    return [{
      append_batch_id: input.appendBatchId,
      batch_index: batchIndex,
      client_user_id: input.clientUserId,
      domain_snapshot_id: customVariable(lead, 'domain_snapshot_id'),
      domain: normalizeDomain(customVariable(lead, 'domain')),
      company_name: lead.company_name?.trim() || null,
      email,
      source_kind: customVariable(lead, 'source_kind') ?? input.sourceKind,
      source_run_id: customVariable(lead, 'source_run_id') ?? input.sourceRunId ?? null,
      source_job_id: customVariable(lead, 'source_job_id') ?? input.sourceJobId ?? null,
      source_row_id: customVariable(lead, 'source_row_id') ?? input.sourceRowId ?? null,
      score,
      score_code: score === null ? 'error' : scoreToCode(score),
      campaign_id: input.campaignId,
      campaign_name_snapshot: input.campaignName?.trim() || null,
      submitted_at: input.occurredAt,
      append_status: input.status,
      skip_reason: input.skipReason ?? null,
      legacy_inferred: input.legacyInferred ?? false,
      created_at: input.occurredAt,
    }];
  });
}

export function buildIdentityResultEvents(input: {
  requested: readonly LedgerLead[];
  accepted: number;
  result: 'completed' | 'failed';
}): { status: 'accepted' | 'skipped' | 'failed' | null; leads: readonly LedgerLead[] } {
  if (input.result === 'failed') return { status: 'failed', leads: input.requested };
  if (input.accepted === input.requested.length) return { status: 'accepted', leads: input.requested };
  if (input.accepted === 0) return { status: 'skipped', leads: input.requested };
  return { status: null, leads: [] };
}

export function buildDomainSnapshot(input: {
  clientUserId: string;
  sourceKind: string;
  sourceRunId?: string | null;
  sourceJobId?: string | null;
  sourceRowId?: string | null;
  domain: string;
  companyName?: string | null;
  score: number | null;
  rating?: string | null;
  spf?: string | null;
  scoreOrigin?: 'api' | 'cache' | 'legacy' | null;
  emails?: ReadonlyArray<{ address: string | null; validationStatus?: string | null }>;
  sourceFilename?: string | null;
  scoredAt: string;
  routedCampaignId?: string | null;
  routedCampaignName?: string | null;
  routedAt?: string | null;
}) {
  const emails = input.emails ?? [];
  const snapshotEmails: Array<{ address: string; validationStatus: string | null }> = [];
  const seenEmails = new Set<string>();
  for (const email of emails) {
    const address = normalizeEmail(email.address);
    if (!address || seenEmails.has(address)) continue;
    seenEmails.add(address);
    snapshotEmails.push({
      address,
      validationStatus: email.validationStatus?.trim() || null,
    });
    if (snapshotEmails.length === 2) break;
  }
  return {
    client_user_id: input.clientUserId,
    source_kind: input.sourceKind,
    source_run_id: input.sourceRunId ?? null,
    source_job_id: input.sourceJobId ?? null,
    source_row_id: input.sourceRowId ?? null,
    domain: normalizeDomain(input.domain),
    company_name: input.companyName?.trim() || null,
    score: input.score,
    score_code: input.score === null ? 'error' : scoreToCode(input.score),
    rating: input.rating ?? null,
    spf: input.spf ?? null,
    score_origin: input.scoreOrigin ?? null,
    email_found_count: emails.filter((email) => Boolean(normalizeEmail(email.address))).length,
    email_validated_count: emails.filter(
      (email) => Boolean(normalizeEmail(email.address)) && READY_EMAIL_STATUSES.has(email.validationStatus ?? ''),
    ).length,
    routed_campaign_id: input.routedCampaignId ?? null,
    routed_campaign_name_snapshot: input.routedCampaignName?.trim() || null,
    routed_at: input.routedAt ?? null,
    metadata: {
      email: snapshotEmails[0]?.address ?? null,
      email_validation_status: snapshotEmails[0]?.validationStatus ?? null,
      email2: snapshotEmails[1]?.address ?? null,
      email2_validation_status: snapshotEmails[1]?.validationStatus ?? null,
      source_filename: input.sourceFilename?.trim() || null,
    },
    scored_at: input.scoredAt,
    created_at: input.scoredAt,
  };
}
