import {
  buildAcceptedIdentitySnapshot,
  buildContactLedgerEvents,
  buildDomainSnapshot,
  buildIdentityResultEvents,
  inferBatchScoreCode,
} from '@/lib/clientReports/ledger';
import type { LeadCreatePayload } from '@/lib/instantly/types';

const leads: LeadCreatePayload[] = [
  {
    email: ' SALES@Example.com ',
    company_name: 'Example',
    custom_variables: {
      domain: 'Example.com', score: '15001', source: 'hh', source_row_id: 'employer-1',
      source_kind: 'auto_pipeline', source_run_id: 'original-run',
      domain_snapshot_id: '123e4567-e89b-12d3-a456-426614174000',
    },
  },
  {
    email: 'info@example.org',
    company_name: 'Example Org',
    custom_variables: { domain: 'example.org', score: '1000000', source: 'hh' },
  },
];

describe('client report immutable ledgers', () => {
  it('freezes normalized contact identity and score code on submission', () => {
    const events = buildContactLedgerEvents({
      appendBatchId: 'batch-1',
      clientUserId: 'client-1',
      campaignId: 'campaign-1',
      campaignName: 'B campaign',
      sourceKind: 'auto_pipeline',
      sourceRunId: 'run-1',
      sourceJobId: 'job-1',
      status: 'submitted',
      leads,
      occurredAt: '2026-08-06T10:00:00.000Z',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      email: 'sales@example.com',
      domain: 'example.com',
      score: 15001,
      score_code: 'B',
      campaign_id: 'campaign-1',
      source_run_id: 'original-run',
      source_job_id: 'job-1',
      source_row_id: 'employer-1',
      domain_snapshot_id: '123e4567-e89b-12d3-a456-426614174000',
      append_status: 'submitted',
    });
  });

  it('uses the explicit error bucket when an append has no numeric score', () => {
    const [event] = buildContactLedgerEvents({
      appendBatchId: 'batch-2',
      clientUserId: 'client-1',
      campaignId: 'campaign-1',
      sourceKind: 'campaign_append',
      status: 'submitted',
      leads: [{ email: 'plain@example.com', company_name: 'Plain', custom_variables: {} }],
      occurredAt: '2026-08-06T10:00:00.000Z',
    });

    expect(event).toMatchObject({ score: null, score_code: 'error' });
  });

  it('only assigns per-contact accepted identity when the whole batch is accepted', () => {
    expect(buildIdentityResultEvents({ requested: leads, accepted: 2, result: 'completed' }))
      .toEqual({ status: 'accepted', leads });
    expect(buildIdentityResultEvents({ requested: leads, accepted: 0, result: 'completed' }))
      .toEqual({ status: 'skipped', leads });
    expect(buildIdentityResultEvents({ requested: leads, accepted: 1, result: 'completed' }))
      .toEqual({ status: null, leads: [] });
  });

  it('keeps the exact accepted aggregate while refusing to invent partial identities', () => {
    expect(inferBatchScoreCode(leads)).toBe('B');
    expect(inferBatchScoreCode([
      leads[0],
      { ...leads[1], custom_variables: { ...leads[1].custom_variables, score: '1001' } },
    ])).toBeNull();
  });

  it('freezes exact accepted identities for partial batches when the provider returns them', () => {
    expect(buildAcceptedIdentitySnapshot({
      requested: leads,
      accepted: 1,
      createdLeads: [{ id: 'external-2', email: 'info@example.org', index: 1 }],
    })).toEqual({
      identityComplete: true,
      acceptedIdentities: [{ externalContactId: 'external-2', email: 'info@example.org', index: 1 }],
    });
  });

  it('keeps partial identity unknown when the provider count and identity list disagree', () => {
    expect(buildAcceptedIdentitySnapshot({
      requested: leads,
      accepted: 1,
      createdLeads: [],
    })).toEqual({ identityComplete: false, acceptedIdentities: [] });
  });

  it('can prove every identity from the request when the whole batch is accepted', () => {
    expect(buildAcceptedIdentitySnapshot({
      requested: leads,
      accepted: 2,
      createdLeads: [],
    })).toEqual({
      identityComplete: true,
      acceptedIdentities: [
        { externalContactId: null, email: 'sales@example.com', index: 0 },
        { externalContactId: null, email: 'info@example.org', index: 1 },
      ],
    });
  });

  it('does not mark identity complete if a fully accepted request contains no normalizable identity', () => {
    expect(buildAcceptedIdentitySnapshot({
      requested: [{ email: '   ', company_name: 'Broken', custom_variables: {} }],
      accepted: 1,
      createdLeads: [],
    })).toEqual({ identityComplete: false, acceptedIdentities: [] });
  });

  it('builds a company snapshot with company and contact units separated', () => {
    expect(buildDomainSnapshot({
      clientUserId: 'client-1',
      sourceKind: 'manual_scoring',
      sourceRunId: 'run-1',
      sourceRowId: '42',
      domain: ' Example.com ',
      companyName: 'Example',
      score: 0,
      rating: 'D',
      spf: 'v=spf1 -all',
      emails: [
        { address: 'info@example.com', validationStatus: 'valid' },
        { address: 'sales@example.com', validationStatus: 'invalid' },
      ],
      scoredAt: '2026-08-06T10:00:00.000Z',
    })).toMatchObject({
      domain: 'example.com',
      score: 0,
      score_code: 'rejected',
      email_found_count: 2,
      email_validated_count: 1,
    });
  });
});
