/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mainDb: MockSupabaseClient = createMockSupabase();
let instantlyDb: MockSupabaseClient = createMockSupabase();
const createLeadsMock = jest.fn();
const resolveEffectiveLimitsMock = jest.fn(() => ({ max_contacts: 5000 }));
const getClientTariffRowMock = jest.fn(async () => ({ status: 'active' }));
const getClientStatusMock = jest.fn(() => 'active');
let mockBlockedEmails = new Set<string>();

jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mainDb; } }));
jest.mock('@/lib/supabaseInstantly', () => ({ get supabaseInstantly() { return instantlyDb; } }));
jest.mock('@/lib/instantly/client', () => ({
  createLeads: (...args: unknown[]) => {
    const requestOptions = args[2] as { onRequestAttempt?: () => void } | undefined;
    requestOptions?.onRequestAttempt?.();
    return createLeadsMock(...args);
  },
  listLeads: jest.fn(),
}));
jest.mock('@/lib/instantly/accounts', () => ({ resolveInstantlyAccountId: () => 'main' }));
jest.mock('@/lib/instantly/clientAccountOptions', () => ({
  resolveClientInstantlyRequestOptions: jest.fn(async () => ({ accountId: 'main' })),
}));
jest.mock('@/lib/clientBlocklist/blockedContacts', () => ({
  getBlockedEmailSet: jest.fn(async () => mockBlockedEmails),
  filterBlockedLeads: (leads: Array<{ email: string }>, blocked: Set<string>) => ({
    kept: leads.filter((lead) => !blocked.has(lead.email)),
    blockedCount: leads.filter((lead) => blocked.has(lead.email)).length,
  }),
}));
jest.mock('@/lib/tariffs', () => ({
  countClientContacts: jest.fn(async () => 0),
  getBillingPeriodStart: jest.fn(() => '2026-08-01T00:00:00Z'),
  getClientTariffRow: () => getClientTariffRowMock(),
  getClientStatus: () => getClientStatusMock(),
  resolveEffectiveLimits: () => resolveEffectiveLimitsMock(),
  isAwaitingFirstPayment: jest.fn(() => false),
}));
jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => undefined),
  logError: jest.fn(async () => undefined),
}));

import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';

const leads = [
  { email: 'one@example.com', company_name: 'One', custom_variables: { domain: 'example.com', score: '1001' } },
  { email: 'two@example.com', company_name: 'Two', custom_variables: { domain: 'example.com', score: '1001' } },
];

describe('appendLeadsToClientCampaign report ledger integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mainDb = createMockSupabase({ tables: {
      client_campaign_append_batches: [], client_campaign_contact_ledger: [],
    } });
    instantlyDb = createMockSupabase({ tables: {
      client_campaign_presets: [{ id: 'preset-1', client_user_id: 'client-1', instantly_account_id: 'main' }],
    } });
    createLeadsMock.mockResolvedValue({ leads_uploaded: 2 });
    resolveEffectiveLimitsMock.mockReturnValue({ max_contacts: 5000 });
    getClientTariffRowMock.mockResolvedValue({ status: 'active' });
    getClientStatusMock.mockReturnValue('active');
    mockBlockedEmails = new Set();
  });

  it('persists submitted identities and a terminal confirmation independently of the external contact list', async () => {
    await appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', contextLabel: 'C campaign', leads,
      ledgerSource: { kind: 'auto_pipeline', runId: 'run-1', jobId: 'job-1' },
    });

    expect(createLeadsMock).toHaveBeenCalledTimes(1);
    expect(mainDb.getRows('client_campaign_append_batches')[0]).toMatchObject({
      status: 'completed', accepted_count: 2, source_kind: 'auto_pipeline',
      source_run_id: 'run-1', source_job_id: 'job-1', identity_complete: true,
    });
    expect(mainDb.getRows('client_campaign_contact_ledger').filter((row) => row.append_status === 'submitted')).toHaveLength(2);
    // Accepted identity rows are copied atomically by the database terminal-event trigger.
    expect(mainDb.getRows('client_campaign_contact_ledger').filter((row) => row.append_status === 'accepted')).toHaveLength(0);
  });

  it('freezes exact accepted identities for a partially accepted external batch', async () => {
    createLeadsMock.mockResolvedValue({
      leads_uploaded: 1,
      created_leads: [{ id: 'external-two', email: 'two@example.com', index: 1 }],
    });

    const result = await appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads,
      ledgerSource: { kind: 'auto_pipeline', runId: 'run-1' },
    });

    expect(mainDb.getRows('client_campaign_append_batches')[0]).toMatchObject({
      accepted_count: 1,
      skipped_count: 1,
      identity_complete: true,
      accepted_identities: [{ externalContactId: 'external-two', email: 'two@example.com', index: 1 }],
    });
    expect(result).toMatchObject({
      accepted: 1,
      acceptedIndexes: [1],
      skippedIndexes: [0],
      attemptedIndexes: [0, 1],
      identityComplete: true,
    });
  });

  it('journals provider-sized chunks independently and returns input-relative accepted identities', async () => {
    const manyLeads = Array.from({ length: 1001 }, (_, index) => ({
      email: `person-${index}@example.com`,
      company_name: `Company ${index}`,
      custom_variables: { domain: `company-${index}.test`, score: '1001' },
    }));
    createLeadsMock.mockImplementation(async (chunk: typeof manyLeads) => ({
      leads_uploaded: chunk.length,
    }));

    const result = await appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads: manyLeads,
      ledgerSource: { kind: 'manual_scoring', runId: 'run-1' },
    });

    expect(createLeadsMock).toHaveBeenCalledTimes(2);
    expect(createLeadsMock.mock.calls.map(([chunk]) => (chunk as unknown[]).length)).toEqual([1000, 1]);
    expect(mainDb.getRows('client_campaign_append_batches')).toHaveLength(2);
    expect(mainDb.getRows('client_campaign_append_batches')).toEqual(expect.arrayContaining([
      expect.objectContaining({ requested_count: 1000, accepted_count: 1000, status: 'completed' }),
      expect.objectContaining({ requested_count: 1, accepted_count: 1, status: 'completed' }),
    ]));
    expect(result.accepted).toBe(1001);
    expect(result.identityComplete).toBe(true);
    expect(result.acceptedIndexes ?? []).toHaveLength(1001);
    expect(result.acceptedIndexes?.at(-1)).toBe(1000);
    expect(result.attemptedIndexes).toHaveLength(1001);
  });

  it('keeps completed chunks durable and exposes their exact partial result if a later chunk fails', async () => {
    const manyLeads = Array.from({ length: 1001 }, (_, index) => ({
      email: `person-${index}@example.com`,
      company_name: `Company ${index}`,
      custom_variables: { domain: `company-${index}.test`, score: '1001' },
    }));
    createLeadsMock
      .mockResolvedValueOnce({ leads_uploaded: 1000 })
      .mockRejectedValueOnce(new Error('provider timeout'));

    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads: manyLeads,
      ledgerSource: { kind: 'manual_scoring', runId: 'run-1' },
    })).rejects.toMatchObject({
      partialResult: expect.objectContaining({
        accepted: 1000,
        identityComplete: true,
        acceptedIndexes: expect.arrayContaining([0, 999]),
        attemptedIndexes: expect.arrayContaining([0, 1000]),
      }),
    });

    expect(mainDb.getRows('client_campaign_append_batches')).toEqual(expect.arrayContaining([
      expect.objectContaining({ requested_count: 1000, accepted_count: 1000, status: 'completed' }),
      expect.objectContaining({ requested_count: 1, accepted_count: 0, status: 'failed' }),
    ]));
  });

  it('reports the delivered chunk if provider delivery succeeds but terminal journaling fails', async () => {
    createLeadsMock.mockImplementationOnce(async () => {
      // Simulate the main database becoming unavailable only after the external
      // provider has accepted the request.
      mainDb = createMockSupabase({
        errorTables: { client_campaign_append_batches: 'database unavailable' },
      });
      return {
        leads_uploaded: 1,
        created_leads: [{ id: 'external-two', email: 'two@example.com', index: 1 }],
      };
    });

    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads,
      ledgerSource: { kind: 'manual_scoring', runId: 'run-1' },
    })).rejects.toMatchObject({
      partialResult: {
        accepted: 1,
        skipped: 1,
        acceptedIndexes: [1],
        attemptedIndexes: [0, 1],
        identityComplete: true,
      },
    });
  });

  it('fails closed before external delivery when the durable batch cannot be created', async () => {
    mainDb = createMockSupabase({
      tables: { client_campaign_append_batches: [], client_campaign_contact_ledger: [] },
      errorInserts: { client_campaign_append_batches: { code: '42P01', message: 'ledger missing' } },
    });

    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads,
      ledgerSource: { kind: 'auto_pipeline', runId: 'run-1' },
    })).rejects.toMatchObject({
      partialResult: expect.objectContaining({ attemptedIndexes: [] }),
    });
    expect(createLeadsMock).not.toHaveBeenCalled();
  });

  it('reports only the tariff-truncated prefix as attempted', async () => {
    resolveEffectiveLimitsMock.mockReturnValue({ max_contacts: 1 });
    createLeadsMock.mockResolvedValue({ leads_uploaded: 1 });

    const result = await appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads,
      ledgerSource: { kind: 'auto_pipeline', runId: 'run-1' },
    });

    expect(createLeadsMock).toHaveBeenCalledWith(
      [leads[0]],
      expect.any(Object),
      expect.any(Object),
    );
    expect(result.attemptedIndexes).toEqual([0]);
  });

  it('uses the explicit managed-contract entitlement without requiring a self-serve client tariff', async () => {
    getClientTariffRowMock.mockResolvedValue({ status: 'inactive' });
    getClientStatusMock.mockReturnValue('inactive');

    const result = await appendLeadsToClientCampaign({
      userId: 'client-1',
      campaignId: 'campaign-1',
      leads,
      entitlementMode: 'managed_contract',
      ledgerSource: { kind: 've2_contact_delivery', runId: 'delivery-run-1' },
    });

    expect(createLeadsMock).toHaveBeenCalledWith(leads, expect.any(Object), expect.any(Object));
    expect(result.attemptedIndexes).toEqual([0, 1]);
  });

  it('returns exact blocklist identities even when no provider request is made for them', async () => {
    mockBlockedEmails = new Set([leads[0].email]);
    createLeadsMock.mockResolvedValue({ leads_uploaded: 1 });
    const result = await appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads, entitlementMode: 'managed_contract',
    });
    expect(result).toMatchObject({
      acceptedIndexes: [1], attemptedIndexes: [1], skippedIndexes: [0],
    });
    mockBlockedEmails = new Set(leads.map((lead) => lead.email));
    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads, entitlementMode: 'managed_contract',
    })).resolves.toMatchObject({ attemptedIndexes: [], skippedIndexes: [0, 1] });
    expect(createLeadsMock).toHaveBeenCalledTimes(1);
  });

  it('fences a changed workspace again at the actual append boundary', async () => {
    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1', leads,
      expectedInstantlyAccountId: 'original-workspace', entitlementMode: 'managed_contract',
    })).rejects.toThrow('workspace');
    expect(createLeadsMock).not.toHaveBeenCalled();
    expect(mainDb.getRows('client_campaign_append_batches')).toHaveLength(0);
  });

  it('fails closed before external delivery when a requested lead has no journalable identity', async () => {
    await expect(appendLeadsToClientCampaign({
      userId: 'client-1', campaignId: 'campaign-1',
      leads: [leads[0], { ...leads[1], email: '   ' }],
      ledgerSource: { kind: 'auto_pipeline', runId: 'run-1' },
    })).rejects.toThrow(/contact identity/i);

    expect(createLeadsMock).not.toHaveBeenCalled();
    expect(mainDb.getRows('client_campaign_append_batches')).toHaveLength(0);
  });
});
