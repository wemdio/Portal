/** @jest-environment node */

/**
 * VE2-only regression contracts for the CONSTRUCT handoff.
 *
 * The shared base-constructor already knows how to split multi-email cells,
 * validate each resulting address and cap addresses per company. VE2 must ask
 * for those steps in the right order; otherwise importConstructRows sees a
 * merged cell, keeps only its first address and can attach the cell's best
 * validation status to a different address.
 *
 * Legacy Hypothesis Engine behavior is intentionally outside this suite.
 */

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
  searchCount: jest.fn(async () => ({ count: 9_120 })),
}));

jest.mock('@/lib/verticalEngineV2/nicheDirectory', () => ({ searchVeNicheDirectoryRows: jest.fn(async () => ({ rows: [] })) }));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  LLMValidationError: jest.requireActual('@/lib/verticalEngineV2/llm').LLMValidationError,
  getLLMValidationDiagnostic: jest.requireActual('@/lib/verticalEngineV2/llm').getLLMValidationDiagnostic,
  getVeModel: jest.fn((kind: string) => `test-${kind}-model`),
  getVeActiveJobSignal: jest.fn(() => undefined),
  veNativeJsonSchema: jest.requireActual('@/lib/verticalEngineV2/llm').veNativeJsonSchema,
  veCollectionCacheModel: jest.requireActual('@/lib/verticalEngineV2/llm').veCollectionCacheModel,
}));
jest.mock('@/lib/verticalEngineV2/relevanceEvidence', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/relevanceEvidence'),
  fetchVeRelevanceEvidence: jest.fn(async () => ({ status: 'unavailable', text: '', url: '', reason: 'offline_fixture' })),
}));
// 2ГИС: частичный мок — проверки части 3а идут по настоящим функциям страницы, диспатч близнеца — по подменённым.
jest.mock('@/lib/verticalEngineV2/twoGisPage', () => {
  const actual = jest.requireActual<typeof import('@/lib/verticalEngineV2/twoGisPage')>('@/lib/verticalEngineV2/twoGisPage');
  return { ...actual, readVeTwoGisPage: jest.fn(actual.readVeTwoGisPage),
    readVeTwoGisRubricDictionary: jest.fn(async () => { throw new Error('unmocked 2ГИС dictionary read'); }) };
});

const mockFindIrrelevantRows = jest.fn();

jest.mock('@/lib/verticalEngineV2/relevanceGate', () => ({
  // Existing lifecycle scenarios now return the explicit decision contract;
  // the triage model itself is not under test in this constructor suite.
  findIrrelevantRows: async (...args: unknown[]) => {
    const result = await mockFindIrrelevantRows(...args);
    const rows = (args[0] as { rows: unknown[] }).rows;
    return { ...result, review: result.review ?? new Set(), errored: result.errored ?? result.unchecked,
      decisions: result.decisions ?? new Map(rows.map((_, index) => [index, {
        version: 2, status: result.flagged.has(index) ? 'irrelevant' : result.unchecked.has(index) ? 'error' : 'relevant',
        reason: 'Mocked completed constructor classification', context_hash: 'a'.repeat(64),
        evidence: [{ field: 'description', quote: 'Mocked business activity' }], review_attempts: 0,
      }])),
    };
  },
}));

import { addVeKnownWebsiteSource, VE_KNOWN_ADULT_WEBSITES } from '@/lib/verticalEngineV2/knownWebsiteDirectory';
import { finalizeVeTwoGisTwins, pairVeTwoGisStates, veCountedPlanTasks, veTwoGisTwinKeys, VE_TWO_GIS_PAIR_LOST_NOTE, withVeTwoGisTwins } from '@/lib/verticalEngineV2/twoGisQuarantine';
import { applyVeCollectionGeographyToPlan, veTwoGisQueryScope } from '@/lib/verticalEngineV2/collectionGeography';
import { veCanWidenPlan } from '@/lib/verticalEngineV2/planWidening';
import { isVeTwoGisGovernmentHost, mapTwoGisRow, veTwoGisAddress, veTwoGisCompanyName, veTwoGisSiteDomain, veTwoGisSiteKind, veTwoGisWebsite,
  veTwoGisWebsiteHost } from '@/lib/verticalEngineV2/twoGisRows';
import { buildVeTwoGisPageQuery, nextVeTwoGisCursor, readVeTwoGisPage, readVeTwoGisPageWith, readVeTwoGisRubricDictionary,
  readVeTwoGisRubricDictionaryWith } from '@/lib/verticalEngineV2/twoGisPage';
import { resolveVeTwoGisRubrics, veTwoGisMappingFailure, VeTwoGisRubricsUnavailableError } from '@/lib/verticalEngineV2/twoGisRubrics';
import { claimVeTwoGisRows, releaseVeTwoGisClaims } from '@/lib/verticalEngineV2/twoGisJournal';
import { readVeTwoGisTwinState, veTwoGisAllow, VE_TWO_GIS_TWIN_NOTES } from '@/lib/verticalEngineV2/twoGisTwin';
import { VeLlmRateLimitError } from '@/lib/verticalEngineV2/llmRateLimit';
import { ProviderUsageWriteError } from '@/lib/providerUsage';
import { VeTwoGisSnapshotError, VeTwoGisUnavailableError } from '@/lib/verticalEngineV2/twoGisSource';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { createMockSupabase as createRawMockSupabase, type MockSupabaseClient, type MockSupabaseSeed } from '@/../tests/helpers/mockSupabase';
import { capVeContactsPerCompany, normalizeVeMaxEmailsPerCompany } from '@/lib/verticalEngineV2/companyContactCap';
import { canResumePartialPreview } from '@/lib/verticalEngineV2/collectionRecovery';
import { planVeCollectionGeographyRepair, prepareVeGeographyRepairContinuation, readVeGeographyRepair, veGeographyRepairHash, type VeGeographyRepairSnapshot } from '@/lib/verticalEngineV2/collectionGeographyRepair';
import { veRelevanceRowKey } from '@/lib/verticalEngineV2/relevanceReserve';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyVeNicheSourceSelection,
  applyVeAudienceSourceRefresh,
  baseRowMatchesExclusion,
  buildBaseExclusionKeysFromRows,
  dedupUnifiedRows,
  mapGoogleRow,
  mapHhRow,
  pruneBaseRowAgainstExclusion,
  runBaseCollectStage,
  veShortHhQuery,
  VE_AUTO_COLLECT_COLUMNS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';
import { searchVeNicheDirectoryRows } from '@/lib/verticalEngineV2/nicheDirectory';
import { createVeCollectionAudienceSnapshot, readVeCollectionAudienceSnapshot, loadVeApprovedSupplyAudience, veNewAudienceSourceCostPolicy, veSourceDiscoveryIsExistingOnly, normalizeVeAudienceSourcePlan, veAudienceNicheProfile, needsLegacyFintechAudienceRefresh } from '@/lib/verticalEngineV2/sourceAudience';
import { deriveVeRetailAudienceScope } from '@/lib/verticalEngineV2/legacyRetailAudience';
import { veAudienceReviewHold, veAutomaticAudienceReviewRows } from '@/lib/verticalEngineV2/audienceReviewHold';
import { buildSourcePlanMessages } from '@/lib/verticalEngineV2/prompts/sourcePlan';
import { buildSourcePlanMessagesEn, buildCatalogRepairMessagesEn } from '@/lib/verticalEngineV2/prompts/sourcePlan.en';
import { selectRefillLeadRows } from '@/lib/verticalEngineV2/stages/baseCollectRefill';
import { prepareSegmentationAudience } from '@/lib/verticalEngineV2/segmentationAudit';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import {
  createCollectionTarget,
  estimateRemainingReady,
  finishCollectionRound,
  collectionRoundLimit,
} from '@/lib/verticalEngineV2/collectionTarget';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';
import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import { stripTaskHarvest } from '@/lib/verticalEngineV2/projectDetail';
import { VePreviewCheckpointConflict } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { recoverVeSavedEmails, resumeVeSavedEmailRecovery, hasPendingVeSavedEmailRecovery,
  type VeSavedEmailRecoveryState } from '@/lib/verticalEngineV2/savedEmailRecovery';
import { createVeJobShutdown, VeWorkerShutdownError } from '@/lib/verticalEngineV2/workerLiveness';
import { normalizeVeSourceContacts, VE_CONFIRMED_WEBSITE_MARK } from '@/lib/verticalEngineV2/sourceContacts';
import { veAcquisitionReceipt, veCompanyWebsiteKey } from '@/lib/verticalEngineV2/collectionIdentity';
import { buildVeSeenCompanies } from '@/lib/verticalEngineV2/seenCompanies';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { planVeJobFailure } from '@/lib/verticalEngineV2/jobRetry';
import { isVeRenewableSourceTask } from '@/lib/verticalEngineV2/sourceRenewal';
import { resolveVeYandexCatalogFilters } from '@/lib/verticalEngineV2/yandexCatalog';
import { newVeAdaptiveCollection, finishVeAdaptiveBatch, chooseVeAdaptiveSource, veSourceStrategyKey, veReadyContactKeys, summarizeVeBatchSpend, readVeBatchSpend, veAdaptiveCandidateLimit } from '@/lib/verticalEngineV2/adaptiveCollection';
import { prioritizeVeCandidates } from '@/lib/verticalEngineV2/candidatePriority';
import { veCompanyFactKey, VE_COMPANY_FACT_TTL_MS } from '@/lib/verticalEngineV2/companyFacts';
import { previewRecoveryKind, openNextVeCollectionRound, grantVeResumeRoundBudget, getVeCollectionContinuation } from '@/lib/verticalEngineV2/collectionRecovery';
import cognitus from './fixtures/cognitusAdaptiveBatches.json';

const PROJECT = { id: 'p1', name: 'P', created_by: 'user-1', market: 'ru' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'Частные клиники',
  summary: 'Сети частных медицинских клиник',
  synonyms: [],
  potential_pct: 50,
  rank: 1,
};

const DIRECTORY_TASK = {
  source: 'companies_directory' as const,
  rationale: 'Тестовый срез реестра',
  directory_filters: { okvedCodes: ['86.1', '86.2', '86.9'], includeIp: false },
};

// The SQL transaction is exercised separately against PostgreSQL. These
// collector scenarios use its transport contract and retain one child for an
// ambiguous/repeated request, including a completed child with paid results.
function createMockSupabase(input: MockSupabaseSeed = {}): MockSupabaseClient {
  const children = new Map<string, string>();
  return createRawMockSupabase({ ...input, rpcHandlers: {
    ve_enqueue_preparation_child: async (params, db) => {
      expect(params.p_parent_job_id).toBeTruthy();
      expect(params).toHaveProperty('p_parent_started_at');
      const row = params.p_record as Record<string, unknown>;
      const table = String(params.p_kind);
      expect(['base_constructor_jobs', 'parser_jobs', 'google_maps_jobs']).toContain(table);
      const key = `${table}:${row.id ?? createHash('sha256').update(JSON.stringify(row)).digest('hex')}`;
      const known = children.get(key) ?? (row.id ? db.getRows(table).find((child) => child.id === row.id)?.id : undefined);
      if (known) return { data: known };
      const result = await db.from(table).insert(row).select('id').single();
      if (result.error) return { data: null, error: result.error };
      const id = String(result.data?.id);
      children.set(key, id);
      return { data: id };
    },
    ...input.rpcHandlers,
  } });
}

function unifiedRow(partial: Partial<VeUnifiedRow>): VeUnifiedRow {
  const result = {} as VeUnifiedRow;
  for (const column of VE_AUTO_COLLECT_COLUMNS) result[column] = partial[column] ?? '';
  return result;
}

function collectInfo(
  harvest: VeUnifiedRow[],
  construct?: VeCollectInfo['construct'],
): VeCollectInfo {
  return {
    plan: { tasks: [DIRECTORY_TASK] },
    tasks: [
      {
        source: DIRECTORY_TASK.source,
        status: 'done',
        child_job_id: null,
        rows: harvest.length,
        task: DIRECTORY_TASK,
        harvest,
      },
    ],
    ...(construct ? { construct } : {}),
  };
}

function makeBase(info: VeCollectInfo): Record<string, unknown> {
  return {
    id: 'b1',
    project_id: 'p1',
    vertical_id: 'v1',
    hypothesis_id: 'h1',
    filename: 'auto: Сети частных клиник',
    row_count: 0,
    columns: [],
    sample_rows: [],
    data: [],
    status: 'collecting',
    source: 'auto',
    collect_info: info,
    error: null,
  };
}

function makeJob(): VeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'b1', hypothesis_id: 'h1' },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-30T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-30T00:00:00Z',
    updated_at: '2026-08-30T00:00:00Z',
  };
}

function seed(
  info: VeCollectInfo,
  extraTables: Record<string, Array<Record<string, unknown>>> = {},
): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_bases: [makeBase(info)],
      ve_verticals: [VERTICAL],
      ve_hypotheses: [
        {
          id: 'h1',
          project_id: 'p1',
          vertical_id: 'v1',
          title: 'Сети частных клиник',
          description: 'Частные клиники с собственным сайтом и действующим бизнесом.',
          status: 'accepted',
        },
      ],
      ve_projects: [PROJECT],
      ve_jobs: [makeJob() as unknown as Record<string, unknown>],
      ...extraTables,
    },
    rpcHandlers: {
      // Размер реестровой части плана — тем же условием, что и выборка.
      ve_directory_plan_population: () => ({
        data: {
          directory_rows_total: 9_120,
          companies_unique_total: 8_410,
          companies_available: 8_410,
          companies_with_email: 6_842,
          companies_with_phone: 7_105,
          slice_companies: [8_410],
        },
      }),
    },
  });
}

function lastBasePatch(db: MockSupabaseClient): Record<string, unknown> | undefined {
  return db.updates.filter((update) => update.table === 've_bases').at(-1)?.patch;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(callLLMWithSchema).mockImplementation(async (messages, schema) => {
    const input = JSON.parse(String(messages.at(-1)?.content));
    if (!Array.isArray(input.companies)) throw new Error('Unexpected LLM request in CONSTRUCT fixture');
    return { data: schema.parse({ cleaned: input.companies.map((company: { idx: number; name: string }) =>
      ({ idx: company.idx, name: company.name })) }), tokensUsed: 0, costUsd: 0,
      promptTokens: 0, completionTokens: 0, rawResponse: '' };
  });
  mockFindIrrelevantRows.mockImplementation(async (input: { rows: unknown[] }) => ({
    flagged: new Set<number>(),
    unchecked: new Set<number>(),
    coverage: {
      checkedCompanies: input.rows.length,
      totalCompanies: input.rows.length,
      complete: true,
    },
    tokensUsed: 0,
    costUsd: 0,
  }));
});

describe('base_collect CONSTRUCT step order', () => {
  it('resumes the saved preview behind a newer billing failure without re-collecting or counting the same round twice', async () => {
    const ready = unifiedRow({ company: 'Clinic Ready', website: 'ready.test', email: 'mail@ready.test' });
    const pending = unifiedRow({ company: 'Clinic Pending', website: 'pending.test', email: 'mail@pending.test' });
    const info: VeCollectInfo = {
      ...collectInfo([ready, pending], { status: 'done', bc_job_id: 'bc-saved' }),
      collection_mode: 'preview', ready_target: 1000,
      // Срез уже расширялся дважды: здесь проверяется только восстановление, а
      // исчерпанный план такой базы больше не расширяется сам.
      adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
      target_progress: { ...createCollectionTarget('preview'), status: 'error', ready_rows: 1, candidates_processed: 2 },
      target_checkpoint: { completed_round: 1, seen_rows: [ready, pending], processed_rows: 2, relevance_unchecked: 1 },
      stats: { tasks_total: 1, tasks_done: 1, tasks_failed: 0, rows_total: 2, excluded_existing_bases: 0,
        excluded_during_fetch: 0, relevance_coverage_complete: false },
      saved_email_recovery: { version: 1, attempt_id: 'automatic:b1',
        checked: { a: 'unknown', b: 'ok', c: 'catch_all', d: 'invalid' },
        automatic_checked: { a: 'unknown', b: 'ok', c: 'catch_all', d: 'invalid' } },
    };
    info.tasks![0].exhausted = true;
    const saved = { ...makeBase(info), status: 'failed', row_count: 1,
      data: [{ ...ready, _email_status: 'ok' }], columns: [...VE_AUTO_COLLECT_COLUMNS], created_at: '2026-09-03' };
    const empty = { ...makeBase({ collection_mode: 'preview', target_progress: {
      ...createCollectionTarget('preview'), status: 'error', reason: 'Requesty 402: insufficient balance',
    } }), id: 'b-empty', status: 'failed', created_at: '2026-09-06' };
    const db = seed(info, { ve_bases: [saved, empty], ve_jobs: [], base_constructor_jobs: [{
      id: 'bc-saved', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
      data: [['Компания', 'Сайт', 'Email', 'Email Статус'],
        [ready.company, ready.website, ready.email, 'ok'], [pending.company, pending.website, pending.email, 'ok']],
    }] });
    const supabase = db as unknown as SupabaseClient;
    const enqueueInput = { projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name,
      hypothesisIds: ['h1'], collectionMode: 'preview' as const, limit: 2000 };
    const discoveryInfo: VeCollectInfo = { ...collectInfo([pending]), collection_mode: 'preview',
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 1, status: 'error' },
      target_checkpoint: { completed_round: 1, seen_rows: [ready] },
      source_contact_recovery: { version: 1, checked: { paid: { website: 'https://confirmed.test/', reason: 'verified' } } } };
    const discoveryDb = seed(discoveryInfo, { ve_jobs: [], ve_bases: [
      { ...makeBase(discoveryInfo), id: 'saved-discovery', status: 'failed', created_at: '2026-09-03' }, empty,
    ] });
    await expect(enqueueVeBaseCollect(discoveryDb as unknown as SupabaseClient, enqueueInput)).resolves.toMatchObject({ ok: true });
    expect(discoveryDb.getRows('ve_bases')).toHaveLength(2);
    expect(discoveryDb.getRows('ve_jobs')[0].payload).toMatchObject({ base_id: 'saved-discovery' });
    expect((discoveryDb.getRows('ve_bases').find((row) => row.id === 'saved-discovery')?.collect_info as VeCollectInfo).source_contact_recovery)
      .toEqual(discoveryInfo.source_contact_recovery);
    mockFindIrrelevantRows.mockResolvedValueOnce({ flagged: new Set(), unchecked: new Set([0]),
      coverage: { checkedCompanies: 0, totalCompanies: 1, complete: false }, tokensUsed: 0, costUsd: 0 });
    for (const complete of [false, true]) {
      const result = await enqueueVeBaseCollect(supabase, enqueueInput);
      expect(result).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
      // A second click must join the same queued recovery.
      await expect(enqueueVeBaseCollect(supabase, enqueueInput)).resolves.toMatchObject({ ok: true, created: false, base: { id: 'b1' } });
      // This failed on relevance coverage, not SMTP. Continuing that saved
      // phase must not clear settled unknowns and buy another email check.
      expect((db.getRows('ve_bases').find((base) => base.id === 'b1')!.collect_info as VeCollectInfo).saved_email_recovery)
        .toEqual(info.saved_email_recovery);
      const queued = db.getRows('ve_jobs').filter((j) => j.stage === 'base_collect').at(-1)!;
      const job = { ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] };
      await supabase.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
      await runBaseCollectStage(job, { supabase });
      await supabase.from('ve_jobs').update({ status: 'done' }).eq('id', queued.id);
      const base = db.getRows('ve_bases').find((b) => b.id === 'b1')!;
      expect(base).toMatchObject({ status: complete ? 'analyzing' : 'failed', row_count: complete ? 2 : 1 });
      expect((base.collect_info as VeCollectInfo).target_progress).toMatchObject({ round: 1, candidates_processed: 2 });
      expect((base.collect_info as VeCollectInfo).target_checkpoint?.processed_rows).toBe(2);
      expect(prepareSegmentationAudience({ rows: base.data as Record<string, unknown>[], columns: [...VE_AUTO_COLLECT_COLUMNS], source: 'auto' }).rows).toHaveLength(complete ? 2 : 1);
    }
    expect(db.getRows('ve_bases')).toHaveLength(2);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(searchRows).not.toHaveBeenCalled();
    expect(db.getRows('ve_jobs').filter((j) => j.stage === 'base_analyze')).toHaveLength(1);

    // A transient name outage resumes the saved name phase, not acquisition or
    // SMTP. Persist a retry cap so worker restarts cannot create an endless loop.
    for (const recoverNames of [true, false]) {
      const nameInfo: VeCollectInfo = { ...collectInfo([ready], { status: 'done', bc_job_id: 'bc-names' }),
        // Расширение среза уже израсходовано: проверяется только очистка названий.
        adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
        collection_mode: 'preview', target_progress: { ...createCollectionTarget('preview'), candidates_processed: 1 },
        target_checkpoint: { completed_round: 1, seen_rows: [ready], processed_rows: 1 },
        company_name_recovery: { validation_error: null, has_buffered_candidates: false,
          round_low_relevance: 0, round_relevance_unchecked: 0 } };
      nameInfo.tasks![0].exhausted = true;
      const namesDb = seed(nameInfo, { ve_bases: [{ ...makeBase(nameInfo), row_count: 1, columns: [...VE_AUTO_COLLECT_COLUMNS],
        data: [{ ...ready, _email_status: 'ok', _ve_relevance: { version: 2, status: 'relevant',
          reason: 'Verified clinic', context_hash: 'a'.repeat(64), evidence: [{ field: 'description', quote: 'Clinic' }] },
          _ve_company_name: { version: 1, source: ready.company,
          website: ready.website, status: 'failed', value: '' } }],
      }], base_constructor_jobs: [{ id: 'bc-names', status: 'completed',
        selected_steps: ['split_emails', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'Email Статус'], [ready.company, ready.website, ready.email, 'ok']],
      }] });
      const namesSupabase = namesDb as unknown as SupabaseClient;
      mockFindIrrelevantRows.mockClear();
      if (recoverNames) {
        // A billing hold keeps this paid phase and its rows for the same job.
        // It must neither consume the transient retry cap nor start new acquisition.
        jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new Error('Requesty 402: insufficient balance'));
        const nameJob = namesDb.getRows('ve_jobs').find((row) => row.id === 'job-1') as unknown as VeJob;
        await expect(runBaseCollectStage({ ...nameJob }, { supabase: namesSupabase }))
          .rejects.toThrow('Requesty 402: insufficient balance');
        expect(namesDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: 1,
          data: [expect.objectContaining({ email: ready.email, _email_status: 'ok' })],
          collect_info: { target_progress: { status: 'collecting', round: 1, candidates_processed: 1 },
            company_name_recovery: expect.any(Object) } });
        expect(namesDb.getRows('ve_jobs')[0].result).toHaveProperty('company_name_checkpoint');
        expect(namesDb.getRows('ve_jobs')[0].result).not.toHaveProperty('company_name_retry');
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const succeeds = recoverNames && attempt === 3;
        if (!succeeds) jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new Error('Requesty 429: temporarily limited'));
        await namesSupabase.from('ve_jobs').update({ status: 'running' }).eq('id', 'job-1');
        const nameJob = namesDb.getRows('ve_jobs').find((row) => row.id === 'job-1') as unknown as VeJob;
        await runBaseCollectStage({ ...nameJob }, { supabase: namesSupabase });
        const nameBase = namesDb.getRows('ve_bases')[0];
        expect((nameBase.collect_info as VeCollectInfo).target_progress?.candidates_processed).toBe(1);
        expect(nameBase.status).toBe(attempt < 3 ? 'collecting' : succeeds ? 'analyzing' : 'failed');
        if (attempt < 3) expect(namesDb.getRows('ve_jobs').find((row) => row.id === 'job-1')).toMatchObject({
          status: 'pending', result: { company_name_retry: { attempts: attempt + 1 } },
        });
      }
      expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
      expect(namesDb.getRows('base_constructor_jobs')).toHaveLength(1);
    }

    // A continuation of BOTH failed validation and unfinished names must not
    // replay the old 402 after successfully cleaning names. A fresh 402 still
    // holds the same validation pass instead of becoming an automatic paid loop.
    for (const { billingRestored, pendingBatch } of [
      { billingRestored: true, pendingBatch: false }, { billingRestored: false, pendingBatch: false },
      { billingRestored: true, pendingBatch: true }, { billingRestored: false, pendingBatch: true },
    ]) {
      const paid = unifiedRow({ company: 'Paid clinic', website: 'https://paid.test', email: 'info@paid.test' });
      const billingError = 'Requesty 402: insufficient balance';
      const interrupted: VeCollectInfo = {
        ...collectInfo([ready, pending], { status: 'done', bc_job_id: 'bc-names-and-review' }),
        collection_mode: 'preview',
        adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
        preview_pipeline: { version: 1, revision: 0, batches: pendingBatch
          ? [{ id: 'paid-child', rows: [paid], inserted: true, dispatched_at: '2026-10-09T17:00:00Z' }] : [],
          job_ids: ['old-child', ...(pendingBatch ? ['paid-child'] : [])], error: billingError },
        target_progress: { ...createCollectionTarget('preview'), status: 'error', candidates_processed: 2 },
        target_checkpoint: { completed_round: 1, seen_rows: [ready, pending], processed_rows: 2 },
        relevance_reserve: { version: 1, rows: [{ ...pending, _email_status: 'ok', _relevance_unchecked: true }] },
        company_name_recovery: { validation_error: billingError, has_buffered_candidates: false,
          round_low_relevance: 0, round_relevance_unchecked: 1 },
      };
      interrupted.tasks![0].exhausted = true;
      const retryDb = seed(interrupted, { ve_jobs: [], ve_bases: [{ ...makeBase(interrupted),
        status: 'failed', error: billingError, row_count: 1, columns: [...VE_AUTO_COLLECT_COLUMNS],
        data: [{ ...ready, _email_status: 'ok', _ve_relevance: { version: 2, status: 'relevant',
          reason: 'Verified clinic', context_hash: 'a'.repeat(64), evidence: [{ field: 'description', quote: 'Clinic' }] },
          _ve_company_name: { version: 1, source: ready.company, website: ready.website, status: 'failed', value: '' } }],
      }], base_constructor_jobs: [{ id: 'bc-names-and-review', status: 'completed' }, ...(pendingBatch ? [{
        id: 'paid-child', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'Email Статус'], [paid.company, paid.website, paid.email, 'ok']],
      }] : [])] });
      const retryClient = retryDb as unknown as SupabaseClient;
      await expect(enqueueVeBaseCollect(retryClient, enqueueInput)).resolves.toMatchObject({ ok: true, base: { id: 'b1' } });
      expect((retryDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).company_name_recovery)
        .toMatchObject({ retry_validation_after_cleanup: true, validation_error: billingError });
      const queued = retryDb.getRows('ve_jobs')[0];
      const retryJob = { ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] };
      mockFindIrrelevantRows.mockClear();
      // One interrupted name wake must retain the explicit continuation marker.
      jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new Error('Requesty 429: temporarily limited'));
      for (let wake = 0; wake < 2; wake++) {
        await retryClient.from('ve_jobs').update({ status: 'running' }).eq('id', retryJob.id);
        await runBaseCollectStage({ ...retryJob }, { supabase: retryClient });
        expect(retryDb.getRows('ve_bases')[0].status).toBe('collecting');
      }
      expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
      const afterNames = retryDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(afterNames.company_name_cleanup?.status).toBe('complete');
      expect(afterNames.company_name_recovery).toBeUndefined();
      expect(afterNames.relevance_review_requested).toBe(true);
      // Finishing old names must not resurrect the old error while an already
      // purchased neighbour waits; the next pass still checks the saved rows.
      expect(afterNames.preview_pipeline).not.toHaveProperty('error');
      if (!billingRestored) mockFindIrrelevantRows.mockImplementation(async (input: { rows: unknown[] }) => ({
        flagged: new Set(), unchecked: new Set(input.rows.map((_, index) => index)),
        coverage: { checkedCompanies: 0, totalCompanies: input.rows.length, complete: false },
        error: billingError, tokensUsed: 0, costUsd: 0,
      }));
      await retryClient.from('ve_jobs').update({ status: 'running' }).eq('id', retryJob.id);
      if (!billingRestored) {
        await expect(runBaseCollectStage({ ...retryJob }, { supabase: retryClient })).rejects.toThrow(billingError);
        expect(retryDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: 1,
          collect_info: { target_progress: { status: 'collecting', round: 1, candidates_processed: 2 },
            relevance_review_requested: true } });
        expect(retryDb.getRows('base_constructor_jobs')).toHaveLength(pendingBatch ? 2 : 1);
        mockFindIrrelevantRows.mockImplementation(async (input: { rows: unknown[] }) => ({
          flagged: new Set<number>(), unchecked: new Set<number>(),
          coverage: { checkedCompanies: input.rows.length, totalCompanies: input.rows.length, complete: true },
          tokensUsed: 0, costUsd: 0,
        }));
      }
      await runBaseCollectStage({ ...retryJob }, { supabase: retryClient });
      for (let wake = 0; pendingBatch && wake < 4 && retryDb.getRows('ve_bases')[0].status === 'collecting'; wake++) {
        await retryClient.from('ve_jobs').update({ status: 'running' }).eq('id', retryJob.id);
        await runBaseCollectStage({ ...retryJob }, { supabase: retryClient });
      }
      const completed = retryDb.getRows('ve_bases')[0];
      expect(completed).toMatchObject({ status: 'analyzing', row_count: 2 + Number(pendingBatch) });
      expect(completed.error).toBeNull();
      expect((completed.collect_info as VeCollectInfo).target_progress).toMatchObject({ round: pendingBatch ? 2 : 1, candidates_processed: pendingBatch ? 3 : 2 });
      expect((completed.collect_info as VeCollectInfo).relevance_review_requested).toBeUndefined();
      expect(mockFindIrrelevantRows).toHaveBeenCalledTimes((pendingBatch ? 2 : 1) + Number(!billingRestored));
      expect(retryDb.getRows('base_constructor_jobs')).toHaveLength(pendingBatch ? 2 : 1);
      expect(searchRows).not.toHaveBeenCalled();
      mockFindIrrelevantRows.mockImplementation(async (input: { rows: unknown[] }) => ({
        flagged: new Set<number>(), unchecked: new Set<number>(),
        coverage: { checkedCompanies: input.rows.length, totalCompanies: input.rows.length, complete: true },
        tokensUsed: 0, costUsd: 0,
      }));
    }

    // Restarting after an outage must buy a NEW validation child for unknowns,
    // while repeated wakes and an in-flight child remain idempotent.
    const emailDb = createMockSupabase({ tables: { ve_projects: [PROJECT], base_constructor_jobs: [] } });
    let emailState: VeSavedEmailRecoveryState | undefined;
    let emailRows: Array<Record<string, unknown>> = [
      { email: 'pending@clinic.test', _email_status: 'unknown' }, { email: 'ready@clinic.test', _email_status: 'ok' },
    ];
    const recover = () => recoverVeSavedEmails({ ctx: { supabase: emailDb as unknown as SupabaseClient },
      job: makeJob(), baseId: 'b1', automatic: true, rows: emailRows, state: emailState,
      save: async (state, rows) => { emailState = state; emailRows = rows; } });
    const finishEmail = async (status: string) => {
      const child = emailDb.getRows('base_constructor_jobs').at(-1)!;
      expect(child.workload_origin).toBe('automation');
      const grid = child.data as string[][];
      await emailDb.from('base_constructor_jobs').update({ status: 'completed',
        data: [[...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, status])] }).eq('id', child.id);
    };
    await recover();
    await finishEmail('unknown');
    await recover();
    expect(hasPendingVeSavedEmailRecovery(emailRows, emailState)).toBe(false);
    emailState = resumeVeSavedEmailRecovery(emailState);
    expect(hasPendingVeSavedEmailRecovery(emailRows, emailState)).toBe(true);
    await recover();
    const children = emailDb.getRows('base_constructor_jobs');
    expect(children).toHaveLength(2);
    expect(children[1].id).not.toBe(children[0].id);
    expect(children[1].initial_row_count).toBe(1);
    emailState = resumeVeSavedEmailRecovery(emailState); // preserve the pending child
    await recover();
    expect(emailDb.getRows('base_constructor_jobs')).toHaveLength(2);
    await finishEmail('ok');
    await recover();
    await recover();
    expect(emailRows.every((row) => row._email_status === 'ok')).toBe(true);
    expect(hasPendingVeSavedEmailRecovery(emailRows, emailState)).toBe(false);
    expect(emailDb.getRows('base_constructor_jobs')).toHaveLength(2);
    // Valid recipients progress while a small SMTP child waits in the shared
    // queue. Even 500 ready recipients must not orphan that queued child.
    for (const count of [1, 500]) {
      const reviewRows = Array.from({ length: count }, (_, index) => ({
        ...unifiedRow({ company: 'Clinic Verified', website: 'verified.test', email: `recipient${index}@verified.test` }),
        _email_status: 'ok', _relevance_unchecked: true,
      }));
      const unknown = { ...unifiedRow({ company: 'Clinic Unknown', website: 'unknown.test', email: 'mail@unknown.test' }),
        _email_status: 'unknown', _relevance_unchecked: true };
      const overlapInfo: VeCollectInfo = { ...collectInfo([]), collection_mode: 'preview', ready_target: 500,
        // Расширение среза уже израсходовано: проверяется дочерняя проверка почт.
        adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
        validation_retry: true, target_progress: { ...createCollectionTarget('preview'), candidates_processed: count + 1 },
        target_checkpoint: { completed_round: 1, seen_rows: [], processed_rows: count + 1 },
        relevance_reserve: { version: 1, rows: [...reviewRows, unknown], source_rows: [] } };
      overlapInfo.tasks![0].exhausted = true;
      const overlapDb = seed(overlapInfo, { ve_bases: [{ ...makeBase(overlapInfo), columns: [...VE_AUTO_COLLECT_COLUMNS] }] });
      const wake = async () => {
        await overlapDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        return runBaseCollectStage(makeJob(), { supabase: overlapDb as unknown as SupabaseClient });
      };
      await wake();
      expect(overlapDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: count });
      const child = overlapDb.getRows('base_constructor_jobs')[0];
      expect(child).toMatchObject({ status: 'pending', selected_steps: ['validate_emails'], initial_row_count: 1 });
      const calls = mockFindIrrelevantRows.mock.calls.length;
      await wake();
      expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(calls);
      expect(overlapDb.getRows('base_constructor_jobs')).toHaveLength(1);
      expect(overlapDb.getRows('ve_jobs').filter((row) => row.stage === 'base_analyze')).toHaveLength(0);
      const grid = child.data as string[][];
      await overlapDb.from('base_constructor_jobs').update({ status: 'completed',
        data: [[...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, 'ok'])] }).eq('id', child.id);
      await wake();
      expect(overlapDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzing', row_count: count + 1 });
      expect((overlapDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).saved_email_recovery?.batch).toBeUndefined();
      expect(overlapDb.getRows('base_constructor_jobs')).toHaveLength(1);
    }
    // A failed/ambiguous queue insert never races a concurrent repair by
    // restoring failed; a later explicit queue check repairs that same base.
    for (const committed of [false, true]) {
      const retryDb = createMockSupabase({ tables: {
        ve_hypotheses: [{ id: 'h1', title: 'Clinic' }], ve_jobs: [],
        ve_bases: [{ ...empty, error: 'Requesty 402: insufficient balance' }],
      }, errorInserts: { ve_jobs: { code: 'XX000', message: 'connection lost', commitRow: committed } } });
      const result = await enqueueVeBaseCollect(retryDb as unknown as SupabaseClient, enqueueInput);
      expect(result.ok).toBe(committed);
      expect(retryDb.getRows('ve_bases')).toHaveLength(1);
      expect(retryDb.getRows('ve_bases')[0].status).toBe('collecting');
      const repairedDb = createMockSupabase({ tables: { ve_hypotheses: [{ id: 'h1', title: 'Clinic' }],
        ve_bases: retryDb.getRows('ve_bases'), ve_jobs: retryDb.getRows('ve_jobs') } });
      await expect(enqueueVeBaseCollect(repairedDb as unknown as SupabaseClient, enqueueInput)).resolves.toMatchObject({ ok: true });
      expect(repairedDb.getRows('ve_bases')).toHaveLength(1);
      expect(repairedDb.getRows('ve_jobs')).toHaveLength(1);
    }
    expect(finishCollectionRound({ ...createCollectionTarget('preview'), candidates_processed: 2000 }, {
      candidates: 0, readyRows: 250, exhausted: false, canContinue: true, error: null, validationRetry: true,
    })).toMatchObject({ status: 'collecting', round: 2, candidates_processed: 2000 });
    const bufferedInfo: VeCollectInfo = { ...info,
      construct: { status: 'done', bc_job_id: 'bc-saved' },
      target_progress: { ...createCollectionTarget('preview'), status: 'error', candidates_processed: 2, ready_rows: 1 },
      target_checkpoint: { completed_round: 1, seen_rows: [ready, pending], processed_rows: 2 },
      stats: { ...info.stats!, relevance_coverage_complete: false },
      tasks: info.tasks!.map((task) => ({ ...task, exhausted: true, harvest: [ready, pending,
        unifiedRow({ company: 'Clinic Buffered', email: 'mail@buffered.test' })] })),
    };
    const bufferedDb = seed(bufferedInfo, { ve_jobs: [],
      ve_bases: [{ ...saved, collect_info: bufferedInfo, status: 'failed' }],
      base_constructor_jobs: db.getRows('base_constructor_jobs') });
    await enqueueVeBaseCollect(bufferedDb as unknown as SupabaseClient, enqueueInput);
    const bufferedJob = bufferedDb.getRows('ve_jobs')[0];
    await bufferedDb.from('ve_jobs').update({ status: 'running' }).eq('id', bufferedJob.id);
    await expect(runBaseCollectStage({ ...makeJob(), id: bufferedJob.id as string, payload: bufferedJob.payload as VeJob['payload'] },
      { supabase: bufferedDb as unknown as SupabaseClient })).resolves.toMatchObject({ result: { waiting: true, target_status: 'collecting' } });
    expect((bufferedDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
      .toMatchObject({ round: 2, candidates_processed: 2, ready_rows: 2 });
    expect(bufferedDb.getRows('base_constructor_jobs')).toHaveLength(1);
  });

  it('targets validated recipients with bounded rounds and distinct stopping reasons', async () => {
    // Source changes require two fully checked poor cohorts; costs are never
    // inferred as zero from missing/ambiguous accounting. Replays are idempotent.
    const cost = summarizeVeBatchSpend([
      { event: 'started', context: { attemptId: 'a', provider: 'requesty' } },
      { event: 'finished', context: { attemptId: 'a', provider: 'requesty', reportedCostUsd: 0.2 } },
      { event: 'finished', context: { attemptId: 'a', provider: 'requesty', reportedCostUsd: 0.2 } },
      { event: 'started', context: { attemptId: 's', provider: 'serper' } },
      { event: 'finished', context: { attemptId: 's', provider: 'serper', serperCredits: 3 } },
    ]);
    expect(cost).toMatchObject({ ai_usd: 0.2, serper_credits: 3, complete: true, unknown_attempts: 0 });
    expect(cost.estimated_total_usd).toBeCloseTo(0.203);
    expect(summarizeVeBatchSpend([{ event: 'finished', context: { attemptId: 'missing', provider: 'requesty' } }]))
      .toMatchObject({ complete: false, unknown_attempts: 1 });
    expect(await readVeBatchSpend(createMockSupabase({ errorTables: { application_logs: 'offline' } }) as unknown as SupabaseClient,
      'p1', 'b1', new Date(0).toISOString(), new Date().toISOString())).toMatchObject({ complete: false });
    let adaptive = { ...newVeAdaptiveCollection(), active_source: 'a' };
    const before = [{ email: 'old@test.ru' }];
    for (let index = 0; index < 2; index++) {
      const pending = { id: String(index), source_key: 'a', source: 'companies_directory', candidates: 100,
        ready_before: veReadyContactKeys(before), started_at: new Date().toISOString() };
      adaptive = { ...finishVeAdaptiveBatch({ ...adaptive, pending }, [...before, { email: 'new@test.ru' },
        { email: 'NEW@test.ru' }], cost), active_source: 'a' };
      expect(adaptive.completed.at(-1)?.new_ready).toBe(1);
      expect(adaptive.replan_needed).toBe(index === 1);
      expect(finishVeAdaptiveBatch({ ...adaptive, pending }, before, cost).completed).toHaveLength(index + 1);
    }
    expect(chooseVeAdaptiveSource(adaptive, ['a', 'untried'])).toBe('untried');
    expect(veSourceStrategyKey(DIRECTORY_TASK)).toBe(veSourceStrategyKey({ ...DIRECTORY_TASK, rationale: 'Wording changes are not a new source' }));
    expect(veSourceStrategyKey(DIRECTORY_TASK)).toBe(veSourceStrategyKey({ ...DIRECTORY_TASK,
      directory_filters: { ...DIRECTORY_TASK.directory_filters, okvedCodes: [...DIRECTORY_TASK.directory_filters.okvedCodes].reverse() } }));
    const company = unifiedRow({ company: 'Завод Орион', inn: '7700000001', address: 'Москва', website: '', email: '' });
    const spare = unifiedRow({ company: 'Нет сведений', website: '', email: '' });
    const present = unifiedRow({ company: 'Компания с сайтом', website: 'https://present.test', email: '' });
    const hints = [{ key: veCompanyFactKey(company)!, website: 'https://orion.test/', facts: 'Производим промышленное оборудование',
      observedAt: new Date().toISOString(), inns: [company.inn], ownerInns: [company.inn] }];
    expect(prioritizeVeCandidates([spare, company, present], hints, 'Промышленное оборудование'))
      .toEqual([{ ...company, website: hints[0].website, source_detail: `${VE_CONFIRMED_WEBSITE_MARK} ${hints[0].website}` }, present, spare]);
    expect(prioritizeVeCandidates([company], [{ ...hints[0], inns: ['7700000002'], ownerInns: ['7700000002'] }])[0].website).toBe('');
    expect(prioritizeVeCandidates([company], hints, '', Date.now() + VE_COMPANY_FACT_TTL_MS)[0].website).toBe('');
    expect(company.website).toBe('');
    const preview = createCollectionTarget('preview', 50_000);
    expect(preview.ready_target).toBe(500);
    expect(collectionRoundLimit(preview)).toBe(100);
    const almostReady = { ...preview, round: 20, ready_rows: 499, candidates_processed: 2200 };
    expect(veAdaptiveCandidateLimit(almostReady)).toBe(50);
    expect(veAdaptiveCandidateLimit({ ...almostReady, ready_rows: 500 })).toBe(0);
    expect(veAdaptiveCandidateLimit({ ...almostReady, candidates_processed: 9990 }, 4)).toBe(6);
    expect(veAdaptiveCandidateLimit({ ...almostReady, candidates_processed: 10_000 })).toBe(0);
    expect(collectionRoundLimit({ ...preview, ready_target: 1_000, first_round_candidates: undefined })).toBe(2_000);
    expect(collectionRoundLimit(createCollectionTarget('supply', 1_000))).toBe(2_000);
    const progressing = finishCollectionRound(preview, {
      candidates: 2_000, readyRows: 200, exhausted: false, canContinue: true, error: null,
    });
    expect(progressing).toMatchObject({ status: 'collecting', round: 2, ready_rows: 200 });
    expect(collectionRoundLimit(progressing)).toBe(3_000);
    // Company inputs do not satisfy the goal. Size the next cohort from
    // measured yield and stop only after 500 fully ready recipients exist.
    const lowYield = finishCollectionRound(preview, {
      candidates: 100, readyRows: 20, exhausted: false, canContinue: true, error: null,
    });
    expect(lowYield.status).toBe('collecting');
    expect(collectionRoundLimit(lowYield)).toBe(2_400);
    expect(finishCollectionRound(lowYield, {
      candidates: 2_400, readyRows: 499, exhausted: false, canContinue: true, error: null,
    }).status).toBe('collecting');
    for (const [change, status] of [
      [{ readyRows: 500 }, 'target_reached'],
      [{ exhausted: true }, 'exhausted'],
      [{ candidates: 10_000 }, 'limited'],
      [{ canContinue: false }, 'limited'],
      [{ error: 'validation unavailable' }, 'error'],
      [{ error: 'validation incomplete', readyRows: 500 }, 'error'],
    ] as const) {
      expect(finishCollectionRound(preview, Object.assign({
        candidates: 2_000, readyRows: 200, exhausted: false, canContinue: true, error: null,
      }, change)).status).toBe(status);
    }
    // Одна фраза на две разные остановки врала специалисту: «продолжать нечем»
    // показывалось и когда источник ещё жив, а просто раунд вышел пустым.
    expect(finishCollectionRound(preview, {
      candidates: 2_000, readyRows: 200, exhausted: false, canContinue: false, error: null,
    })).toMatchObject({ status: 'limited', reason: expect.stringContaining('Нет подтверждённого продолжения') });
    expect(finishCollectionRound(preview, {
      candidates: 0, readyRows: 200, exhausted: false, canContinue: true, error: null,
    })).toMatchObject({ status: 'limited', reason: expect.stringContaining('Партия вышла пустой') });
    expect(finishCollectionRound({ ...preview, round: 5 }, {
      candidates: 1, readyRows: 0, exhausted: false, canContinue: true, error: null,
    }).status).toBe('limited');
    expect(estimateRemainingReady({ population: 5_000, candidatesProcessed: 1_000, readyRows: 200, eligible: true, asOf: '2026-09-03' }))
      .toMatchObject({ contacts: 800, confidence: 'low' });
    expect(estimateRemainingReady({ population: 5_000, candidatesProcessed: 1_000, readyRows: 200, eligible: false, asOf: '2026-09-03' })).toBeNull();
    // Production regression: 1,071 previously consumed HH observations without
    // INNs/sites were selected again, inflating counters and buying another BC.
    const anonymous = Array.from({ length: 1_071 }, (_, i) => unifiedRow({ company: `Agency ${i}`, source_detail: 'hh' }));
    const repeatedInfo: VeCollectInfo = { ...collectInfo(anonymous), collection_mode: 'preview',
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 1071 },
      target_checkpoint: { completed_round: 1, seen_rows: anonymous.map(({ company, inn, email, website }) => ({ company, inn, email, website })) } };
    repeatedInfo.tasks![0].exhausted = true;
    const repeatedDb = seed(repeatedInfo);
    await runBaseCollectStage(makeJob(), { supabase: repeatedDb as unknown as SupabaseClient });
    expect(repeatedDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect((lastBasePatch(repeatedDb)?.collect_info as VeCollectInfo).target_progress?.candidates_processed).toBe(1071);
    const knownInn = unifiedRow({ company: 'Agency with missing site', inn: '7700000777', source_detail: 'реестр' });
    const recoveredInfo: VeCollectInfo = { ...collectInfo([knownInn]), collection_mode: 'preview',
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 1 },
      target_checkpoint: { completed_round: 1, seen_rows: [knownInn] } };
    recoveredInfo.tasks![0].exhausted = true;
    jest.mocked(fetchVeRelevanceEvidence).mockClear();
    jest.mocked(fetchVeRelevanceEvidence).mockResolvedValueOnce({ status: 'ok', text: 'Confirmed legal entity', url: 'https://found.test/', reason: 'discovered_verified_website' });
    const recoveredDb = seed(recoveredInfo);
    await runBaseCollectStage(makeJob(), { supabase: recoveredDb as unknown as SupabaseClient });
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    expect((recoveredDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).search_policy)
      .toMatchObject({ phase: 'paid', deferred_rows: [knownInn] });
    await recoveredDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await runBaseCollectStage(makeJob(), { supabase: recoveredDb as unknown as SupabaseClient });
    const recoveredInput = recoveredDb.getRows('base_constructor_jobs')[0].data as string[][];
    expect(recoveredInput).toHaveLength(2);
    expect(recoveredInput[1]).toContain('https://found.test/');

    // Cross-base exclusions must apply before paid site discovery, while the
    // same-base missing-site recovery above remains possible. Even a full
    // discovery wave of duplicates cannot postpone the fresh company.
    const excludedSources = Array.from({ length: 16 }, (_, i) => unifiedRow({
      company: `Already collected ${i}`, inn: String(7700000100 + i),
    }));
    const discoveryInfo: VeCollectInfo = { ...collectInfo([...excludedSources, knownInn]), collection_mode: 'preview',
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] }, target_progress: createCollectionTarget('preview') };
    const discoveryDb = seed(discoveryInfo, { ve_bases: [makeBase(discoveryInfo), {
      ...makeBase({}), id: 'other-ready', hypothesis_id: 'h2', status: 'analyzed',
      columns: [...VE_AUTO_COLLECT_COLUMNS],
      data: excludedSources.map((row) => ({ ...row, email: `ready@${row.inn}.test`, _email_status: 'ok' })),
    }] });
    jest.mocked(fetchVeRelevanceEvidence).mockClear().mockResolvedValueOnce({
      status: 'ok', text: 'Confirmed legal entity', url: 'https://found.test/', reason: 'discovered_verified_website',
    });
    await runBaseCollectStage(makeJob(), { supabase: discoveryDb as unknown as SupabaseClient });
    expect(fetchVeRelevanceEvidence).toHaveBeenCalledTimes(1);
    expect(fetchVeRelevanceEvidence).toHaveBeenCalledWith('', expect.objectContaining({ companyInn: knownInn.inn }));
    expect((discoveryDb.getRows('base_constructor_jobs')[0].data as string[][])).toHaveLength(2);

    // Production regression: thousands of paid lookups while the ready count
    // stayed unchanged. Cap the last wave to the remaining cohort and retain
    // source rows without routing empty failures into paid enrichment instead.
    for (const pipelined of [false, true]) {
      const budgetInfo: VeCollectInfo = { ...collectInfo([knownInn, ...excludedSources]), collection_mode: 'preview',
        // Автоматическое расширение среза уже израсходовано: проверяется остановка по добору сайтов.
        adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
        search_policy: { version: 1, phase: 'paid', deferred_rows: [knownInn] },
        target_progress: createCollectionTarget('preview'),
        source_contact_budget: { version: 2, checked_at_growth: 0, ready_high_water: 0, paused: false },
        source_contact_recovery: { version: 1, checked: Object.fromEntries(Array.from({ length: 119 }, (_, i) =>
          [`previous-${i}`, { website: '', reason: 'identity_unverified' }])) },
        ...(pipelined ? { preview_pipeline: { version: 1 as const, revision: 0, batches: [] } } : {}),
      };
      budgetInfo.tasks![0].exhausted = true;
      const budgetDb = seed(structuredClone(budgetInfo));
      jest.mocked(fetchVeRelevanceEvidence).mockClear().mockResolvedValueOnce({
        status: 'unavailable', text: '', url: '', reason: 'identity_unverified',
      });
      await runBaseCollectStage(makeJob(), { supabase: budgetDb as unknown as SupabaseClient });
      expect(fetchVeRelevanceEvidence).toHaveBeenCalledTimes(1);
      expect(budgetDb.getRows('base_constructor_jobs')).toHaveLength(0);
      const limited = budgetDb.getRows('ve_bases')[0];
      expect(limited).toMatchObject({ status: 'analyzed', row_count: 0, data: [], collect_info: {
        source_contact_budget: { paused: true }, target_progress: { status: 'limited', ready_target: 500,
          reason: expect.stringContaining('Добор сайтов закрыт') },
      } });
      expect((limited.collect_info as VeCollectInfo).tasks![0].harvest).toHaveLength(17);
      expect((limited.collect_info as VeCollectInfo).search_policy?.deferred_rows).toEqual([knownInn]);
      // An ordinary continuation reuses the existing preview; it cannot reset
      // this persisted allowance or silently purchase another collection.
      await enqueueVeBaseCollect(budgetDb as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
        verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000 });
      expect(budgetDb.getRows('ve_bases')).toHaveLength(1);

      // Finding the final site's URL is not itself success, but its paid-for
      // constructor must finish before the cohort can be judged unproductive.
      const inFlightInfo = structuredClone(budgetInfo);
      delete inFlightInfo.source_contact_recovery!.checked['previous-118'];
      const inFlightDb = seed(inFlightInfo);
      jest.mocked(fetchVeRelevanceEvidence).mockClear().mockResolvedValueOnce({
        status: 'unavailable', text: '', url: '', reason: 'identity_unverified',
      }).mockResolvedValueOnce({
        status: 'ok', text: 'Confirmed legal entity', url: 'https://found.test/', reason: 'verified',
      });
      await runBaseCollectStage(makeJob(), { supabase: inFlightDb as unknown as SupabaseClient });
      const child = inFlightDb.getRows('base_constructor_jobs')[0];
      expect(child).toBeDefined();
      expect(child.initial_row_count).toBe(1);
      await inFlightDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
      await runBaseCollectStage(makeJob(), { supabase: inFlightDb as unknown as SupabaseClient });
      expect(fetchVeRelevanceEvidence).toHaveBeenCalledTimes(2);
      expect(inFlightDb.getRows('base_constructor_jobs')).toHaveLength(1);
      expect(inFlightDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', collect_info: {
        source_contact_budget: { paused: false },
      } });
      // A website with no validated email does not reset the growth counter.
      await inFlightDb.from('base_constructor_jobs').update({ status: 'completed',
        data: [[...(child.data as string[][])[0], 'Email Статус']] }).eq('id', child.id);
      for (let wake = 0; wake < 2; wake++) {
        await inFlightDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        await runBaseCollectStage(makeJob(), { supabase: inFlightDb as unknown as SupabaseClient });
      }
      expect(fetchVeRelevanceEvidence).toHaveBeenCalledTimes(2);
      expect(inFlightDb.getRows('base_constructor_jobs')).toHaveLength(1);
      expect(inFlightDb.getRows('ve_bases')[0]).toMatchObject({ data: [], collect_info: {
        source_contact_budget: { paused: true }, target_progress: { status: 'limited', ready_rows: 0 },
      } });
    }

    // Empty site/email lanes do not mean the whole directory is exhausted.
    // Persist the phase switch, then read the original filters and search only
    // for the deficit. A restored worker must not restart the empty free lanes.
    const phasedInfo: VeCollectInfo = { ...collectInfo([]), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview') };
    phasedInfo.tasks![0].status = 'pending';
    const phasedDb = seed(phasedInfo);
    jest.mocked(searchRows).mockReset().mockImplementation(async (filters) => ({ rows: filters.hasWebsite || filters.hasEmail
      ? [] : [{ name: knownInn.company, inn: knownInn.inn, website: '', email: '' }] }));
    jest.mocked(fetchVeRelevanceEvidence).mockClear().mockResolvedValueOnce({
      status: 'ok', text: 'Confirmed legal entity', url: 'https://found.test/', reason: 'discovered_verified_website',
    });
    await runBaseCollectStage(makeJob(), { supabase: phasedDb as unknown as SupabaseClient });
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    expect(searchRows).toHaveBeenCalledTimes(2);
    // Сначала компании с готовым адресом (контакт без обхода сайта и без
    // SMTP-очереди), затем добор по сайту.
    expect(jest.mocked(searchRows).mock.calls.map(([filters]) => [!!filters.hasWebsite, !!filters.hasEmail]))
      .toEqual([[false, true], [true, false]]);
    expect((phasedDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).search_policy?.phase).toBe('paid');
    await phasedDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await runBaseCollectStage(makeJob(), { supabase: phasedDb as unknown as SupabaseClient });
    expect(searchRows).toHaveBeenCalledTimes(3);
    expect(jest.mocked(searchRows).mock.calls.at(-1)?.[0]).toEqual(DIRECTORY_TASK.directory_filters);
    // Первый заход каждого набора фильтров начинается с нуля.
    expect(jest.mocked(searchRows).mock.calls.map(([, , offset]) => offset ?? 0)).toEqual([0, 0, 0]);
    // Закладка выдачи сохранена только там, где реально что-то просканировано:
    // пустые бесплатные лейны её не создают, платный — создаёт. Без закладки
    // следующий заход снова начинал бы с первой страницы и однажды упирался
    // в потолок сканирования навсегда.
    const scannedTask = (phasedDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0];
    expect(Object.values(scannedTask.directory_cursors ?? {})).toEqual([1]);
    expect(fetchVeRelevanceEvidence).toHaveBeenCalledTimes(1);
    expect(phasedDb.getRows('base_constructor_jobs')).toHaveLength(1);

    // The small cohort must reach the actual constructor and publish checked
    // rows while the same base continues collecting. Old runs retain their
    // original input scope across a deployment.
    jest.mocked(fetchVeRelevanceEvidence).mockClear();
    const harvest = Array.from({ length: 1_200 }, (_, i) => unifiedRow({
      company: `Clinic ${i}`, website: `clinic-${i}.test`, email: `mail@clinic-${i}.test`,
    }));
    for (const legacy of [false, true]) {
      const target = { ...createCollectionTarget('preview') };
      if (legacy) {
        delete target.first_round_candidates;
        target.ready_target = 1_000;
      }
      const db = seed({ ...collectInfo([...harvest, knownInn]), collection_mode: 'preview', target_progress: target });
      await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
      const constructor = db.getRows('base_constructor_jobs')[0];
      expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).search_policy?.phase).toBe('existing');
      expect((stripTaskHarvest(db.getRows('ve_bases')[0]).collect_info as VeCollectInfo).search_policy).not.toHaveProperty('deferred_rows');
      expect(constructor.workload_origin).toBe('automation');
      const expected = legacy ? 1_200 : 100;
      const expectedReady = legacy ? 1_200 : 20;
      const input = constructor.data as string[][];
      expect(input).toHaveLength(expected + 1);
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.ready_target)
        .toBe(legacy ? 1_000 : 500);
      await db.from('base_constructor_jobs').update({ status: 'completed',
        data: [[...input[0], 'Email Статус'], ...input.slice(1).map((row, index) =>
          [...row, legacy || index < expectedReady ? 'ok' : 'invalid'])],
      }).eq('id', constructor.id);
      await db.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
      await expect(runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }))
        .resolves.toMatchObject({ result: legacy ? { target_status: 'target_reached' }
          : { waiting: true, target_status: 'collecting' } });
      const base = db.getRows('ve_bases')[0];
      expect(base).toMatchObject({ status: legacy ? 'analyzing' : 'collecting', row_count: expectedReady });
      expect((base.collect_info as VeCollectInfo).target_progress).toMatchObject({
        round: legacy ? 1 : 2, ready_rows: expectedReady, candidates_processed: expected,
        first_round_candidates: legacy ? 2_000 : 100,
        ready_target: 500,
      });
      expect(base.sample_rows).toHaveLength(Math.min(30, expectedReady));
      expect(prepareSegmentationAudience({ rows: base.sample_rows as Record<string, unknown>[],
        columns: base.columns as string[], source: 'auto' }).rows).toHaveLength(Math.min(30, expectedReady));
      if (!legacy) {
        jest.mocked(searchRows).mockResolvedValue({ rows: Array.from({ length: 480 }, (_, i) => ({
          name: `Clinic Next ${i}`, website: `next-${i}.test`, email: `mail@next-${i}.test`,
        })) });
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
        for (let tick = 0; tick < 10 && db.getRows('ve_bases')[0].status === 'collecting'; tick++) {
          const nextConstructor = db.getRows('base_constructor_jobs').find((row) => row.status === 'pending');
          if (nextConstructor) {
            const nextInput = nextConstructor.data as string[][];
            expect(nextInput.length).toBeLessThanOrEqual(101);
            await db.from('base_constructor_jobs').update({ status: 'completed',
              data: [[...nextInput[0], 'Email Статус'], ...nextInput.slice(1).map((row) => [...row, 'ok'])],
            }).eq('id', nextConstructor.id);
          }
          await db.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
          await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
        }
        const completed = db.getRows('ve_bases')[0];
        expect(completed).toMatchObject({ status: 'analyzing', row_count: 516 });
        expect(prepareSegmentationAudience({ rows: completed.data as Record<string, unknown>[],
          columns: completed.columns as string[], source: 'auto' }).rows).toHaveLength(516);
        expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
        expect((completed.collect_info as VeCollectInfo).search_policy?.phase).toBe('existing');
        // The original harvest's unused tail supplies later batches.
        expect(new Set((completed.data as Array<{ email: string }>).map((row) => row.email)).size).toBe(516);
        const adaptive = (completed.collect_info as VeCollectInfo).adaptive_collection!;
        expect(adaptive.completed.map((batch) => batch.new_ready)).toEqual([20, 100, 100, 100, 100, 96]);
        expect(stripTaskHarvest(completed).collect_info).toMatchObject({ adaptive_collection: { completed_batches: 6 } });
        expect((stripTaskHarvest(completed).collect_info as VeCollectInfo).adaptive_collection).not.toHaveProperty('pending');
      }
    }

    // Real scheduler at 499/500: reserve a useful cohort in both collector
    // paths, then persist Retry-After without buying another constructor.
    for (const pipeline of [false, true]) {
      const ready = harvest.slice(0, 499).map((row) => ({ ...row, _email_status: 'ok',
        _ve_company_name: { version: 1, source: row.company, website: row.website, status: 'ready', value: row.company } }));
      const near: VeCollectInfo = { ...collectInfo(harvest.slice(499, 700)), collection_mode: 'preview',
        adaptive_collection: newVeAdaptiveCollection(),
        target_progress: { ...createCollectionTarget('preview'), round: 20, ready_rows: 499, candidates_processed: 2200 },
        target_checkpoint: { completed_round: 19, seen_rows: ready },
        ...(pipeline ? { preview_pipeline: { version: 1 as const, revision: 0, batches: [], job_ids: ['old-child'] } } : {}),
      };
      const nearDb = seed(near);
      // Repeated wakes must cross the real JSON boundary: the generic mock
      // otherwise aliases nested collect_info writes with live stage objects.
      const from = nearDb.from.bind(nearDb);
      nearDb.from = (table) => {
        const query = from(table);
        if (table === 've_bases') {
          const update = query.update.bind(query);
          query.update = (patch) => update(structuredClone(patch));
          const single = query.single.bind(query);
          query.single = async () => structuredClone(await single());
        }
        return query;
      };
      await nearDb.from('ve_bases').update({ data: ready, row_count: ready.length, columns: [...VE_AUTO_COLLECT_COLUMNS] }).eq('id', 'b1');
      const wake = async () => {
        await nearDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        return runBaseCollectStage(nearDb.getRows('ve_jobs')[0] as unknown as VeJob, { supabase: nearDb as unknown as SupabaseClient });
      };
      await wake();
      const child = nearDb.getRows('base_constructor_jobs')[0];
      expect((child.data as string[][])).toHaveLength(51);
      const grid = child.data as string[][];
      await nearDb.from('base_constructor_jobs').update({ status: 'completed', data: [
        [...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, 'ok']),
      ] }).eq('id', child.id);
      const retryAt = Date.now() + 180_000;
      const checkpoint = { version: 2, context_hash: 'a'.repeat(64), verdicts: {}, website_evidence: {},
        citation_repairs: {}, semantic_reviews: {}, semantic_review_refs: {}, failures: [] };
      for (const deferred of [false, true]) {
        mockFindIrrelevantRows.mockResolvedValueOnce({ flagged: new Set(), unchecked: new Set([0]),
          coverage: { checkedCompanies: 0, totalCompanies: 50, complete: false }, tokensUsed: 0, costUsd: 0,
          checkpoint, error: 'Requesty 429: retry later', retryable: true, rateLimit: { retryAt, deferred } });
        await expect(wake()).resolves.toMatchObject({ result: { waiting: true } });
        const waiting = nearDb.getRows('ve_jobs')[0];
        expect(waiting.status).toBe('pending');
        expect(new Date(waiting.run_after as string).getTime()).toBeGreaterThanOrEqual(retryAt);
        expect((waiting.result as { relevance_retry: { attempts: number } }).relevance_retry.attempts).toBe(1);
        expect(nearDb.getRows('ve_bases')[0].status).toBe('collecting');
        expect(nearDb.getRows('base_constructor_jobs')).toHaveLength(1);
      }
      await wake();
      expect(nearDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzing', row_count: 549 });
      expect(nearDb.getRows('base_constructor_jobs')).toHaveLength(1);
    }

    // Real scheduler: two poor completed batches switch to another saved
    // source, keep the first source's remainder and don't replay paid children.
    const alternativeRows = harvest.slice(300, 500).map((row) => ({ ...row, company: `Alternative ${row.company}` }));
    const switching: VeCollectInfo = { ...collectInfo(harvest.slice(0, 300)), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview'), preview_pipeline: { version: 1, revision: 0, batches: [] } };
    const otherTask = { ...DIRECTORY_TASK, directory_filters: { okvedCodes: ['86.2'] } };
    switching.tasks!.push({ source: 'companies_directory', task: otherTask, status: 'done', child_job_id: null,
      rows: alternativeRows.length, harvest: alternativeRows, exhausted: true });
    const switchDb = seed(switching);
    const switchWake = async () => {
      await switchDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
      return runBaseCollectStage(makeJob(), { supabase: switchDb as unknown as SupabaseClient });
    };
    for (let round = 0; round < 2; round++) {
      await switchWake();
      const child = switchDb.getRows('base_constructor_jobs').find((row) => row.status === 'pending')!;
      expect(child).toBeDefined();
      const count = switchDb.getRows('base_constructor_jobs').length;
      await switchWake();
      expect(switchDb.getRows('base_constructor_jobs')).toHaveLength(count);
      const grid = child.data as string[][];
      expect(grid).toHaveLength(101);
      await switchDb.from('base_constructor_jobs').update({ status: 'completed', data: [
        [...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, 'ok']),
      ] }).eq('id', child.id);
      mockFindIrrelevantRows.mockResolvedValueOnce({ flagged: new Set(Array.from({ length: 100 }, (_, i) => i)),
        unchecked: new Set(), coverage: { checkedCompanies: 100, totalCompanies: 100, complete: true }, tokensUsed: 0, costUsd: 0 });
      await switchWake();
      const current = switchDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(current.adaptive_collection?.completed).toHaveLength(round + 1);
      expect(current.adaptive_collection?.replan_needed).toBe(round === 1);
    }
    await switchWake();
    const switched = switchDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(switched.adaptive_collection).toMatchObject({ active_source: veSourceStrategyKey(otherTask), switches: 1 });
    const newChild = switchDb.getRows('base_constructor_jobs').find((row) => row.status === 'pending')!;
    expect((newChild.data as string[][])[1][0]).toContain('Alternative');
    expect(switched.tasks![0].harvest).toHaveLength(300);
    expect(switched.adaptive_collection?.completed.map((result) => result.new_ready)).toEqual([0, 0]);
    expect((stripTaskHarvest(switchDb.getRows('ve_bases')[0]).collect_info as VeCollectInfo).adaptive_collection).not.toHaveProperty('pending');

    // With no untried source, replan once, preserve original restrictions and
    // invalidate the old single-population forecast. Pending retries reuse it.
    const replanning = structuredClone(switched);
    delete replanning.construct;
    replanning.preview_pipeline!.batches = [];
    delete replanning.preview_pipeline!.active_batch_id;
    replanning.tasks = [replanning.tasks![0]];
    replanning.plan = { tasks: [DIRECTORY_TASK] };
    delete replanning.adaptive_collection!.pending;
    replanning.adaptive_collection!.active_source = veSourceStrategyKey(DIRECTORY_TASK);
    replanning.adaptive_collection!.replan_needed = true;
    const replanDb = seed(replanning);
    const proposed = { ...DIRECTORY_TASK, directory_filters: { okvedCodes: ['86.3'], includeIp: true } };
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce({ data: { tasks: [proposed] }, tokensUsed: 10, costUsd: 0.01,
      promptTokens: 5, completionTokens: 5, rawResponse: '' });
    jest.mocked(searchRows).mockResolvedValue({ rows: [{ name: 'New slice clinic', website: 'new-slice.test', email: 'hello@new-slice.test' }] });
    await runBaseCollectStage(makeJob(), { supabase: replanDb as unknown as SupabaseClient });
    const replanned = replanDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    const expectedTask = { ...proposed, directory_filters: { ...proposed.directory_filters, includeIp: false } };
    expect(replanned.tasks?.at(-1)?.task).toEqual(expectedTask);
    expect(replanned.adaptive_collection).toMatchObject({ replan_attempts: 1, active_source: veSourceStrategyKey(expectedTask) });
    // Размер пересчитан одним вызовом по объединению прежнего и нового срезов;
    // прежний прогноз к новому плану не переносится.
    expect(replanned.estimate?.remaining_ready_estimate ?? null).toBeNull();
    expect(replanDb.rpcCalls.filter((call) => call.fn === 've_directory_plan_population').at(-1)?.params.p_slices).toHaveLength(2);
    const planCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
    expect(jest.mocked(callLLMWithSchema).mock.calls.at(-1)?.[2]).toEqual({ model: 'test-collection-model' });
    await replanDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await runBaseCollectStage(makeJob(), { supabase: replanDb as unknown as SupabaseClient });
    expect(callLLMWithSchema).toHaveBeenCalledTimes(planCalls);
    expect(replanDb.getRows('base_constructor_jobs')).toHaveLength(1);

    // In paid phase, an empty first source must not terminate a base while a
    // saved alternative is still pending (and was deliberately not dispatched).
    const emptyFirst: VeCollectInfo = { ...collectInfo([]), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview'), search_policy: { version: 1, phase: 'paid', deferred_rows: [] } };
    emptyFirst.tasks![0].status = 'pending';
    emptyFirst.tasks!.push({ source: otherTask.source, task: otherTask, status: 'pending', child_job_id: null, rows: 0 });
    const emptyFirstDb = seed(emptyFirst);
    jest.mocked(searchRows).mockResolvedValue({ rows: [] });
    await expect(runBaseCollectStage(makeJob(), { supabase: emptyFirstDb as unknown as SupabaseClient }))
      .resolves.toMatchObject({ result: { waiting: true, next_source: 'companies_directory' } });
    expect(emptyFirstDb.getRows('ve_bases')[0].status).toBe('collecting');
    expect((emptyFirstDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).adaptive_collection?.active_source)
      .toBe(veSourceStrategyKey(otherTask));

    // Slow saved-email/relevance review must not leave both constructor slots
    // empty for an hour. Repeated wakes keep the same reserved children; a
    // manual saved-only review, error or reached goal must buy no new batch.
    for (const mode of ['automatic', 'manual', 'failed', 'target', 'last_round'] as const) {
      const round = mode === 'last_round' ? 100 : 2;
      const reviewing: VeCollectInfo = { ...collectInfo(harvest.slice(0, 600)), collection_mode: 'preview',
        relevance_review_requested: true,
        target_progress: { ...createCollectionTarget('preview'), round, candidates_processed: 200,
          ready_rows: mode === 'target' ? 500 : 0 },
        target_checkpoint: { completed_round: round, seen_rows: harvest.slice(0, 200) },
        relevance_reserve: { version: 1, rows: [{ ...harvest[0], _email_status: 'unknown' }] },
        preview_pipeline: { version: 1, revision: 0, batches: [], completed_batches: 1, job_ids: ['previous-batch'],
          ...(mode === 'failed' ? { error: 'Previous batch failed' } : {}) } };
      const db = seed(reviewing);
      const job = { ...makeJob(), payload: { ...makeJob().payload, ...(mode === 'manual' ? { review_relevance: true } : {}) } };
      for (let wake = 0; wake < 2; wake++) {
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', job.id);
        await runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient });
      }
      const children = db.getRows('base_constructor_jobs');
      const prefetched = children.filter((child) => (child.selected_steps as string[]).includes('find_emails'));
      expect(prefetched).toHaveLength(mode === 'automatic' ? 2 : 0);
      expect(children.filter((child) => (child.selected_steps as string[]).length === 1)).toHaveLength(1);
      const after = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(after.preview_pipeline?.active_batch_id).toBeUndefined();
      expect(after.target_progress?.candidates_processed).toBe(200);
      expect(db.getRows('ve_bases')[0].row_count).toBe(0);
      if (mode === 'automatic') {
        const emails = prefetched.flatMap((child) => {
          const grid = child.data as string[][];
          return grid.slice(1).map((row) => row[grid[0].indexOf('Email')]);
        });
        expect(emails).toHaveLength(400);
        expect(new Set(emails).size).toBe(400);
        expect(emails).not.toContain(harvest[0].email);
        expect(after.search_policy?.phase).toBe('existing');
        // Once the saved check finishes, consume the prefetched output through
        // normal gates exactly once, preserving its ready/candidate counters.
        const emailChild = children.find((child) => (child.selected_steps as string[]).length === 1)!;
        const emailGrid = emailChild.data as string[][];
        await db.from('base_constructor_jobs').update({ status: 'completed', data: [
          [...emailGrid[0], 'Email Статус'], ...emailGrid.slice(1).map((row) => [...row, 'unknown']),
        ] }).eq('id', emailChild.id);
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', job.id);
        await runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient });
        const grid = prefetched[0].data as string[][];
        await db.from('base_constructor_jobs').update({ status: 'completed', data: [
          [...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, 'ok']),
        ] }).eq('id', prefetched[0].id);
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', job.id);
        await runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient });
        expect(db.getRows('base_constructor_jobs')).toHaveLength(3);
        expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
          .toMatchObject({ candidates_processed: 400, ready_rows: 200 });
      }
    }

    // New previews overlap sources and durable constructor batches. An old
    // slow batch cannot block checked output from its completed neighbours.
    for (const failFirst of [false, true]) {
      const fastInfo: VeCollectInfo = { ...collectInfo(harvest), collection_mode: 'preview',
        target_progress: createCollectionTarget('preview'),
        preview_pipeline: { version: 1, revision: 0, batches: [] } };
      fastInfo.tasks!.push({ source: 'hh_live', status: 'dispatched', child_job_id: 'slow-hh', rows: 0,
        task: { source: 'hh_live', rationale: 'Parallel source', hh_query: { text: 'клиники' } },
        dispatched_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString() });
      const db = seed(fastInfo, { parser_jobs: [{ id: 'slow-hh', status: failFirst ? 'processing' : 'pending',
        started_at: failFirst ? new Date().toISOString() : null }] });
      const wake = async () => {
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        return runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
      };
      const finishChild = async (id: unknown, failed = false) => {
        const child = db.getRows('base_constructor_jobs').find((row) => row.id === id)!;
        const input = child.data as string[][];
        await db.from('base_constructor_jobs').update({ status: failed ? 'failed' : 'completed',
          data: [[...input[0], 'Email Статус'], ...input.slice(1).map((row) => [...row, failed ? 'invalid' : 'ok'])] }).eq('id', id);
      };
      await wake();
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks?.find((task) => task.child_job_id === 'slow-hh'))
        .toMatchObject({ status: 'dispatched' });
      const children = db.getRows('base_constructor_jobs');
      expect(children).toHaveLength(2);
      expect(children.every((row) => (row.data as string[][]).length === 101)).toBe(true);
      expect(children[0].step_config).toMatchObject({ queue_class: 'interactive_preview',
        find_emails: { reuse_website_description: true, stop_at_first: false, max_per_site: 6 } });
      const slowId = children[0].id;
      const completedId = children[1].id;
      await finishChild(completedId, failFirst);
      // Simulate death after child INSERT committed, before the parent saved
      // its acknowledgement. Replaying the reservation must preserve output.
      const parentInfo = structuredClone(db.getRows('ve_bases')[0].collect_info) as VeCollectInfo;
      parentInfo.preview_pipeline!.batches[1].inserted = false;
      await db.from('ve_bases').update({ collect_info: parentInfo }).eq('id', 'b1');
      await wake();
      expect(db.getRows('base_constructor_jobs')).toHaveLength(2);
      expect(db.getRows('base_constructor_jobs')[1].status).toBe(failFirst ? 'failed' : 'completed');
      expect(db.getRows('ve_bases')[0].row_count).toBe(failFirst ? 0 : 100);
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).preview_pipeline!.batches.map((batch) => batch.id)).toEqual([slowId]);
      if (!failFirst) {
        for (let tick = 0; tick < 12 && ((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.ready_rows ?? 0) < 500; tick++) {
          const next = db.getRows('base_constructor_jobs').find((row) => row.id !== slowId && row.status === 'pending');
          if (next) await finishChild(next.id);
          await wake();
        }
        expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.ready_rows).toBe(500);
        const purchased = db.getRows('base_constructor_jobs').length;
        await wake();
        expect(db.getRows('base_constructor_jobs')).toHaveLength(purchased);
      }
      await finishChild(slowId);
      await wake();
      const result = db.getRows('ve_bases')[0];
      expect(result.status).toBe(failFirst ? 'failed' : 'analyzing');
      const rows = prepareSegmentationAudience({ rows: result.data as Record<string, unknown>[],
        columns: result.columns as string[], source: 'auto' }).rows;
      expect(rows).toHaveLength(failFirst ? 100 : 600);
      expect(new Set(rows.map((row) => row.email)).size).toBe(rows.length);
      expect((result.collect_info as VeCollectInfo).preview_pipeline!.batches).toEqual([]);
      expect((result.collect_info as VeCollectInfo).target_progress).toMatchObject({
        candidates_processed: failFirst ? 200 : 600, status: failFirst ? 'error' : 'target_reached',
      });
      expect(db.getRows('base_constructor_jobs').every((row) => row.status !== 'pending')).toBe(true);
      expect(stripTaskHarvest(result).collect_info).not.toHaveProperty('preview_pipeline');
      if (failFirst) {
        const timeoutInfo = structuredClone(result.collect_info) as VeCollectInfo;
        const queuedTask = timeoutInfo.tasks!.find((task) => task.child_job_id === 'slow-hh')!;
        queuedTask.status = 'failed';
        queuedTask.error = 'timeout: дочерняя джоба зависла';
        await db.from('ve_bases').update({ collect_info: timeoutInfo }).eq('id', 'b1');
        await db.from('ve_jobs').update({ status: 'failed' }).eq('id', makeJob().id);
        const resumed = await enqueueVeBaseCollect(db as unknown as SupabaseClient, {
          projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name,
          hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000,
        });
        expect(resumed).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
        expect(db.getRows('ve_bases')).toHaveLength(1);
        const recoveredInfo = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
        expect(recoveredInfo).toMatchObject({ relevance_review_requested: true, validation_retry: true });
        expect(recoveredInfo.tasks?.find((task) => task.child_job_id === 'slow-hh')).toMatchObject({ status: 'dispatched' });
        expect(recoveredInfo.tasks?.find((task) => task.child_job_id === 'slow-hh')).not.toHaveProperty('error');
        expect(recoveredInfo.preview_pipeline).not.toHaveProperty('error');
        expect(db.getRows('base_constructor_jobs')).toHaveLength(2);
        const retry = db.getRows('ve_jobs').find((row) => row.id !== makeJob().id && row.stage === 'base_collect')!;
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', retry.id);
        await runBaseCollectStage({ ...makeJob(), id: retry.id as string, payload: retry.payload as VeJob['payload'] },
          { supabase: db as unknown as SupabaseClient });
        expect(db.getRows('base_constructor_jobs')).toHaveLength(2);
        expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
          .toMatchObject({ candidates_processed: 200, ready_rows: 100, status: 'collecting' });
      }
    }

    const raceInfo: VeCollectInfo = { ...collectInfo(harvest.slice(0, 2)), collection_mode: 'preview',
      // Расширение среза уже израсходовано: проверяется гонка ревизий, а не исчерпание.
      adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
      target_progress: createCollectionTarget('preview'), preview_pipeline: { version: 1, revision: 0, batches: [] } };
    raceInfo.tasks![0].exhausted = true;
    const raceDb = seed(raceInfo);
    await runBaseCollectStage(makeJob(), { supabase: raceDb as unknown as SupabaseClient });
    const raceChild = raceDb.getRows('base_constructor_jobs')[0];
    const raceGrid = raceChild.data as string[][];
    await raceDb.from('base_constructor_jobs').update({ status: 'completed',
      data: [[...raceGrid[0], 'Email Статус'], ...raceGrid.slice(1).map((row) => [...row, 'ok'])] }).eq('id', raceChild.id);
    const classify = mockFindIrrelevantRows.getMockImplementation()!;
    let winnerInfo: VeCollectInfo | undefined;
    mockFindIrrelevantRows.mockImplementationOnce(async (input) => {
      const newer = structuredClone(raceDb.getRows('ve_bases')[0].collect_info) as VeCollectInfo;
      newer.preview_pipeline!.revision++;
      winnerInfo = structuredClone(newer);
      await raceDb.from('ve_bases').update({ collect_info: newer }).eq('id', 'b1');
      return classify(input);
    });
    await raceDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await expect(runBaseCollectStage(makeJob(), { supabase: raceDb as unknown as SupabaseClient }))
      .rejects.toBeInstanceOf(VePreviewCheckpointConflict);
    expect(raceDb.getRows('ve_bases')[0].data).toEqual([]);
    expect(raceDb.getRows('ve_bases')[0].collect_info).toEqual(winnerInfo);
    await raceDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await runBaseCollectStage(makeJob(), { supabase: raceDb as unknown as SupabaseClient });
    expect(raceDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect((raceDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
      .toMatchObject({ ready_rows: 2, candidates_processed: 2, status: 'exhausted' });

    const rolling = seed({ ...collectInfo(harvest, { bc_job_id: 'old-worker-child', status: 'dispatched' }),
      collection_mode: 'preview', target_progress: createCollectionTarget('preview'),
      preview_pipeline: { version: 1, revision: 0, batches: [] } },
    { base_constructor_jobs: [{ id: 'old-worker-child', status: 'pending' }] });
    await runBaseCollectStage(makeJob(), { supabase: rolling as unknown as SupabaseClient });
    expect(rolling.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(rolling.getRows('ve_bases')[0].collect_info).not.toHaveProperty('preview_pipeline');

    const stopInfo: VeCollectInfo = { ...collectInfo(harvest.slice(0, 2)), collection_mode: 'preview',
      // Расширение среза уже израсходовано: проверяется остановка воркера, а не исчерпание.
      adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
      target_progress: createCollectionTarget('preview'), preview_pipeline: { version: 1, revision: 0, batches: [] } };
    stopInfo.tasks![0].exhausted = true;
    const stopDb = seed(stopInfo);
    const controller = new AbortController();
    const shutdown = createVeJobShutdown({ abort: controller, graceMs: 1000, onDeadline: jest.fn() });
    try {
      await expect(runBaseCollectStage(makeJob(), { supabase: stopDb as unknown as SupabaseClient,
        signal: controller.signal, onCheckpoint: () => {
          // SIGTERM after child INSERT: acknowledge its durable identity before yielding.
          if (stopDb.getRows('base_constructor_jobs').length) shutdown.request();
          shutdown.checkpoint();
        } })).rejects.toBeInstanceOf(VeWorkerShutdownError);
    } finally { shutdown.stop(); }
    const savedChild = stopDb.getRows('base_constructor_jobs')[0];
    expect((stopDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).preview_pipeline!.batches[0])
      .toMatchObject({ id: savedChild.id, inserted: true });
    expect(stopDb.getRows('ve_jobs')[0]).toMatchObject({ status: 'running' });
    expect(stopDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting' });
    const savedGrid = savedChild.data as string[][];
    await stopDb.from('base_constructor_jobs').update({ status: 'completed',
      data: [[...savedGrid[0], 'Email Статус'], ...savedGrid.slice(1).map(row => [...row, 'ok'])] }).eq('id', savedChild.id);
    const stopAfterGate = new AbortController();
    const gateShutdown = createVeJobShutdown({ abort: stopAfterGate, graceMs: 1000, onDeadline: jest.fn() });
    mockFindIrrelevantRows.mockImplementationOnce(async input => { gateShutdown.request(); return classify(input); });
    try {
      await expect(runBaseCollectStage(makeJob(), { supabase: stopDb as unknown as SupabaseClient,
        signal: stopAfterGate.signal, onCheckpoint: gateShutdown.checkpoint })).rejects.toBeInstanceOf(VeWorkerShutdownError);
    } finally { gateShutdown.stop(); }
    const classifiedCalls = mockFindIrrelevantRows.mock.calls.length;
    expect(stopDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: 2 });
    await runBaseCollectStage(makeJob(), { supabase: stopDb as unknown as SupabaseClient });
    expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(classifiedCalls);
    expect(stopDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect((stopDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
      .toMatchObject({ ready_rows: 2, candidates_processed: 2, status: 'exhausted' });
  });

  it('resumes a supply target from committed ready rows without revalidating the previous round', async () => {
    const first = unifiedRow({ company: 'Clinic First', website: 'first.test', email: 'ready@first.test' });
    const bad = unifiedRow({ company: 'Clinic Bad', website: 'bad.test', email: 'bad@bad.test' });
    const info = {
      ...collectInfo([first, bad], { bc_job_id: 'bc-first', status: 'dispatched' }),
      collection_mode: 'supply' as const,
      ready_target: 2,
    };
    const db = seed(info, { base_constructor_jobs: [{
      id: 'bc-first', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
      data: [
        ['Компания', 'Сайт', 'Email', 'Email Статус'],
        [first.company, first.website, first.email, 'ok'],
        [bad.company, bad.website, bad.email, 'invalid'],
      ],
    }] });
    const job = { ...makeJob(), payload: { ...makeJob().payload, collection_mode: 'supply', ready_target: 2 } };
    await expect(runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient }))
      .resolves.toMatchObject({ result: { waiting: true, target_status: 'collecting' } });
    const checkpoint = db.getRows('ve_bases')[0];
    expect(checkpoint).toMatchObject({ status: 'collecting', row_count: 1 });
    expect((checkpoint.collect_info as VeCollectInfo).construct).toBeUndefined();
    expect((checkpoint.collect_info as VeCollectInfo).target_progress).toMatchObject({ round: 2, ready_rows: 1 });

    jest.mocked(searchRows).mockResolvedValue({ rows: [
      { name: first.company, email: first.email, website: first.website },
      { name: bad.company, email: bad.email, website: bad.website },
      { name: 'Clinic Next', email: 'next@next.test', website: 'next.test' },
    ] });
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', job.id);
    await runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient });
    const constructor = db.getRows('base_constructor_jobs').find((row) => row.id !== 'bc-first')!;
    expect(constructor.data).not.toEqual(expect.arrayContaining([expect.arrayContaining([first.company])]));
    await db.from('base_constructor_jobs').update({
      status: 'completed', data: [
        ['Компания', 'Сайт', 'Email', 'Email Статус'],
        ['Clinic Next', 'next.test', 'next@next.test', 'ok'],
      ],
    }).eq('id', constructor.id);
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', job.id);
    await runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient });
    const completed = db.getRows('ve_bases')[0];
    expect(completed).toMatchObject({ status: 'analyzed', row_count: 2 });
    expect((completed.collect_info as VeCollectInfo).target_progress).toMatchObject({ status: 'target_reached', ready_rows: 2 });
    expect((completed.data as Array<Record<string, unknown>>).map((row) => row.email)).toEqual(['ready@first.test', 'next@next.test']);
    expect(mockFindIrrelevantRows.mock.calls.map(([input]) => input.rows.map((row: VeUnifiedRow) => row.email)))
      .toEqual([['ready@first.test'], ['next@next.test']]);
    expect(db.inserts.filter((entry) => entry.table === 've_jobs')).toEqual([]);

    // Legacy supply failures can have a done parent and a CLOSED round. The
    // explicit SQL repair reopens those same IDs with this saved-review marker.
    // Recheck only the unfinished verdict: no replacement source/SMTP batch and
    // no second accounting of the 6,753 already processed candidates.
    for (const collectionMode of ['supply', 'preview'] as const) for (const bounded of [false, true]) {
      const savedReady = { ...first, _email_status: 'ok', _ve_relevance: {
        version: 2, status: 'relevant', reason: 'Confirmed clinic', context_hash: 'a'.repeat(64),
        evidence: [{ field: 'description', quote: 'Clinic' }],
      }, _ve_company_name: { version: 1, status: 'ready', value: first.company, source: first.company, website: first.website } };
      const pending = { ...unifiedRow({ company: 'Saved Pending Clinic', website: 'pending.test', email: 'mail@pending.test' }),
        _email_status: 'ok', _relevance_unchecked: true };
      const round = bounded ? 5 : 71;
      const maxRounds = bounded ? 5 : collectionMode === 'preview' ? 102 : 100;
      const readyTarget = collectionMode === 'preview' ? 500 : bounded ? 3 : 2;
      const resumeInfo: VeCollectInfo = {
        ...collectInfo([first, pending], { bc_job_id: 'bc-billing-complete', status: 'done' }),
        collection_mode: collectionMode, ...(collectionMode === 'supply' ? { supply_batch_id: 'supply-saved' } : {}), ready_target: readyTarget,
        adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
        target_progress: { ...createCollectionTarget(collectionMode, readyTarget),
          round, max_rounds: maxRounds, max_candidates: 10_000, candidates_processed: 6753, ready_rows: 1 },
        target_checkpoint: { completed_round: round, seen_rows: [first, pending], processed_rows: 10475 },
        relevance_review_requested: true,
        relevance_reserve: { version: 1, rows: [savedReady, pending] },
        ...(collectionMode === 'supply' ? { supply_billing_resume: { version: 1 as const, batch_id: 'supply-saved', job_id: 'job-1',
          blocked_at: '2026-08-30T00:00:00Z', resumed_at: '2026-08-31T00:00:00Z',
          max_rounds: maxRounds, max_candidates: 10_000 } } : {
          preview_billing_resume: { version: 1 as const, job_id: 'job-1', blocked_at: '2026-08-30T00:00:00Z',
            resumed_at: '2026-08-31T00:00:00Z', max_rounds: maxRounds, max_candidates: 10_000 },
          preview_pipeline: { version: 1 as const, revision: 1546, batches: [], completed_batches: 1, job_ids: ['bc-billing-complete'] },
        }),
      };
      resumeInfo.tasks![0].exhausted = !bounded;
      resumeInfo.tasks![0].directory_cursors = { saved_lane: 9000 };
      const resumeJob = { ...makeJob(), payload: { ...makeJob().payload,
        collection_mode: collectionMode, ...(collectionMode === 'supply' ? { supply_batch_id: 'supply-saved' } : {}) }, attempts: 0 };
      const paidChild = { id: 'bc-billing-complete', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'Email Статус'],
          [first.company, first.website, first.email, 'ok'], [pending.company, pending.website, pending.email, 'ok']] };
      const resumeDb = seed(resumeInfo, {
        ve_bases: [{ ...makeBase(resumeInfo), data: [savedReady], row_count: 1, columns: [...VE_AUTO_COLLECT_COLUMNS] }],
        ve_jobs: [resumeJob as unknown as Record<string, unknown>],
        ve_contact_supply_batches: collectionMode === 'supply' ? [{ id: 'supply-saved', plan_id: 'supply-plan', base_id: 'b1', status: 'collecting' }] : [],
        base_constructor_jobs: [structuredClone(paidChild)],
      });
      const originalRpc = resumeDb.rpc;
      let active = false;
      resumeDb.rpc = (name, params) => name === 've_require_contact_supply_active'
        ? Promise.resolve(active ? { data: { id: 'supply-plan' }, error: null }
          : { data: null, error: { message: 'supply plan is not active (paused or stopped)' } })
        : originalRpc(name, params);
      const sourceCalls = jest.mocked(searchRows).mock.calls.length;
      const gateCalls = mockFindIrrelevantRows.mock.calls.length;
      if (collectionMode === 'supply') {
        await expect(runBaseCollectStage(resumeJob, { supabase: resumeDb as unknown as SupabaseClient }))
          .resolves.toMatchObject({ result: { supply_held: true } });
        expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(gateCalls);
      }
      active = true;
      await resumeDb.from('ve_jobs').update({ status: 'running' }).eq('id', resumeJob.id);
      await runBaseCollectStage(resumeJob, { supabase: resumeDb as unknown as SupabaseClient });
      const saved = resumeDb.getRows('ve_bases')[0];
      expect(saved).toMatchObject({ status: collectionMode === 'preview' ? 'analyzing' : 'analyzed', row_count: 2 });
      expect((saved.collect_info as VeCollectInfo).target_progress).toMatchObject({
        status: bounded ? 'limited' : collectionMode === 'preview' ? 'exhausted' : 'target_reached', round, max_rounds: maxRounds,
        max_candidates: 10_000, candidates_processed: 6753, ready_rows: 2,
      });
      expect((saved.collect_info as VeCollectInfo).target_checkpoint?.processed_rows).toBe(10475);
      expect((saved.collect_info as VeCollectInfo).tasks![0].directory_cursors).toEqual({ saved_lane: 9000 });
      expect(mockFindIrrelevantRows.mock.calls.slice(gateCalls).map(([input]) => input.rows.map((row: VeUnifiedRow) => row.email)))
        .toEqual([['mail@pending.test']]);
      expect(searchRows).toHaveBeenCalledTimes(sourceCalls);
      expect(resumeDb.getRows('base_constructor_jobs')).toEqual([paidChild]);
      expect(resumeDb.getRows('ve_contact_supply_batches')).toHaveLength(collectionMode === 'supply' ? 1 : 0);
      expect(resumeDb.inserts).toHaveLength(collectionMode === 'preview' ? 1 : 0);
      if (collectionMode === 'preview') expect(resumeDb.getRows('ve_jobs')).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'base_analyze', payload: { base_id: 'b1' } }),
      ]));
      const reviewed = mockFindIrrelevantRows.mock.calls.length;
      await runBaseCollectStage(resumeJob, { supabase: resumeDb as unknown as SupabaseClient });
      expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(reviewed);
    }

    // Joynio: retry only the checkpoint of an already paid/completed batch.
    // An ambiguous commit must not rerun classification or create a new child.
    const recoveryInfo: VeCollectInfo = { ...collectInfo([
      unifiedRow({ company: 'Clinic One', website: 'one.test', email: 'one@one.test' }),
      unifiedRow({ company: 'Clinic Two', website: 'two.test', email: 'two@two.test' }),
    ]), collection_mode: 'preview', adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
      target_progress: createCollectionTarget('preview'), preview_pipeline: { version: 1, revision: 0, batches: [] } };
    recoveryInfo.tasks![0].exhausted = true;
    const recoveryDb = seed(recoveryInfo);
    await runBaseCollectStage(makeJob(), { supabase: recoveryDb as unknown as SupabaseClient });
    const recoveryChild = recoveryDb.getRows('base_constructor_jobs')[0];
    const recoveryGrid = recoveryChild.data as string[][];
    await recoveryDb.from('base_constructor_jobs').update({ status: 'completed', data: [
      [...recoveryGrid[0], 'Email Статус'], ...recoveryGrid.slice(1).map((row) => [...row, 'ok']),
    ] }).eq('id', recoveryChild.id);
    for (const mode of ['gateway', 'lost_response', 'lost_read', 'lost_final', 'outage', 'unknown_exhaustion', 'permanent',
      'conflict', 'paused', 'new_claim', 'aborted', 'abort_backoff'] as const) {
      const db = seed(structuredClone(recoveryInfo), {
        ve_bases: structuredClone(recoveryDb.getRows('ve_bases')),
        base_constructor_jobs: structuredClone(recoveryDb.getRows('base_constructor_jobs')),
      });
      const originalFrom = db.from.bind(db);
      const controller = new AbortController();
      const writes: Record<string, unknown>[] = [];
      let lostRead = false;
      let winner: VeCollectInfo | undefined;
      let errorSnapshots = 0;
      db.from = (table) => {
        const builder = originalFrom(table);
        if (table !== 've_bases') return builder;
        let checkpoint = false;
        let projection = '';
        const update = builder.update.bind(builder), select = builder.select.bind(builder);
        builder.update = (patch) => {
          checkpoint = patch.row_count === 2 && Array.isArray(patch.data)
            && (mode === 'lost_final' ? patch.status === 'analyzing' : patch.status === undefined);
          if (checkpoint) writes.push(structuredClone(patch));
          return update(patch);
        };
        builder.select = (columns, options) => {
          projection = columns ?? '*';
          if (writes.length && projection === 'status, collect_info') errorSnapshots++;
          return select(columns, options);
        };
        const single = builder.maybeSingle.bind(builder);
        builder.maybeSingle = async () => {
          if (!checkpoint && writes.length && projection === 'id'
            && ((mode === 'lost_read' && !lostRead) || mode === 'unknown_exhaustion')) {
            lostRead = true;
            return { data: null, error: { message: 'Bad Gateway' }, status: 502 } as unknown as Awaited<ReturnType<typeof single>>;
          }
          if (!checkpoint || (writes.length > 1 && !['outage', 'unknown_exhaustion'].includes(mode))) return single();
          if (['lost_response', 'lost_read', 'lost_final'].includes(mode)) await single();
          if (mode === 'unknown_exhaustion') {
            if (writes.length === 1) await single();
            if (writes.length === 3) {
              winner = structuredClone(db.getRows('ve_bases')[0].collect_info) as VeCollectInfo;
              winner.preview_pipeline!.revision++;
              winner.preview_pipeline!.checkpoint_id = 'newer-writer';
              await originalFrom('ve_bases').update({ collect_info: winner }).eq('id', 'b1');
            }
          }
          if (mode === 'conflict') {
            const winner = structuredClone(db.getRows('ve_bases')[0].collect_info) as VeCollectInfo;
            winner.preview_pipeline!.revision++;
            await originalFrom('ve_bases').update({ collect_info: winner }).eq('id', 'b1');
          }
          if (mode === 'paused' || mode === 'new_claim') await originalFrom('ve_jobs')
            .update(mode === 'paused' ? { status: 'cancelled' } : { started_at: '2026-08-30T01:00:00Z' }).eq('id', makeJob().id);
          if (mode === 'aborted') controller.abort(new Error('checkpoint cancelled'));
          if (mode === 'abort_backoff') setTimeout(() => controller.abort(new Error('checkpoint cancelled')), 10);
          return { data: null, error: mode === 'permanent'
            ? { message: 'permission denied for table ve_bases', code: '42501' }
            : { message: 'An invalid response was received from upstream server' }, status: mode === 'permanent' ? 403 : 502,
          } as unknown as Awaited<ReturnType<typeof single>>;
        };
        return builder;
      };
      const gateCalls = mockFindIrrelevantRows.mock.calls.length;
      const llmCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
      const sourceCalls = jest.mocked(searchRows).mock.calls.length;
      jest.useFakeTimers();
      try {
        const observed = runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient, signal: controller.signal })
          .then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
        await jest.advanceTimersByTimeAsync(5_000);
        const outcome = await observed;
        const succeeds = ['gateway', 'lost_response', 'lost_read', 'lost_final'].includes(mode);
        if (succeeds) {
          expect({ mode, error: outcome.error }).toEqual({ mode, error: null });
          expect(db.getRows('ve_bases')[0]).toMatchObject({ row_count: 2, status: 'analyzing' });
        } else if (['conflict', 'paused', 'new_claim'].includes(mode)) {
          expect(outcome.error).toBeInstanceOf(VePreviewCheckpointConflict);
          expect(db.getRows('ve_bases')[0]).toMatchObject({ row_count: 0, status: 'collecting' });
          expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.status).not.toBe('error');
        } else expect(outcome.error?.message).toContain(mode.startsWith('abort') ? 'checkpoint cancelled'
          : mode === 'permanent' ? 'permission denied' : 'invalid response');
        expect(writes).toHaveLength(['outage', 'unknown_exhaustion'].includes(mode) ? 3 : ['gateway', 'lost_read'].includes(mode) ? 2 : 1);
        expect(new Set(writes.map((patch) => JSON.stringify(patch))).size).toBe(1);
        expect(errorSnapshots).toBe(0);
        if (mode === 'unknown_exhaustion') {
          expect(db.getRows('ve_bases')[0]).toMatchObject({ row_count: 2, status: 'collecting' });
          expect(db.getRows('ve_bases')[0].collect_info).toEqual(winner);
        }
        expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(gateCalls + 1);
        // Normal name cleanup starts only after a confirmed checkpoint.
        expect(callLLMWithSchema).toHaveBeenCalledTimes(llmCalls + Number(succeeds));
        expect(searchRows).toHaveBeenCalledTimes(sourceCalls);
        expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
        if (['outage', 'unknown_exhaustion'].includes(mode)) {
          const saved = structuredClone(db.getRows('ve_bases')[0].collect_info) as VeCollectInfo;
          // A page/constructor save can fail while durable progress is still
          // collecting; the worker records failure only on the base/job.
          saved.target_progress!.status = 'collecting';
          const failed = { ...db.getRows('ve_bases')[0], collect_info: saved, status: 'failed', error: outcome.error!.message };
          // The worker can exhaust its free DB-interruption retries with the
          // same untouched progress; continuation must retain that pipeline too.
          for (const reason of [failed.error,
            'Preview checkpoint save: VE2 database PATCH request timeout after 120000ms (response body stalled)',
            'Preview checkpoint save: VE2 database PATCH request connection lost: socket ended']) {
            expect(previewRecoveryKind({ ...failed, error: reason })).toBe('pipeline');
            expect(previewRecoveryKind({ ...failed, error: reason,
              collect_info: { ...saved, preview_pipeline: undefined } })).toBeNull();
            expect(previewRecoveryKind({ ...failed, error: reason, collect_info: { ...saved,
              target_checkpoint: { ...saved.target_checkpoint, completed_round: 999 } } })).toBeNull();
          }
          for (const reason of ['Preview checkpoint save: permission denied', 'Preview checkpoint save: invalid payload',
            'An invalid response was received from upstream server', 'VE2 database PATCH request timeout after 120000ms',
            'VE2 database PATCH request connection lost: socket ended', 'Preview checkpoint save: provider timeout',
            'Preview checkpoint save: VE2 job aborted']) expect(previewRecoveryKind({ ...failed, error: reason })).toBeNull();
          await originalFrom('ve_bases').update({ status: 'failed', error: failed.error, collect_info: saved }).eq('id', 'b1');
          await originalFrom('ve_jobs').update({ status: 'failed' }).eq('id', makeJob().id);
          for (let click = 0; click < 2; click++) await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, {
            projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000,
          })).resolves.toMatchObject({ ok: true, base: { id: 'b1' } });
          expect(db.getRows('ve_bases')).toHaveLength(1);
          const resumed = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
          expect(resumed.target_checkpoint).toEqual(saved.target_checkpoint);
          expect(resumed.target_progress?.candidates_processed).toBe(saved.target_progress?.candidates_processed);
          expect(resumed.preview_pipeline?.batches).toEqual(saved.preview_pipeline?.batches);
          expect(db.getRows('ve_jobs').filter((job) => job.status === 'pending')).toHaveLength(1);
          expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
        }
      } finally { jest.useRealTimers(); }
    }
  });

  it('holds paused supply without blocking manual work, then resumes safely and records processing errors', async () => {
    const info = { ...collectInfo([
      unifiedRow({ company: 'Held Clinic', email: 'held@clinic.test', website: 'held.test' }),
    ], { bc_job_id: 'bc-held', status: 'dispatched' as const, dispatched_at: '2020-01-01T00:00:00Z' }),
    collection_mode: 'supply' as const, ready_target: 10, supply_batch_id: 'batch-held' };
    const db = seed(info, {
      ve_bases: [{ ...makeBase(info), created_at: '2026-08-30T00:00:00Z' }],
      ve_contact_supply_batches: [{ id: 'batch-held', base_id: 'b1', plan_id: 'plan-held' }],
      base_constructor_jobs: [{ id: 'bc-held', status: 'processing' }],
    });
    let eligible = false;
    const originalRpc = db.rpc;
    db.rpc = (name, params) => name === 've_require_contact_supply_active'
      ? Promise.resolve(eligible ? { data: { id: 'plan-held' }, error: null } : { data: null, error: { message: 'supply plan is not active (paused or stopped)' } })
      : originalRpc(name, params);
    const job = { ...makeJob(), payload: { ...makeJob().payload, collection_mode: 'supply', ready_target: 10, supply_batch_id: 'batch-held' } };
    await expect(runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient }))
      .resolves.toMatchObject({ result: { waiting: true, supply_held: true } });
    expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).supply_hold).toBe(true);
    expect(db.inserts).toEqual([]);

    await db.from('ve_bases').insert({ ...makeBase(collectInfo([
      unifiedRow({ company: 'Manual Clinic', email: 'manual@clinic.test', website: 'manual.test' }),
    ])), id: 'b-manual', created_at: '2026-08-31T00:00:00Z' });
    await db.from('ve_jobs').insert({ ...makeJob(), id: 'job-manual', payload: { base_id: 'b-manual' } });
    await expect(runBaseCollectStage({ ...makeJob(), id: 'job-manual', payload: { base_id: 'b-manual' } }, { supabase: db as unknown as SupabaseClient }))
      .resolves.toMatchObject({ result: { construct: 'dispatched' } });
    eligible = true;
    await expect(runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient }))
      .resolves.toMatchObject({ result: { waiting_for_base_id: 'b-manual' } });
    await db.from('ve_bases').update({ status: 'analyzed' }).eq('id', 'b-manual');
    await expect(runBaseCollectStage(job, { supabase: db as unknown as SupabaseClient })).rejects.toThrow('6ч');
    const failed = db.getRows('ve_bases').find((base) => base.id === 'b1')!;
    expect(failed.status).toBe('failed');
    expect((failed.collect_info as VeCollectInfo).target_progress).toMatchObject({ status: 'error' });

    // Seven hours waiting for credit are not seven hours of parent execution.
    // Repeated wakes reuse the timer receipt, and a manual supply pause still wins.
    for (const manual of [false, true]) {
      const now = Date.now();
      const dispatch = new Date(now - 9 * 60 * 60_000).toISOString();
      const blockedAt = new Date(now - 8 * 60 * 60_000).toISOString();
      const resumedAt = new Date(now - 1 * 60 * 60_000).toISOString();
      const billingInfo: VeCollectInfo = { ...collectInfo([
        unifiedRow({ company: 'Saved Clinic', email: 'saved@clinic.test', website: 'saved.test' }),
      ], { bc_job_id: 'bc-billing', status: 'dispatched', dispatched_at: dispatch }),
      collection_mode: 'supply', ready_target: 10, supply_batch_id: 'batch-billing' };
      if (manual) {
        billingInfo.target_progress = createCollectionTarget('supply', 10);
        billingInfo.supply_billing_resume = { version: 1, batch_id: 'batch-billing', job_id: 'job-1',
          blocked_at: blockedAt, resumed_at: resumedAt, max_rounds: 5, max_candidates: 10_000 };
      }
      billingInfo.tasks![0].dispatched_at = dispatch;
      const billingDb = seed(billingInfo, {
        ve_contact_supply_batches: [{ id: 'batch-billing', base_id: 'b1', plan_id: 'plan-billing' }],
        base_constructor_jobs: [{ id: 'bc-billing', status: 'processing' }],
      });
      const billingRpc = billingDb.rpc;
      let billingEligible = false;
      billingDb.rpc = (name, params) => name === 've_require_contact_supply_active'
        ? Promise.resolve(billingEligible ? { data: { id: 'plan-billing' }, error: null }
          : { data: null, error: { message: 'supply plan is not active (paused or stopped)' } })
        : billingRpc(name, params);
      const billingJob = { ...makeJob(), payload: { ...makeJob().payload, collection_mode: 'supply',
        ready_target: 10, supply_batch_id: 'batch-billing', ...(!manual ? { requesty_billing_recovery: {
          version: 1, blocked_at: blockedAt, resumed_at: resumedAt,
        } } : {}) } };
      const billingClient = billingDb as unknown as SupabaseClient;
      await expect(runBaseCollectStage(billingJob, { supabase: billingClient }))
        .resolves.toMatchObject({ result: { supply_held: true } });
      const afterCredit = billingDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      const shiftedDispatch = new Date(now - 2 * 60 * 60_000).toISOString();
      expect(afterCredit.construct?.dispatched_at).toBe(shiftedDispatch);
      expect(afterCredit.tasks![0].dispatched_at).toBe(shiftedDispatch);
      expect(afterCredit.requesty_billing_timer_recovery).toEqual({ blocked_at: blockedAt, resumed_at: resumedAt });
      expect(billingDb.getRows('base_constructor_jobs')).toHaveLength(1);
      expect(billingDb.getRows('base_constructor_jobs')[0].status).toBe('processing');
      await expect(runBaseCollectStage(billingJob, { supabase: billingClient }))
        .resolves.toMatchObject({ result: { supply_held: true } });
      expect((billingDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).construct?.dispatched_at).toBe(shiftedDispatch);
      billingEligible = true;
      await expect(runBaseCollectStage(billingJob, { supabase: billingClient }))
        .resolves.toMatchObject({ result: { waiting: true } });
      expect(billingDb.getRows('ve_bases')[0].status).toBe('collecting');
      expect(billingDb.getRows('base_constructor_jobs')).toHaveLength(1);
      if (manual) expect((billingDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress)
        .toMatchObject({ round: 1, max_rounds: 5, max_candidates: 10_000, candidates_processed: 0 });
    }
  });

  it.each([
    {
      label: 'email-rich harvest',
      row: unifiedRow({
        company: 'Клиника Альфа',
        website: 'alpha.test',
        email: 'info@alpha.test, doctor@alpha.test',
        inn: '7700000001',
        source_detail: 'реестр',
      }),
      expected: [
        'find_emails',
        'enrich_descriptions',
        'split_emails',
        'dedup_email',
        'validate_emails',
      ],
    },
    {
      label: 'email-poor harvest',
      row: unifiedRow({
        company: 'Клиника Бета',
        website: 'beta.test',
        inn: '7700000002',
        source_detail: 'реестр',
      }),
      expected: [
        'find_emails',
        'enrich_descriptions',
        'split_emails',
        'dedup_email',
        'validate_emails',
      ],
    },
  ])('$label refreshes website emails before splitting and validation without a company cap', async ({ row, expected }) => {
    const db = seed(collectInfo([row]));

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { waiting: true, construct: 'dispatched' } });

    const constructorInsert = db.inserts.find((insert) => insert.table === 'base_constructor_jobs');
    expect(constructorInsert?.rows[0].selected_steps).toEqual(expected);
    expect(constructorInsert?.rows[0].step_config).toEqual({
      find_emails_target: 'separate',
      // Запас сверх лимита адресов на компанию: краул — главный расход
      // времени, а всё сверх лимита выбрасывалось уже после SMTP-проверки.
      // Описание забираем из уже скачанной главной: иначе enrich_descriptions
      // качает тот же сайт второй раз, втрое меньшей параллельностью.
      find_emails: { stop_at_first: false, max_per_site: 6, max_pages: 4, site_timeout_ms: 30_000, merge_mode: 'prefer_found_validated',
        reuse_website_description: true },
    });
    const dispatchedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(dispatchedInfo.construct?.progress).toMatchObject({ status: 'pending', total_steps: expected.length });
    expect(dispatchedInfo.stats).toMatchObject({ rows_total: 1, tasks_done: 1 });
    expect(dispatchedInfo.stats).not.toHaveProperty('finished_at');
    expect(dispatchedInfo.stats).not.toHaveProperty('launchable_rows');
    expect(db.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: 0 });

    await db.from('base_constructor_jobs').update({
      status: 'processing',
      current_step: 2,
      total_steps: expected.length,
      current_step_key: expected[1],
      current_step_progress: 37,
    }).eq('id', constructorInsert?.rows[0].id);
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const waitingInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(waitingInfo.construct).toMatchObject({
      status: 'dispatched',
      progress: {
        status: 'processing',
        current_step: 2,
        total_steps: expected.length,
        current_step_key: expected[1],
        current_step_progress: 37,
      },
    });
    expect(waitingInfo.stats).toMatchObject({ rows_total: 1 });
    expect(waitingInfo.stats).not.toHaveProperty('finished_at');
    expect(db.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', row_count: 0 });
    // jsonb may reorder keys; unchanged snapshots must not rewrite harvests.
    await db.from('ve_bases').update({
      collect_info: {
        ...waitingInfo,
        stats: Object.fromEntries(Object.entries(waitingInfo.stats!).reverse()),
        construct: {
          ...waitingInfo.construct,
          progress: Object.fromEntries(Object.entries(waitingInfo.construct!.progress!).reverse()),
        },
      },
    }).eq('id', 'b1');
    const baseWrites = db.updates.filter((update) => update.table === 've_bases').length;
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    expect(db.updates.filter((update) => update.table === 've_bases')).toHaveLength(baseWrites);

    await db.from('base_constructor_jobs').update({
      current_step: 0, total_steps: 0, current_step_progress: 101, current_step_key: '',
    }).eq('id', constructorInsert?.rows[0].id);
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    expect((lastBasePatch(db)?.collect_info as VeCollectInfo).construct?.progress).toEqual({
      status: 'processing', current_step: null, total_steps: null,
      current_step_key: null, current_step_progress: null,
    });
  });

  it('stores the company-level estimate from the exact single directory task', async () => {
    const db = seed(collectInfo([
      unifiedRow({ company: 'Клиника Альфа', website: 'alpha.test', inn: '7700000001' }),
    ]));

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    // Размер среза — тем же условием, что и выборка (точный ОКВЭД с запасным),
    // а не приблизительным ОКВЭД ve_directory_segment_stats.
    expect(db.rpcCalls.filter((call) => call.fn !== 've_enqueue_preparation_child')).toEqual([
      {
        fn: 've_directory_plan_population',
        params: {
          // Email is a funnel output here, not a filter on the population.
          p_slices: [{ okved_prefixes: ['86.1', '86.2', '86.9'], region_codes: null, include_ip: false, has_email: false }],
          p_exclude_inns: null,
        },
      },
    ]);
    const estimatePatch = db.updates.find((update) => {
      const info = update.patch.collect_info as VeCollectInfo | undefined;
      return info?.estimate?.unique_companies === 8_410;
    });
    expect((estimatePatch?.patch.collect_info as VeCollectInfo).estimate).toMatchObject({
      unique_companies: 8_410,
      available_companies: 8_410,
      companies_with_email: 6_842,
      companies_with_phone: 7_105,
      directory_rows_total: 9_120,
      population_method: 'plan_union',
      population_matches_source: true,
    });

    // Catalog sources use the stored dictionary and a read-only cursor RPC.
    // Losing the process between pages must not lose rows or create a parser.
    const catalogTask = { source: 'yandex_maps' as const, rationale: 'Existing catalog',
      maps_query: { queries: ['Лифты'], geo: 'Россия' } };
    const filters = { categories: ['Лифты'], countries: ['Россия'] };
    const catalogInfo: VeCollectInfo = { plan: { tasks: [catalogTask] }, tasks: [{
      source: 'yandex_maps', status: 'pending', child_job_id: null, task: catalogTask, rows: 0,
      catalog: { version: 1, filters },
    }] };
    const catalogDb = seed(catalogInfo);
    const pages = [{ yandex_id: '1', name: 'Lift service', website: 'lift.test', categories: 'Лифты',
      subcategories: 'Ремонт лифтов', email: 'office@lift.test' }];
    const originalRpc = catalogDb.rpc;
    catalogDb.rpc = ((name: string, params: Record<string, unknown>) => {
      const operation = name === 'yandex_maps_catalog_search'
        ? Promise.resolve({ data: params.p_after ? [] : pages, error: null }) : originalRpc(name, params);
      if (name === 'yandex_maps_catalog_search') {
        expect(params).toMatchObject({ p_categories: ['Лифты'], p_countries: ['Россия'], p_offset: 0 });
        catalogDb.rpcCalls.push({ fn: name, params });
      }
      return Object.assign(operation, { abortSignal: () => operation });
    }) as typeof catalogDb.rpc;
    let stopped = false;
    await expect(runBaseCollectStage(makeJob(), { supabase: catalogDb as unknown as SupabaseClient,
      onCheckpoint: () => {
        const info = catalogDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
        if (!stopped && info.tasks?.[0].catalog?.after === '1') {
          stopped = true; throw new VeWorkerShutdownError();
        }
      },
    })).rejects.toMatchObject({ name: 'VeWorkerShutdownError' });
    expect(catalogDb.getRows('ve_bases')[0].collect_info).toMatchObject({ tasks: [{
      rows: 1, status: 'pending', catalog: { after: '1' },
      harvest: [{ company: 'Lift service', category: expect.stringContaining('Ремонт лифтов') }],
    }] });
    await runBaseCollectStage(makeJob(), { supabase: catalogDb as unknown as SupabaseClient });
    const catalogSaved = catalogDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(catalogSaved.tasks?.[0]).toMatchObject({ status: 'done', rows: 1, exhausted: true, child_job_id: null });
    expect(catalogDb.rpcCalls.map((call) => call.params.p_after)).toEqual([null, '1']);
    expect(catalogDb.getRows('yandex_maps_jobs')).toHaveLength(0);
    expect(catalogDb.getRows('base_constructor_jobs')).toHaveLength(1);
    const failedCatalog = { ...makeBase({ ...catalogInfo, collection_mode: 'preview',
      target_progress: { ...createCollectionTarget('preview'), status: 'error' },
      tasks: [{ ...catalogInfo.tasks![0], catalog: undefined, status: 'failed' as const, child_job_id: 'old-parser', error: 'proxy unavailable' }],
    }), status: 'failed' };
    expect(previewRecoveryKind(failedCatalog)).toBe('catalog');
    expect(previewRecoveryKind({ ...failedCatalog, source: 'manual' })).toBeNull();
    const recoveryDb = seed(catalogInfo, { ve_bases: [failedCatalog], ve_jobs: [] });
    const recovered = await enqueueVeBaseCollect(recoveryDb as unknown as SupabaseClient, {
      projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name, limit: 100,
      hypothesisIds: ['h1'], collectionMode: 'preview',
    });
    expect(recovered).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
    expect(recoveryDb.getRows('ve_bases')).toHaveLength(1);
    expect(recoveryDb.getRows('ve_bases')[0].collect_info).toMatchObject({ tasks: [{
      status: 'pending', child_job_id: null, legacy_child_job_id: 'old-parser',
    }] });

    const dictionaries = createMockSupabase({ enforceQueryWindows: true, tables: {
      yandex_maps_catalog_rubrics: [{ rubric: 'Лифты' }, { rubric: 'Стройматериалы оптом' }],
      yandex_maps_catalog_places: [{ country: 'Россия', region: 'Москва и Московская область', city: 'Москва' }],
    } });
    const dictionaryDb = { from: (table: string) => {
      let start = 0, end = 999;
      const query = { select: () => query, order: () => query,
        range: (from: number, to: number) => { start = from; end = to; return query; },
        abortSignal: async () => ({ data: dictionaries.getRows(table).slice(start, end + 1), error: null }),
      };
      return query;
    },
    // Проверка «в рубрике есть организации в выбранной географии».
    rpc: () => ({ abortSignal: async () => ({ data: 1, error: null }) }) } as unknown as SupabaseClient;
    const modelCalls = (callLLMWithSchema as jest.Mock).mock.calls.length;
    expect(await resolveVeYandexCatalogFilters({ db: dictionaryDb, query: catalogTask.maps_query })).toEqual(filters);
    expect((callLLMWithSchema as jest.Mock).mock.calls).toHaveLength(modelCalls);
    await expect(resolveVeYandexCatalogFilters({ db: dictionaryDb, query: { queries: ['Лифты'], geo: 'Несуществующее место' } })).rejects.toThrow('география');
    (callLLMWithSchema as jest.Mock).mockResolvedValueOnce({ data: { category_ids: [0], place_ids: [] }, tokensUsed: 0, costUsd: 0 });
    expect(await resolveVeYandexCatalogFilters({ db: dictionaryDb, query: { queries: ['обслуживание лифтов'], geo: 'РФ' } })).toEqual(filters);
  });

  it('возобновляет каталог после ЗАКРЫТОГО раунда и не отвергает собственную контрольную точку', async () => {
    // Прод, база 4cf192ba-8897-4ee2-9c01-5f6c2d8ae920 («Стройматериалы B2B»,
    // проект Прион), лежит с 17.09.2026. Раунд 1 закрылся штатно: контрольная
    // точка записана (completed_round = 1), 2000 кандидатов обработаны, 105
    // контактов готовы. Но задача карт упала, finishCollectionRound вернул
    // error и НЕ увеличил номер раунда. «Продолжить подготовку» возвращала
    // базу в collecting с тем же round = 1, а стадия отвергала это же
    // состояние: completed_round === round - 1 не выполняется (1 !== 0).
    const catalogTask = { source: 'yandex_maps' as const, rationale: 'Каталог стройматериалов',
      maps_query: { queries: ['Стройматериалы оптом'], geo: 'Россия' } };
    const closedRound: VeCollectInfo = {
      collection_mode: 'preview',
      ready_target: 500,
      limit: 2_000,
      plan: { tasks: [DIRECTORY_TASK, catalogTask] },
      construct: { bc_job_id: 'bc-round-1', status: 'done', dispatched_at: '2026-09-16T01:30:00Z' },
      stats: { tasks_total: 2, tasks_done: 1, tasks_failed: 1, rows_total: 2_000,
        excluded_existing_bases: 0, excluded_during_fetch: 0, finished_at: '2026-09-16T07:36:00Z' },
      tasks: [
        { source: 'companies_directory', status: 'done', child_job_id: null, task: DIRECTORY_TASK,
          rows: 2_000, directory_cursors: { exact: 2_000 }, harvest: [] },
        { source: 'yandex_maps', status: 'failed', child_job_id: 'maps-child-1', task: catalogTask,
          rows: 0, error: 'Requesty 429: rate limited' },
      ],
      target_progress: { ...createCollectionTarget('preview'), round: 1, ready_rows: 105,
        candidates_processed: 2_000, first_round_candidates: 2_000,
        status: 'error', reason: 'yandex_maps: Requesty 429: rate limited' },
      target_checkpoint: { completed_round: 1, seen_rows: [], processed_rows: 6_031,
        prior_low_relevance: 0, prior_relevance_unchecked: 0, low_relevance: 0, relevance_unchecked: 6_179 },
    } as unknown as VeCollectInfo;
    const stuck = { ...makeBase(closedRound), status: 'failed',
      error: 'yandex_maps: Requesty 429: rate limited' };
    expect(previewRecoveryKind(stuck)).toBe('catalog');

    const db = seed(closedRound, { ve_bases: [stuck], ve_jobs: [] });
    expect(await enqueueVeBaseCollect(db as unknown as SupabaseClient, {
      projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name, limit: 100,
      hypothesisIds: ['h1'], collectionMode: 'preview',
    })).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
    const resumed = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;

    // Закрытый раунд продолжается СЛЕДУЮЩИМ: номер увеличен, и вместе с ним
    // выполнен тот же переход, что делает стадия на границе раунда, — иначе
    // конструктор первого раунда достался бы второму и заново втянул те же
    // 2000 компаний, завысив candidates_processed.
    expect(resumed.target_progress).toMatchObject({ round: 2, status: 'collecting',
      ready_rows: 105, candidates_processed: 2_000 });
    expect(resumed.target_progress?.reason).toBeUndefined();
    expect(resumed.construct).toBeUndefined();
    expect(resumed.stats?.finished_at).toBeUndefined();
    expect(resumed.limit).toBe(collectionRoundLimit(resumed.target_progress!));
    // Упавшая задача карт снова опрашивает СВОЕГО ребёнка, живой лейн реестра
    // возвращается к своей закладке, а не читает срез с первой страницы.
    expect(resumed.tasks).toMatchObject([
      { source: 'companies_directory', status: 'pending', child_job_id: null, rows: 0,
        directory_cursors: { exact: 2_000 } },
      { source: 'yandex_maps', status: 'pending', child_job_id: null, legacy_child_job_id: 'maps-child-1' },
    ]);

    // Прод дословно: именно этот запуск падал «Invalid collection target checkpoint».
    const stageError = await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient })
      .then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(stageError).not.toBe('Invalid collection target checkpoint');

    // Раунд, который НЕ закрылся (контрольная точка на раунд позади), обязан
    // продолжаться тем же номером: возобновление не двигает счётчик вслепую.
    const openRound = { ...closedRound, target_checkpoint: { ...closedRound.target_checkpoint!,
      completed_round: 1 }, target_progress: { ...closedRound.target_progress!, round: 2 } } as VeCollectInfo;
    const openBase = { ...makeBase(openRound), status: 'failed', error: 'yandex_maps: Requesty 429: rate limited' };
    expect(previewRecoveryKind(openBase)).toBe('catalog');
    const openDb = seed(openRound, { ve_bases: [openBase], ve_jobs: [] });
    await enqueueVeBaseCollect(openDb as unknown as SupabaseClient, {
      projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name, limit: 100,
      hypothesisIds: ['h1'], collectionMode: 'preview',
    });
    const openResumed = openDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(openResumed.target_progress).toMatchObject({ round: 2, status: 'collecting' });
    expect(openResumed.construct).toMatchObject({ bc_job_id: 'bc-round-1', status: 'done' });

    // Состояние прода СЕГОДНЯ: первая попытка возобновления уже перевела
    // задачу карт в pending и упала на проверке, а стадия записала свою
    // причину в target_progress. Не узнать это состояние значит собрать новую
    // платную базу вместо 105 уже проверенных контактов старой.
    const afterFailedResume = { ...closedRound,
      tasks: [closedRound.tasks![0], { ...closedRound.tasks![1], status: 'pending' as const,
        child_job_id: null, legacy_child_job_id: 'maps-child-1', error: undefined }],
      target_progress: { ...closedRound.target_progress!, reason: 'Invalid collection target checkpoint' },
    } as unknown as VeCollectInfo;
    const bricked = { ...makeBase(afterFailedResume), status: 'failed',
      error: 'Invalid collection target checkpoint' };
    expect(previewRecoveryKind(bricked)).toBe('catalog');
    const brickedDb = seed(afterFailedResume, { ve_bases: [bricked], ve_jobs: [] });
    expect(await enqueueVeBaseCollect(brickedDb as unknown as SupabaseClient, {
      projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name, limit: 100,
      hypothesisIds: ['h1'], collectionMode: 'preview',
    })).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
    const brickedResumed = brickedDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(brickedResumed.target_progress).toMatchObject({ round: 2, status: 'collecting', ready_rows: 105 });
    expect(brickedResumed.construct).toBeUndefined();
    expect(brickedDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting', error: null });
    const brickedStageError = await runBaseCollectStage(makeJob(), { supabase: brickedDb as unknown as SupabaseClient })
      .then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(brickedStageError).not.toBe('Invalid collection target checkpoint');

    // Равенство completed_round и round означает «раунд закрыт» ТОЛЬКО без
    // флагов повторного прохода. С любым из них стадия читает то же равенство
    // как «идёт сохранённый проход ТОГО ЖЕ раунда»: сдвинув номер такой базе,
    // мы отняли бы у неё конструктор и залипли бы ровно той ошибкой, ради
    // которой написана вся эта ветка.
    for (const flag of ['validation_retry', 'company_name_recovery', 'relevance_review_requested'] as const) {
      const guarded = structuredClone(closedRound) as unknown as Record<string, unknown>;
      guarded[flag] = true;
      expect(openNextVeCollectionRound(guarded)).toBe(false);
      expect((guarded.target_progress as { round: number }).round).toBe(1);
    }
    // Без флагов раунд открывается — иначе проверка выше была бы бессмысленной.
    const openable = structuredClone(closedRound) as unknown as Record<string, unknown>;
    expect(openNextVeCollectionRound(openable)).toBe(true);
    expect((openable.target_progress as { round: number }).round).toBe(2);
  });

  it('re-dispatches an in-flight legacy constructor result that never split multi-email cells', async () => {
    const legacyConstruct: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-legacy-without-split',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const info = collectInfo([
      unifiedRow({
        company: 'Клиника Легаси',
        website: 'legacy.test',
        email: 'first@legacy.test, live@legacy.test',
        inn: '7700000099',
      }),
    ], legacyConstruct);
    const db = seed(info, {
      base_constructor_jobs: [
        {
          id: 'bc-legacy-without-split',
          status: 'completed',
          error_message: null,
          selected_steps: [
            'dedup_email',
            'validate_emails',
            'cap_emails_per_company',
            'enrich_descriptions',
          ],
          data: [
            ['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
            [
              'Клиника Легаси',
              'legacy.test',
              'first@legacy.test, live@legacy.test',
              '7700000099',
              'ok',
            ],
          ],
        },
      ],
    });

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { waiting: true, construct: 're_dispatched' } });

    const replacement = db.inserts
      .filter((insert) => insert.table === 'base_constructor_jobs')
      .at(-1)?.rows[0];
    expect(replacement?.selected_steps).toContain('split_emails');
    expect(replacement?.data).toEqual(expect.arrayContaining([
      expect.arrayContaining(['first@legacy.test, live@legacy.test']),
    ]));

    const replacementInfo = db.updates
      .map((update) => update.patch.collect_info as VeCollectInfo | undefined)
      .find((stored) =>
        stored?.construct?.bc_job_id != null
        && stored.construct.bc_job_id !== 'bc-legacy-without-split',
      );
    expect(replacementInfo?.construct).toMatchObject({ status: 'dispatched' });
    expect(replacementInfo?.construct?.progress).toMatchObject({ status: 'pending' });
    expect(db.updates).not.toContainEqual(expect.objectContaining({
      table: 've_bases',
      patch: expect.objectContaining({ status: 'analyzing' }),
    }));
  });
});

describe('base_collect CONSTRUCT import', () => {
  it('keeps one address per row, preserves its own status and admits ok and catch-all addresses', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc1',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Альфа',
            website: 'alpha.test',
            email: 'source@alpha.test',
            inn: '7700000001',
            source_detail: 'реестр',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc1',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Альфа', 'alpha.test', 'catch@alpha.test', '', '', '', '86.2',
                '', '', '7700000001', 'реестр', 'catch_all',
              ],
              [
                'Клиника Альфа', 'alpha.test', 'live@alpha.test', '', '', '', '86.2',
                '', '', '7700000001', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );

    const runGate = mockFindIrrelevantRows.getMockImplementation()!;
    let stateDuringGate: unknown;
    mockFindIrrelevantRows.mockImplementationOnce((input) => {
      const inFlight = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      stateDuringGate = {
        controlStatus: inFlight.construct?.status,
        constructorStatus: inFlight.construct?.progress?.status,
        finishedAt: inFlight.stats?.finished_at,
      };
      return runGate(input);
    });

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { rows: 2 } });
    expect(stateDuringGate).toEqual({
      controlStatus: 'dispatched', constructorStatus: 'completed', finishedAt: undefined,
    });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows).toEqual([
      expect.objectContaining({ email: 'catch@alpha.test', _email_status: 'catch_all' }),
      expect.objectContaining({ email: 'live@alpha.test', _email_status: 'ok' }),
    ]);

    const audience = prepareSegmentationAudience({
      rows: storedRows,
      columns: [...VE_AUTO_COLLECT_COLUMNS],
      source: 'auto',
    });
    expect(audience.leads.map((lead) => lead.email)).toEqual(['catch@alpha.test', 'live@alpha.test']);
    expect(audience.excluded.invalidEmailStatus).toBe(0);

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 2,
      launchable_rows: 2,
      low_relevance: 0,
    });
    // Defer paid fit checks for companies with no accepted email. Preserve the
    // facts of invalid sibling emails when another address IS usable, and run
    // the same fit gate once a previously unknown email becomes usable.
    const contacts = [
      ['Клиника Альфа', 'alpha.test', 'live@alpha.test', '7700000001', 'ok'],
      ['Клиника Альфа', 'alpha.test', 'bad@alpha.test', '7700000001', 'invalid'],
      ['Клиника Бета', 'beta.test', 'unknown@beta.test', '7700000002', 'unknown'],
      ['Клиника Гамма', 'gamma.test', 'bad@gamma.test', '7700000003', 'invalid'],
    ];
    const waitingInfo: VeCollectInfo = {
      ...collectInfo(contacts.map(([company, website, email, inn]) => unifiedRow({ company, website, email, inn })), dispatched),
      collection_mode: 'preview', target_progress: createCollectionTarget('preview'), ready_target: 500,
    };
    const waitingDb = seed(waitingInfo, { base_constructor_jobs: [{ id: 'bc1', status: 'completed',
      selected_steps: ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
      data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'], ...contacts] }] });
    mockFindIrrelevantRows.mockClear();
    await runBaseCollectStage(makeJob(), { supabase: waitingDb as unknown as SupabaseClient });
    expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(1);
    expect(mockFindIrrelevantRows.mock.calls[0][0].rows.map((row: VeUnifiedRow) => row.email)).toEqual(['live@alpha.test', 'bad@alpha.test']);
    const waitingBase = lastBasePatch(waitingDb)!;
    const afterWaiting = waitingBase.collect_info as VeCollectInfo;
    expect(waitingBase.row_count).toBe(1);
    expect(afterWaiting.relevance_reserve?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'unknown@beta.test', _ve_email_pending_relevance: true }),
      expect.objectContaining({ email: 'bad@gamma.test', _ve_email_pending_relevance: true }),
    ]));
    expect(afterWaiting.relevance_summary).toMatchObject({ email_unready: 3, needs_review: 0 });
    // Resume from saved observations after email recovery, without a fresh
    // source collection. All facts of Beta still pass the usual fit gate.
    const reserve = structuredClone(afterWaiting.relevance_reserve!);
    for (const row of reserve.rows) if (row.email === 'unknown@beta.test') row._email_status = 'ok';
    const recoveredInfo: VeCollectInfo = { ...afterWaiting, relevance_reserve: reserve, relevance_review_requested: true };
    const recoveredDb = seed(recoveredInfo, { ve_bases: [{ ...makeBase(recoveredInfo),
      data: waitingBase.data, columns: waitingBase.columns, row_count: waitingBase.row_count }] });
    mockFindIrrelevantRows.mockClear();
    await runBaseCollectStage(makeJob(), { supabase: recoveredDb as unknown as SupabaseClient });
    expect(mockFindIrrelevantRows.mock.calls[0][0].rows.map((row: VeUnifiedRow) => row.email)).toEqual(['unknown@beta.test']);
    expect(lastBasePatch(recoveredDb)?.row_count).toBe(2);
    // Header-only validated output means zero usable addresses. Failed or
    // malformed output must still remain a recoverable validation failure.
    for (const [status, validHeader] of [['completed', true], ['failed', true], ['completed', false]] as const) {
      const rows = [unifiedRow({ company: 'Без контактов', website: 'empty.test' })];
      const info: VeCollectInfo = { ...collectInfo(rows, { bc_job_id: 'empty-child', status: 'dispatched' }),
        collection_mode: 'preview', target_progress: createCollectionTarget('preview'), ready_target: 500 };
      const emptyDb = seed(info, { base_constructor_jobs: [{ id: 'empty-child', status,
        selected_steps: ['split_emails', 'validate_emails'], data: [validHeader ? ['Компания', 'Email', 'Email Статус'] : ['Email Статус']] }] });
      await runBaseCollectStage(makeJob(), { supabase: emptyDb as unknown as SupabaseClient });
      const after = lastBasePatch(emptyDb)!;
      expect(after.row_count).toBe(0);
      expect((after.collect_info as VeCollectInfo).target_progress?.status === 'error').toBe(status !== 'completed' || !validHeader);
      expect(emptyDb.getRows('base_constructor_jobs')).toHaveLength(1);
    }
  });

  it('takes at most N addresses of a company into the ready base, keeps the rest in the reserve and restores them without paid work', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = { bc_job_id: 'bc1', status: 'dispatched', dispatched_at: '2026-08-30T00:00:00Z' };
    const contacts = [
      ['Клиника Альфа', 'alpha.test', 'a1@alpha.test', '7700000001', 'catch_all'],
      ['Клиника Альфа', 'alpha.test', 'a2@alpha.test', '7700000001', 'ok'],
      ['Клиника Альфа', 'alpha.test', 'a3@alpha.test', '7700000001', 'ok'],
      ['Клиника Альфа', 'alpha.test', 'a4@alpha.test', '7700000001', 'ok'],
      ['Клиника Бета', 'beta.test', 'b1@beta.test', '7700000002', 'ok'],
    ];
    const info: VeCollectInfo = {
      ...collectInfo([unifiedRow({ company: 'Клиника Альфа', website: 'alpha.test', inn: '7700000001' }),
        unifiedRow({ company: 'Клиника Бета', website: 'beta.test', inn: '7700000002' })], dispatched),
      collection_mode: 'preview', target_progress: createCollectionTarget('preview'), ready_target: 500,
    };
    const db = seed(info, { ve_bases: [{ ...makeBase(info), max_emails_per_company: 2 }],
      base_constructor_jobs: [{ id: 'bc1', status: 'completed', selected_steps: ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'], ...contacts] }] });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const dataPatch = (client: MockSupabaseClient) => client.updates.filter((update) => update.table === 've_bases' && Array.isArray(update.patch.data)).at(-1)!.patch;
    const emails = (rows: unknown) => (rows as Array<Record<string, unknown>>).map((row) => row.email);
    const capped = dataPatch(db);
    const cappedInfo = capped.collect_info as VeCollectInfo;
    // A confirmed address beats catch_all; otherwise the first N in order. Order is preserved.
    expect(emails(capped.data)).toEqual(['a2@alpha.test', 'a3@alpha.test', 'b1@beta.test']);
    expect(capped.row_count).toBe(3);
    expect(cappedInfo.target_progress?.ready_rows).toBe(3);
    expect(cappedInfo.company_contact_cap).toMatchObject({ limit: 2, over_cap_rows: 2, companies: 2 });
    expect(cappedInfo.relevance_summary).toMatchObject({ over_company_cap: 2, other: 0 });
    expect(cappedInfo.relevance_reserve?.rows.filter((row) => row._ve_company_cap).map((row) => [row.email, row._ve_company_cap]))
      .toEqual([['a1@alpha.test', { limit: 2 }], ['a4@alpha.test', { limit: 2 }]]);
    expect((capped.data as Array<Record<string, unknown>>).some((row) => '_ve_company_cap' in row)).toBe(false);
    expect(db.updates.filter((update) => update.table === 've_bases').at(-1)?.patch).toEqual({ contact_cap_applied: 2 });

    // The specialist tightens the limit to 1 on the FINISHED base. The saved rows
    // are re-partitioned in place: no collection, no constructor, no relevance or
    // name calls, no analysis job, and the base never leaves status 'analyzed'.
    // Причина, с которой сбор реально остановился. Кап применяют ПОСЛЕ сбора, и
    // раньше он затирал её целиком: 44 базы из 54 рассказывали специалисту, что
    // их остановил лимит адресов, хотя у них кончился реестр или предел раундов.
    const finished: VeCollectInfo = { ...structuredClone(cappedInfo),
      target_progress: { ...cappedInfo.target_progress!, status: 'target_reached',
        reason: 'Источники выбранного плана исчерпаны' } };
    const job = { ...makeJob(), payload: { ...makeJob().payload, collection_mode: 'preview', reproject_contacts: true } } as VeJob;
    const tightenDb = seed(finished, { ve_jobs: [job as unknown as Record<string, unknown>],
      ve_bases: [{ ...makeBase(finished), status: 'analyzed', data: capped.data, columns: capped.columns,
        row_count: capped.row_count, max_emails_per_company: 1, contact_cap_applied: 2 }] });
    mockFindIrrelevantRows.mockClear();
    await runBaseCollectStage(job, { supabase: tightenDb as unknown as SupabaseClient });
    const tightened = dataPatch(tightenDb);
    const tightenedInfo = tightened.collect_info as VeCollectInfo;
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    expect(tightenDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(tightenDb.getRows('ve_jobs').filter((row) => row.status === 'pending')).toHaveLength(0);
    expect(emails(tightened.data)).toEqual(['a2@alpha.test', 'b1@beta.test']);
    expect(tightened.row_count).toBe(2);
    expect(tightened.contact_cap_applied).toBe(1);
    expect(tightened.status).toBeUndefined();
    expect(tightenedInfo.target_progress).toMatchObject({ status: 'limited', ready_rows: 2, reason: expect.stringContaining('лимит 1') });
    // Настоящая причина сохранена, а заметка про кап не задвоилась при повторном
    // применении лимита (сначала 2, теперь 1).
    expect(tightenedInfo.target_progress?.reason).toContain('Источники выбранного плана исчерпаны');
    expect(tightenedInfo.target_progress?.reason?.match(/Применён лимит/g)).toHaveLength(1);
    expect(tightenedInfo.target_progress?.reason).not.toContain('лимит 2');
    expect(tightenedInfo.relevance_summary).toMatchObject({ over_company_cap: 3 });
    expect(tightenedInfo.company_contact_cap).toMatchObject({ limit: 1, over_cap_rows: 1, companies: 2 });

    // Raising or removing the limit is NOT automatic: returning addresses need a
    // paid company-name check, so only the applied value is recorded.
    const loosenJob = { ...job, id: 'job-loosen' } as VeJob;
    const loosenDb = seed(finished, { ve_jobs: [loosenJob as unknown as Record<string, unknown>],
      ve_bases: [{ ...makeBase(finished), status: 'analyzed', data: capped.data, columns: capped.columns,
        row_count: capped.row_count, max_emails_per_company: null, contact_cap_applied: 2 }] });
    await runBaseCollectStage(loosenJob, { supabase: loosenDb as unknown as SupabaseClient });
    expect(loosenDb.updates.filter((update) => update.table === 've_bases' && Array.isArray(update.patch.data))).toHaveLength(0);
    expect(loosenDb.getRows('ve_bases')[0].data).toEqual(capped.data);

    // Raising the limit back is the specialist's explicit action, and it is offered:
    // the held-back addresses are in the reserve and a normal round returns them.
    // Nothing else in this base asks for a continuation, so the limit is the reason.
    const overCapRow = { company: 'Клиника Альфа', inn: '7700000001', email: 'a1@alpha.test', _email_status: 'ok',
      _ve_company_cap: { limit: 2 }, _ve_relevance: { version: 2, status: 'relevant', reason: 'ok', evidence: [{ field: 'description', quote: 'x' }], context_hash: 'a'.repeat(64) } };
    const heldBack = { id: 'b9', source: 'auto', status: 'analyzed', hypothesis_id: 'h1', collect_info: {
      collection_mode: 'preview', tasks: [], relevance_reserve: { version: 1, rows: [overCapRow] },
      target_progress: { mode: 'preview', status: 'limited', ready_rows: 3, ready_target: 500, round: 1, max_rounds: 100, max_candidates: 10_000, candidates_processed: 10 },
      target_checkpoint: { completed_round: 1 } } };
    expect(canResumePartialPreview({ ...heldBack, max_emails_per_company: 5, contact_cap_applied: 2 })).toBe(true);
    expect(canResumePartialPreview({ ...heldBack, max_emails_per_company: null, contact_cap_applied: 2 })).toBe(true);
    expect(canResumePartialPreview({ ...heldBack, max_emails_per_company: 2, contact_cap_applied: 2 })).toBe(false);
    expect(canResumePartialPreview({ ...heldBack, max_emails_per_company: 1, contact_cap_applied: 2 })).toBe(false);

    // Addresses already in the ready base stay when the limit shrinks the choice:
    // the reserve is merged in front of the base and must not flip the selection.
    const rows = ['x1', 'x2', 'x3'].map((name) => ({ company: 'Гамма', inn: '7700000003', email: `${name}@gamma.test`, _email_status: 'ok' }));
    expect(capVeContactsPerCompany(rows, { limit: 1, incumbentKeys: new Set([veRelevanceRowKey(rows[2])]) }).kept).toEqual([rows[2]]);
    expect(capVeContactsPerCompany(rows, { limit: null }).kept).toBe(rows);
    expect(normalizeVeMaxEmailsPerCompany(0)).toBeNull();
    expect(normalizeVeMaxEmailsPerCompany(101)).toBeNull();
    expect(normalizeVeMaxEmailsPerCompany(3)).toBe(3);
  });

  // База 1a69cda6 «Энергетические компании», 16.09.2026: 771 адрес от 39 компаний
  // (у первой 123) закрылись «цель достигнута». Распределение адресов по
  // компаниям — с прода; ИНН, названия и почты подставные.
  const ENERGY_ADDRESSES_PER_COMPANY = [123, 80, 73, 69, 55, 41, 37, 36, 35, 31, 29, 27, 26, 12, 12, 11, 11, 10, 7, 6, 6,
    5, 5, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const denseEnergyBase = (limit: number | null) => {
    const companies = ENERGY_ADDRESSES_PER_COMPANY.map((_, i) => ({
      company: `Энергокомпания ${i + 1}`, website: `energy${i + 1}.test`, inn: `77010${String(i + 1).padStart(5, '0')}` }));
    const contacts = companies.flatMap((company, i) => Array.from({ length: ENERGY_ADDRESSES_PER_COMPANY[i] }, (_, k) =>
      [company.company, company.website, `m${k + 1}@${company.website}`, company.inn, 'ok']));
    const info: VeCollectInfo = {
      ...collectInfo(companies.map((company) => unifiedRow(company)),
        { bc_job_id: 'bc-energy', status: 'dispatched', dispatched_at: '2026-09-16T00:00:00Z' }),
      collection_mode: 'preview', target_progress: createCollectionTarget('preview'), ready_target: 500,
    };
    const db = seed(info, { ve_bases: [{ ...makeBase(info), max_emails_per_company: limit }],
      base_constructor_jobs: [{ id: 'bc-energy', status: 'completed', selected_steps: ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'], ...contacts] }] });
    return { db, total: contacts.length };
  };

  it('counts at most three addresses of a company toward the goal when no limit is set, and keeps every address in the base', async () => {
    const { db, total } = denseEnergyBase(null);
    expect(total).toBe(771);
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const patch = db.updates.filter((update) => update.table === 've_bases' && Array.isArray(update.patch.data)).at(-1)!.patch;
    const info = patch.collect_info as VeCollectInfo;
    // Плотность — не охват: 39 компаний дают в цель 92 контакта (не больше 3 × 39 = 117).
    expect(info.target_progress).toMatchObject({ status: 'collecting', ready_rows: 92, ready_target: 500,
      ready_companies: 39, ready_contacts: 771, counted_per_company: 3 });
    expect(info.target_progress!.ready_rows).toBeLessThanOrEqual(117);
    expect(patch.status).toBe('collecting');
    expect(db.getRows('ve_jobs').find((row) => row.id === 'job-1')?.status).toBe('pending');
    // Выдача прежняя: без лимита специалиста готовая база хранит все 771 адрес.
    expect(patch.data).toHaveLength(771);
    expect(patch.row_count).toBe(771);
    expect(info.stats?.launchable_rows).toBe(771);
    expect(info.company_contact_cap).toBeUndefined();
    expect(info.relevance_reserve?.rows.some((row) => row._ve_company_cap)).toBe(false);
  });

  it('«Продолжить подготовку» недобранной плотной базы считает её недобранной и продолжает сбор', async () => {
    const { db } = denseEnergyBase(null);
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const patch = db.updates.filter((update) => update.table === 've_bases' && Array.isArray(update.patch.data)).at(-1)!.patch;
    const info = patch.collect_info as VeCollectInfo;
    // Сбор остановился недобранным: 92 из 500 в цели при 771 адресе в базе.
    // «Продолжить подготовку» пересчитывает сохранённые строки тем же правилом:
    // база остаётся недобранной и идёт дальше, а не закрывается «цель
    // достигнута» на тех же 771 адресах.
    const stopped: VeCollectInfo = { ...info, target_progress: { ...info.target_progress!, ready_rows: 92,
      round: info.target_checkpoint!.completed_round, status: 'limited', reason: 'Достигнут защитный предел кандидатов или раундов; цель ещё не набрана' } };
    const resumeDb = seed(stopped, { ve_bases: [{ ...makeBase(stopped), status: 'analyzed', data: patch.data,
      columns: patch.columns, row_count: patch.row_count, max_emails_per_company: null }] });
    await resumeDb.from('ve_jobs').update({ status: 'done' }).eq('id', makeJob().id);
    expect(canResumePartialPreview(resumeDb.getRows('ve_bases')[0])).toBe(true);
    await expect(enqueueVeBaseCollect(resumeDb as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000, resumeBaseId: 'b1' }))
      .resolves.toMatchObject({ ok: true, base: { id: 'b1' } });
    const resumeJob = resumeDb.getRows('ve_jobs').find((row) => row.status === 'pending')! as unknown as VeJob;
    await resumeDb.from('ve_jobs').update({ status: 'running' }).eq('id', resumeJob.id);
    await runBaseCollectStage({ ...resumeJob, status: 'running' }, { supabase: resumeDb as unknown as SupabaseClient });
    const resumed = resumeDb.getRows('ve_bases')[0];
    expect((resumed.collect_info as VeCollectInfo).target_progress).toMatchObject({ status: 'collecting', ready_rows: 92, ready_contacts: 771 });
    expect(resumed.status).toBe('collecting');
    expect(resumed.row_count).toBe(771);
  });

  it('keeps the specialist limit as the goal measure: every address of the capped base counts', async () => {
    const { db } = denseEnergyBase(5);
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const patch = db.updates.filter((update) => update.table === 've_bases' && Array.isArray(update.patch.data)).at(-1)!.patch;
    const info = patch.collect_info as VeCollectInfo;
    // Лимит 5, а не 3 по умолчанию: в базе и в цели одни и те же 139 адресов.
    expect(patch.data).toHaveLength(139);
    expect(info.target_progress).toMatchObject({ status: 'collecting', ready_rows: 139, ready_companies: 39 });
    expect(info.target_progress).not.toHaveProperty('ready_contacts');
    expect(info.target_progress).not.toHaveProperty('counted_per_company');
    expect(info.company_contact_cap).toMatchObject({ limit: 5, over_cap_rows: 632, companies: 39 });
  });

  // Очередная партия в сотню компаний по уже измеренному срезу источника; в
  // срезе uniqueCompanies. Возвращает итог раунда.
  const narrowPlants = Array.from({ length: 100 }, (_, i) => unifiedRow({
    company: `Завод ${i}`, website: `plant${i}.test`, email: `mail@plant${i}.test`, inn: `77${String(i).padStart(8, '0')}`,
    source_detail: 'Производит промышленные насосы на собственной площадке.',
  }));
  // Компании, проверенные прежними партиями: партия берёт не больше сотни, а
  // правило узкого рынка смотрит на все обработанные компании базы.
  const priorPlants = Array.from({ length: 220 }, (_, i) => unifiedRow({
    company: `Прежний завод ${i}`, website: `prior${i}.test`, inn: `78${String(i).padStart(8, '0')}`, source_detail: 'реестр' }));
  const narrowHistory = (widenings: number): Partial<VeCollectInfo> => ({
    adaptive_collection: { ...newVeAdaptiveCollection(), widenings },
    relevance_reserve: { version: 1, rows: [], source_rows: priorPlants },
  });
  // Срез уже расширялся дважды: расширять автоматически больше нечем.
  const noWidening = narrowHistory(2);
  const populationReply = (unique: number, available = unique, slices = [unique]) => ({ data: {
    directory_rows_total: unique, companies_unique_total: unique, companies_available: available,
    companies_with_email: unique, companies_with_phone: unique, slice_companies: slices } });
  const runNarrowMarket = async (population: ReturnType<typeof populationReply>, constructorRows: string[][],
    extra: Partial<VeCollectInfo> = noWidening, otherBases: Array<Record<string, unknown>> = []) => {
    const info: VeCollectInfo = {
      ...collectInfo(narrowPlants, { bc_job_id: 'bc-narrow', status: 'dispatched', dispatched_at: '2026-09-20T00:00:00Z' }),
      collection_mode: 'preview', ready_target: 500,
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 900 },
      target_checkpoint: { completed_round: 1, seen_rows: [], processed_rows: 900, low_relevance: 0, relevance_unchecked: 0 },
      // Прежняя оценка: посчитана до исправления, при сборке пересчитается.
      estimate: { version: 2, unique_companies: 0, companies_with_email: 0,
        population_matches_source: false, population_as_of: new Date().toISOString() },
      stats: { tasks_total: 1, tasks_done: 1, tasks_failed: 0, rows_total: 900, excluded_existing_bases: 0, excluded_during_fetch: 0 },
      ...extra,
    };
    const db = createMockSupabase({ tables: {
      ve_bases: [makeBase(info), ...otherBases], ve_verticals: [VERTICAL], ve_projects: [PROJECT],
      ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', title: 'Сети частных клиник',
        description: 'Частные клиники с собственным сайтом и действующим бизнесом.', status: 'accepted' }],
      ve_jobs: [makeJob() as unknown as Record<string, unknown>],
      base_constructor_jobs: [{ id: 'bc-narrow', status: 'completed', error_message: null,
        selected_steps: ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'], ...constructorRows],
        result_stats: { total_rows: constructorRows.length, emails_found: constructorRows.length } }],
    }, rpcHandlers: { ve_directory_plan_population: () => population } });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const patch = db.updates.filter((u) => u.table === 've_bases' && (u.patch.collect_info as VeCollectInfo)?.target_progress).at(-1)!.patch;
    return { info: patch.collect_info as VeCollectInfo, db };
  };
  const runNarrowMarketRound = async (uniqueCompanies: number, constructorRows: string[][], extra: Partial<VeCollectInfo> = noWidening) =>
    (await runNarrowMarket(populationReply(uniqueCompanies), constructorRows, extra)).info.target_progress!;
  // Выход как у реальных баз: годной почтой заканчивается меньше десятой части компаний.
  const lowYieldRows = narrowPlants.map((row, i) => [row.company, row.website, row.email, row.inn, i < 30 ? 'ok' : 'invalid']);

  it('stops a hypothesis whose market cannot reach the target instead of grinding to the candidate cap', async () => {
    // Узкая гипотеза раньше шла к потолку в 10 000 компаний: каждый следующий
    // раунд просил БОЛЬШЕ компаний, и за каждую платили чтением сайта и SMTP.
    // Реалистичный выход: годной почтой заканчивается меньше десятой части компаний.
    const run = (uniqueCompanies: number) => runNarrowMarketRound(uniqueCompanies, lowYieldRows);
    // 320 компаний из 1000 проверено, выход низкий: остаток даст ~64 контакта,
    // до сотни не дотянуть. Срез уже расширялся дважды — база завершается.
    const stopped = await run(1000);
    expect(stopped.status).toBe('limited');
    expect(stopped.reason).toContain('Рынок гипотезы исчерпан');
    expect(stopped.reason).toContain('осталось примерно 64 контактов (≈64 компаний)');
    expect(stopped.reason).toContain('Срез уже расширялся автоматически (2 из 2)');
    // Статус терминальный и раунд совпадает с завершённым: «Продолжить подготовку» доступна.
    expect(stopped.round).toBe(2);
    // Широкий срез не останавливаем.
    expect((await run(200_000)).status).not.toBe('limited');
    // Узкая, но полезная база продолжает сбор: 7 500 компаний в срезе при том же
    // выходе дают сотни контактов. Порог абсолютный, сто контактов, а не доля
    // цели: узкая гипотеза на 200-300 контактов — маленькая, но полезная база.
    expect((await run(7_500)).status).not.toBe('limited');
  });

  it('forecasts a narrow market in goal units: extra addresses of the same companies do not widen it', async () => {
    // 20 заводов по 6 проверенных адресов: 120 строк, но в цель идут по 3 адреса
    // компании — 60. Срез в 400 компаний при таком выходе даёт ещё ~15 контактов,
    // то есть база не наберёт и 100. По строкам прогноз был бы 150, и сбор шёл бы дальше.
    const denseRows = narrowPlants.flatMap((row, i) => i < 20
      ? Array.from({ length: 6 }, (_, k) => [row.company, row.website, `m${k + 1}@${row.website}`, row.inn, 'ok'])
      : [[row.company, row.website, row.email, row.inn, 'invalid']]);
    const stopped = await runNarrowMarketRound(400, denseRows);
    expect(stopped).toMatchObject({ status: 'limited', ready_rows: 60, ready_contacts: 120, ready_companies: 20 });
    expect(stopped.reason).toContain('Рынок гипотезы исчерпан');
    expect(stopped.reason).toContain('сверх собранных 60');
  });

  // Реальный срез базы f1bb9ccf «Мясопереработка»: ОКВЭД 10.1, выручка от 100 млн,
  // штат от 20. С порогами — 954 компании (замер на проде 23.09.2026), без них 3 380.
  const MEAT_101 = { source: 'companies_directory' as const, rationale: 'Мясопереработка из реестра',
    directory_filters: { includeIp: false, okvedCodes: ['10.1'], revenueFrom: 100_000_000, employeesFrom: 20 } };
  const withTasks = (...tasks: NonNullable<VeCollectInfo['plan']>['tasks']): Partial<VeCollectInfo> => ({
    plan: { tasks },
    tasks: tasks.map((task, index) => index === 0
      ? { source: task.source, status: 'done' as const, child_job_id: null, rows: narrowPlants.length, task, harvest: narrowPlants }
      : { source: task.source, status: 'done' as const, child_job_id: null, rows: 0, task }),
  });

  it('does not stop a narrow slice while it can still widen: opens the second queue or asks for a new slice', async () => {
    // По прогнозу срез мал (954 компании: ещё ~59 контактов сверх 30), но пороги
    // выручки и штата придумал планировщик. Раньше база здесь завершалась.
    const widened = await runNarrowMarket(populationReply(954), lowYieldRows, { ...narrowHistory(0), ...withTasks(MEAT_101) });
    expect(widened.info.target_progress).toMatchObject({ status: 'collecting', round: 3 });
    expect(widened.info.target_progress).not.toHaveProperty('reason');
    expect(widened.info.tasks).toHaveLength(2);
    expect(widened.info.tasks![1]).toMatchObject({ status: 'pending', task: { widened: 'second_queue',
      directory_filters: { includeIp: false, okvedCodes: ['10.1'] } } });
    expect(widened.info.tasks![1].task.directory_filters).not.toHaveProperty('revenueFrom');
    expect(widened.info.adaptive_collection).toMatchObject({ widenings: 1 });
    expect(widened.info.adaptive_collection?.note).toContain('Текущий срез мал для базы по прогнозу');
    // Второй очереди нет (порогов нет) — один раз просим новый срез того же рынка.
    const replan = await runNarrowMarket(populationReply(1000), lowYieldRows, narrowHistory(0));
    expect(replan.info.target_progress).toMatchObject({ status: 'collecting' });
    expect(replan.info.adaptive_collection).toMatchObject({ widenings: 1, replan_needed: true, replan_reason: 'plan_exhausted' });
  });

  it('forecasts after an interrupted last batch: unchecked companies no longer hide the estimate', async () => {
    // Десяти компаниям партии конструктор не вернул строк: партия не разобрана
    // до конца. Так заканчивается почти каждая база (68 из 83 на 22.09.2026),
    // и прогноза не было ни у одной.
    const { info } = await runNarrowMarket(populationReply(7_500), lowYieldRows.slice(0, 90));
    expect(info.relevance_summary?.unchecked).toBeGreaterThan(0);
    expect(info.estimate?.estimate_reason).toBeUndefined();
    expect(info.estimate?.remaining_ready_estimate).toMatchObject({
      // (7 500 − 320 просмотренных) × 30 готовых / 320 обработанных.
      contacts: 673, companies: 673, remaining_companies: 7_180, source_population: 7_500, confidence: 'low',
    });
    expect(info.estimate?.remaining_ready_estimate?.scope).toContain('Последняя партия проверена не полностью');
  });

  it('counts overlapping registry slices once and leaves out companies of other bases in the project', async () => {
    // План с двумя пересекающимися срезами: 86.2 входит в 86. Реальные размеры
    // с прода: 26 337 и 52 992 компании, объединение — 52 992, а не 79 329.
    const dentistry = { source: 'companies_directory' as const, rationale: 'Стоматологии', directory_filters: { includeIp: false, okvedCodes: ['86.2'] } };
    const health = { source: 'companies_directory' as const, rationale: 'Медицина', directory_filters: { includeIp: false, okvedCodes: ['86'] } };
    const otherBase = { ...makeBase({}), id: 'b2', hypothesis_id: 'h2', source: 'upload', status: 'analyzed',
      columns: ['company', 'email', 'inn'],
      data: [{ company: 'Клиника соседей', email: 'hi@neighbour.test', inn: '7799000001' },
        // Эту компанию база уже проверила сама: она вычитается как просмотренная, а не как чужая.
        { company: priorPlants[5].company, email: 'hi@prior5.test', inn: priorPlants[5].inn }] };
    const { info, db } = await runNarrowMarket(populationReply(52_992, 52_991, [26_337, 52_992]), lowYieldRows,
      { ...noWidening, ...withTasks(dentistry, health) }, [otherBase]);
    const calls = db.rpcCalls.filter((call) => call.fn === 've_directory_plan_population');
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      p_slices: [
        { okved_prefixes: ['86.2'], region_codes: null, include_ip: false, has_email: false },
        { okved_prefixes: ['86'], region_codes: null, include_ip: false, has_email: false },
      ],
      p_exclude_inns: ['7799000001'],
    });
    expect(info.estimate).toMatchObject({ population_matches_source: true, unique_companies: 52_992,
      available_companies: 52_991, slice_companies: [26_337, 52_992] });
    expect(info.estimate?.note).toBeUndefined();
    expect(info.estimate?.remaining_ready_estimate).toMatchObject({
      source_population: 52_991, remaining_companies: 52_991 - 320, contacts: Math.round((52_991 - 320) * 30 / 320) });
  });

  it('forecasts the registry part of a plan with a sizeless source and does not stop while that source is live', async () => {
    // Раньше прогноз требовал плана из одной задачи: 81 база из 89 его не имела.
    const maps = { source: 'yandex_maps' as const, rationale: 'Каталог карт', maps_query: { queries: ['Насосы'], geo: 'Россия' } };
    const live = await runNarrowMarket(populationReply(1000), lowYieldRows, { ...noWidening, ...withTasks(DIRECTORY_TASK, maps) });
    expect(live.info.estimate).toMatchObject({ population_matches_source: true, unsized_sources: ['Яндекс Карты'] });
    expect(live.info.estimate?.remaining_ready_estimate).toMatchObject({ contacts: 64, companies: 64 });
    expect(live.info.estimate?.remaining_ready_estimate?.scope).toContain('источники без размера рынка: Яндекс Карты');
    // Размер карт неизвестен: пока каталог жив, малый реестр — не повод завершать базу.
    expect(live.info.target_progress?.status).toBe('collecting');
    const exhaustedMaps = { ...noWidening, ...withTasks(DIRECTORY_TASK, maps) };
    exhaustedMaps.tasks![1].exhausted = true;
    const stopped = await runNarrowMarket(populationReply(1000), lowYieldRows, exhaustedMaps);
    expect(stopped.info.target_progress).toMatchObject({ status: 'limited', reason: expect.stringContaining('Рынок гипотезы исчерпан') });
  });

  it('does not claim launch-ready recipients after a failed partial validation', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-partial-failed',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Частичная',
            website: 'partial.test',
            email: 'unchecked@partial.test',
            inn: '7700000088',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc-partial-failed',
            status: 'failed',
            error_message: 'validator unavailable',
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            // Partial checkpoint has no row-level validation column yet.
            data: [
              ['Компания', 'Сайт', 'Email', 'ИНН'],
              ['Клиника Частичная', 'partial.test', 'unchecked@partial.test', '7700000088'],
            ],
          },
        ],
      },
    );

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 1,
      low_relevance: 0,
    });
    expect(storedInfo.stats).not.toHaveProperty('launchable_rows');
  });

  it('fails closed when relevance coverage leaves a valid-email company unchecked', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-relevance-partial',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Проверенная',
            website: 'checked.test',
            email: 'hello@checked.test',
            inn: '7700000101',
          }),
          unifiedRow({
            company: 'Клиника Без Вердикта',
            website: 'unchecked.test',
            email: 'hello@unchecked.test',
            inn: '7700000102',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc-relevance-partial',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Проверенная', 'checked.test', 'hello@checked.test', '', '', '',
                '86.2', '', '', '7700000101', 'реестр', 'ok',
              ],
              [
                'Клиника Без Вердикта', 'unchecked.test', 'hello@unchecked.test', '', '', '',
                '86.2', '', '', '7700000102', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );
    mockFindIrrelevantRows.mockResolvedValueOnce({
      flagged: new Set<number>(),
      unchecked: new Set<number>([1]),
      coverage: {
        checkedCompanies: 1,
        totalCompanies: 2,
        complete: false,
      },
      tokensUsed: 7,
      costUsd: 0.001,
    });

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows[0]).not.toHaveProperty('_relevance_unchecked');
    expect(storedRows[1]).toEqual(expect.objectContaining({
      email: 'hello@unchecked.test',
      _email_status: 'ok',
      _relevance_unchecked: true,
    }));

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 2,
      processed_rows: 2,
      launchable_rows: 1,
      relevance_unchecked: 1,
      relevance_checked_companies: 1,
      relevance_total_companies: 2,
      relevance_coverage_complete: false,
    });
  });
});

describe('VE2 auto email validation gate', () => {
  it('excludes auto rows with a missing or empty validation status', () => {
    const audience = prepareSegmentationAudience({
      rows: [
        { company: 'Подтверждённая', email: 'ok@example.test', _email_status: 'ok' },
        { company: 'Без статуса', email: 'missing@example.test' },
        { company: 'Пустой статус', email: 'empty@example.test', _email_status: '' },
      ],
      columns: ['company', 'email'],
      source: 'auto',
    });

    expect(audience.leads.map((lead) => lead.email)).toEqual(['ok@example.test']);
    expect(audience.excluded.invalidEmailStatus).toBe(2);
  });

  it('does not turn a partial constructor row without a verdict into a launch lead', () => {
    const audience = prepareSegmentationAudience({
      rows: [{ company: 'Частичная', email: 'unchecked@example.test' }],
      columns: ['company', 'email'],
      source: 'auto',
    });

    expect(audience.leads).toEqual([]);
    expect(audience.excluded.invalidEmailStatus).toBe(1);
  });

  it('refill admits ok and catch-all and fails closed without status data', () => {
    const rows = [
      unifiedRow({ company: 'OK', email: 'ok@example.test' }),
      unifiedRow({ company: 'Catch-all', email: 'catch@example.test' }),
      unifiedRow({ company: 'Без статуса', email: 'missing@example.test' }),
      unifiedRow({ company: 'Пустой статус', email: 'empty@example.test' }),
    ];

    expect(selectRefillLeadRows(rows, ['ok', 'catch_all', null, ''])).toMatchObject({
      leadRows: [expect.objectContaining({ email: 'ok@example.test' }), expect.objectContaining({ email: 'catch@example.test' })],
      withEmail: 4,
      valid: 2,
    });
    expect(selectRefillLeadRows(rows, null)).toMatchObject({
      leadRows: [],
      withEmail: 4,
      valid: 0,
    });
  });
});

describe('VE2 source-row email preservation', () => {
  it('keeps every email returned by Google Maps for the constructor split', () => {
    const row = mapGoogleRow({
      name: 'Clinic',
      website: 'clinic.test',
      emails: ['first@clinic.test', 'second@clinic.test'],
    });

    expect(row.email).toBe('first@clinic.test, second@clinic.test');
    const dirty = unifiedRow({ company: 'Agency', website: 'http://exclusive@century21.ru/', email: 'second@agency.test', source_detail: 'hh' });
    const clean = normalizeVeSourceContacts(dirty);
    expect(clean.website).toBe('');
    expect(clean.email).toBe('second@agency.test, exclusive@century21.ru');
    expect(clean.source_detail).toContain(dirty.website);
    expect(dirty.website).toBe('http://exclusive@century21.ru/');
    expect(normalizeVeSourceContacts({ ...dirty, email: '', website: 'https://agency.test/?ref=tracking@foreign.test' }).email).toBe('');
    expect(veAcquisitionReceipt({ ...dirty, address: 'Москва' })).not.toBe(veAcquisitionReceipt({ ...dirty, address: 'Тула' }));

    // Saved HH employer metadata must survive mapping, without turning a
    // vacancy title or an industry label into a validation verdict.
    const hh = mapHhRow({ company_name: 'Студия', company_site_url: 'studio.test', name: 'Художник', area: 'Москва',
      company_description: '<style>hidden</style><p>Создаём игры.</p><p>Издатель &quot;Мир&quot; &amp; студия &#x1F3AE;.</p><script>ignore()</script>',
      industries: [' Разработка компьютерных игр ', { id: '1', name: 'Анимация &amp; VFX' }, null,
        'Разработка компьютерных игр', { id: '2' }, 123],
      description: 'Описание вакансии не заменяет описание компании', _email_status: 'ok', _ve_relevance: { status: 'relevant' },
    }, 'игровой художник');
    expect(hh).toMatchObject({ company: 'Студия', website: 'studio.test', vacancy_title: 'Художник', address: 'Москва',
      category: 'Разработка компьютерных игр\nАнимация & VFX', description: 'Создаём игры. Издатель "Мир" & студия 🎮.',
      email: '', source_detail: 'hh: игровой художник' });
    expect(hh).not.toHaveProperty('_email_status');
    expect(hh).not.toHaveProperty('_ve_relevance');
    const boundedHh = mapHhRow({ industries: ['А'.repeat(599) + '🎮'],
      company_description: 'Б'.repeat(1999) + '🎮' }, '');
    expect(boundedHh.category).toBe('А'.repeat(599));
    expect(boundedHh.description).toBe('Б'.repeat(1999));
    expect(mapHhRow({ company_description: '\u0000\uD800&#xD800;&#x110000;&#999999999999999999999999;' }, ''))
      .not.toHaveProperty('description');
    expect(mapHhRow({ company_description: { html: 'Not a string' }, industries: { name: 123 } }, '').category).toBe('');
    const withoutMetadata = mapHhRow({ company_name: 'Студия', name: 'Дизайнер' }, 'дизайнер');
    expect(Object.keys(withoutMetadata)).toEqual([...VE_AUTO_COLLECT_COLUMNS]);
    expect(withoutMetadata.category).toBe('');
  });

  it('merges emails when duplicate company and website rows collapse', () => {
    const rows = dedupUnifiedRows([
      unifiedRow({
        company: 'ООО Клиника',
        website: 'https://clinic.test/about',
        email: 'first@clinic.test',
      }),
      unifiedRow({
        company: 'Клиника ООО',
        website: 'www.clinic.test',
        email: 'second@clinic.test',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('first@clinic.test, second@clinic.test');
  });
});

describe('VE2 cross-base contact exclusion', () => {
  it('waits for an older collecting base in the same project before dispatching work', async () => {
    const info = collectInfo([
      unifiedRow({
        company: 'Клиника Новая',
        website: 'new.test',
        email: 'new@example.test',
        inn: '7700000333',
      }),
    ]);
    const current = {
      ...makeBase(info),
      id: 'b-new',
      created_at: '2026-08-30T00:02:00Z',
    };
    const older = {
      ...makeBase(collectInfo([])),
      id: 'b-old',
      vertical_id: 'another-vertical',
      created_at: '2026-08-30T00:01:00Z',
    };
    const db = seed(info, {
      ve_bases: [current, older],
      ve_jobs: [
        {
          id: 'job-old',
          project_id: 'p1',
          stage: 'base_collect',
          status: 'pending',
          payload: { base_id: 'b-old', hypothesis_id: 'h1' },
        },
      ],
    });

    await expect(
      runBaseCollectStage(
        { ...makeJob(), payload: { base_id: 'b-new', hypothesis_id: 'h1' } },
        { supabase: db as unknown as SupabaseClient },
      ),
    ).resolves.toMatchObject({
      result: { waiting: true, base_id: 'b-new', waiting_for_base_id: 'b-old' },
    });

    expect(db.inserts).toEqual([]);
    expect(db.updates).toContainEqual(expect.objectContaining({
      table: 've_jobs',
      patch: expect.objectContaining({ status: 'pending' }),
    }));
    expect(lastBasePatch(db)?.collect_info).toMatchObject({ waiting_for_base_id: 'b-old' });
    const queueWrites = db.updates.filter((update) => update.table === 've_bases').length;
    const waitingJob = { ...makeJob(), payload: { base_id: 'b-new', hypothesis_id: 'h1' } };
    await runBaseCollectStage(waitingJob, { supabase: db as unknown as SupabaseClient });
    expect(db.updates.filter((update) => update.table === 've_bases')).toHaveLength(queueWrites);

    // Independent hypotheses can dispatch while the first base is collecting.
    await db.from('ve_bases').update({ hypothesis_id: 'another-hypothesis' }).eq('id', 'b-old');
    await expect(
      runBaseCollectStage(waitingJob, { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { waiting: true, construct: 'dispatched' } });
    expect(lastBasePatch(db)?.collect_info).not.toHaveProperty('waiting_for_base_id');
    expect((lastBasePatch(db)?.collect_info as VeCollectInfo).stats).toMatchObject({ rows_total: 1 });
  });

  it('does not wait forever for an old collecting base without a live worker job', async () => {
    const info: VeCollectInfo = { ...collectInfo([
      unifiedRow({
        company: 'Клиника Новая',
        website: 'new.test',
        email: 'new@example.test',
        inn: '7700000333',
      }),
    ]), waiting_for_base_id: 'b-stale' };
    const current = {
      ...makeBase(info),
      id: 'b-new',
      created_at: '2026-08-30T00:02:00Z',
    };
    const stale = {
      ...makeBase(collectInfo([])),
      id: 'b-stale',
      created_at: '2026-08-30T00:01:00Z',
    };
    const db = seed(info, { ve_bases: [current, stale] });

    const result = await runBaseCollectStage(
      { ...makeJob(), payload: { base_id: 'b-new', hypothesis_id: 'h1' } },
      { supabase: db as unknown as SupabaseClient },
    );

    expect(result.result).not.toHaveProperty('waiting_for_base_id');
    expect(lastBasePatch(db)?.collect_info).not.toHaveProperty('waiting_for_base_id');
    expect(db.inserts).toContainEqual(expect.objectContaining({ table: 'base_constructor_jobs' }));
  });

  it('treats every email in another base as occupied even when company and inn differ', () => {
    const keys = buildBaseExclusionKeysFromRows([
      {
        company: 'ООО Старое имя',
        inn: '7700000001',
        email: 'owner@example.test, Shared@Example.test',
      },
    ]);

    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Совсем другая компания',
      inn: '7800000002',
      email: 'shared@example.test',
    }))).toBe(true);
    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Совсем другая компания',
      inn: '7800000002',
      email: 'fresh@example.test',
    }))).toBe(false);
  });

  it('keeps a multi-email row when at least one contact is still unused', () => {
    const keys = buildBaseExclusionKeysFromRows([
      {
        company: 'Старая компания',
        inn: '7700000001',
        email: 'used@example.test',
      },
    ]);

    const partial = unifiedRow({
      company: 'Новая компания',
      inn: '7800000002',
      email: 'used@example.test, fresh@example.test',
    });
    expect(baseRowMatchesExclusion(keys, partial)).toBe(false);
    expect(pruneBaseRowAgainstExclusion(keys, partial)).toMatchObject({
      email: 'fresh@example.test',
    });
    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Новая компания',
      inn: '7800000002',
      email: 'used@example.test',
    }))).toBe(true);
  });

  it('reads localized email, company and INN aliases from uploaded bases', () => {
    const keys = buildBaseExclusionKeysFromRows([
      {
        Компания: 'ООО Альфа',
        ИНН: '7700000123',
        'E-mail': 'Owner@Alpha.test',
      },
    ]);

    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Другая компания',
      inn: '7800000456',
      email: 'owner@alpha.test',
    }))).toBe(true);
    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Другая компания',
      inn: '7700000123',
      email: 'fresh@other.test',
    }))).toBe(true);
    // A matching generic name without INN or website does not prove that this
    // new contact belongs to the company already present in the uploaded base.
    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Альфа ООО',
      inn: '',
      email: 'fresh@other.test',
    }))).toBe(false);
  });

  it('rechecks other project bases after constructor import and drops duplicate emails', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-post-construct-dedup',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const currentHarvest = [
      unifiedRow({
        company: 'Клиника Новое Имя',
        website: 'new-name.test',
        email: 'source@new-name.test',
        inn: '7700000111',
      }),
    ];
    const db = seed(
      collectInfo(currentHarvest, dispatched),
      {
        ve_bases: [
          makeBase(collectInfo(currentHarvest, dispatched)),
          {
            id: 'b-other',
            project_id: 'p1',
            vertical_id: 'v1',
            hypothesis_id: 'h2',
            filename: 'other',
            row_count: 1,
            columns: [],
            sample_rows: [],
            data: [
              {
                company: 'Клиника Старое Имя',
                website: 'old-name.test',
                email: 'found@clinic.test',
                inn: '7800000222',
              },
            ],
            status: 'analyzed',
            source: 'auto',
            collect_info: {},
            error: null,
          },
        ],
        base_constructor_jobs: [
          {
            id: 'bc-post-construct-dedup',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Новое Имя', 'new-name.test', 'found@clinic.test', '', '', '',
                '86.2', '', '', '7700000111', 'реестр', 'ok',
              ],
              [
                'Клиника Новое Имя', 'new-name.test', 'fresh@clinic.test', '', '', '',
                '86.2', '', '', '7700000111', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows.map((row) => row.email)).toEqual(['fresh@clinic.test']);
    expect(lastBasePatch(db)?.row_count).toBe(1);

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 1,
      excluded_existing_bases: 1,
      excluded_existing_bases_after_construct: 1,
      launchable_rows: 1,
    });

    // Project exclusions use only already present identifiers. Block known
    // matches before paid admission; an anonymous Gmail contact stays eligible.
    const policy = { project_id: 'p1', revision: 1, inns: ['7700000101', '7700000102'],
      domains: ['blocked.test'], emails: [], updated_at: '2026-10-12T10:00:00Z' };
    const candidates = [
      unifiedRow({ company: 'Excluded by INN', inn: '7700000101', website: 'known.test', email: 'mail@known.test' }),
      unifiedRow({ company: 'Excluded by domain', website: 'sales.blocked.test', email: 'mail@sales.blocked.test' }),
      unifiedRow({ company: 'Allowed clinic', inn: '7700000103', website: 'allowed.test', email: 'mail@allowed.test' }),
      unifiedRow({ company: 'Identity appears later', email: 'later@gmail.com' }),
      unifiedRow({ company: 'Unidentified clinic', email: 'unknown@gmail.com' }),
    ];
    const excludedInfo: VeCollectInfo = { ...collectInfo(candidates), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview'), adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 } };
    excludedInfo.tasks![0].exhausted = true;
    const policyDb = seed(excludedInfo, { ve_project_exclusions: [policy,
      { project_id: 'another-project', revision: 9, inns: ['7700000103'], domains: ['allowed.test'], emails: [] }] });
    const policyClient = policyDb as unknown as SupabaseClient;
    const gateCalls = mockFindIrrelevantRows.mock.calls.length;
    const sourceCalls = jest.mocked(fetchVeRelevanceEvidence).mock.calls.length;
    await runBaseCollectStage(makeJob(), { supabase: policyClient });
    const child = policyDb.getRows('base_constructor_jobs')[0];
    expect(policyDb.getRows('base_constructor_jobs')).toHaveLength(1);
    const inputGrid = child.data as string[][];
    expect(inputGrid).toHaveLength(4);
    expect(inputGrid.slice(1).map((row) => row[0])).toEqual(expect.arrayContaining([
      'Allowed clinic', 'Identity appears later', 'Unidentified clinic',
    ]));
    expect(inputGrid.flat()).not.toContain('Excluded by INN');
    expect(inputGrid.flat()).not.toContain('Excluded by domain');
    const innColumn = inputGrid[0].indexOf('ИНН');
    expect(innColumn).toBeGreaterThanOrEqual(0);
    const outputGrid = inputGrid.slice(1).map((row) => {
      const values = [...row];
      if (values[0] === 'Identity appears later') values[innColumn] = '7700000102';
      return [...values, 'ok'];
    });
    await policyDb.from('base_constructor_jobs').update({ status: 'completed',
      data: [[...inputGrid[0], 'Email Статус'], ...outputGrid] }).eq('id', child.id);
    await policyDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    await runBaseCollectStage(makeJob(), { supabase: policyClient });
    const finished = policyDb.getRows('ve_bases')[0];
    expect((finished.data as Array<Record<string, unknown>>).map((row) => row.email).sort())
      .toEqual(['mail@allowed.test', 'unknown@gmail.com']);
    expect(finished.collect_info).toMatchObject({ project_exclusions: {
      revision: 1, mode: 'existing_identity', blocked_rows: 1, unidentified_rows: 1,
    }, target_progress: { candidates_processed: 3, max_candidates: 10_000 },
    project_exclusion_reserve: { rows: [expect.objectContaining({ email: 'later@gmail.com', inn: '7700000102', _email_status: 'ok' })] } });
    expect(stripTaskHarvest(finished).collect_info).not.toHaveProperty('project_exclusion_reserve');
    expect(mockFindIrrelevantRows.mock.calls.slice(gateCalls).flatMap(([request]) => request.rows)
      .some((row: Record<string, unknown>) => row.inn === '7700000102')).toBe(false);
    expect(jest.mocked(fetchVeRelevanceEvidence).mock.calls.length).toBe(sourceCalls);
    await runBaseCollectStage(makeJob(), { supabase: policyClient });
    expect(policyDb.getRows('base_constructor_jobs')).toHaveLength(1);

    // Removing a rule does not start a job or repeat paid acquisition. At the
    // next explicit saved-only review, its existing email verdict is retained
    // and only the never-reviewed observation joins the normal relevance gate.
    await policyDb.from('ve_project_exclusions').update({ revision: 2, inns: ['7700000101'] }).eq('project_id', 'p1');
    const resumeInfo = policyDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    await policyDb.from('ve_bases').update({ status: 'collecting', collect_info: {
      ...resumeInfo, relevance_review_requested: true,
    } }).eq('id', 'b1');
    await policyDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
    const restoredGateCalls = mockFindIrrelevantRows.mock.calls.length;
    await runBaseCollectStage(makeJob(), { supabase: policyClient });
    expect((policyDb.getRows('ve_bases')[0].data as Array<Record<string, unknown>>).map((row) => row.email).sort())
      .toEqual(['later@gmail.com', 'mail@allowed.test', 'unknown@gmail.com']);
    expect(mockFindIrrelevantRows.mock.calls.slice(restoredGateCalls).flatMap(([request]) => request.rows)
      .some((row: Record<string, unknown>) => row.inn === '7700000102')).toBe(true);
    expect(policyDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(policyDb.getRows('ve_bases')[0].collect_info).toMatchObject({
      project_exclusion_reserve: { rows: [] }, target_progress: { candidates_processed: 3 },
    });

    // A reserved batch may be disallowed between its durable checkpoint and
    // child insertion. Complete that same reservation locally with no paid
    // worker claim, instead of hanging forever or creating another child.
    const reservedInfo: VeCollectInfo = { ...collectInfo([candidates[0]]), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview'), adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 },
      preview_pipeline: { version: 1, revision: 0, batches: [{ id: 'policy-reserved-child',
        rows: [candidates[0]], dispatched_at: '2026-10-12T10:00:00Z' }] } };
    reservedInfo.tasks![0].exhausted = true;
    const reservedDb = seed(reservedInfo, { ve_project_exclusions: [policy] });
    const reservedGateCalls = mockFindIrrelevantRows.mock.calls.length;
    await runBaseCollectStage(makeJob(), { supabase: reservedDb as unknown as SupabaseClient });
    expect(reservedDb.getRows('base_constructor_jobs')).toEqual([expect.objectContaining({
      id: 'policy-reserved-child', status: 'completed', initial_row_count: 0,
    })]);
    expect(reservedDb.getRows('ve_bases')[0]).toMatchObject({ row_count: 0, data: [] });
    expect(mockFindIrrelevantRows.mock.calls.length).toBe(reservedGateCalls);

    const emailReservedDb = seed(reservedInfo, { ve_project_exclusions: [{ ...policy,
      inns: [], domains: [], emails: ['mail@known.test'],
    }] });
    await runBaseCollectStage(makeJob(), { supabase: emailReservedDb as unknown as SupabaseClient });
    expect(emailReservedDb.getRows('base_constructor_jobs')).toEqual([expect.objectContaining({
      id: 'policy-reserved-child', status: 'completed', initial_row_count: 0,
    })]);
    expect(emailReservedDb.getRows('ve_bases')[0]).toMatchObject({ row_count: 0, data: [] });
    expect(mockFindIrrelevantRows.mock.calls.length).toBe(reservedGateCalls);

    // An unavailable policy is different from an unidentified company. It
    // stops before any paid work instead of silently treating rules as empty.
    const unreadableDb = createMockSupabase({ tables: {
      ve_bases: [makeBase(collectInfo([candidates[2]]))], ve_jobs: [makeJob() as unknown as Record<string, unknown>],
    }, errorTables: { ve_project_exclusions: 'database unavailable' } });
    await expect(runBaseCollectStage(makeJob(), { supabase: unreadableDb as unknown as SupabaseClient }))
      .rejects.toThrow('Не удалось проверить исключения проекта');
    expect(unreadableDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(mockFindIrrelevantRows.mock.calls.length).toBe(reservedGateCalls);

    // A rule changed during the last paid phase must still win publication.
    // No second cleanup call or another constructor is needed to enforce it.
    const changing = seed({ ...collectInfo([candidates[2]], dispatched), collection_mode: 'preview',
      target_progress: createCollectionTarget('preview'), adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 } },
    { ve_project_exclusions: [{ ...policy, inns: [], domains: [] }], base_constructor_jobs: [{
      id: dispatched.bc_job_id, status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
      data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
        ['Allowed clinic', 'allowed.test', 'mail@allowed.test', '7700000103', 'ok']],
    }] });
    (changing.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0].exhausted = true;
    const nameCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
    const cleanNames = jest.mocked(callLLMWithSchema).getMockImplementation()!;
    jest.mocked(callLLMWithSchema).mockImplementationOnce(async (...args) => {
      await changing.from('ve_project_exclusions').update({ revision: 2, domains: ['allowed.test'] }).eq('project_id', 'p1');
      return cleanNames(...args);
    });
    await runBaseCollectStage(makeJob(), { supabase: changing as unknown as SupabaseClient });
    expect(changing.getRows('ve_bases')[0]).toMatchObject({ row_count: 0, data: [], collect_info: {
      project_exclusions: { revision: 2, blocked_rows: 1 }, target_progress: { ready_rows: 0 },
      project_exclusion_reserve: { rows: [expect.objectContaining({ email: 'mail@allowed.test' })] },
    } });
    expect(jest.mocked(callLLMWithSchema).mock.calls.length).toBe(nameCalls + 1);
    expect(changing.getRows('base_constructor_jobs')).toHaveLength(1);

    // A saved split result may contain multiple recipients from one company.
    // Exact email rules remove only that recipient, without another constructor.
    for (const [sourceEmail, legacyChild] of [
      ['mail@allowed.test, other@allowed.test', false], ['mail@allowed.test', false], ['mail@allowed.test', true],
    ] as const) {
      const emailSplitDb = seed({ ...collectInfo([{ ...candidates[2], email: sourceEmail }],
        { ...dispatched, dispatched_at: new Date().toISOString() }), collection_mode: 'preview',
        target_progress: createCollectionTarget('preview'), adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2 } },
      { ve_project_exclusions: [{ ...policy, inns: [], domains: [], emails: ['mail@allowed.test'] }],
        base_constructor_jobs: [{ id: dispatched.bc_job_id, status: 'running',
          selected_steps: legacyChild ? ['validate_emails'] : ['split_emails', 'validate_emails'],
          data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
            ['Allowed clinic', 'allowed.test', 'mail@allowed.test', '7700000103', 'ok'],
            ['Allowed clinic', 'allowed.test', 'other@allowed.test', '7700000103', 'ok']],
        }] });
      (emailSplitDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0].exhausted = true;
      const callsBeforePoll = jest.mocked(callLLMWithSchema).mock.calls.length;
      const pendingChild = await runBaseCollectStage(makeJob(), { supabase: emailSplitDb as unknown as SupabaseClient });
      expect(pendingChild.result).toMatchObject({ waiting: true });
      expect(jest.mocked(callLLMWithSchema).mock.calls.length).toBe(callsBeforePoll);
      expect(emailSplitDb.getRows('base_constructor_jobs')).toHaveLength(1);
      await emailSplitDb.from('base_constructor_jobs').update({ status: 'completed' }).eq('id', dispatched.bc_job_id);
      await emailSplitDb.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
      await runBaseCollectStage(makeJob(), { supabase: emailSplitDb as unknown as SupabaseClient });
      if (legacyChild) {
        // Unsafe legacy verdicts cannot be reused; no allowed source rows
        // remain, so there must be no paid replacement constructor either.
        expect(emailSplitDb.getRows('ve_bases')[0]).toMatchObject({ row_count: 0, data: [] });
        expect(jest.mocked(callLLMWithSchema).mock.calls.length).toBe(callsBeforePoll);
      } else {
        expect(emailSplitDb.getRows('ve_bases')[0]).toMatchObject({ row_count: 1,
          data: [expect.objectContaining({ email: 'other@allowed.test' })],
          collect_info: { project_exclusion_reserve: { rows: [expect.objectContaining({ email: 'mail@allowed.test' })] } },
        });
      }
      expect(emailSplitDb.getRows('base_constructor_jobs')).toHaveLength(1);
    }
  });
});

describe('base_collect: реестр оборвался посреди лейна', () => {
  it('сохраняет разобранный префикс и закладку вместо падения задачи', async () => {
    // Прод 21.09, база 3cd77243: шлюз отдал таймаут на очередной странице —
    // 400 собранных компаний и 10 590 просмотренных строк уходили в мусор,
    // задача становилась failed и вместе с ней падала вся база.
    const db = seed({ plan: { tasks: [DIRECTORY_TASK] }, tasks: [
      { source: DIRECTORY_TASK.source, status: 'pending', child_job_id: null, rows: 0, task: DIRECTORY_TASK },
    ] });
    jest.mocked(searchRows).mockImplementation(async (_filters, limit, offset) => ((offset ?? 0) >= 1_000
      ? { rows: [], error: 'The upstream server is timing out' }
      : { rows: Array.from({ length: limit ?? 1_000 }, (_, index) => ({
        name: `Клиника ${index}`, inn: String(7_700_000_000 + index),
        website: `https://c${index}.test/`, email: `mail@c${index}.test`,
      })) }));

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const saved = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    const task = saved.tasks![0];
    expect(task.status).toBe('done');
    expect(task.rows).toBe(1_000);
    expect(task.error).toBeUndefined();
    expect(task.note).toContain('частичная партия');
    expect(Object.values(task.directory_cursors ?? {})).toEqual([1_000]);
  });
});

describe('base_collect: ливлок сохранённой проверки', () => {
  /** Тот же хэш адреса, что считает savedEmailRecovery (sha256 от JSON). */
  const emailKey = (email: string) => createHash('sha256').update(JSON.stringify(email)).digest('hex');
  const savedNeedsReview = () => ({ version: 2 as const, status: 'needs_review' as const,
    reason: 'Нет сведений о деятельности; требуется подтверждение по сайту.', evidence: [],
    context_hash: 'c'.repeat(64), review_attempts: 0 });

  it('перестаёт уточнять тот же отбор, когда меняется только негодный адрес соседней строки', async () => {
    // Прод 21.09.2026, база 912c19df: 40 раундов подряд «уточняем 479
    // сохранённых контактов 110 компаний» → «проверено 110 из 110, без verdict
    // 479». Отбор не менялся, провайдера не спрашивали ни разу, но детектор
    // застоя не защёлкивался: в отпечаток входило число готовых контактов и
    // сырой статус валидации соседнего адреса.
    const mainA = { ...unifiedRow({ company: 'Клиника А', website: 'a.test', email: 'chief@a.test', inn: '7701234567' }),
      _email_status: 'catch_all', _ve_relevance: savedNeedsReview() };
    const siblingA = { ...unifiedRow({ company: 'Клиника А', website: 'a.test', email: 'info@a.test', inn: '7701234567' }),
      _email_status: 'unknown', _ve_relevance: savedNeedsReview() };
    const mainB = { ...unifiedRow({ company: 'Клиника Б', website: 'b.test', email: 'chief@b.test', inn: '7709876543' }),
      _email_status: 'catch_all', _ve_relevance: savedNeedsReview() };
    const reserve = [mainA, siblingA, mainB];
    const checked = { [emailKey('info@a.test')]: 'unknown' as const };
    const info: VeCollectInfo = {
      ...collectInfo([]),
      collection_mode: 'preview', ready_target: 500,
      relevance_review_requested: true,
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      relevance_reserve: { version: 1, rows: reserve },
      target_progress: { ...createCollectionTarget('preview'), status: 'collecting', round: 4,
        candidates_processed: 40, ready_rows: 0 },
      target_checkpoint: { completed_round: 4, seen_rows: reserve, processed_rows: 3 },
      saved_email_recovery: { version: 1, attempt_id: 'automatic:b1', checked, automatic_checked: checked },
    };
    info.tasks![0].exhausted = true;
    const db = seed(info);
    const supabase = db as unknown as SupabaseClient;
    // Гейт отвечает ровно тем, что уже лежит в чекпоинте: ни одной компании
    // он сдвинуть не может, обращения к провайдеру нет.
    mockFindIrrelevantRows.mockImplementation(async (input: { rows: Array<Record<string, unknown>> }) => ({
      flagged: new Set<number>(), unchecked: new Set(input.rows.map((_, index) => index)),
      review: new Set(input.rows.map((_, index) => index)), errored: new Set<number>(),
      decisions: new Map(input.rows.map((_, index) => [index, savedNeedsReview()])),
      coverage: { checkedCompanies: 2, totalCompanies: 2, complete: true }, tokensUsed: 0, costUsd: 0,
    }));

    const runRound = async () => {
      const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect').at(-1)!;
      await supabase.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
      await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
        { supabase });
      return db.getRows('ve_bases').find((row) => row.id === 'b1')!.collect_info as VeCollectInfo;
    };

    const first = await runRound();
    expect(first.relevance_review_requested).toBe(true);
    expect(first.relevance_review_progress?.passes).toBe(0);
    expect(first.idle_rounds).toBe(1);
    expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(1);

    // Дочерняя валидация почт ответила по соседнему адресу «невалидный».
    // Получателем он не стал, отбор сохранённой проверки не изменился —
    // повторять её незачем.
    const patched = db.getRows('ve_bases').find((row) => row.id === 'b1')!.collect_info as VeCollectInfo;
    await supabase.from('ve_bases').update({ collect_info: { ...patched, relevance_reserve: {
      ...patched.relevance_reserve!, rows: patched.relevance_reserve!.rows.map((row) => row.email === 'info@a.test'
        ? { ...row, _email_status: 'invalid' } : row),
    } } }).eq('id', 'b1');

    const second = await runRound();
    expect(second.relevance_review_progress).toEqual({ signature: first.relevance_review_progress!.signature, passes: 1 });
    expect(second.relevance_review_requested).toBeUndefined();
    // Контакты никуда не делись: раунд завершается честно, резерв цел.
    expect(second.relevance_reserve!.rows).toHaveLength(3);
    expect(second.relevance_summary).toMatchObject({ total: 3, needs_review: 3 });

    // Legarus: 499/500 leaves one website review per wake. Reviewing another
    // saved company is progress even when no new ready contact was admitted.
    // The acquired round and paid limits must stay exactly the same.
    for (const mode of ['unchanged', 'invalid_noise', 'progress'] as const) {
      const ready = Array.from({ length: 499 }, (_, index) => {
        const row = unifiedRow({ company: `Готовая клиника ${index}`, website: `ready${index}.test`, email: `office@ready${index}.test` });
        return { ...row, _email_status: 'ok',
          _ve_company_name: { version: 1, source: row.company, website: row.website, status: 'ready', value: row.company } };
      });
      const nearReserve = structuredClone(reserve).map((row) => mode === 'invalid_noise' && row.email === 'info@a.test'
        ? { ...row, _email_status: 'invalid' } : row);
      const nearInfo: VeCollectInfo = {
        ...collectInfo([]), collection_mode: 'preview', ready_target: 500, relevance_review_requested: true, idle_rounds: 9,
        relevance_review_progress: { signature: first.relevance_review_progress!.signature, passes: 0 },
        search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
        adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2 },
        relevance_reserve: { version: 1, rows: nearReserve },
        target_progress: { ...createCollectionTarget('preview'), status: 'collecting', round: 4, candidates_processed: 1000, ready_rows: 499 },
        target_checkpoint: { completed_round: 4, seen_rows: nearReserve, processed_rows: 3 },
        saved_email_recovery: { version: 1, attempt_id: 'automatic:b1', checked, automatic_checked: checked },
      };
      nearInfo.tasks![0].exhausted = true;
      const nearDb = seed(nearInfo, { ve_bases: [{ ...makeBase(nearInfo), data: ready, row_count: 499, columns: [...VE_AUTO_COLLECT_COLUMNS] }] });
      mockFindIrrelevantRows.mockClear().mockImplementation(async (input: { rows: Array<Record<string, unknown>>; websiteLimit: number }) => {
        expect(input.websiteLimit).toBe(1);
        return { flagged: new Set<number>(), unchecked: new Set(input.rows.map((_, index) => index)),
          review: new Set(input.rows.map((_, index) => index)), errored: new Set<number>(),
          decisions: new Map(input.rows.map((row, index) => [index, {
            ...(row._ve_relevance as ReturnType<typeof savedNeedsReview>),
            ...(mode === 'progress' && row.company === 'Клиника А' ? { review_attempts: 1 } : {}),
          }])), coverage: { checkedCompanies: 2, totalCompanies: 2, complete: true }, tokensUsed: 0, costUsd: 0 };
      });
      jest.mocked(callLLMWithSchema).mockClear();
      jest.mocked(searchRows).mockClear();
      jest.mocked(fetchVeRelevanceEvidence).mockClear();
      const started = Date.now();
      await runBaseCollectStage(makeJob(), { supabase: nearDb as unknown as SupabaseClient });
      const afterBase = nearDb.getRows('ve_bases')[0];
      const after = afterBase.collect_info as VeCollectInfo;
      expect(afterBase.row_count).toBe(499);
      expect(after.target_progress?.candidates_processed).toBe(1000);
      expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(1);
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      expect(searchRows).not.toHaveBeenCalled();
      expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
      expect(nearDb.getRows('base_constructor_jobs')).toHaveLength(0);
      if (mode === 'progress') {
        expect(after.target_progress).toMatchObject({ status: 'collecting', round: 4, ready_rows: 499 });
        expect(after.relevance_review_progress?.signature).not.toBe(first.relevance_review_progress!.signature);
        expect(after.idle_rounds).toBe(0);
        const nextRun = Date.parse(nearDb.getRows('ve_jobs')[0].run_after as string);
        expect(nextRun - started).toBeGreaterThanOrEqual(30_000);
        expect(nextRun).toBeLessThanOrEqual(Date.now() + 30_000);
      } else {
        expect(after.relevance_review_progress).toEqual({ signature: first.relevance_review_progress!.signature, passes: 1 });
        expect(after.relevance_review_requested).toBeUndefined();
        expect(afterBase.status).not.toBe('collecting');
      }
    }
  });
});

/**
 * План кончился раньше цели (аудит 22.09.2026, 33 базы). Тексты гипотез и
 * фильтры реестра — с прода: f1bb9ccf «Мясопереработка» (порог придуман,
 * 954 компании вместо 3 389) и 6b475d8c «Кондитерские фабрики» (гипотеза
 * «Крупные производители», размер законен).
 */
describe('base_collect: план кончился раньше цели', () => {
  const MEAT = { title: 'Мясопереработка', description: 'Производители колбас, мясных полуфабрикатов, охлажденного мяса и деликатесов с Меркурием и сложной прослеживаемостью партий.' };
  const SWEETS = { title: 'Кондитерские фабрики', description: 'Крупные производители конфет, шоколада, печенья и снеков с рецептурами, сменами, складами сырья и поставками в федеральные сети.' };
  const MEAT_TASK = { source: 'companies_directory' as const,
    rationale: 'Собираем мясоперерабатывающие производства по ОКВЭД 10.1 под гипотезу про колбасы, полуфабрикаты и Меркурий.',
    directory_filters: { includeIp: false, okvedCodes: ['10.1'], revenueFrom: 100_000_000, employeesFrom: 20 } };
  const SWEETS_TASK = { source: 'companies_directory' as const,
    rationale: 'Собираем крупные кондитерские фабрики для гипотезы про рецептуры, партии и поставки в сети.',
    directory_filters: { includeIp: false, okvedCodes: ['10.7', '10.8'], revenueFrom: 300_000_000, employeesFrom: 50 } };
  const hypothesis = (text: { title: string; description: string; broad?: boolean; audience_scope?: unknown }) =>
    ({ ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', ...text }] });
  const processed = [
    unifiedRow({ company: 'Мясокомбинат Восток', inn: '7700000011', website: 'vostok.test', email: 'info@vostok.test' }),
    unifiedRow({ company: 'Колбасный завод Юг', inn: '7700000012', website: 'yug.test', email: 'sales@yug.test' }),
  ];
  const ready = processed.map((row) => ({ ...row, _email_status: 'ok',
    _ve_company_name: { version: 1, source: row.company, website: row.website, status: 'ready', value: row.company } }));
  const exhaustedInfo = (task: VeCollectInfo['plan'] extends infer P ? P extends { tasks: Array<infer T> } ? T : never : never,
    extra: Partial<VeCollectInfo> = {}): VeCollectInfo => ({
    plan: { tasks: [task] },
    tasks: [{ source: task.source, status: 'done', child_job_id: null, rows: processed.length, task, harvest: processed,
      exhausted: true, note: 'реестр исчерпан' }],
    collection_mode: 'preview', ready_target: 500, adaptive_collection: newVeAdaptiveCollection(),
    search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
    target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: processed.length, ready_rows: ready.length },
    target_checkpoint: { completed_round: 2, seen_rows: processed, processed_rows: processed.length },
    ...extra,
  });
  const seedBase = (info: VeCollectInfo, text: { title: string; description: string; broad?: boolean }, base: Record<string, unknown> = {},
    others: Array<Record<string, unknown>> = []) =>
    seed(info, { ...hypothesis(text), ve_bases: [{ ...makeBase(info), data: ready, row_count: ready.length,
      columns: [...VE_AUTO_COLLECT_COLUMNS], ...base }, ...others] });
  const wake = async (db: MockSupabaseClient) => {
    const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect').at(-1)!;
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
    await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
      { supabase: db as unknown as SupabaseClient });
    return db.getRows('ve_bases')[0];
  };
  const completeConstructor = async (db: MockSupabaseClient) => {
    const child = db.getRows('base_constructor_jobs').find((row) => row.status === 'pending')!;
    const grid = child.data as string[][];
    await db.from('base_constructor_jobs').update({ status: 'completed',
      data: [[...grid[0], 'Email Статус'], ...grid.slice(1).map((row) => [...row, 'ok'])] }).eq('id', child.id);
  };
  const planLlmReply = (tasks: unknown[]) => ({ data: { tasks }, tokensUsed: 10, costUsd: 0.01,
    promptTokens: 5, completionTokens: 5, rawResponse: '' });

  it('explicit source corrections preserve receipts and budgets, check new candidates and never buy an automatic review of the old reserve', async () => {
    const adult = { id: 'h1', status: 'accepted', title: 'Платформы веб-моделей и взрослого контента',
      description: 'Стриминговые платформы для взрослых и фан-сообщества 18+.' };
    const emptyTask = { source: 'companies_directory' as const, rationale: 'Exhausted', directory_filters: { okvedCodes: ['63'] } };
    const adultInfo = exhaustedInfo(emptyTask, { hypotheses: [adult], niche_source_profile: 'adult_platform',
      cost_policy: { version: 1, website_discovery: 'existing_only' },
      target_progress: { ...createCollectionTarget('preview'), round: 3, max_rounds: 50, candidates_processed: 2, ready_rows: 0 },
      tasks: [{ source: emptyTask.source, task: emptyTask, status: 'done', exhausted: true, child_job_id: null, rows: 0 }],
      adaptive_collection: { ...newVeAdaptiveCollection(), active_source: veSourceStrategyKey(emptyTask), replan_attempts: 2,
        replan_needed: true, replan_reason: 'plan_exhausted', widenings: 2 },
      relevance_reserve: { version: 1, rows: [{ company: 'Old unrelated company', website: 'old.test', email: 'old@old.test', _relevance_unchecked: true }] },
    });
    expect(addVeKnownWebsiteSource(adultInfo)).toBe(true);
    adultInfo.known_website_source!.continuation_only = true;
    adultInfo.known_website_source!.held_review_companies = veAudienceReviewHold(adultInfo.relevance_reserve!.rows);
    const oldPaidTask = { source: 'hh_live' as const, rationale: 'Old paid scrape', hh_query: { text: 'платежи' } };
    adultInfo.tasks!.push({ source: 'hh_live', task: oldPaidTask, status: 'done', child_job_id: 'already-paid-hh', rows: 1,
      harvest: [unifiedRow({ company: 'Old unrelated company', website: 'old.test', email: 'old@old.test' })] });
    adultInfo.plan = { tasks: adultInfo.tasks!.map(task => task.task) };
    const sourceOnlyFixture = structuredClone(adultInfo);
    const adultDb = seedBase(adultInfo, adult, { data: [], row_count: 0 });
    let adultBase = await wake(adultDb);
    const child = adultDb.getRows('base_constructor_jobs')[0];
    const grid = child.data as string[][];
    const emailColumn = 2, websiteColumn = 1;
    expect(grid.slice(1)).toHaveLength(VE_KNOWN_ADULT_WEBSITES.length);
    expect(grid.slice(1).every(row => row[emailColumn] === '')).toBe(true);
    expect(adultDb.getRows('parser_jobs')).toHaveLength(0);
    expect(searchRows).not.toHaveBeenCalled();
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    await wake(adultDb);
    expect(adultDb.getRows('base_constructor_jobs')).toHaveLength(1);
    await adultDb.from('base_constructor_jobs').update({ status: 'completed', data: [[...grid[0], 'Email Статус'],
      ...grid.slice(1).map((row, index) => { const found = [...row]; found[emailColumn] = `info@${new URL(row[websiteColumn]).hostname}`;
        return [...found, index === 0 ? 'invalid' : 'ok']; })] }).eq('id', child.id);
    adultBase = await wake(adultDb);
    expect(mockFindIrrelevantRows).toHaveBeenCalled();
    for (const [call] of mockFindIrrelevantRows.mock.calls) {
      expect(call.allowPaidSearch).toBe(false);
      expect(call.rows.every((row: VeUnifiedRow) => row.company !== 'Old unrelated company')).toBe(true);
    }
    const completedAdult = adultBase.collect_info as VeCollectInfo;
    expect(completedAdult.target_progress).toMatchObject({ status: 'limited', max_rounds: 50, candidates_processed: 12 });
    expect(completedAdult.adaptive_collection).toMatchObject({ replan_attempts: 2, widenings: 2 });
    expect(completedAdult).not.toHaveProperty('relevance_review_requested');
    expect(completedAdult.tasks![0]).toMatchObject({ source: 'known_websites', status: 'done', exhausted: true, rows: 10 });
    expect(completedAdult.tasks![1]).toEqual(sourceOnlyFixture.tasks![1]);
    expect(adultBase.row_count).toBe(9);
    expect(stripTaskHarvest({ collect_info: completedAdult }).collect_info).not.toHaveProperty('known_website_source');
    expect((adultBase.data as VeUnifiedRow[]).every(row => row.email !== 'info@bongacams.com' && row.email !== 'old@old.test')).toBe(true);
    const jobsBefore = adultDb.getRows('base_constructor_jobs').length;
    await wake(adultDb);
    expect(adultDb.getRows('base_constructor_jobs')).toHaveLength(jobsBefore);
    // One remaining candidate is a hard cap, not permission to admit all ten.
    const tailInfo = structuredClone(sourceOnlyFixture);
    tailInfo.target_progress!.candidates_processed = 5237;
    tailInfo.target_progress!.max_candidates = 5238;
    tailInfo.target_checkpoint!.processed_rows = 5237;
    const tailDb = seedBase(tailInfo, adult, { data: [], row_count: 0 });
    await wake(tailDb);
    const tailChild = tailDb.getRows('base_constructor_jobs')[0];
    expect((tailChild.data as string[][]).slice(1)).toHaveLength(1);
    const tailSaved = tailDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(tailSaved.target_progress!.max_candidates).toBe(5238);
    expect(tailSaved.tasks![0].harvest).toHaveLength(10);
    expect(tailSaved.tasks![1]).toEqual(sourceOnlyFixture.tasks![1]);
    const invalidInfo = structuredClone(sourceOnlyFixture);
    Object.assign(invalidInfo.tasks![0].task, { known_websites: { catalog: 'untrusted-catalog' } });
    const invalidDb = seedBase(invalidInfo, adult, { data: [], row_count: 0 });
    const invalidBase = await wake(invalidDb);
    expect(invalidBase.status).toBe('failed');
    expect(invalidDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(invalidDb.getRows('parser_jobs')).toHaveLength(0);
    // A closed failed round resumes only its saved validation and SAME child.
    const retryInfo = structuredClone(completedAdult);
    retryInfo.target_progress!.status = 'error';
    retryInfo.target_progress!.reason = 'Проверка релевантности завершилась не полностью';
    retryInfo.stats!.relevance_coverage_complete = false;
    const oldRow = retryInfo.relevance_reserve!.rows.find(row => row.company === 'Old unrelated company')!;
    const newRow = structuredClone((adultBase.data as Array<Record<string, unknown>>).find(row => row.company === 'Chaturbate')!);
    expect(newRow).toBeDefined();
    newRow._relevance_unchecked = true;
    newRow._ve_relevance = { version: 2, status: 'error', reason: 'transient', context_hash: 'b'.repeat(64), evidence: [] };
    retryInfo.relevance_reserve!.rows = [oldRow, newRow];
    const retryDb = seedBase(retryInfo, adult, { status: 'failed', error: retryInfo.target_progress!.reason, data: [], row_count: 0 });
    await retryDb.from('ve_jobs').update({ status: 'failed' }).eq('id', 'job-1');
    const resume = await enqueueVeBaseCollect(retryDb as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: 'Платформы', limit: 100, hypothesisIds: ['h1'], collectionMode: 'preview', resumeBaseId: 'b1' });
    expect(resume.ok).toBe(true);
    const resumed = retryDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(resumed).toMatchObject({ validation_retry: true, relevance_review_requested: true,
      construct: completedAdult.construct, target_progress: { round: completedAdult.target_progress!.round, max_rounds: 50 } });
    mockFindIrrelevantRows.mockClear();
    await wake(retryDb);
    expect(retryDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(mockFindIrrelevantRows).toHaveBeenCalled();
    for (const [call] of mockFindIrrelevantRows.mock.calls) expect(call.rows.every((row: VeUnifiedRow) => row.company !== 'Old unrelated company')).toBe(true);
    expect((retryDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![1]).toEqual(sourceOnlyFixture.tasks![1]);
    // A source-only restaurant correction is allowed to inspect one new
    // existing-catalogue lane. Empty/duplicate pages cannot buy idle rounds.
    jest.clearAllMocks();
    const restaurant = { id: 'h1', status: 'accepted', origin: 'generated' as const, broad: false,
      title: 'Ресторанные сети', description: 'Ресторанные холдинги, сети кафе и фудмоллы.' };
    const catalogTask = { source: 'yandex_maps' as const, rationale: 'Existing catalogue',
      maps_query: { queries: ['Рестораны', 'Кафе', 'Фудмоллы'], geo: 'Россия' } };
    const catalogKey = veSourceStrategyKey(catalogTask);
    const idleInfo: VeCollectInfo = { collection_mode: 'preview', hypotheses: [restaurant],
      plan: { tasks: [catalogTask] }, tasks: [{ source: 'yandex_maps', task: catalogTask, status: 'pending', rows: 0, child_job_id: null,
        catalog: { version: 1, filters: { categories: ['Рестораны', 'Кафе', 'Фудмоллы'], countries: ['Россия'] }, after: 'old' } }],
      target_progress: { ...createCollectionTarget('preview'), round: 50, max_rounds: 50, candidates_processed: processed.length, ready_rows: 0 },
      target_checkpoint: { completed_round: 49, processed_rows: processed.length, seen_rows: processed },
      cost_policy: { version: 1, website_discovery: 'existing_only' },
      adaptive_collection: { ...newVeAdaptiveCollection(), active_source: catalogKey },
      relevance_reserve: { version: 1, rows: [{ ...processed[0], _relevance_unchecked: true }] },
      restaurant_source_refresh: { version: 1, source_key: catalogKey,
        previous_task: { source: 'hh_live', status: 'done', rows: 0, child_job_id: 'old-paid-hh' },
        held_review_companies: veAudienceReviewHold(processed) } };
    const restaurantFixture = structuredClone(idleInfo);
    const idleDb = seedBase(idleInfo, restaurant, { data: [], row_count: 0 });
    const oldRpc = idleDb.rpc;
    idleDb.rpc = ((name: string, params: Record<string, unknown>) => {
      if (name !== 'yandex_maps_catalog_search') return oldRpc(name, params);
      const result = Promise.resolve({ data: Array.from({ length: Number(params.p_limit) }, (_, i) => ({
        yandex_id: String(i + 1), name: processed[0].company, website: processed[0].website, email: processed[0].email,
      })), error: null });
      return Object.assign(result, { abortSignal: () => result });
    }) as typeof idleDb.rpc;
    const idleBase = await wake(idleDb);
    const idleSaved = idleBase.collect_info as VeCollectInfo;
    expect(idleSaved.target_progress).toMatchObject({ status: 'limited', round: 50, max_rounds: 50, candidates_processed: processed.length });
    expect(idleDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(idleDb.getRows('parser_jobs')).toHaveLength(0);
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(stripTaskHarvest({ collect_info: idleSaved }).collect_info).not.toHaveProperty('restaurant_source_refresh');
    // A genuinely new catalogue candidate does reach the ordinary constructor
    // and relevance gate; the held legacy company must not accompany it.
    const newInfo = structuredClone(restaurantFixture);
    newInfo.target_progress = { ...newInfo.target_progress!, round: 3 };
    newInfo.target_checkpoint = { ...newInfo.target_checkpoint!, completed_round: 2 };
    const newDb = seedBase(newInfo, restaurant, { data: [], row_count: 0 });
    const newRpc = newDb.rpc;
    newDb.rpc = ((name: string, params: Record<string, unknown>) => {
      if (name !== 'yandex_maps_catalog_search') return newRpc(name, params);
      const result = Promise.resolve({ data: params.p_after === 'old' ? [{ yandex_id: 'new-restaurant', name: 'Сеть ресторанов',
        website: 'https://restaurants.test', email: 'info@restaurants.test' }] : [], error: null });
      return Object.assign(result, { abortSignal: () => result });
    }) as typeof newDb.rpc;
    await wake(newDb);
    expect((newDb.getRows('base_constructor_jobs')[0].data as string[][]).slice(1).map((row) => row[0])).toEqual(['Сеть ресторанов']);
    await completeConstructor(newDb);
    const newBase = await wake(newDb);
    expect(newBase.row_count).toBe(1);
    expect((newBase.collect_info as VeCollectInfo).target_progress).toMatchObject({ max_rounds: 50, candidates_processed: 3 });
    for (const [call] of mockFindIrrelevantRows.mock.calls) {
      expect(call.allowPaidSearch).toBe(false);
      expect(call.rows.every((row: VeUnifiedRow) => row.company !== processed[0].company)).toBe(true);
    }
    expect(newDb.getRows('parser_jobs')).toHaveLength(0);
    expect(newDb.getRows('yandex_maps_jobs')).toHaveLength(0);
    expect(callLLMWithSchema).toHaveBeenCalledTimes(1);
    expect(jest.mocked(callLLMWithSchema).mock.calls[0][0][0].content).toContain('названия компаний');
    jest.clearAllMocks();
    const jewelry = { id: 'h1', status: 'accepted', origin: 'generated' as const, broad: false,
      title: 'Ювелирные заводы и сети украшений',
      description: 'Производители золотых и серебряных украшений с фирменной розницей и интернет-витриной. Сложность удержания клиента между покупками к праздничным датам.' };
    const oldTask = { source: 'companies_directory' as const, rationale: 'Old broad plan',
      directory_filters: { okvedCodes: ['32', '47.7'], includeIp: false } };
    const hhTask = { source: 'hh_live' as const, rationale: 'Already paid', hh_query: { text: 'Ювелир', date_to: '2026-02-10' } };
    const oldReserve = { ...unifiedRow({ company: 'Old uncertain shop', website: 'old-shop.test', email: 'mail@old-shop.test' }),
      _email_status: 'ok', _ve_relevance: { version: 2, status: 'error', reason: 'old pending check' } };
    const info = exhaustedInfo(oldTask, { hypotheses: [jewelry], audience_scope_refresh_requested: true,
      construct: { status: 'done', bc_job_id: 'old-paid-constructor' },
      relevance_reserve: { version: 1, rows: [oldReserve] },
    });
    info.tasks![0].directory_cursors = { previous_slice: 1000 };
    info.tasks!.push({ source: 'hh_live', status: 'done', child_job_id: 'old-paid-hh', rows: 0, harvest: [], task: hhTask, exhausted: true });
    const snapshot = createVeCollectionAudienceSnapshot([{ ...jewelry, audience_scope: deriveVeRetailAudienceScope(jewelry)! }],
      'explicit_continuation', '2026-10-16T12:00:00Z');
    const immutable = JSON.stringify([info.target_progress, info.target_checkpoint, info.adaptive_collection, info.relevance_reserve, info.tasks![1]]);
    const waiting = structuredClone(info);
    waiting.tasks![1].status = 'dispatched';
    expect(applyVeAudienceSourceRefresh(waiting, snapshot)).toBe(false);
    expect(applyVeAudienceSourceRefresh(info, snapshot)).toBe(true);
    expect(JSON.stringify([info.target_progress, info.target_checkpoint, info.adaptive_collection, info.relevance_reserve, info.tasks![1]])).toBe(immutable);
    expect(info.tasks![0].task.directory_filters?.okvedCodes).toEqual(['32.12', '47.77']);
    expect(info.tasks![0].directory_cursors).toEqual({ previous_slice: 1000 });
    expect(info.cost_policy?.website_discovery).toBe('existing_only');
    expect(info.validation_retry).toBeUndefined();
    expect(info.relevance_review_requested).toBeUndefined();
    expect(info.construct).toBeUndefined();
    expect(info.audience_source_refresh?.held_review_companies).toEqual(veAudienceReviewHold([oldReserve]));
    expect(stripTaskHarvest({ collect_info: { audience_source_refresh: info.audience_source_refresh } }).collect_info).not.toHaveProperty('audience_source_refresh');
    expect(applyVeAudienceSourceRefresh(info, snapshot)).toBe(false);
    const fresh = unifiedRow({ company: 'New jewelry producer', inn: '7700000909', website: 'new-jewelry.test', email: 'mail@new-jewelry.test' });
    expect(veAutomaticAudienceReviewRows([oldReserve, fresh], info.audience_source_refresh?.held_review_companies)).toEqual([fresh]);
    expect(veAutomaticAudienceReviewRows([oldReserve], undefined)).toEqual([oldReserve]);
    expect(() => veAutomaticAudienceReviewRows([oldReserve], ['broken'])).toThrow('Invalid source refresh review hold');

    jest.mocked(searchRows).mockResolvedValue({ rows: [{ name: fresh.company, inn: fresh.inn, okved_main: '32.12',
      site: fresh.website, email: fresh.email }] });
    const db = seedBase(info, jewelry);
    mockFindIrrelevantRows.mockClear();
    await wake(db);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    await completeConstructor(db);
    const result = await wake(db);
    expect(mockFindIrrelevantRows).toHaveBeenCalled();
    for (const [request] of mockFindIrrelevantRows.mock.calls) {
      expect(request.allowPaidSearch).toBe(false);
      expect(request.rows.some((row: Record<string, unknown>) => row.website === oldReserve.website)).toBe(false);
    }
    const finalInfo = result.collect_info as VeCollectInfo;
    expect(finalInfo.relevance_reserve?.rows.some((row) => row.website === oldReserve.website)).toBe(true);
    expect(finalInfo.relevance_review_requested).not.toBe(true);
    expect((result.data as Record<string, unknown>[]).some((row) => row.email === fresh.email)).toBe(true);
    expect(finalInfo.target_progress?.max_candidates).toBe(info.target_progress?.max_candidates);
    expect(db.getRows('hh_jobs')).toHaveLength(0);

    // A later automatic follow-up may review a NEW uncertain company, while
    // preserving the held reserve through the recovery save callback/merge.
    const followup = structuredClone(info);
    followup.relevance_review_requested = true;
    followup.validation_retry = true;
    followup.target_checkpoint!.completed_round = followup.target_progress!.round;
    for (const state of followup.tasks!) { state.status = 'done'; state.exhausted = true; }
    followup.relevance_reserve = { version: 1, rows: [oldReserve, { ...fresh, _email_status: 'ok',
      _ve_relevance: { version: 2, status: 'error', reason: 'new interrupted check' } }] };
    const followupDb = seedBase(followup, jewelry);
    mockFindIrrelevantRows.mockClear();
    const followed = await wake(followupDb);
    expect(mockFindIrrelevantRows).toHaveBeenCalled();
    const reviewedSites = mockFindIrrelevantRows.mock.calls.flatMap(([request]) => request.rows.map((row: Record<string, unknown>) => row.website));
    expect(reviewedSites).toContain(fresh.website);
    expect(reviewedSites).not.toContain(oldReserve.website);
    expect((followed.collect_info as VeCollectInfo).relevance_reserve?.rows.some((row) => row.website === oldReserve.website)).toBe(true);
  });

  it('исчерпанный реестр с придуманным порогом открывает срез без порогов, повторное исчерпание честно завершает базу', async () => {
    const db = seedBase(exhaustedInfo(MEAT_TASK), MEAT);
    let base = await wake(db);
    let info = base.collect_info as VeCollectInfo;
    expect(base.status).toBe('collecting');
    expect(info.target_progress).toMatchObject({ status: 'collecting', round: 4 });
    expect(info.tasks).toHaveLength(2);
    const second = info.tasks![1];
    expect(second).toMatchObject({ status: 'pending', task: { widened: 'second_queue',
      directory_filters: { includeIp: false, okvedCodes: ['10.1'] } } });
    expect(second.task.directory_filters).not.toHaveProperty('revenueFrom');
    expect(second.task.directory_filters).not.toHaveProperty('employeesFrom');
    expect(info.adaptive_collection).toMatchObject({ widenings: 1, active_source: veSourceStrategyKey(second.task) });
    expect(info.plan?.tasks).toHaveLength(2);
    expect(searchRows).not.toHaveBeenCalled();

    // Вторая очередь: тот же ОКВЭД без порогов, сначала компании с готовой почтой.
    jest.mocked(searchRows).mockResolvedValue({ rows: [
      { name: 'Колбасный цех Север', inn: '7700000101', email: 'sales@sever.test', website: 'sever.test', employees_count: null, revenue: null },
      { name: 'Мясной двор Запад', inn: '7700000102', email: 'info@zapad.test', website: 'zapad.test', employees_count: 8, revenue: 40_000_000 },
    ] });
    base = await wake(db);
    const filters = jest.mocked(searchRows).mock.calls[0][0];
    expect(filters).toMatchObject({ okvedCodes: ['10.1'], hasEmail: true, includeIp: false });
    expect(filters.revenueFrom).toBeUndefined();
    expect(filters.employeesFrom).toBeUndefined();
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    expect((base.collect_info as VeCollectInfo).tasks![1]).toMatchObject({ exhausted: true, rows: 2 });

    await completeConstructor(db);
    base = await wake(db);
    info = base.collect_info as VeCollectInfo;
    expect(base).toMatchObject({ status: 'collecting', row_count: 4 });
    // Второй очереди больше нет: один раз просим у планировщика новый срез.
    expect(info.adaptive_collection).toMatchObject({ widenings: 2, replan_needed: true, replan_reason: 'plan_exhausted' });

    // Планировщик снова предлагает тот же ОКВЭД с выдуманным порогом: порог
    // снимается кодом, такой срез уже пройден — новых компаний нет.
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([MEAT_TASK]));
    base = await wake(db);
    info = base.collect_info as VeCollectInfo;
    const feedback = String(jest.mocked(callLLMWithSchema).mock.calls
      .map((call) => call[0].at(-1)?.content).find((content) => String(content).includes('Источники плана исчерпаны')));
    expect(feedback).toContain('Предыдущий план (без порогов размера)');
    expect(feedback).not.toContain('revenueFrom');
    expect(feedback).not.toContain('employeesFrom');
    expect(base.status).toBe('analyzing');
    expect(info.target_progress).toMatchObject({ status: 'exhausted', ready_rows: 4 });
    expect(info.target_progress?.reason).toContain('Срез уже расширялся автоматически (2 из 2)');
    expect(info.adaptive_collection).toMatchObject({ widenings: 2, replan_attempts: 1 });
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(db.getRows('ve_jobs').filter((row) => row.stage === 'base_analyze')).toHaveLength(1);

    // A saved generation plan may still own exhausted water-utility tasks.
    // Scope the newly widened tasks only: old acquisition work stays recorded
    // and must not be searched, classified or validated a second time.
    const power = { ...MEAT_TASK, directory_filters: {
      includeIp: false, okvedCodes: ['35.1', '35.3'], regionCodes: ['78'], revenueFrom: 500_000_000,
    } };
    const water = { ...MEAT_TASK, directory_filters: {
      includeIp: false, okvedCodes: ['36', '37'], regionCodes: ['78'], revenueFrom: 200_000_000,
    } };
    const oldEnergy = exhaustedInfo(power, {
      plan: { tasks: [power, water] },
      tasks: [power, water].map((task, index) => ({
        source: task.source, task, status: 'done', child_job_id: null, rows: 1,
        harvest: [processed[index]], exhausted: true,
        directory_cursors: { old_scope: index === 0 ? 90 : 78 },
      })),
      target_checkpoint: { completed_round: 2, processed_rows: processed.length,
        seen_rows: processed.map(({ company, inn, email, website, address, source_detail }) => ({
          company, inn, email, website, address, source_detail,
        })) },
    });
    const oldTasks = JSON.parse(JSON.stringify(oldEnergy.tasks));
    const oldCheckpoint = JSON.parse(JSON.stringify(oldEnergy.target_checkpoint));
    const energyDb = seedBase(oldEnergy, {
      title: 'Энергетические компании', broad: false,
      description: 'ТЭЦ, ГРЭС, АЭС-смежные и генерирующие компании с химлабораториями воды, топлива, масел и выбросов. ЛИМС упорядочивает пробы, графики, приборы и отчётность.',
    });
    jest.mocked(searchRows).mockClear();
    jest.mocked(callLLMWithSchema).mockClear();
    jest.mocked(fetchVeRelevanceEvidence).mockClear();
    mockFindIrrelevantRows.mockClear();
    const energyBase = await wake(energyDb);
    const energy = energyBase.collect_info as VeCollectInfo;
    expect(energyBase).toMatchObject({ status: 'collecting', row_count: ready.length, data: ready });
    expect(energy.tasks).toHaveLength(3);
    expect(energy.tasks!.slice(0, 2)).toEqual(oldTasks);
    expect(energy.plan?.tasks.slice(0, 2)).toEqual([power, water]);
    expect(energy.tasks![2]).toMatchObject({ status: 'pending', rows: 0, child_job_id: null,
      task: { widened: 'second_queue', directory_filters: {
        includeIp: false, okvedCodes: ['35.1', '35.3'], regionCodes: ['78'],
      } } });
    expect(energy.tasks![2].task.directory_filters).not.toHaveProperty('revenueFrom');
    expect(energy.target_checkpoint).toMatchObject({ ...oldCheckpoint, completed_round: 3 });
    expect(energy.target_progress).toMatchObject({ ...oldEnergy.target_progress, status: 'collecting', round: 4 });
    expect(energy.adaptive_collection).toMatchObject({ widenings: 1,
      active_source: veSourceStrategyKey(energy.tasks![2].task) });
    expect(searchRows).not.toHaveBeenCalled();
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    expect(energyDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(energyDb.getRows('parser_jobs')).toHaveLength(0);
  });

  it('новый план не сохраняет порог без основания, а обоснованный — сохраняет и расширяет по правилу', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: [] });
    for (const [text, task] of [[MEAT, MEAT_TASK], [SWEETS, SWEETS_TASK]] as const) {
      const db = seed({ collection_mode: 'preview' }, hypothesis(text));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([task]));
      let info = (await wake(db)).collect_info as VeCollectInfo;
      if (text === MEAT) {
        expect(info.plan?.tasks[0].directory_filters).toEqual({ includeIp: false, okvedCodes: ['10.1'] });
        continue;
      }
      expect(info.plan?.tasks[0].directory_filters).toEqual(SWEETS_TASK.directory_filters);
      // Сначала лейны с готовыми контактами, затем полный срез; оба пусты —
      // вторая очередь: порог вдвое мягче, пустые поля проходят.
      expect(info.search_policy?.phase).toBe('paid');
      info = (await wake(db)).collect_info as VeCollectInfo;
      expect(info.tasks![1].task.directory_filters).toEqual({ includeIp: false, okvedCodes: ['10.7', '10.8'],
        sizeOrUnknown: { revenueFrom: 150_000_000, employeesFrom: 25 } });
      expect(info.target_progress?.status).toBe('collecting');
    }

    const payment = { title: 'Финтех и платежное посредничество', description: 'Платёжные провайдеры и агрегаторы', broad: true };
    const task = { source: 'companies_directory' as const, rationale: 'Финансы и ИТ', directory_filters: { okvedCodes: ['64', '62'], includeIp: false } };
    // Broad audience generation still preserves the explicitly named business
    // model. Neither mode can borrow the whole-sector population or buy search.
    for (const broad of [false, true]) {
      const freshDb = seed({ collection_mode: 'preview' }, hypothesis({ ...payment, broad }));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([task]));
      await wake(freshDb);
      const fresh = freshDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(fresh.niche_source_profile).toBe('payments');
      expect(fresh.hypotheses?.[0].broad).toBe(broad);
      expect(fresh.search_policy?.phase).toBe('existing');
      expect(fresh.estimate).toMatchObject({ population_matches_source: false, unique_companies: null });
      expect(fresh.tasks![0].task.directory_filters?.nameTerms).toContain('финтех');
    }

    const oldScopeFlag = process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
    try {
      process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = 'p1';
      const pilotDb = seed({ collection_mode: 'preview' }, hypothesis(payment));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([task]));
      const pilot = (await wake(pilotDb)).collect_info as VeCollectInfo;
      expect(pilot.audience_snapshot).toMatchObject({ version: 1, reason: 'new_preview' });
      expect(pilot.cost_policy).toEqual({ version: 1, website_discovery: 'existing_only' });
      expect(pilot.tasks![0].task.directory_filters?.nameTerms).toBeUndefined();
      expect(pilot.niche_source_profile).toBeUndefined();
      delete process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
      const typedDb = seed({ collection_mode: 'preview' }, hypothesis({ ...payment, audience_scope: {
        version: 1, kind: 'sector', any_of: ['Финтех', 'Платёжные провайдеры'], required: ['Выручка до 80 млн рублей'], excluded: ['Банки'],
      } }));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([{ ...task, directory_filters: { ...task.directory_filters, revenueTo: 80_000_000 } }]));
      const typed = (await wake(typedDb)).collect_info as VeCollectInfo;
      expect(typed.audience_snapshot?.hypotheses[0].description).toContain('Выручка до 80 млн рублей');
      expect(typed.tasks![0].task.directory_filters?.revenueTo).toBe(80_000_000);
      expect(typed.cost_policy).toEqual({ version: 1, website_discovery: 'existing_only' });

      // The new project contract freezes audience without silently removing
      // ordinary free-first discovery. Legacy pilots keep their stricter cap.
      const ordinary = { id: 'h1', status: 'accepted', ...MEAT, audience_scope: {
        version: 1 as const, kind: 'sector' as const, any_of: ['Мясопереработка'], required: [], excluded: [],
      } };
      for (const generationVersion of [undefined, null, 1]) {
        const ordinaryDb = seed({ collection_mode: 'preview' }, { ...hypothesis(ordinary),
          ve_projects: [{ ...PROJECT, audience_generation_version: generationVersion }] });
        jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([MEAT_TASK]));
        const ordinaryInfo = (await wake(ordinaryDb)).collect_info as VeCollectInfo;
        expect(ordinaryInfo.cost_policy?.website_discovery).toBe(generationVersion === 1 ? 'existing_then_configured' : 'existing_only');
        expect(ordinaryInfo.search_policy?.phase).toBe(generationVersion === 1 ? 'paid' : 'existing');
        expect(ordinaryInfo.audience_snapshot?.hypotheses[0].audience_scope).toEqual(ordinary.audience_scope);
      }
      const configured = veNewAudienceSourceCostPolicy(ordinary, 1, 'ru');
      expect(veNewAudienceSourceCostPolicy(ordinary, 1, 'us')).toEqual(configured);
      expect(veNewAudienceSourceCostPolicy({ ...ordinary, title: 'Fintech and payment providers',
        audience_scope: { ...ordinary.audience_scope, any_of: ['Fintech', 'Payment providers'] } }, 1, 'us')).toEqual(configured);
      expect(veSourceDiscoveryIsExistingOnly({ cost_policy: configured, search_policy: { phase: 'existing' } })).toBe(true);
      expect(veSourceDiscoveryIsExistingOnly({ cost_policy: configured, search_policy: { phase: 'paid' } })).toBe(false);
      expect(() => veNewAudienceSourceCostPolicy(ordinary, 2, 'ru')).toThrow('Unsupported');
      for (const restricted of [
        { ...ordinary, title: payment.title }, // Original specialty title still caps cost.
        { ...ordinary, audience_scope: { ...ordinary.audience_scope, any_of: ['Финтех'] } },
        { ...ordinary, audience_scope: { ...ordinary.audience_scope, any_of: ['Платёжные провайдеры'], required: ['Нанимают финансового директора'] } },
        { ...ordinary, audience_scope: { ...ordinary.audience_scope, any_of: ['Мясопереработка', 'Платёжные провайдеры'] } },
      ]) expect(veNewAudienceSourceCostPolicy(restricted, 1, 'ru').website_discovery).toBe('existing_only');

      // A persisted ordinary preview retains its policy on retry, even if the
      // project marker changes. The global switch still controls paid lookups.
      const oldPaidFlag = process.env.VE_PAID_WEBSITE_SEARCH;
      try {
        for (const flag of ['off', 'on']) {
          process.env.VE_PAID_WEBSITE_SEARCH = flag;
          const reviewInfo = exhaustedInfo(MEAT_TASK, {
            audience_snapshot: createVeCollectionAudienceSnapshot([ordinary], 'new_preview', '2026-10-15T00:00:00Z'),
            cost_policy: configured, hypotheses: [ordinary], relevance_review_requested: true, validation_retry: true,
            construct: { status: 'done', bc_job_id: 'already-imported' },
            target_checkpoint: { completed_round: 3, seen_rows: processed, processed_rows: processed.length },
            relevance_reserve: { version: 1, rows: [{ ...ready[0], _ve_relevance: { version: 1, status: 'error' } }] },
          });
          const reviewDb = seedBase(reviewInfo, payment);
          mockFindIrrelevantRows.mockClear();
          const reviewed = (await wake(reviewDb)).collect_info as VeCollectInfo;
          expect(reviewed.cost_policy).toEqual(configured);
          expect(reviewed.audience_snapshot?.hash).toBe(reviewInfo.audience_snapshot?.hash);
          expect(mockFindIrrelevantRows).toHaveBeenCalled();
          for (const [input] of mockFindIrrelevantRows.mock.calls) expect(input.allowPaidSearch).toBe(flag !== 'off');
        }
      } finally {
        if (oldPaidFlag === undefined) delete process.env.VE_PAID_WEBSITE_SEARCH;
        else process.env.VE_PAID_WEBSITE_SEARCH = oldPaidFlag;
      }
    } finally {
      if (oldScopeFlag === undefined) delete process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
      else process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = oldScopeFlag;
    }

    const seen = unifiedRow({ company: 'Ранее проверенная компания', inn: '7700000901' });
    const prior = exhaustedInfo(task, { hypotheses: [{ id: 'h1', status: 'accepted', ...payment }],
      target_progress: { ...createCollectionTarget('preview'), round: 7, candidates_processed: 10_000, ready_rows: 2 },
      target_checkpoint: { completed_round: 6, seen_rows: [seen], processed_rows: 10_000 },
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2, active_source: veSourceStrategyKey(task) },
    });
    prior.tasks![0].directory_cursors = { old_scope: 2000 };
    const immutable = JSON.stringify([prior.target_progress, prior.target_checkpoint, prior.search_policy,
      prior.adaptive_collection!.completed, prior.adaptive_collection!.replan_attempts]);
    expect(applyVeNicheSourceSelection(prior, 'payments')).toBe(true);
    expect(JSON.stringify([prior.target_progress, prior.target_checkpoint, prior.search_policy,
      prior.adaptive_collection!.completed, prior.adaptive_collection!.replan_attempts])).toBe(immutable);
    expect(prior.tasks).toHaveLength(1);
    expect(prior.tasks![0].directory_cursors).toEqual({ old_scope: 2000 });
    expect(prior.tasks![0].harvest?.[0]).toMatchObject({ _ve_source_strategy: veSourceStrategyKey(task) });
    expect(prior.adaptive_collection!.active_source).toBe(veSourceStrategyKey(prior.tasks![0].task));
    expect(prior.source_selection?.previous_tasks[0]).toMatchObject({ task, exhausted: true });
    expect(applyVeNicheSourceSelection(prior, 'payments')).toBe(false);

    // Existing payment bases have already applied v1. Refresh only their
    // future source scope once; never erase what was tried or paid for.
    const legacyPayments = JSON.parse(JSON.stringify(prior)) as VeCollectInfo;
    legacyPayments.source_selection!.version = 1;
    delete legacyPayments.tasks![0].task.directory_filters!.identityCatalog;
    legacyPayments.tasks![0].task.directory_filters!.nameTerms = ['платеж', 'финтех', 'pay'];
    legacyPayments.tasks![0].exhausted = true;
    legacyPayments.plan!.tasks = legacyPayments.tasks!.map((state) => state.task);
    legacyPayments.adaptive_collection!.active_source = veSourceStrategyKey(legacyPayments.tasks![0].task);
    const oldPaymentKey = legacyPayments.adaptive_collection!.active_source;
    // Controlled sector correction changes source coverage, not caps/receipts.
    const sector = { ...payment, id: 'h1', status: 'accepted', broad: true, origin: 'generated' as const };
    const scoped = structuredClone(prior);
    scoped.hypotheses = [sector];
    scoped.collection_mode = 'preview';
    scoped.audience_scope_refresh_requested = true;
    scoped.construct = { status: 'done', bc_job_id: 'paid-finished' };
    scoped.tasks!.push({ ...structuredClone(scoped.tasks![0]), task: { ...structuredClone(scoped.tasks![0].task),
      directory_filters: { ...scoped.tasks![0].task.directory_filters, okvedCodes: ['66'] } } });
    // Adaptive tasks can outgrow the initial plan. The live tasks are authoritative.
    scoped.plan = { tasks: [scoped.tasks![0].task] };
    const pendingScope = structuredClone(scoped);
    pendingScope.cost_policy = { version: 1, website_discovery: 'existing_only' };
    const snapshot = createVeCollectionAudienceSnapshot([sector], 'explicit_continuation', '2026-10-14T12:00:00Z');
    const safety = JSON.stringify([scoped.target_progress, scoped.target_checkpoint, scoped.adaptive_collection]);
    expect(needsLegacyFintechAudienceRefresh(scoped)).toBe(true);
    expect(applyVeAudienceSourceRefresh(scoped, snapshot)).toBe(true);
    expect(scoped.tasks).toHaveLength(prior.tasks!.length + 1);
    expect(scoped.construct).toBeUndefined();
    expect(scoped.audience_source_refresh?.previous_construct).toEqual({ status: 'done', bc_job_id: 'paid-finished' });
    expect(scoped.tasks![1].task.directory_filters?.nameTerms).toContain('скоринг');
    expect(scoped.tasks![0].task).toEqual(prior.tasks![0].task);
    expect(scoped.tasks![0].directory_cursors).toEqual({ old_scope: 2000 });
    expect(JSON.stringify([scoped.target_progress, scoped.target_checkpoint, scoped.adaptive_collection])).toBe(safety);
    expect(veSourceDiscoveryIsExistingOnly(scoped)).toBe(true);
    delete scoped.source_selection;
    expect(veSourceDiscoveryIsExistingOnly(scoped)).toBe(true);
    expect(applyVeAudienceSourceRefresh(scoped, snapshot)).toBe(false);
    const changedAfterClick = seedBase(pendingScope, { title: 'Стоматологии', description: 'Изменённая после клика аудитория', broad: false });
    await wake(changedAfterClick);
    expect((changedAfterClick.getRows('ve_bases')[0].collect_info as VeCollectInfo).audience_snapshot?.hypotheses[0].title).toBe(payment.title);
    expect(readVeCollectionAudienceSnapshot(snapshot)?.hash).toBe(snapshot.hash);
    expect(() => readVeCollectionAudienceSnapshot({ ...snapshot, version: 2 })).toThrow();
    expect(() => readVeCollectionAudienceSnapshot({ ...snapshot, hash: 'changed' })).toThrow();
    expect(() => veSourceDiscoveryIsExistingOnly({ cost_policy: { version: 2 } })).toThrow();
    const boundCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
    const wrongBinding = seed({ collection_mode: 'preview', cost_policy: { version: 1, website_discovery: 'existing_only' },
      audience_snapshot: createVeCollectionAudienceSnapshot([{ ...sector, id: 'another-hypothesis' }], 'new_preview', snapshot.applied_at) }, hypothesis(payment));
    await expect(wake(wrongBinding)).rejects.toThrow('does not belong to the base hypothesis');
    expect(jest.mocked(callLLMWithSchema).mock.calls).toHaveLength(boundCalls);
    for (const guard of [{ collection_mode: 'supply' }, { construct: { status: 'dispatched', bc_job_id: 'paid' } },
      { saved_email_recovery: { batch: { id: 'paid' } } }, { adaptive_collection: { pending: { id: 'paid' } } }]) {
      const held = { ...prior, collection_mode: 'preview', hypotheses: [sector], ...guard } as VeCollectInfo;
      const before = JSON.stringify(held);
      expect(applyVeAudienceSourceRefresh(held, snapshot)).toBe(false);
      expect(JSON.stringify(held)).toBe(before);
    }
    const structured = { ...sector, audience_scope: { version: 1 as const, kind: 'sector' as const,
      any_of: ['Финтех', 'Платёжные провайдеры'], required: ['Выручка до 80 млн рублей'], excluded: ['Банки'] } };
    const structuredSnapshot = createVeCollectionAudienceSnapshot([structured], 'new_preview', '2026-10-14T12:00:00Z');
    expect(structuredSnapshot.hypotheses[0].description).toContain('ANY ONE');
    expect(structuredSnapshot.hypotheses[0].description).toContain('Выручка до 80 млн рублей');
    expect(structuredSnapshot.hypotheses[0].description).toContain('Банки');
    expect(veAudienceNicheProfile([structured])).toBeNull();
    for (const builder of [buildSourcePlanMessages, buildSourcePlanMessagesEn, buildCatalogRepairMessagesEn]) {
      const messages = builder({ verticalName: 'Не относящийся к аудитории контекст', hypotheses: [structured], audienceScope: structured.audience_scope });
      expect(messages[0].content).toContain('AUTHORITATIVE STRUCTURED AUDIENCE');
      expect(messages[0].content).toContain('All required conditions (AND)');
      expect(messages[0].content).toContain('Выручка до 80 млн рублей');
      expect(messages[0].content).toContain('Банки');
    }
    const approvalDb = createMockSupabase({ tables: { ve_contact_supply_batches: [{ id: 'batch', base_id: 'supply', plan_id: 'supply-plan' }],
      ve_contact_supply_plans: [{ id: 'supply-plan', project_id: 'p1', hypothesis_id: 'h1', item_id: 'launch' }],
      ve_launch_queue_items: [{ id: 'launch', project_id: 'p1', hypothesis_id: 'h1', base_id: 'approved-preview' }],
      ve_bases: [{ id: 'approved-preview', project_id: 'p1', hypothesis_id: 'h1', audience_snapshot: structuredSnapshot,
        cost_policy: { version: 1, website_discovery: 'existing_only' } }],
      ve_hypotheses: [{ id: 'h1', title: 'Стоматологии', description: 'Изменённая после запуска аудитория', audience_scope: null }],
    } });
    const approvedScope = await loadVeApprovedSupplyAudience(approvalDb as unknown as SupabaseClient,
      { projectId: 'p1', hypothesisId: 'h1', batchId: 'batch', baseId: 'supply' });
    expect(approvedScope?.snapshot?.hash).toBe(structuredSnapshot.hash);
    expect(approvedScope?.snapshot?.hypotheses[0].description).toContain('Выручка до 80 млн рублей');
    expect(approvedScope?.costPolicy).toEqual({ version: 1, website_discovery: 'existing_only' });
    await approvalDb.from('ve_bases').update({ cost_policy: { version: 1, website_discovery: 'existing_then_configured' } }).eq('id', 'approved-preview');
    const configuredApproval = await loadVeApprovedSupplyAudience(approvalDb as unknown as SupabaseClient,
      { projectId: 'p1', hypothesisId: 'h1', batchId: 'batch', baseId: 'supply' });
    expect(configuredApproval?.snapshot?.hash).toBe(structuredSnapshot.hash);
    expect(configuredApproval?.costPolicy).toEqual({ version: 1, website_discovery: 'existing_then_configured' });
    for (const websiteDiscovery of ['existing_only', 'existing_then_configured'] as const) {
      const inherited = { version: 1 as const, website_discovery: websiteDiscovery };
      const supplyInfo: VeCollectInfo = { collection_mode: 'supply', supply_batch_id: 'batch', ready_target: 500 };
      const supplyDb = seed(supplyInfo, {
        ...hypothesis({ title: 'Стоматологии', description: 'Текущая гипотеза не определяет одобренный добор.' }),
        ve_contact_supply_batches: [{ id: 'batch', base_id: 'b1', plan_id: 'supply-plan' }],
        ve_contact_supply_plans: approvalDb.getRows('ve_contact_supply_plans'),
        ve_launch_queue_items: approvalDb.getRows('ve_launch_queue_items'),
        ve_bases: [makeBase(supplyInfo), {
          id: 'approved-preview', project_id: 'p1', hypothesis_id: 'h1', source: 'auto', status: 'analyzed',
          audience_snapshot: structuredSnapshot, cost_policy: inherited,
        }],
      });
      const originalRpc = supplyDb.rpc;
      supplyDb.rpc = (name, params) => name === 've_require_contact_supply_active'
        ? Promise.resolve({ data: { id: 'supply-plan' }, error: null }) : originalRpc(name, params);
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([task]));
      const supply = (await wake(supplyDb)).collect_info as VeCollectInfo;
      expect(supply.audience_snapshot?.hash).toBe(structuredSnapshot.hash);
      expect(supply.cost_policy).toEqual(inherited);
    }
    expect(approvalDb.getRows('ve_hypotheses')[0].title).toBe('Стоматологии');
    await expect(loadVeApprovedSupplyAudience(approvalDb as unknown as SupabaseClient,
      { projectId: 'other-project', hypothesisId: 'h1', batchId: 'batch', baseId: 'supply' })).rejects.toThrow();

    expect(normalizeVeAudienceSourcePlan({ tasks: [task] }, [structured]).decision).toBe('unchanged');
    const requiredHiring = { ...structured, audience_scope: { ...structured.audience_scope,
      kind: 'segment' as const, any_of: ['Платёжные провайдеры'], required: ['Нанимают финансового директора'] } };
    const hiringPlan = { tasks: [{ source: 'hh_live' as const, rationale: 'Сохранить обязательную роль',
      hh_query: { text: '"платёжный провайдер" AND "финансовый директор"' } }] };
    expect(normalizeVeAudienceSourcePlan(hiringPlan, [requiredHiring]).plan).toEqual(hiringPlan);
    expect(veAudienceNicheProfile([requiredHiring])).toBeNull();
    const mixed = { ...structured, audience_scope: { ...structured.audience_scope, any_of: ['Финтех', 'Стоматологии'] } };
    expect(normalizeVeAudienceSourcePlan({ tasks: [task] }, [mixed]).plan).toEqual({ tasks: [task] });
    expect(needsLegacyFintechAudienceRefresh({ ...prior, collection_mode: 'preview', hypotheses: [{ ...sector, origin: 'manual' }] })).toBe(false);

    const paymentHistory = JSON.stringify(legacyPayments.source_selection!.previous_tasks);
    const paymentBudgets = JSON.stringify([legacyPayments.target_progress, legacyPayments.target_checkpoint,
      legacyPayments.search_policy, legacyPayments.adaptive_collection!.completed, legacyPayments.adaptive_collection!.replan_attempts]);
    expect(applyVeNicheSourceSelection(legacyPayments, 'payments')).toBe(true);
    expect(legacyPayments.source_selection?.version).toBe(2);
    expect(JSON.stringify(legacyPayments.source_selection!.previous_tasks.slice(0, -1))).toBe(paymentHistory);
    expect(legacyPayments.tasks![0].task.directory_filters).toMatchObject({ identityCatalog: 'payments-2026-10-12' });
    expect(legacyPayments.tasks![0].task.directory_filters!.nameTerms).toEqual(expect.arrayContaining(['пэй', 'пеймент']));
    expect(legacyPayments.adaptive_collection!.active_source).not.toBe(oldPaymentKey);
    expect(legacyPayments.tasks![0].exhausted).toBeUndefined();
    expect(legacyPayments.tasks![0].directory_cursors).toEqual({ old_scope: 2000 });
    expect(JSON.stringify([legacyPayments.target_progress, legacyPayments.target_checkpoint,
      legacyPayments.search_policy, legacyPayments.adaptive_collection!.completed, legacyPayments.adaptive_collection!.replan_attempts])).toBe(paymentBudgets);
    expect(applyVeNicheSourceSelection(legacyPayments, 'payments')).toBe(false);

    // A corrected official site may retry a saved, unusable company once.
    // Already acquired corrected sites, ready contacts and other bases win.
    const provider = unifiedRow({ company: 'ООО ПЭЙКИПЕР-ПРОЦЕССИНГ', inn: '5047186409',
      website: 'unrelated.test', email: 'wrong@unrelated.test' });
    const correctedProvider = normalizeVeSourceContacts(provider);
    const providerTask = legacyPayments.tasks![0].task;
    for (const blockedBy of ['none', 'corrected_seen', 'ready', 'other_base'] as const) {
      const repairedInfo = exhaustedInfo(providerTask, {
        niche_source_profile: 'payments', source_selection: { version: 2, profile: 'payments', previous_tasks: [] },
        hypotheses: [{ id: 'h1', status: 'accepted', ...payment }],
        target_checkpoint: { completed_round: 2, seen_rows: [blockedBy === 'corrected_seen' ? correctedProvider : provider], processed_rows: 1 },
        target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: 1, ready_rows: 0 },
        adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, active_source: veSourceStrategyKey(providerTask) },
      });
      repairedInfo.tasks![0] = { source: 'companies_directory', status: 'pending', child_job_id: null,
        rows: 0, task: providerTask, harvest: [] };
      const providerDb = seedBase(repairedInfo, payment, { data: blockedBy === 'ready' ? [provider] : [] },
        blockedBy === 'other_base' ? [{ id: 'other-provider-base', project_id: PROJECT.id, hypothesis_id: 'other-hypothesis',
          status: 'analyzed', data: [provider] }] : []);
      jest.mocked(searchVeNicheDirectoryRows).mockClear().mockResolvedValue({ rows: [
        { name: provider.company, inn: provider.inn, website: provider.website, email: provider.email },
      ] });
      jest.mocked(callLLMWithSchema).mockClear();
      await wake(providerDb);
      const created = providerDb.getRows('base_constructor_jobs');
      expect(created).toHaveLength(blockedBy === 'none' ? 1 : 0);
      if (created.length) {
        const grid = created[0].data as string[][];
        expect(grid[1][grid[0].indexOf('Сайт')]).toBe(correctedProvider.website);
        expect(grid[1][grid[0].indexOf('Email')]).toBe('');
      }
      expect(callLLMWithSchema).not.toHaveBeenCalled();
    }

    // A fresh exact-owner fact repairs a nonempty raw URL before acquisition.
    // The saved harvest must receive the URL, cleared email and provenance
    // together, even though normalization changed its receipt in memory.
    const rawOwner = unifiedRow({ company: 'Платёжный провайдер пример', inn: '7700000995',
      website: 'stale-owner.test', email: 'wrong@stale-owner.test', source_detail: 'реестр' });
    const verifiedWebsite = 'https://verified-owner.test/contacts';
    const factInfo = exhaustedInfo(providerTask, {
      niche_source_profile: 'payments', source_selection: { version: 2, profile: 'payments', previous_tasks: [] },
      hypotheses: [{ id: 'h1', status: 'accepted', ...payment }],
      target_checkpoint: { completed_round: 2, seen_rows: [], processed_rows: 0 },
      target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: 0, ready_rows: 0 },
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, active_source: veSourceStrategyKey(providerTask) },
    });
    factInfo.tasks![0] = { source: 'companies_directory', status: 'pending', child_job_id: null,
      rows: 0, task: providerTask, harvest: [] };
    const factDb = seedBase(factInfo, payment, { data: [] });
    await factDb.from('ve_company_fact_pages').insert({ company_key: veCompanyFactKey(rawOwner), reader_version: 1,
      observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + VE_COMPANY_FACT_TTL_MS).toISOString(),
      website: verifiedWebsite, facts: 'Платежный агрегатор для бизнеса', inns: [rawOwner.inn], owner_inns: [rawOwner.inn] });
    jest.mocked(searchVeNicheDirectoryRows).mockClear().mockResolvedValue({ rows: [
      { name: rawOwner.company, inn: rawOwner.inn, website: rawOwner.website, email: rawOwner.email },
    ] });
    jest.mocked(callLLMWithSchema).mockClear();
    jest.mocked(fetchVeRelevanceEvidence).mockClear();
    const factResult = (await wake(factDb)).collect_info as VeCollectInfo;
    const savedOwner = factResult.tasks![0].harvest![0];
    expect(savedOwner).toMatchObject({ inn: rawOwner.inn, website: verifiedWebsite, email: '' });
    expect(savedOwner.source_detail).toContain(`${VE_CONFIRMED_WEBSITE_MARK} ${verifiedWebsite}`);
    expect(savedOwner.source_detail).toContain(rawOwner.email);
    const factChildren = factDb.getRows('base_constructor_jobs');
    expect(factChildren).toHaveLength(1);
    const factGrid = factChildren[0].data as string[][];
    expect(factGrid[1][factGrid[0].indexOf('Сайт')]).toBe(verifiedWebsite);
    expect(factGrid[1][factGrid[0].indexOf('Email')]).toBe('');
    const childBeforeRetry = JSON.stringify(factChildren[0]);
    await wake(factDb);
    expect(factDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(JSON.stringify(factDb.getRows('base_constructor_jobs')[0])).toBe(childBeforeRetry);
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();

    // PG esoteric/fintech, 12.10: v1 changed the query but kept a done page
    // attributed to the old, dry strategy. That page must not pin renewal.
    for (const replanAttempts of [0, 2]) {
      const oldKey = veSourceStrategyKey(task);
      const oldRow = { ...unifiedRow({ company: 'Старый ИТ-подрядчик', inn: '7700000991',
        website: 'old-provider.test', email: 'sales@old-provider.test' }), _ve_source_strategy: oldKey };
      const migrated = exhaustedInfo(task, {
        hypotheses: [{ id: 'h1', status: 'accepted', ...payment }],
        target_progress: { ...createCollectionTarget('preview'), round: 42, candidates_processed: 1993,
          ready_rows: 2, max_rounds: 141 },
        target_checkpoint: { completed_round: 41, seen_rows: processed, processed_rows: 1993 },
        adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: replanAttempts, widenings: 2,
          active_source: oldKey, completed: Array.from({ length: replanAttempts ? 5 : 15 }, (_, index) => ({
            id: `old-${index}`, source_key: oldKey, source: 'companies_directory', candidates: 100,
            new_ready: 0, new_target: 0, poor: true, started_at: '2026-09-30T14:56:46.399Z',
            finished_at: '2026-09-30T15:08:38.981Z',
            spend: { ai_usd: 0.01, serper_credits: 0, estimated_total_usd: 0.01, unknown_attempts: 0, complete: true },
          })) },
      });
      migrated.tasks![0].harvest = [oldRow];
      migrated.tasks![0].directory_cursors = { old_scope: 1729 };
      applyVeNicheSourceSelection(migrated, 'payments');
      const oldHistory = JSON.stringify(migrated.adaptive_collection!.completed);
      const oldCheckpoint = JSON.stringify(migrated.target_checkpoint);
      const savedMigration = JSON.parse(JSON.stringify(migrated)) as VeCollectInfo;
      const migratedDb = seedBase(migrated, payment);
      jest.mocked(callLLMWithSchema).mockClear();
      jest.mocked(searchRows).mockClear();
      jest.mocked(searchVeNicheDirectoryRows).mockClear().mockResolvedValue({ rows: [
        { name: 'Финтех Платежи', inn: '7700000992', website: 'fintech-pay.test', email: 'info@fintech-pay.test' },
      ] });
      const resumed = (await wake(migratedDb)).collect_info as VeCollectInfo;
      expect(searchVeNicheDirectoryRows).toHaveBeenCalled();
      expect(jest.mocked(searchVeNicheDirectoryRows).mock.calls[0].slice(1, 3)).toEqual([
        expect.objectContaining({ hasEmail: true, okvedCodes: ['64', '62'] }), expect.arrayContaining(['финтех']),
      ]);
      expect(resumed.tasks![0].directory_cursors?.old_scope).toBe(1729);
      expect(resumed.search_policy!.deferred_rows).toContainEqual(oldRow);
      expect(JSON.stringify(resumed.target_checkpoint)).toBe(oldCheckpoint);
      expect(JSON.stringify(resumed.adaptive_collection!.completed)).toBe(oldHistory);
      expect(resumed.adaptive_collection!.replan_attempts).toBe(replanAttempts);
      expect(resumed.target_progress).toMatchObject({ round: 42, candidates_processed: 1993, max_rounds: 141 });
      const children = migratedDb.getRows('base_constructor_jobs');
      expect(children).toHaveLength(1);
      expect(JSON.stringify(children[0].data)).toContain('fintech-pay.test');
      expect(JSON.stringify(children[0].data)).not.toContain('old-provider.test');
      expect(searchRows).not.toHaveBeenCalled();
      expect(callLLMWithSchema).not.toHaveBeenCalled();

      // The exception is only for retired pages: unchanged held sources stay
      // held, and ordinary non-niche renewal keeps its existing behaviour.
      for (const sameScope of [true, false]) {
        const control = JSON.parse(JSON.stringify(savedMigration)) as VeCollectInfo;
        if (sameScope) {
          control.tasks![0].task = task;
          control.plan!.tasks = [task];
          control.adaptive_collection!.active_source = oldKey;
        } else {
          delete control.niche_source_profile;
          delete control.source_selection;
          control.hypotheses = [{ id: 'h1', status: 'accepted', ...MEAT }];
        }
        const controlDb = seedBase(control, sameScope ? payment : MEAT);
        jest.mocked(searchVeNicheDirectoryRows).mockClear();
        await wake(controlDb);
        expect(searchVeNicheDirectoryRows).not.toHaveBeenCalled();
        expect(controlDb.getRows('base_constructor_jobs')).toHaveLength(0);
        expect((controlDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0].harvest).toContainEqual(oldRow);
      }
    }
    jest.mocked(searchVeNicheDirectoryRows).mockReset().mockResolvedValue({ rows: [] });
    for (const outstanding of [
      { construct: { bc_job_id: 'paid-child', status: 'dispatched' as const } },
      { tasks: [{ ...prior.tasks![0], status: 'dispatched' as const, child_job_id: 'paid-hh' }] },
      { preview_pipeline: { version: 1 as const, revision: 1, batches: [{ id: 'paid-batch', rows: [seen], dispatched_at: '2026-10-11' }] } },
    ]) {
      const inFlight = { ...prior, source_selection: undefined, ...outstanding };
      const snapshot = JSON.stringify(inFlight);
      expect(applyVeNicheSourceSelection(inFlight, 'payments')).toBe(false);
      expect(JSON.stringify(inFlight)).toBe(snapshot);
    }
    prior.adaptive_collection!.replan_attempts = 0;
    prior.adaptive_collection!.replan_needed = true;
    const cappedDb = seedBase(prior, payment);
    jest.mocked(callLLMWithSchema).mockClear();
    jest.mocked(searchVeNicheDirectoryRows).mockClear();
    jest.mocked(searchRows).mockClear();
    await wake(cappedDb);
    const capped = cappedDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(capped.target_progress).toMatchObject({ candidates_processed: 10_000, ready_rows: 2 });
    expect(capped.search_policy?.phase).toBe('paid'); // Saved phase is historical; the niche guard still blocks new spend.
    expect(searchVeNicheDirectoryRows).not.toHaveBeenCalled();
    expect(searchRows).not.toHaveBeenCalled();
    expect(cappedDb.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(callLLMWithSchema).not.toHaveBeenCalled();

    // An old paid preview first resumes relevance, before tasks can migrate.
    // The policy and safe source correction must be applied before that return.
    for (const [broad, savedBroad] of [[false, undefined], [true, undefined], [true, true]] as const) {
      const retryInfo = exhaustedInfo(task, { hypotheses: [{ id: 'h1', status: 'accepted', title: payment.title, broad: savedBroad }],
        relevance_review_requested: true, validation_retry: true,
        construct: { status: 'done', bc_job_id: 'already-imported' },
        target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: 2, ready_rows: 2 },
        target_checkpoint: { completed_round: 3, seen_rows: processed, processed_rows: 2 },
        relevance_reserve: { version: 1, rows: [{ ...ready[0], _ve_relevance: { version: 1, status: 'error' } }] },
      });
      const retryDb = seedBase(retryInfo, { ...payment, broad });
      mockFindIrrelevantRows.mockClear();
      await wake(retryDb);
      const retried = retryDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(retried.niche_source_profile).toBe('payments');
      expect(retried.hypotheses?.[0].broad).toBe(broad);
      expect(retried.source_selection?.profile).toBe('payments');
      expect(mockFindIrrelevantRows).toHaveBeenCalled();
      for (const [input] of mockFindIrrelevantRows.mock.calls) expect(input.allowPaidSearch).toBe(false);
      expect(retried.tasks![0].task.directory_filters?.nameTerms).toContain('финтех');
      expect(searchVeNicheDirectoryRows).not.toHaveBeenCalled();
    }
  });

  it('inherits approved geography without a structured audience and never reads the current project brief', async () => {
    const lineage = {
      ve_contact_supply_batches: [{ id: 'geo-batch', base_id: 'geo-supply', plan_id: 'geo-plan' }],
      ve_contact_supply_plans: [{ id: 'geo-plan', project_id: 'p1', hypothesis_id: 'h1', item_id: 'geo-launch' }],
      ve_launch_queue_items: [{ id: 'geo-launch', project_id: 'p1', hypothesis_id: 'h1', base_id: 'geo-preview' }],
      ve_projects: [{ id: 'p1', brief: { client_brief: { icp: { geo: 'Current brief must not apply' } } } }],
    };
    const input = { projectId: 'p1', hypothesisId: 'h1', batchId: 'geo-batch', baseId: 'geo-supply' };
    const source = { id: 'geo-preview', project_id: 'p1', hypothesis_id: 'h1', audience_snapshot: null, cost_policy: null };
    for (const geography of [{ version: 1, required: 'Москва и МО' }, { version: 1, required: null }, undefined]) {
      const db = createMockSupabase({ tables: { ...lineage, ve_bases: [{ ...source, collection_geography: geography }] } });
      const result = await loadVeApprovedSupplyAudience(db as unknown as SupabaseClient, input);
      expect(result).toEqual(geography ? { snapshot: null, costPolicy: null, geography } : null);
      expect(db.selects.some((read) => read.table === 've_projects' || read.table === 've_hypotheses')).toBe(false);
      if (result?.geography) {
        result.geography.required = 'Changed by caller';
        expect(db.getRows('ve_bases')[0].collection_geography).toEqual(geography);
      }
    }
    for (const geography of [{ version: 2, required: 'Москва' }, { version: 1, required: 77 }]) {
      const db = createMockSupabase({ tables: { ...lineage, ve_bases: [{ ...source, collection_geography: geography }] } });
      await expect(loadVeApprovedSupplyAudience(db as unknown as SupabaseClient, input)).rejects.toThrow();
    }
    for (const changed of [
      { ve_contact_supply_batches: [{ ...lineage.ve_contact_supply_batches[0], base_id: 'unrelated-base' }] },
      { ve_contact_supply_plans: [{ ...lineage.ve_contact_supply_plans[0], project_id: 'unrelated-project' }] },
      { ve_launch_queue_items: [{ ...lineage.ve_launch_queue_items[0], hypothesis_id: 'unrelated-hypothesis' }] },
      { ve_bases: [{ ...source, project_id: 'unrelated-project', collection_geography: { version: 1, required: 'Москва' } }] },
    ]) {
      const db = createMockSupabase({ tables: { ...lineage,
        ve_bases: [{ ...source, collection_geography: { version: 1, required: 'Москва' } }], ...changed } });
      await expect(loadVeApprovedSupplyAudience(db as unknown as SupabaseClient, input)).rejects.toThrow();
    }
  });

  it('план широкой гипотезы — классы ОКВЭД и каталог без порогов и без сигнала найма', async () => {
    // Задачи — из планов баз «Франшизы медклиник» (b5df5b70) и «Медицинские
    // лаборатории» (433aa426) проекта «Велл Медиа»: там они узкие, здесь сектор.
    const franchise = { source: 'companies_directory' as const, rationale: 'Юрлица медцентров, стоматологий и лабораторий.',
      directory_filters: { hasEmail: false, includeIp: false, okvedCodes: ['86'], revenueFrom: 50_000_000, employeesFrom: 20 } };
    const beauty = { source: 'companies_directory' as const, rationale: 'Косметологические сети.',
      directory_filters: { hasEmail: false, includeIp: false, okvedCodes: ['96.02', '86.23'], revenueFrom: 30_000_000, employeesFrom: 15 } };
    const hiring = { source: 'hh_live' as const, rationale: 'Компании, нанимающие роли по франчайзингу.',
      hh_query: { text: '"директор по франчайзингу" (клиника OR стоматология)', date_from: '2026-08-18', date_to: '2026-09-17' } };
    const labs = { source: 'yandex_maps' as const, rationale: 'Точки медицинских лабораторий и пунктов анализов.',
      maps_query: { geo: 'Россия', queries: ['медицинская лаборатория', 'пункт приема анализов', 'анализы'] } };
    jest.mocked(searchRows).mockResolvedValue({ rows: [] });
    const sector = { title: 'Частная медицина', description: 'Частные клиники, медцентры, стоматологии, лаборатории и диагностические центры. Общая боль — пациент дорожает.' };
    for (const broad of [true, false]) {
      jest.mocked(callLLMWithSchema).mockClear();
      const db = seed({ collection_mode: 'preview' }, { ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1',
        status: 'accepted', broad, ...sector }] });
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([franchise, beauty, hiring, labs]));
      const info = (await wake(db)).collect_info as VeCollectInfo;
      expect(info.niche_source_profile).toBeUndefined();
      expect(info.source_selection).toBeUndefined();
      const prompt = String(jest.mocked(callLLMWithSchema).mock.calls[0][0].at(-1)?.content);
      if (!broad) {
        // Узкая — как раньше: коды группы и найм остаются, пороги сняты (в тексте о размере ни слова).
        expect(prompt).not.toContain('[широкая]');
        expect(info.plan?.tasks.map((task) => task.source)).toEqual(['companies_directory', 'companies_directory', 'hh_live', 'yandex_maps']);
        expect(info.plan?.tasks[1].directory_filters?.okvedCodes).toEqual(['96.02', '86.23']);
        continue;
      }
      expect(prompt).toContain('[широкая] Частная медицина');
      expect(info.plan?.tasks).toEqual([
        { ...franchise, directory_filters: { hasEmail: false, includeIp: false, okvedCodes: ['86'] } },
        { ...beauty, directory_filters: { hasEmail: false, includeIp: false, okvedCodes: ['96', '86'] } },
        labs,
      ]);
    }
  });

  // 2ГИС (план R3, часть 2): флаг, близнецы в первичном плане, пары.
  const TWO_GIS_FLAG = { version: 1 as const, snapshot_id: 7, features_version: 1, max_candidates: 1000, frozen_at: '2026-10-26T12:00:00.000Z' };
  const twoGisMaps = (query: string) => ({ source: 'yandex_maps' as const, rationale: `Карты: ${query}`, maps_query: { geo: 'Россия', queries: [query] } });

  it('2ГИС: флаг ставит только вставка нового RU-превью при mode=on, проверенном снимке и открытой выдаче; поставка копирует его по тем же правилам', async () => {
    const settings = { market: 'ru', mode: 'on', reads_enabled: true, client_use: 'all', internal_projects: [], excluded_projects: [],
      quiet_start_utc: '02:00', quiet_end_utc: '11:00', max_candidates: 1000, snapshot_id: 7, features_version: 1, built_at: '2026-10-26T10:00:00Z' };
    const meat = (id: string) => ({ id, project_id: 'p1', vertical_id: 'v1', status: 'accepted', broad: false, ...MEAT });
    const enqueueDb = (row: Record<string, unknown> | null, market = 'ru', errorTables?: Record<string, string>) => createMockSupabase({
      tables: { ve_projects: [{ id: 'p1', brief: {}, market }], ve_hypotheses: [meat('h1'), meat('h2')],
        ...(row ? { ve_twogis_source_settings: [row] } : {}) }, ...(errorTables ? { errorTables } : {}) });
    const settingsReads = (db: MockSupabaseClient) => db.selects.filter((read) => read.table === 've_twogis_source_settings').length;
    const enqueue = { verticalId: 'v1', projectId: 'p1', verticalName: 'Мясо', limit: 100 };
    const preview = { ...enqueue, collectionMode: 'preview' as const, hypothesisIds: ['h1', 'h2'] };
    const db = enqueueDb(settings);
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, preview)).resolves.toMatchObject({ ok: true, created: true });
    expect(db.getRows('ve_bases').map((base) => (base.collect_info as VeCollectInfo).two_gis_source))
      .toEqual([0, 1].map(() => ({ ...TWO_GIS_FLAG, frozen_at: expect.any(String) })));
    expect(db.getRows('ve_jobs').every((row) => !('two_gis_source' in (row.payload as Record<string, unknown>)))).toBe(true);
    expect(settingsReads(db)).toBe(1); // одна строка настроек на запрос
    expect(db.selects).toContainEqual({ table: 've_projects', columns: 'brief, market' }); // рынок — тем же чтением, что и география
    // Повтор и ремонт осиротевшей базы флаг не ставят и настроек не читают.
    await db.from('ve_twogis_source_settings').update({ snapshot_id: 8 }).eq('market', 'ru');
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, preview)).resolves.toMatchObject({ ok: true, created: false });
    await db.from('ve_jobs').delete();
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, preview)).resolves.toMatchObject({ ok: true, created: false });
    expect(settingsReads(db)).toBe(1);
    expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).two_gis_source?.snapshot_id).toBe(7);
    for (const [row, market, errors] of [[{ ...settings, mode: 'off' }], [{ ...settings, client_use: 'off' }],
      [{ ...settings, excluded_projects: ['p1'] }], [{ ...settings, client_use: 'internal', internal_projects: ['other'] }],
      [{ ...settings, snapshot_id: null }], [{ ...settings, mode: 'maybe' }], [null], [settings, 'ru', { ve_twogis_source_settings: 'read failed' }],
      [settings, 'us']] as Array<[Record<string, unknown> | null, string?, Record<string, string>?]>) {
      const closed = enqueueDb(row, market, errors);
      await expect(enqueueVeBaseCollect(closed as unknown as SupabaseClient, preview)).resolves.toMatchObject({ ok: true, created: true });
      expect(closed.getRows('ve_bases').some((base) => 'two_gis_source' in (base.collect_info as VeCollectInfo))).toBe(false);
      expect(settingsReads(closed)).toBe(market === 'us' ? 0 : 1);
    }
    const refill = enqueueDb(settings);
    await expect(enqueueVeBaseCollect(refill as unknown as SupabaseClient, { ...enqueue, hypothesisIds: null, refill: { campaignId: 'c1' } }))
      .resolves.toMatchObject({ ok: true });
    expect(settingsReads(refill)).toBe(0);

    // Поставка: линия запуска несёт флаг и без снимка и географии; чужая форма — как флага нет.
    const lineage = { ve_contact_supply_batches: [{ id: 'flag-batch', base_id: 'b1', plan_id: 'flag-plan' }],
      ve_contact_supply_plans: [{ id: 'flag-plan', project_id: 'p1', hypothesis_id: 'h1', item_id: 'flag-launch' }],
      ve_launch_queue_items: [{ id: 'flag-launch', project_id: 'p1', hypothesis_id: 'h1', base_id: 'flag-preview' }] };
    const source = { id: 'flag-preview', project_id: 'p1', hypothesis_id: 'h1', source: 'auto', status: 'analyzed', audience_snapshot: null, cost_policy: null };
    const lineageInput = { projectId: 'p1', hypothesisId: 'h1', batchId: 'flag-batch', baseId: 'b1' };
    for (const [flag, expected] of [[TWO_GIS_FLAG, { snapshot: null, costPolicy: null, geography: null, twoGisSource: TWO_GIS_FLAG }],
      [{ ...TWO_GIS_FLAG, version: 2 }, null], [undefined, null]] as const) {
      const lineageDb = createMockSupabase({ tables: { ...lineage, ve_bases: [{ ...source, two_gis_source: flag }] } });
      await expect(loadVeApprovedSupplyAudience(lineageDb as unknown as SupabaseClient, lineageInput)).resolves.toEqual(expected);
      expect(lineageDb.selects.some((read) => read.table === 've_bases'
        && read.columns.includes('two_gis_source:collect_info->two_gis_source'))).toBe(true);
    }
    jest.mocked(searchRows).mockResolvedValue({ rows: [] } as never);
    for (const [row, flagged, copied] of [[settings, true, true], [{ ...settings, mode: 'off' }, true, false],
      [{ ...settings, snapshot_id: 8 }, true, false], [{ ...settings, features_version: 2 }, true, false],
      [{ ...settings, excluded_projects: ['p1'] }, true, false], [settings, false, false]] as const) {
      const supplyInfo: VeCollectInfo = { collection_mode: 'supply', supply_batch_id: 'flag-batch', ready_target: 500 };
      const supplyDb = seed(supplyInfo, { ...hypothesis({ ...MEAT, broad: false }), ...lineage, ve_twogis_source_settings: [row],
        ve_bases: [makeBase(supplyInfo), { ...source, ...(flagged ? { two_gis_source: TWO_GIS_FLAG } : {}),
          collection_geography: { version: 1, required: null } }] });
      const originalRpc = supplyDb.rpc;
      supplyDb.rpc = (name, params) => name === 've_require_contact_supply_active'
        ? Promise.resolve({ data: { id: 'flag-plan' }, error: null }) : originalRpc(name, params);
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([MEAT_TASK]));
      const supply = (await wake(supplyDb)).collect_info as VeCollectInfo;
      if (copied) expect(supply.two_gis_source).toEqual(TWO_GIS_FLAG);
      else expect(supply).not.toHaveProperty('two_gis_source');
      expect(settingsReads(supplyDb)).toBe(flagged ? 1 : 0);
    }
  });

  it('2ГИС: база без флага, а с флагом — при профиле аудитории, получает тот же план, промпт и состояния; реплан близнецов не даёт', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: [] } as never);
    const llmTasks = [MEAT_TASK, twoGisMaps('мясокомбинат'), twoGisMaps('колбасный цех')];
    const run = async (info: VeCollectInfo, text: { title: string; description: string; broad?: boolean; audience_scope?: unknown }) => {
      jest.mocked(callLLMWithSchema).mockClear();
      const db = seed(info, hypothesis(text));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply(llmTasks));
      const saved = (await wake(db)).collect_info as VeCollectInfo;
      return { saved, prompt: jest.mocked(callLLMWithSchema).mock.calls[0][0],
        settingsReads: db.selects.filter((read) => read.table === 've_twogis_source_settings').length };
    };
    type Text = { title: string; description: string; broad?: boolean };
    const texts: Text[] = [{ ...MEAT, broad: false }, { ...MEAT }, { title: 'Стоматологические клиники', broad: false,
      description: 'Частные стоматологии с несколькими креслами и записью пациентов онлайн.' }];
    for (const text of texts) {
      const plain = await run({ collection_mode: 'preview' }, text);
      expect(plain.saved.plan!.tasks.some((task) => task.source === 'two_gis')).toBe(false);
      // Задачи карт этот тик не трогал: их состояние — ровно прежние пять полей, без two_gis и пары.
      expect(plain.saved.tasks!.slice(1).map((state) => Object.keys(state).sort().join()))
        .toEqual(['child_job_id,rows,source,status,task', 'child_job_id,rows,source,status,task']);
      expect(plain.settingsReads).toBe(0);
      if (text.broad === false && text.title === MEAT.title) continue; // без профиля флаг даёт близнецов — следующий it()
      // Флаг при профиле или непрочитанном broad ничего не меняет: тот же план, состояния и промпт.
      const inert = await run({ collection_mode: 'preview', two_gis_source: TWO_GIS_FLAG }, text);
      expect(inert.saved.plan).toEqual(plain.saved.plan);
      expect(inert.saved.tasks).toEqual(plain.saved.tasks);
      expect(inert.prompt).toEqual(plain.prompt);
      expect(inert.settingsReads).toBe(0);
    }

    // Реплан базы с близнецом: в промпте его нет, добавленная задача — без близнеца и пары.
    const [maps, twin] = withVeTwoGisTwins({ tasks: [twoGisMaps('мясокомбинат')] }).tasks;
    const replanInfo = exhaustedInfo(MEAT_TASK, { two_gis_source: TWO_GIS_FLAG,
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_needed: true, replan_reason: 'low_yield', active_source: veSourceStrategyKey(MEAT_TASK) } });
    replanInfo.plan!.tasks.push(maps, twin);
    replanInfo.tasks!.push({ source: 'yandex_maps', task: maps, status: 'done', child_job_id: null, rows: 0, exhausted: true, two_gis_pair_id: 'p' },
      { source: 'two_gis', task: twin, status: 'done', child_job_id: null, rows: 0, unavailable: true, two_gis_pair_id: 'p' });
    jest.mocked(callLLMWithSchema).mockClear();
    const db = seedBase(replanInfo, { ...MEAT, broad: false });
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([twoGisMaps('кондитерская фабрика'), SWEETS_TASK]));
    const replanned = (await wake(db)).collect_info as VeCollectInfo;
    const feedback = String(jest.mocked(callLLMWithSchema).mock.calls[0][0].at(-1)?.content);
    expect(feedback).toContain('Предыдущий план (без порогов размера)');
    expect(feedback).not.toContain('two_gis');
    // Реплан добавил Яндекс-задачу — без близнеца и без пары; близнец в базе по-прежнему один.
    expect(replanned.tasks![3]).toMatchObject({ source: 'yandex_maps', task: { maps_query: { queries: ['кондитерская фабрика'] } } });
    expect(replanned.tasks![3].two_gis_pair_id).toBeUndefined();
    expect(replanned.tasks!.filter((state) => state.source === 'two_gis')).toHaveLength(1);
    expect(replanned.tasks!.slice(3).every((state) => state.two_gis_pair_id === undefined)).toBe(true);
  });

  it('2ГИС: близнецы вне потолка 6 задач, каждый сразу после своей Яндекс-задачи с общей парой; known_websites близнеца не перезаписывает', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: [] } as never);
    const directory = (okved: string) => ({ source: 'companies_directory' as const, rationale: `Реестр ${okved}`,
      directory_filters: { includeIp: false, okvedCodes: [okved] } });
    const hh = { source: 'hh_live' as const, rationale: 'Найм технологов мясного производства', hh_query: { text: 'технолог мясного производства' } };
    const db = seed({ collection_mode: 'preview', two_gis_source: TWO_GIS_FLAG }, hypothesis({ ...MEAT, broad: false }));
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply([directory('10.1'), twoGisMaps('мясокомбинат'),
      twoGisMaps('колбасный цех'), hh, directory('10.13')]));
    const info = (await wake(db)).collect_info as VeCollectInfo;
    expect(info.plan!.tasks.map((task) => task.source)).toEqual(['companies_directory', 'yandex_maps', 'two_gis', 'yandex_maps', 'two_gis',
      'hh_live', 'companies_directory']);
    expect(veCountedPlanTasks(info.plan!.tasks)).toHaveLength(5);
    const pairs = info.tasks!.map((state) => state.two_gis_pair_id ?? null);
    expect(pairs[1]).toEqual(expect.any(String));
    expect([pairs[2], pairs[3], pairs[4]]).toEqual([pairs[1], expect.any(String), pairs[3]]);
    expect(pairs[3]).not.toBe(pairs[1]);
    expect([pairs[0], pairs[5], pairs[6]]).toEqual([null, null, null]);
    // Потолок плана считает только 5 настоящих задач; с двумя обычными вместо близнецов их было бы 7.
    expect(veCanWidenPlan(info.plan!.tasks, { replan_attempts: 0, widenings: 0 })).toBe(true);
    expect(veCanWidenPlan([...veCountedPlanTasks(info.plan!.tasks), directory('10.85'), directory('10.86')],
      { replan_attempts: 0, widenings: 0 })).toBe(false);

    // Решение Сергея 26.10: структурная аудитория получает близнеца, кроме аудитории с обязательными условиями;
    // профили (ниша, клиники, медиа, ритейл, рестораны, генерация, финтех) — без близнецов.
    const planOf = async (text: Record<string, unknown>, tasks: unknown[], extra: Partial<VeCollectInfo> = {}) => {
      const profiledDb = seed({ collection_mode: 'preview', two_gis_source: TWO_GIS_FLAG, ...extra },
        hypothesis(text as { title: string; description: string }));
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(planLlmReply(tasks));
      const profiled = await wake(profiledDb);
      expect(profiled.status).not.toBe('failed');
      return (profiled.collect_info as VeCollectInfo).plan!.tasks.map((task) => task.source);
    };
    const scope = (required: string[]) => ({ version: 1, kind: 'segment', any_of: ['Мясоперерабатывающие заводы'], required, excluded: [] });
    const meatPlan = [directory('10.1'), twoGisMaps('мясокомбинат')];
    expect(await planOf({ ...MEAT, broad: false, audience_scope: scope([]) }, meatPlan)).toEqual(['companies_directory', 'yandex_maps', 'two_gis']);
    expect(await planOf({ ...MEAT, broad: false, audience_scope: scope(['Собственная лаборатория']) }, meatPlan))
      .toEqual(['companies_directory', 'yandex_maps']);
    // Дедуп близнецов — после географии брифа: «Москва» и «Россия» сводятся к одному ключу; проза — без близнеца.
    const moscowRussia = [directory('10.1'), { ...twoGisMaps('мясокомбинат'), maps_query: { geo: 'Москва', queries: ['мясокомбинат'] } },
      twoGisMaps('мясокомбинат')];
    expect(await planOf({ ...MEAT, broad: false }, moscowRussia, { collection_geography: { version: 1, required: 'Москва и МО' } }))
      .toEqual(['companies_directory', 'yandex_maps', 'two_gis', 'yandex_maps']);
    expect(await planOf({ ...MEAT, broad: false }, meatPlan, { collection_geography: { version: 1, required: 'РФ кроме Москвы' } }))
      .not.toContain('two_gis');
    for (const profile of [
      { title: 'Платформы веб-моделей и взрослого контента', description: 'Стриминговые платформы для взрослых и фан-сообщества 18+.', broad: false },
      { title: 'Стоматологические клиники', description: 'Частные стоматологии с несколькими креслами и записью пациентов онлайн.', broad: false },
      { title: 'Игры и анимация', broad: false,
        description: 'Игровые издатели, анимационные студии и владельцы IP с титрами, UI, мерчем и промо. Шрифт помогает создать узнаваемый мир и локализовать кириллицу.' },
      { title: 'Производители строительно-отделочных материалов', broad: false, origin: 'generated',
        description: 'Заводы сухих смесей, напольных покрытий, плитки и ЛКМ с собственным шоурумом и интернет-магазином. Потеря прямых частных заказов при передаче их сторонним дилерам.' },
      { title: 'Сетевые ресторанные альянсы и гастромаркеты', broad: false, origin: 'generated',
        description: 'Ресторанные холдинги, сети концептуальных кафе и фудмоллы. Необходимость привлекать трафик гостей в непиковые часы и презентовать сезонные меню.' },
      { title: 'Энергетические компании', broad: false,
        description: 'ТЭЦ, ГРЭС, АЭС-смежные и генерирующие компании с химлабораториями воды, топлива, масел и выбросов. ЛИМС упорядочивает пробы, графики, приборы и отчётность.' },
      // Широкий финтех, который не распознаётся нишей «платежи».
      { title: 'Финтех-компании', description: 'Необанки и финтех-сервисы', broad: true },
    ]) {
      const sources = await planOf(profile, [...meatPlan, hh]);
      expect(sources).toContain('yandex_maps');
      expect(sources).not.toContain('two_gis');
    }

    // known_websites: при добавлении близнец не перезаписан; при замене его Яндекс-задачи — закрыт.
    const adult = { id: 'h1', status: 'accepted', title: 'Платформы веб-моделей и взрослого контента',
      description: 'Стриминговые платформы для взрослых и фан-сообщества 18+.' };
    const [webcam, webcamTwin] = withVeTwoGisTwins({ tasks: [twoGisMaps('вебкам студия')] }).tasks;
    const knownInfo = (maps: Partial<NonNullable<VeCollectInfo['tasks']>[number]>): VeCollectInfo => ({ collection_mode: 'preview',
      hypotheses: [adult], niche_source_profile: 'adult_platform', plan: { tasks: [webcam, webcamTwin] },
      target_progress: { ...createCollectionTarget('preview'), round: 1, candidates_processed: 0, ready_rows: 0 },
      tasks: [{ source: 'yandex_maps', task: webcam, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p', ...maps },
        { source: 'two_gis', task: webcamTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p' }] });
    const appended = knownInfo({ status: 'done', rows: 2, harvest: processed });
    expect(addVeKnownWebsiteSource(appended)).toBe(true);
    expect(appended.tasks!.map((state) => state.source)).toEqual(['yandex_maps', 'two_gis', 'known_websites']);
    expect(appended.tasks![1]).toEqual({ source: 'two_gis', task: webcamTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p' });
    const replaced = knownInfo({});
    expect(addVeKnownWebsiteSource(replaced)).toBe(true);
    expect(replaced.tasks!.map((state) => state.source)).toEqual(['known_websites', 'two_gis']);
    expect(replaced.tasks![1]).toMatchObject({ status: 'done', unavailable: true, two_gis_pair_id: 'p' });
  });

  it('2ГИС: сайт, название и строка карточки; страница — параметры, курсор и исходы чтения без исключений для одной базы', async () => {
    // Ключ домена: весь хост на конструкторе, иначе домен по tldts; мусор — null.
    for (const [raw, domain, kind] of [['https://www.Romashka.RU/about?x=1', 'romashka.ru', 'own'], ['shop.romashka.ru', 'romashka.ru', 'own'],
      ['acme.tilda.ws', 'acme.tilda.ws', 'builder'], ['shop.acme.tilda.ws', 'shop.acme.tilda.ws', 'builder'],
      ['acme.wixsite.com', 'acme.wixsite.com', 'builder'], ['school5.gosuslugi.ru', 'school5.gosuslugi.ru', 'builder'],
      ['acme.nethouse.ru', 'acme.nethouse.ru', 'builder'], ['tilda.ws', 'tilda.ws', 'catalog'], ['info2gis.tilda.ws', 'info2gis.tilda.ws', 'catalog'],
      ['company.2gis.biz', '2gis.biz', 'catalog'], ['кафе.рф', 'xn--80akn5b.xn--p1ai', 'own'], ['http://old.example.ru', 'example.ru', 'own'],
      ['http://www.www.romashka.ru', 'romashka.ru', 'own'], ['www.www.tilda.ws', 'tilda.ws', 'catalog'],
      ['не сайт', null, null], ['127.0.0.1', null, null]] as const) {
      expect([raw, veTwoGisSiteDomain(raw), veTwoGisSiteKind(raw)]).toEqual([raw, domain, kind]);
    }
    expect(veTwoGisWebsiteHost('https://www.Кафе.РФ/menu')).toBe('xn--80akn5b.xn--p1ai');
    expect(veTwoGisWebsiteHost('http://www.www.romashka.ru')).toBe('romashka.ru'); // CHECK host !~ '^www\.' в ve2
    expect(['mos.ru', 'dogm.mos.ru', 'school5.gosuslugi.ru', '77.mvd.ru', 'notmos.ru', 'romashka.ru'].map(isVeTwoGisGovernmentHost))
      .toEqual([true, true, true, true, false, false]);
    // Название — до первой запятой вне «», "", “”, „“, () и []; апостроф — не кавычка.
    for (const [name, company] of [['Ромашка, мебельная фабрика', 'Ромашка'], ['«Рога, копыта», ООО', '«Рога, копыта»'],
      ['ООО "Альфа, Бета", склад', 'ООО "Альфа, Бета"'], ['Сервис (ремонт, продажа), магазин', 'Сервис (ремонт, продажа)'],
      ['ООО “Альфа, Бета”, склад', 'ООО “Альфа, Бета”'], ['„Альфа, Бета“, склад', '„Альфа, Бета“'],
      ['Альфа[ремонт, продажа], склад', 'Альфа[ремонт, продажа]'], ['О’КЕЙ, гипермаркет', 'О’КЕЙ'],
      ['Ромашка, мебельная фабрика, склад', 'Ромашка'], ['«А, Б», цех, склад', '«А, Б»'],
      ['  Просто название  ', 'Просто название'], [', склад', ', склад'], ['', '']] as const) expect(veTwoGisCompanyName(name)).toBe(company);
    expect([veTwoGisWebsite('old.example.ru', 'http'), veTwoGisWebsite('example.ru', 'https')]).toEqual(['http://old.example.ru', 'example.ru']);
    expect([veTwoGisAddress('Москва', '77'), veTwoGisAddress('Химки', '50'), veTwoGisAddress('Казань', null), veTwoGisAddress('', '16')])
      .toEqual(['Москва', 'Химки, Московская область', 'Казань', 'Республика Татарстан']);
    // Строка: без телефона, почты, рубрики и полного адреса; метка — только ссылка на карточку.
    const card = { card_id: '7000000000000008', registrable_domain: 'old-site.ru', host: 'www.Old-Site.ru', site_scheme: 'http' as const,
      region_code: '50', name: 'Старый сайт, агентство', city_name: 'Химки', phone: '+7 900 000-00-00', email: 'secret@card.test',
      geometry_name: 'ул. Тестовая, 1', post_code: '141400' };
    const mapped = mapTwoGisRow(card, 7);
    expect(mapped).toEqual({ company: 'Старый сайт', website: 'http://old-site.ru', email: '', phone: '', vacancy_title: '',
      address: 'Химки, Московская область', category: '', employees: '', revenue: '', inn: '', source_detail: 'справочник организаций',
      _ve_two_gis: { card_id: '7000000000000008', snapshot_id: 7 } });
    expect(Object.keys(mapped).sort()).toEqual([...VE_AUTO_COLLECT_COLUMNS, '_ve_two_gis'].sort());
    expect(mapTwoGisRow({ ...card, site_scheme: 'https' }, 7).website).toBe('old-site.ru');
    expect(JSON.stringify(mapped)).not.toMatch(/Тестовая|141400|secret@|900/);
    // http-only сайт — та же компания, что голый хост и https://www. других источников (дедуп, исключения).
    const siteKey = veCompanyWebsiteKey({ company: mapped.company, website: 'old-site.ru' });
    expect(siteKey).not.toBeNull();
    for (const website of [mapped.website, 'https://www.old-site.ru/']) {
      expect(veCompanyWebsiteKey({ company: mapped.company, website })).toBe(siteKey);
    }

    // Страница: параметры по географии, всегда горячие карточки, контакты карточки не читаются.
    const allow = { nonCompany: false, privateRubric: true, ipName: false, government: true };
    const input = { flag: { snapshot_id: 7, features_version: 1 }, rubrics: ['Агентства недвижимости', 'Риелторы', 'Риелторы'],
      after: '', scope: {}, allow, limit: 500 };
    for (const [scope, geoAll, regions, cities] of [[{}, true, [], []], [{ region_codes: ['77', '50'] }, false, ['77', '50'], []],
      [{ cities: ['Орёл', 'Г. Химки'] }, false, [], ['орел', 'химки']],
      [{ region_codes: ['16'], cities: ['Казань'] }, false, ['16'], ['казань']]] as const) {
      const query = buildVeTwoGisPageQuery({ ...input, scope: scope as { region_codes?: string[]; cities?: string[] } });
      expect(query.values).toEqual(['', geoAll, regions, cities, false, true, false, true, 500, 'Агентства недвижимости', 'Риелторы']);
      expect(query.text).toContain('WHERE cf.hot');
      expect(query.text).toContain('SELECT DISTINCT ON (cf.registrable_domain)');
      expect(query.text.match(/FROM public\.card_subcategories cs/g)).toHaveLength(2);
      expect(query.text).not.toMatch(/\bc\.(?:phone|email|website|vkontakte|instagram|lat|lon|geometry_name|post_code)\b/);
      expect(query.text).toMatch(/\$2::boolean OR cf\.region_code = ANY\(\$3::text\[\]\) OR cf\.city_key = ANY\(\$4::text\[\]\)/);
      // Порядок и пределы, на которых стоит правило курсора: без них карточки теряются или повторяются.
      expect([...query.text.matchAll(/WHERE cs\.value = (\$\d+) AND cs\.card_id > \$1::text ORDER BY cs\.card_id LIMIT 20000\)/g)]
        .map((match) => match[1])).toEqual(['$10', '$11']);
      expect(query.text).toMatch(/\) u ORDER BY u\.card_id LIMIT 20000\)/);
      expect(query.text).toMatch(/ORDER BY cf\.registrable_domain, cf\.card_id\)/);
      expect(query.text).toMatch(/FROM hits ORDER BY hits\.card_id LIMIT \$9::int\)/);
      expect(query.text).toMatch(/ORDER BY p\.card_id NULLS LAST$/); // курсор полной страницы — её последняя строка
      expect(query.text).toMatch(/\(\$5::boolean OR NOT cf\.is_non_company\) AND \(\$6::boolean OR NOT cf\.is_private_rubric\)\s+AND \(\$7::boolean OR NOT cf\.is_ip_name\) AND \(\$8::boolean OR NOT cf\.is_government\)/);
    }
    expect(buildVeTwoGisPageQuery({ ...input, allow: { nonCompany: false, privateRubric: false, ipName: true, government: true } })
      .values.slice(4, 8)).toEqual([false, false, true, true]);
    for (const rubrics of [[], [' '], Array.from({ length: 9 }, (_, i) => `Рубрика ${i}`)]) {
      expect(() => buildVeTwoGisPageQuery({ ...input, rubrics })).toThrow();
    }
    for (const limit of [0, 501, 1.5]) expect(() => buildVeTwoGisPageQuery({ ...input, limit })).toThrow();
    // Ошибка кода вызывающего — не сбой базы: отказ до транзакции, без паузы всем.
    for (const [bad, message] of [[{ rubrics: [] }, /^2ГИС: страница принимает 1–8 рубрик, передано 0$/],
      [{ limit: 0 }, /^2ГИС: размер страницы 0 вне 1–500$/]] as const) {
      const rejected = readVeTwoGisPage({ ...input, ...bad });
      await expect(rejected).rejects.toThrow(message);
      await expect(rejected).rejects.not.toBeInstanceOf(VeTwoGisUnavailableError);
    }
    // Курсор: полная страница — с последней карточки; неполная — с конца окна; исчерпано — неполная страница неполного окна.
    const ids = (...values: string[]) => values.map((card_id) => ({ card_id }));
    expect(nextVeTwoGisCursor('a', { rows: ids('b', 'c'), windowIds: 20_000, windowLast: 'z' }, 2)).toEqual({ cursor: 'c', exhausted: false });
    expect(nextVeTwoGisCursor('a', { rows: ids('b', 'c'), windowIds: 50, windowLast: 'z' }, 2)).toEqual({ cursor: 'c', exhausted: false });
    expect(nextVeTwoGisCursor('a', { rows: ids('b'), windowIds: 50, windowLast: 'z' }, 2)).toEqual({ cursor: 'z', exhausted: true });
    expect(nextVeTwoGisCursor('a', { rows: ids('b'), windowIds: 20_000, windowLast: 'z' }, 2)).toEqual({ cursor: 'z', exhausted: false });
    expect(nextVeTwoGisCursor('a', { rows: [], windowIds: 0, windowLast: null }, 2)).toEqual({ cursor: 'a', exhausted: true });
    expect(() => nextVeTwoGisCursor('a', { rows: [], windowIds: 3, windowLast: 'a' }, 2)).toThrow();

    // Чтение внутри транзакции: импорт и устаревший флаг — значения, глобальная рассинхронизация — VeTwoGisSnapshotError.
    const fake = (state: Record<string, unknown> | null, locked = true, page: Array<Record<string, unknown>> = []) => {
      const calls: Array<{ text: string; values?: unknown[] }> = [];
      return { calls, client: { query: (async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (text.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ locked }] };
        if (text.includes('FROM ve2.build_state')) return { rows: state ? [state] : [] };
        return { rows: page };
      }) as unknown as PoolClient['query'] } };
    };
    const built = { snapshot_id: '7', features_version: 1, current_snapshot_id: '7', table_features_version: 1 };
    const importing = fake(built, false);
    expect(await readVeTwoGisPageWith(importing.client, input)).toEqual({ kind: 'import' });
    expect(importing.calls.map((call) => call.text)).toEqual(['SET LOCAL enable_hashagg = off',
      'SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS locked']);
    expect(importing.calls[1].values).toEqual(['portal:2gis-dataset:snapshot-import']);
    const stale = fake(built);
    expect(await readVeTwoGisPageWith(stale.client, { ...input, flag: { snapshot_id: 7, features_version: 2 } }))
      .toEqual({ kind: 'stale', build: { snapshotId: 7, featuresVersion: 1 } });
    expect(stale.calls).toHaveLength(3); // без запроса страницы
    const staleSnapshot = fake(built);
    expect(await readVeTwoGisPageWith(staleSnapshot.client, { ...input, flag: { snapshot_id: 6, features_version: 1 } }))
      .toEqual({ kind: 'stale', build: { snapshotId: 7, featuresVersion: 1 } });
    expect(staleSnapshot.calls).toHaveLength(3);
    for (const broken of [null, { ...built, current_snapshot_id: '8' }, { ...built, current_snapshot_id: null },
      { ...built, table_features_version: 2 }, { ...built, table_features_version: null }]) {
      const reader = fake(broken);
      await expect(readVeTwoGisPageWith(reader.client, input)).rejects.toBeInstanceOf(VeTwoGisSnapshotError);
      expect(reader.calls.some((call) => call.text.includes('card_subcategories'))).toBe(false);
    }
    const pageRow = (card_id: string) => ({ window_ids: 120, window_last: '7000000000000099', card_id, registrable_domain: `${card_id}.ru`,
      host: `${card_id}.ru`, site_scheme: card_id.endsWith('2') ? 'http' : 'https', region_code: '77', name: 'Название', city_name: 'Москва' });
    const short = fake(built, true, [pageRow('7000000000000001'), pageRow('7000000000000002')]);
    const shortPage = await readVeTwoGisPageWith(short.client, { ...input, limit: 3 });
    expect(shortPage).toMatchObject({ kind: 'page', cursor: '7000000000000099', exhausted: true, windowIds: 120 });
    expect(shortPage.kind === 'page' && shortPage.rows.map((row) => [row.card_id, row.site_scheme])).toEqual([
      ['7000000000000001', 'https'], ['7000000000000002', 'http']]);
    expect(short.calls[3].values?.slice(0, 9)).toEqual(['', true, [], [], false, true, false, true, 3]);
    const fullPage = await readVeTwoGisPageWith(fake(built, true, [pageRow('7000000000000001'), pageRow('7000000000000002')]).client,
      { ...input, limit: 2, after: '7000000000000000' });
    expect(fullPage).toMatchObject({ kind: 'page', cursor: '7000000000000002', exhausted: false });
    const empty = await readVeTwoGisPageWith(fake(built, true, [{ window_ids: 0, window_last: null, card_id: null }]).client,
      { ...input, after: '7000000000000500' });
    expect(empty).toEqual({ kind: 'page', rows: [], cursor: '7000000000000500', exhausted: true, windowIds: 0 });

    // Часть 3б: словарь, подбор рубрик, разрешения, курсор, диспатч близнеца, журнал линии.
    const actualPage = jest.requireActual<typeof import('@/lib/verticalEngineV2/twoGisPage')>('@/lib/verticalEngineV2/twoGisPage');
    try {
      // (а) Словарь — под той же проверкой импорта и сборки, без SET LOCAL.
      const dictionaryRead = fake(built, true, [{ label: 'Кафе', cards: '9000' }, { label: 'Мясокомбинаты', cards: '120' }]);
      expect(await readVeTwoGisRubricDictionaryWith(dictionaryRead.client, input.flag)).toEqual({ kind: 'dictionary',
        rubrics: [{ label: 'Кафе', cards: 9000 }, { label: 'Мясокомбинаты', cards: 120 }] });
      expect(dictionaryRead.calls).toHaveLength(3); // импорт, build_state, словарь
      expect(dictionaryRead.calls[2].text).toMatch(/FROM public\.facet_subcategories fs[\s\S]*GROUP BY fs\.value ORDER BY fs\.value LIMIT 5001$/);
      expect(await readVeTwoGisRubricDictionaryWith(fake(built, false).client, input.flag)).toEqual({ kind: 'import' });
      expect(await readVeTwoGisRubricDictionaryWith(fake(built).client, { snapshot_id: 7, features_version: 2 })).toMatchObject({ kind: 'stale' });
      await expect(readVeTwoGisRubricDictionaryWith(fake(null).client, input.flag)).rejects.toBeInstanceOf(VeTwoGisSnapshotError);

      // (б) Рубрики: точная форма — без модели; иначе короткий список, модель и проверка корня; не больше 8.
      const dictionary = [{ label: 'Мясокомбинаты', cards: 120 }, { label: 'Колбасные изделия', cards: 40 },
        { label: 'Цеховые столовые', cards: 10 }, { label: 'Кафе', cards: 9000 }];
      jest.mocked(callLLMWithSchema).mockClear();
      expect(await resolveVeTwoGisRubrics({ dictionary, queries: ['мясокомбинат'] })).toEqual({ rubrics: ['Мясокомбинаты'], viaModel: false });
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      jest.mocked(callLLMWithSchema).mockImplementationOnce(async (messages, schema) => {
        const prompt = JSON.parse(String(messages.at(-1)?.content)) as { categories: Array<{ id: number }> };
        return { data: schema.parse({ category_ids: prompt.categories.map((category) => category.id) }), tokensUsed: 5, costUsd: 0.001,
          promptTokens: 4, completionTokens: 1, rawResponse: '' };
      });
      expect(await resolveVeTwoGisRubrics({ dictionary, queries: ['колбасный цех'], context: MEAT.title }))
        .toEqual({ rubrics: ['Колбасные изделия'], viaModel: true }); // «Цеховые столовые» снимает проверка корня
      expect(jest.mocked(callLLMWithSchema).mock.calls[0][2]).toMatchObject({ model: 'test-gate-model', requireCompleteJson: true });
      expect((JSON.parse(String(jest.mocked(callLLMWithSchema).mock.calls[0][0].at(-1)?.content)) as { categories: Array<{ label: string }> })
        .categories.map((category) => category.label)).toEqual(['Колбасные изделия', 'Цеховые столовые']);
      jest.mocked(callLLMWithSchema).mockClear();
      await expect(resolveVeTwoGisRubrics({ dictionary, queries: ['ювелир'] })).rejects.toBeInstanceOf(VeTwoGisRubricsUnavailableError);
      const oversize = resolveVeTwoGisRubrics({ dictionary: Array.from({ length: 5001 }, (_, index) => ({ label: `Рубрика ${index}`, cards: 1 })),
        queries: ['мясокомбинат'] });
      await expect(oversize).rejects.toBeInstanceOf(VeTwoGisRubricsUnavailableError);
      await expect(oversize).rejects.toMatchObject({ reason: 'oversize' }); // своя заметка: предел словаря, а не «нет рубрик»
      await expect(resolveVeTwoGisRubrics({ dictionary, queries: ['ювелир'] })).rejects.toMatchObject({ reason: 'none' });
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      const words = ['Альфа', 'Бетон', 'Гамма', 'Дельта', 'Эпсилон', 'Зета', 'Тета', 'Каппа', 'Лямбда', 'Омега'];
      expect(await resolveVeTwoGisRubrics({ dictionary: words.map((label) => ({ label, cards: 1 })), queries: words.map((word) => word.toLowerCase()) }))
        .toEqual({ rubrics: words.slice(0, 8), viaModel: false });
      jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new VeLlmRateLimitError(Date.now() + 60_000, false));
      await expect(resolveVeTwoGisRubrics({ dictionary, queries: ['колбасный цех'] })).rejects.toBeInstanceOf(VeLlmRateLimitError);
      jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new Error('Requesty 402: insufficient balance'));
      await expect(resolveVeTwoGisRubrics({ dictionary, queries: ['колбасный цех'] })).rejects.toThrow(/^Requesty 402/);
      expect([new Error('Requesty 401: bad key'), new Error('Requesty 503: upstream'), new Error('x')].map(veTwoGisMappingFailure))
        .toEqual(['retire', 'pending', 'count']);

      // (в) Разрешения: рубрика — хоть одна в наборе; ИП — только задача реестра плана с includeIp (не расширенная).
      const sets = { nonCompany: ['Банкоматы'], privateRubric: ['Нотариусы'], government: ['Школы'] };
      const directoryState = (includeIp: boolean, widened?: 'replan' | 'second_queue') => ({ source: 'companies_directory' as const,
        status: 'done' as const, child_job_id: null, rows: 0,
        task: { ...MEAT_TASK, directory_filters: { ...MEAT_TASK.directory_filters, includeIp }, ...(widened ? { widened } : {}) } });
      expect(veTwoGisAllow({ rubrics: ['Нотариусы', 'Школы'], tasks: [] }, sets))
        .toEqual({ nonCompany: false, privateRubric: true, ipName: false, government: true });
      expect(veTwoGisAllow({ rubrics: ['банкоматы'], tasks: [directoryState(true)] }, sets))
        .toEqual({ nonCompany: true, privateRubric: true, ipName: true, government: false });
      for (const tasks of [[directoryState(true, 'replan')], [directoryState(true, 'second_queue')], [directoryState(false)], []]) {
        expect(veTwoGisAllow({ rubrics: ['Мясокомбинаты'], tasks }, sets)).toEqual({ nonCompany: false, privateRubric: false, ipName: false, government: false });
      }

      // (г) Курсор: целый и на снимке флага; чужие поля будущих частей сохраняются.
      const cursorOf = (extra: Record<string, unknown> = {}) => ({ version: 1, snapshot_id: 7, features_version: 1, mapping_revision: 1,
        rubrics: ['Мясокомбинаты'], after: '', claimed: 0, pages: 0, ...extra });
      expect(readVeTwoGisTwinState(undefined, TWO_GIS_FLAG)).toEqual({ kind: 'none', mappingFailures: 0 });
      expect(readVeTwoGisTwinState({ version: 1, cursor: 1 }, TWO_GIS_FLAG)).toEqual({ kind: 'invalid' });
      expect(readVeTwoGisTwinState(cursorOf({ not_before: 'x' }), TWO_GIS_FLAG)).toEqual({ kind: 'cursor', cursor: cursorOf({ not_before: 'x' }) });
      expect(readVeTwoGisTwinState(cursorOf({ snapshot_id: 8 }), TWO_GIS_FLAG)).toEqual({ kind: 'invalid' });
      expect(readVeTwoGisTwinState({ version: 1, mapping_failures: 2 }, TWO_GIS_FLAG)).toEqual({ kind: 'none', mappingFailures: 2 });

      // (д) Тик: подбор без модели, две страницы, фильтры строк, журнал (повтор, перехват, занято, дубль), одна запись базы.
      const [twinMaps, twinTask] = withVeTwoGisTwins({ tasks: [twoGisMaps('мясокомбинат')] }).tasks;
      const hour = (offset: number) => `${String((new Date().getUTCHours() + offset) % 24).padStart(2, '0')}:00`;
      const twinSettings = { market: 'ru', mode: 'on', reads_enabled: true, client_use: 'all', internal_projects: [], excluded_projects: [],
        quiet_start_utc: hour(2), quiet_end_utc: hour(3), max_candidates: 1000, snapshot_id: 7, features_version: 1, built_at: '2026-10-26T10:00:00Z' };
      const twinCatalog = { version: 1 as const, filters: { categories: ['Мясокомбинаты'], countries: ['Россия'] } };
      const twinInfo = (flagged = true): VeCollectInfo => ({ collection_mode: 'preview', ...(flagged ? { two_gis_source: TWO_GIS_FLAG } : {}),
        target_progress: createCollectionTarget('preview'), plan: { tasks: [twinMaps, twinTask] },
        tasks: [{ source: 'yandex_maps', task: twinMaps, status: 'done', child_job_id: null, rows: 0, exhausted: true, catalog: twinCatalog,
          two_gis_pair_id: 'p' }, { source: 'two_gis', task: twinTask, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p' }] });
      const journalRow = (id: number, domain: string, baseId: string, cardId: string, outcome = 'claimed') => ({ id, project_id: 'p1',
        hypothesis_id: 'h1', base_id: baseId, registrable_domain: domain, host: domain, card_id: cardId, snapshot_id: 7, outcome });
      const twinDb = (info: VeCollectInfo, extra: Record<string, Array<Record<string, unknown>>> = {},
        errorUpserts?: Record<string, { code: string; message: string }>) => createMockSupabase({
        tables: { ve_verticals: [VERTICAL], ve_projects: [PROJECT], ve_jobs: [makeJob() as unknown as Record<string, unknown>],
          ...hypothesis({ ...MEAT, broad: false }), ve_twogis_source_settings: [twinSettings],
          ve_project_exclusions: [{ project_id: 'p1', revision: 1, inns: [], domains: ['blocked-meat.ru'], emails: [], updated_at: '2026-10-26T10:00:00Z' }],
          ve_bases: [makeBase(info), { ...makeBase({}), id: 'b0-old', status: 'analyzed' }, { ...makeBase({}), id: 'b9-live', source: 'manual' }],
          ve_twogis_rows: [journalRow(1, 'held.ru', 'b9-live', 'c-h'), journalRow(2, 'old-owner.ru', 'b0-old', 'c-o'),
            journalRow(3, 'replay.ru', 'b1', '7000000000000007'), journalRow(4, 'rejected.ru', 'b1', '7000000000000008', 'rejected'), journalRow(5, 'twice.ru', 'b1', 'c-old')],
          ...extra },
        ...(errorUpserts ? { errorUpserts } : {}),
        rpcHandlers: { ve_directory_plan_population: () => ({ data: { directory_rows_total: 0, companies_unique_total: 0, companies_available: 0,
          companies_with_email: 0, companies_with_phone: 0, slice_companies: [] } }) } });
      const twinCard = (n: number, domain: string, name = `Мясокомбинат ${domain}, производство`, windowIds = 20_000, windowLast = '7000000000000099') => ({
        window_ids: windowIds, window_last: windowLast, card_id: `7${String(n).padStart(15, '0')}`, registrable_domain: domain, host: domain,
        site_scheme: 'https', region_code: '77', name, city_name: 'Москва' });
      const twinPages: Record<string, Array<Record<string, unknown>>> = {
        '': [twinCard(1, 'meat1.ru'), twinCard(2, '2gis.ru'), twinCard(3, 'blocked-meat.ru'), twinCard(4, 'meat4.ru', 'ООО'), twinCard(5, 'held.ru'),
          twinCard(6, 'old-owner.ru'), twinCard(7, 'replay.ru'), twinCard(8, 'rejected.ru'), twinCard(9, 'twice.ru'),
          twinCard(10, 'school5.gosuslugi.ru')],
        '7000000000000099': [twinCard(101, 'meat9.ru', undefined, 50, '7000000000000150')],
      };
      jest.mocked(readVeTwoGisRubricDictionary).mockReset().mockResolvedValue({ kind: 'dictionary', rubrics: dictionary });
      jest.mocked(readVeTwoGisPage).mockReset().mockImplementation(async (query) =>
        actualPage.readVeTwoGisPageWith(fake(built, true, twinPages[query.after] ?? []).client, query));
      const tick = async (tickDb: MockSupabaseClient) => {
        jest.mocked(readVeTwoGisPage).mockClear();
        jest.mocked(readVeTwoGisRubricDictionary).mockClear();
        jest.mocked(callLLMWithSchema).mockClear();
        await runBaseCollectStage(makeJob(), { supabase: tickDb as unknown as SupabaseClient });
        const saved = tickDb.getRows('ve_bases').find((row) => row.id === 'b1')!;
        return { saved, twin: (saved.collect_info as VeCollectInfo).tasks![1] };
      };
      const journalOf = (tickDb: MockSupabaseClient) => Object.fromEntries(tickDb.getRows('ve_twogis_rows')
        .map((row) => [row.registrable_domain, [row.base_id, row.card_id, row.outcome]]));
      const journalMutations = (tickDb: MockSupabaseClient) => tickDb.mutations.filter((mutation) => mutation.table === 've_twogis_rows');
      const websites = (rows: VeUnifiedRow[] | undefined) => (rows ?? []).map((row) => row.website).sort();

      const mainDb = twinDb(twinInfo());
      // Решение (а): от чтения словаря до последней записи журнала база не пишется.
      let atDictionary = -1;
      jest.mocked(readVeTwoGisRubricDictionary).mockImplementationOnce(async () => {
        atDictionary = mainDb.mutations.length;
        return { kind: 'dictionary', rubrics: dictionary };
      });
      const main = await tick(mainDb);
      expect(main.saved.status).toBe('collecting');
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      expect(readVeTwoGisRubricDictionary).toHaveBeenCalledTimes(1);
      expect(mainDb.selects.filter((read) => read.table === 've_twogis_source_settings')).toHaveLength(1);
      expect(jest.mocked(readVeTwoGisPage).mock.calls.map(([query]) => [query.after, query.limit])).toEqual([['', 100], ['7000000000000099', 97]]);
      expect(jest.mocked(readVeTwoGisPage).mock.calls[0][0]).toEqual({ flag: { snapshot_id: 7, features_version: 1 }, rubrics: ['Мясокомбинаты'],
        after: '', scope: {}, allow: { nonCompany: false, privateRubric: false, ipName: false, government: false }, limit: 100 });
      // 2gis.ru, «ООО», сайт госоргана и занятый held — вне; rejected (тот же card_id, итог) и twice — дубли;
      // blocked-meat (правило проекта) — без счётчика.
      expect(main.twin).toMatchObject({ status: 'done', exhausted: true, rows: 4, excluded_during_fetch: 4, already_seen_during_fetch: 2 });
      expect(main.twin.unavailable).toBeUndefined();
      expect(websites(main.twin.harvest)).toEqual(['meat1.ru', 'meat9.ru', 'old-owner.ru', 'replay.ru']);
      expect(main.twin.harvest!.every((row) => row.source_detail === 'справочник организаций' && '_ve_two_gis' in row)).toBe(true);
      expect(main.twin.two_gis).toEqual({ version: 1, snapshot_id: 7, features_version: 1, mapping_revision: 1, rubrics: ['Мясокомбинаты'],
        after: '7000000000000150', claimed: 4, pages: 2 });
      const mainJournal = journalOf(mainDb);
      expect(mainJournal).toEqual({ 'held.ru': ['b9-live', 'c-h', 'claimed'], 'old-owner.ru': ['b1', '7000000000000006', 'claimed'],
        'replay.ru': ['b1', '7000000000000007', 'claimed'], 'rejected.ru': ['b1', '7000000000000008', 'rejected'], 'twice.ru': ['b1', 'c-old', 'claimed'],
        'meat1.ru': ['b1', '7000000000000001', 'claimed'], 'meat9.ru': ['b1', '7000000000000101', 'claimed'] });
      expect(mainDb.getRows('ve_twogis_rows').find((row) => row.registrable_domain === 'replay.ru')?.id).toBe(3);
      const mainMutations = journalMutations(mainDb);
      expect(mainMutations.map((mutation) => mutation.kind)).toEqual(['upsert', 'delete', 'upsert', 'upsert']);
      for (const mutation of mainMutations) {
        if (mutation.kind !== 'upsert') continue;
        expect(mutation.onConflict).toBe('project_id,hypothesis_id,registrable_domain');
        expect(mutation.rows.every((row) => !('id' in row) && row.hypothesis_id === 'h1' && row.base_id === 'b1' && row.outcome === 'claimed')).toBe(true);
      }
      expect(mainMutations[0].kind === 'upsert' && mainMutations[0].rows.map((row) => row.registrable_domain))
        .toEqual(['meat1.ru', 'held.ru', 'old-owner.ru', 'replay.ru', 'rejected.ru', 'twice.ru']);
      expect(mainMutations[1].kind === 'delete' && mainMutations[1].rows.map((row) => row.id)).toEqual([2]); // claimed базы b0-old
      // Решение (а): журнал — по странице, запись базы — одна, после последней записи журнала (и не после подбора).
      const journalAt = mainDb.mutations.flatMap((mutation, index) => mutation.table === 've_twogis_rows' ? [index] : []);
      expect(atDictionary).toBeGreaterThanOrEqual(0);
      expect(mainDb.mutations.slice(atDictionary, journalAt.at(-1)).some((mutation) => mutation.table === 've_bases')).toBe(false);
      expect(mainDb.mutations.slice(journalAt.at(-1)).some((mutation) => mutation.table === 've_bases' && mutation.kind === 'update')).toBe(true);

      // Текст гипотезы ИП не разрешает: «индивидуальные предприниматели» без includeIp в плане — ipName false.
      const ipText = { id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', broad: false,
        title: 'Индивидуальные предприниматели — мясные лавки', description: 'ИП и самозанятые с собственной мясной лавкой и сайтом.' };
      const ipTextDb = twinDb({ ...twinInfo(), hypotheses: [ipText] }, { ve_hypotheses: [ipText] });
      await tick(ipTextDb);
      expect(jest.mocked(readVeTwoGisPage).mock.calls[0][0].allow).toEqual({ nonCompany: false, privateRubric: false, ipName: false, government: false });

      // (е) Повтор после потерянной записи базы: те же заявки узнаются по base_id и card_id, журнал не меняется.
      const replayDb = twinDb(twinInfo(), { ve_twogis_rows: mainDb.getRows('ve_twogis_rows').map((row) => ({ ...row })) });
      const replay = await tick(replayDb);
      expect(journalOf(replayDb)).toEqual(mainJournal);
      expect(journalMutations(replayDb).some((mutation) => mutation.kind === 'delete')).toBe(false);
      expect(websites(replay.twin.harvest)).toEqual(['meat1.ru', 'meat9.ru', 'old-owner.ru', 'replay.ru']);
      expect(replay.twin.two_gis).toMatchObject({ claimed: 4, pages: 2 });

      // Два близнеца одной базы с одними рубриками: второй доменов первого не берёт (повтор своей claim — не для соседа).
      const [siblingMapsA, siblingTwinA, siblingMapsB, siblingTwinB] = withVeTwoGisTwins({ tasks: [twoGisMaps('мясокомбинат'),
        twoGisMaps('мясокомбинаты')] }).tasks;
      const siblingState = (task: typeof siblingTwinA, pair: string, twin: boolean) => twin
        ? { source: 'two_gis' as const, task, status: 'pending' as const, child_job_id: null, rows: 0, two_gis_pair_id: pair }
        : { source: 'yandex_maps' as const, task, status: 'done' as const, child_job_id: null, rows: 0, exhausted: true, catalog: twinCatalog,
          two_gis_pair_id: pair };
      const siblingDb = twinDb({ ...twinInfo(), plan: { tasks: [siblingMapsA, siblingTwinA, siblingMapsB, siblingTwinB] },
        tasks: [siblingState(siblingMapsA, 'pa', false), siblingState(siblingTwinA, 'pa', true), siblingState(siblingMapsB, 'pb', false),
          siblingState(siblingTwinB, 'pb', true)] });
      const sibling = await tick(siblingDb);
      const [, firstTwin, , secondTwin] = (sibling.saved.collect_info as VeCollectInfo).tasks!;
      expect(websites(firstTwin.harvest)).toEqual(['meat1.ru', 'meat9.ru', 'old-owner.ru', 'replay.ru']);
      expect(firstTwin.two_gis).toMatchObject({ claimed: 4 });
      expect(secondTwin).toMatchObject({ status: 'done', exhausted: true, rows: 0, already_seen_during_fetch: 6, two_gis: { claimed: 0, pages: 2 } });
      expect(secondTwin.harvest ?? []).toEqual([]);
      expect(journalOf(siblingDb)).toEqual(mainJournal);

      // (ж) Исходы: близнец закрыт или отложен, база не failed.
      const outcome = async (arrange: () => void, errorUpserts?: Record<string, { code: string; message: string }>) => {
        const caseDb = twinDb(twinInfo(), {}, errorUpserts);
        jest.mocked(readVeTwoGisPage).mockClear();
        arrange();
        const result = await tick(caseDb);
        expect(result.saved.status).not.toBe('failed');
        return { ...result, caseDb };
      };
      const dictionaryImport = await outcome(() => jest.mocked(readVeTwoGisRubricDictionary).mockResolvedValueOnce({ kind: 'import' }));
      expect(dictionaryImport.twin).toMatchObject({ status: 'pending' });
      expect(dictionaryImport.twin.two_gis).toBeUndefined();
      expect(readVeTwoGisPage).not.toHaveBeenCalled();
      expect(journalMutations(dictionaryImport.caseDb)).toEqual([]);
      const mappingFails = await outcome(() => {
        jest.mocked(readVeTwoGisRubricDictionary).mockResolvedValueOnce({ kind: 'dictionary', rubrics: [{ label: 'Мясоперерабатывающие предприятия', cards: 50 }] });
        jest.mocked(callLLMWithSchema).mockRejectedValueOnce(new Error('LLM вернул невалидный JSON'));
      });
      expect(mappingFails.twin).toMatchObject({ status: 'pending' });
      expect(mappingFails.twin.two_gis).toEqual({ version: 1, mapping_failures: 1 });
      const oversizeDictionary = await outcome(() => jest.mocked(readVeTwoGisRubricDictionary).mockResolvedValueOnce({ kind: 'dictionary',
        rubrics: Array.from({ length: 5001 }, (_, index) => ({ label: `Рубрика ${index}`, cards: 1 })) }));
      expect(oversizeDictionary.twin).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_TWIN_NOTES.dictionarySize });
      // Оплата и лимит запросов при подборе — не сбой подбора: тик падает той же ошибкой, маркера нет, близнец ждёт.
      for (const error of [new Error('Requesty 402: insufficient balance'), new VeLlmRateLimitError(Date.now() + 60_000, false)]) {
        const billingDb = twinDb(twinInfo());
        jest.mocked(readVeTwoGisRubricDictionary).mockResolvedValueOnce({ kind: 'dictionary', rubrics: [{ label: 'Мясоперерабатывающие предприятия', cards: 50 }] });
        jest.mocked(callLLMWithSchema).mockRejectedValueOnce(error);
        await expect(runBaseCollectStage(makeJob(), { supabase: billingDb as unknown as SupabaseClient })).rejects.toBe(error);
        const billingTwin = (billingDb.getRows('ve_bases').find((row) => row.id === 'b1')!.collect_info as VeCollectInfo).tasks![1];
        expect(billingTwin).toMatchObject({ status: 'pending' });
        expect(billingTwin.two_gis).toBeUndefined();
      }
      const snapshotChanged = await outcome(() => jest.mocked(readVeTwoGisPage).mockRejectedValueOnce(new VeTwoGisUnavailableError('snapshot', '2ГИС: snapshot (x)')));
      expect(snapshotChanged.twin).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_TWIN_NOTES.snapshot, two_gis: { after: '' } });
      const staleFlag = await outcome(() => jest.mocked(readVeTwoGisPage).mockResolvedValueOnce({ kind: 'stale', build: { snapshotId: 8, featuresVersion: 1 } }));
      expect(staleFlag.twin).toMatchObject({ status: 'done', unavailable: true });
      const paused = await outcome(() => jest.mocked(readVeTwoGisPage).mockRejectedValueOnce(new VeTwoGisUnavailableError('paused', '2ГИС: пауза')));
      expect(paused.twin).toMatchObject({ status: 'pending', two_gis: { after: '' } });
      expect(paused.twin.two_gis).not.toHaveProperty('errors');
      const codeError = await outcome(() => jest.mocked(readVeTwoGisPage).mockRejectedValueOnce(new VeTwoGisUnavailableError('other', '2ГИС: other (x)')));
      expect(codeError.twin).toMatchObject({ status: 'pending', two_gis: { errors: 1 } });
      const journalCheck = await outcome(() => undefined, { ve_twogis_rows: { code: '23514', message: 'check violation' } });
      expect(journalCheck.twin).toMatchObject({ status: 'pending', rows: 0, two_gis: { errors: 1, after: '' } });
      expect(journalCheck.twin.harvest).toBeUndefined();
      const journalBlip = await outcome(() => undefined, { ve_twogis_rows: { code: '08006', message: 'connection failure' } });
      expect(journalBlip.twin).toMatchObject({ status: 'pending', two_gis: { after: '' } });
      expect(journalBlip.twin.two_gis).not.toHaveProperty('errors');

      // (з) Правило проекта по ИНН: в карточках ИНН нет — закрыт без чтений 2ГИС.
      const innDb = twinDb(twinInfo(), { ve_project_exclusions: [{ project_id: 'p1', revision: 1, inns: ['7700000101'], domains: [], emails: [],
        updated_at: '2026-10-26T10:00:00Z' }] });
      const innRules = await tick(innDb);
      expect(innRules.twin).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_TWIN_NOTES.projectInns });
      expect(innDb.selects.some((read) => read.table === 've_twogis_source_settings' || read.table === 've_twogis_rows')).toBe(false);
      expect(readVeTwoGisRubricDictionary).not.toHaveBeenCalled();
      expect(readVeTwoGisPage).not.toHaveBeenCalled();

      // (и) Без флага — защита R1: «Источник недоступен в этой версии», к таблицам 2ГИС не обращаемся.
      const flaglessDb = twinDb(twinInfo(false));
      const flagless = await tick(flaglessDb);
      expect(flagless.twin).toMatchObject({ status: 'done', unavailable: true, note: 'Источник недоступен в этой версии' });
      expect([...flaglessDb.selects, ...flaglessDb.mutations].some((entry) => entry.table.startsWith('ve_twogis_'))).toBe(false);

      // (к) Вышедшее из ветки близнеца (здесь — сбой кода на странице): закрыт один близнец, не failed и не повтор
      // всей джобы; сбой учёта расходов и временный сбой БД — ожидание и повтор тика, как у других источников.
      const brokenPage = (rows: () => never) => ({ kind: 'page' as const, get rows(): never { return rows(); }, cursor: 'x', exhausted: false, windowIds: 1 });
      const escaped = await outcome(() => jest.mocked(readVeTwoGisPage).mockResolvedValueOnce(brokenPage(() => { throw new TypeError('rows is not iterable'); })));
      expect(escaped.saved.status).toBe('collecting');
      expect(escaped.twin).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_TWIN_NOTES.readError });
      expect(escaped.twin.error).toBeUndefined();
      for (const error of [new ProviderUsageWriteError(), new Error('fetch failed'),
        new Error('ve_bases exclusion read: VE2 database GET request timeout after 120000ms (no response headers)')]) {
        const retryDb = twinDb(twinInfo());
        jest.mocked(readVeTwoGisPage).mockResolvedValueOnce(brokenPage(() => { throw error; }));
        await expect(runBaseCollectStage(makeJob(), { supabase: retryDb as unknown as SupabaseClient })).rejects.toBe(error);
        expect((retryDb.getRows('ve_bases').find((row) => row.id === 'b1')!.collect_info as VeCollectInfo).tasks![1]).toMatchObject({ status: 'pending' });
      }

      // (л) Выход базы из сбора освобождает её claimed после записи статуса — и простой записью, и CAS превью.
      const exitOf = (extra: Partial<VeCollectInfo>) => {
        const info = exhaustedInfo(MEAT_TASK, { two_gis_source: TWO_GIS_FLAG, adaptive_collection: { ...newVeAdaptiveCollection(),
          replan_attempts: 2, widenings: 2, active_source: veSourceStrategyKey(MEAT_TASK) }, ...extra });
        info.tasks!.push({ source: 'yandex_maps', task: twinMaps, status: 'done', child_job_id: null, rows: 0, exhausted: true, catalog: twinCatalog,
          two_gis_pair_id: 'p' }, { source: 'two_gis', task: twinTask, status: 'done', exhausted: true, child_job_id: null, rows: 1, two_gis_pair_id: 'p',
          harvest: [mapTwoGisRow({ card_id: '7000000000000001', registrable_domain: 'meat1.ru', host: 'meat1.ru', site_scheme: 'https', region_code: '77',
            name: 'Мясокомбинат 1', city_name: 'Москва' }, 7)],
          two_gis: { version: 1, snapshot_id: 7, features_version: 1, mapping_revision: 1, rubrics: ['Мясокомбинаты'], after: '7000000000000001', claimed: 1, pages: 1 } });
        info.plan = { tasks: info.tasks!.map((state) => state.task) };
        return info;
      };
      // CAS — путь прода: у превью с флагом всегда preview_pipeline (с job_ids он переживает проверку совместимости).
      for (const extra of [{}, { preview_pipeline: { version: 1 as const, revision: 0, batches: [], job_ids: ['prev-batch'], completed_batches: 1 } }]) {
        const exitInfo = exitOf(extra);
        const exitDb = seed(exitInfo, { ...hypothesis({ ...MEAT, broad: false }), ve_bases: [{ ...makeBase(exitInfo), data: ready, row_count: ready.length,
          columns: [...VE_AUTO_COLLECT_COLUMNS] }], ve_twogis_rows: [journalRow(10, 'meat1.ru', 'b1', '7000000000000001'),
          journalRow(11, 'rejected.ru', 'b1', 'c-r', 'rejected'), journalRow(12, 'held.ru', 'b9-live', 'c-h')] });
        await runBaseCollectStage(makeJob(), { supabase: exitDb as unknown as SupabaseClient });
        expect(exitDb.getRows('ve_bases')[0].status).toBe('analyzing');
        if (extra.preview_pipeline) expect((exitDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).preview_pipeline?.revision).toBeGreaterThan(0);
        expect(exitDb.getRows('ve_twogis_rows').map((row) => row.id)).toEqual([11, 12]);
        const releasedAt = exitDb.mutations.findIndex((mutation) => mutation.table === 've_twogis_rows' && mutation.kind === 'delete');
        const analyzingAt = exitDb.mutations.findIndex((mutation) => mutation.table === 've_bases' && mutation.kind === 'update'
          && mutation.patch.status === 'analyzing');
        expect(analyzingAt).toBeGreaterThanOrEqual(0);
        expect(releasedAt).toBeGreaterThan(analyzingAt);
      }
      // База без флага и близнецов выходит из сбора без единого обращения к таблицам 2ГИС.
      const plainExit = exhaustedInfo(MEAT_TASK, { adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2,
        active_source: veSourceStrategyKey(MEAT_TASK) } });
      const plainDb = seed(plainExit, { ...hypothesis({ ...MEAT, broad: false }), ve_bases: [{ ...makeBase(plainExit), data: ready, row_count: ready.length,
        columns: [...VE_AUTO_COLLECT_COLUMNS] }] });
      await runBaseCollectStage(makeJob(), { supabase: plainDb as unknown as SupabaseClient });
      expect(plainDb.getRows('ve_bases')[0].status).toBe('analyzing');
      expect([...plainDb.selects, ...plainDb.mutations].some((entry) => entry.table.startsWith('ve_twogis_'))).toBe(false);

      // (м) Журнал напрямую, линия без гипотезы: своё — повтор, новое — вставка; фильтр линии — .is(null), не .eq(null);
      // чужое claimed — всегда занято, без перехвата (уникальный индекс собирающих баз такую линию не сериализует).
      const nullDb = createMockSupabase({ tables: { ve_twogis_rows: [{ ...journalRow(20, 'meat1.ru', 'b1', 'c-1'), hypothesis_id: null },
        { ...journalRow(21, 'meat3.ru', 'b-dead', 'c-3'), hypothesis_id: null }] } });
      const lineFilters: string[] = [];
      const recorded = (builder: object): object => new Proxy(builder, { get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if ((prop === 'is' || prop === 'eq') && args[0] === 'hypothesis_id') lineFilters.push(`${String(prop)}(${String(args[1])})`);
          const out = (value as (...rest: unknown[]) => unknown).apply(target, args);
          return out === target ? recorded(target) : out;
        };
      } });
      const recordingDb = { from: (table: string) => recorded(nullDb.from(table)) } as unknown as SupabaseClient;
      const nullClaim = await claimVeTwoGisRows(recordingDb, { projectId: 'p1', hypothesisId: null, baseId: 'b1', snapshotId: 7 },
        [{ registrable_domain: 'meat1.ru', host: 'meat1.ru', card_id: 'c-1' }, { registrable_domain: 'meat2.ru', host: 'meat2.ru', card_id: 'c-2' },
          { registrable_domain: 'meat3.ru', host: 'meat3.ru', card_id: 'c-x' }]);
      expect([...nullClaim.accepted].sort()).toEqual(['meat1.ru', 'meat2.ru']);
      expect(nullClaim).toMatchObject({ inserted: 1, replayed: 1, held: 1, takenOver: 0 });
      expect(lineFilters).toContain('is(null)');
      expect(lineFilters).not.toContain('eq(null)');
      expect(nullDb.mutations.some((mutation) => mutation.kind === 'delete')).toBe(false);
      expect(nullDb.getRows('ve_twogis_rows').find((row) => row.id === 21)?.base_id).toBe('b-dead');
      expect(nullDb.getRows('ve_twogis_rows')).toHaveLength(3);
      await releaseVeTwoGisClaims(nullDb as unknown as SupabaseClient, 'b1');
      expect(nullDb.getRows('ve_twogis_rows').map((row) => row.id)).toEqual([21]);
    } finally {
      jest.mocked(readVeTwoGisPage).mockReset().mockImplementation(actualPage.readVeTwoGisPage);
      jest.mocked(readVeTwoGisRubricDictionary).mockReset().mockImplementation(async () => { throw new Error('unmocked 2ГИС dictionary read'); });
      jest.mocked(callLLMWithSchema).mockReset(); // beforeEach ставит обычный ответ CONSTRUCT заново
    }
  });

  it('analyzed-база с исчерпанным реестром с порогами продолжается и открывает расширенный срез', async () => {
    const info = exhaustedInfo(SWEETS_TASK, {
      target_progress: { ...createCollectionTarget('preview'), status: 'limited', round: 11, max_rounds: 100, candidates_processed: processed.length,
        ready_rows: ready.length, reason: 'Добор сайтов закрыт: последние 120 платных поисков не дали ни одного готового контакта' },
      target_checkpoint: { completed_round: 11, seen_rows: processed, processed_rows: processed.length },
      source_contact_budget: { version: 2, checked_at_growth: 0, ready_high_water: 0, paused: true },
    });
    // Соседняя гипотеза проекта уже забрала «Зарю»: общий рынок не ломает дедуп.
    const neighbour = { ...makeBase({}), id: 'b-neighbour', hypothesis_id: 'h2', status: 'analyzed', columns: [...VE_AUTO_COLLECT_COLUMNS],
      data: [{ ...unifiedRow({ company: 'Кондитерская фабрика Заря', inn: '7700000202', email: 'sales@zarya.test', website: 'zarya.test' }),
        _email_status: 'ok' }] };
    const db = seedBase(info, SWEETS, { status: 'analyzed' }, [neighbour]);
    await db.from('ve_jobs').update({ status: 'done' }).eq('id', makeJob().id);
    expect(canResumePartialPreview(db.getRows('ve_bases').find((row) => row.id === 'b1')!)).toBe(true);
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000, resumeBaseId: 'b1' }))
      .resolves.toMatchObject({ ok: true, created: true });
    let base = await wake(db);
    expect(base.status).toBe('collecting');
    const second = (base.collect_info as VeCollectInfo).tasks![1];
    expect(second.task.directory_filters).toEqual({ includeIp: false, okvedCodes: ['10.7', '10.8'],
      sizeOrUnknown: { revenueFrom: 150_000_000, employeesFrom: 25 } });

    jest.mocked(searchRows).mockResolvedValue({ rows: [
      { name: 'Фабрика без отчётности', inn: '7700000201', email: 'info@nodata.test', website: 'nodata.test', employees_count: null, revenue: null },
      { name: 'Кондитерская фабрика Заря', inn: '7700000202', email: 'sales@zarya.test', website: 'zarya.test', employees_count: 30, revenue: 200_000_000 },
      { name: 'Пекарня у дома', inn: '7700000203', email: 'hello@bakery.test', website: 'bakery.test', employees_count: 10, revenue: 400_000_000 },
      { name: 'Торговый дом Сладость', inn: '7700000204', email: 'td@sweet.test', website: 'sweet.test', employees_count: 100, revenue: 50_000_000 },
      // Адрес в реестре есть, но это не почта: без сайта такой контакт не берём.
      { name: 'Фабрика с битой почтой', inn: '7700000205', email: 'нет', website: '', employees_count: null, revenue: null },
    ] });
    base = await wake(db);
    expect(jest.mocked(searchRows).mock.calls[0][0]).not.toHaveProperty('revenueFrom');
    const harvest = (base.collect_info as VeCollectInfo).tasks![1].harvest!;
    // Проходят пустой штат/выручка и компания в ослабленных границах; мелкая
    // пекарня и торговый дом с малой выручкой отсеяны, «Заря» уже в соседней
    // базе, у фабрики с битой почтой нет готового контакта.
    expect(harvest.map((row) => row.company)).toEqual(['Фабрика без отчётности']);
    const child = db.getRows('base_constructor_jobs')[0];
    expect((child.data as string[][]).slice(1).map((row) => row[0])).toEqual(['Фабрика без отчётности']);
  });

  it('расширенный срез с двумя плохими партиями завершает базу с понятной причиной', async () => {
    const second = { ...MEAT_TASK, widened: 'second_queue' as const,
      directory_filters: { includeIp: false, okvedCodes: ['10.1'] } };
    const secondKey = veSourceStrategyKey(second);
    const candidates = Array.from({ length: 50 }, (_, index) => unifiedRow({ company: `Цех ${index}`,
      inn: String(7700001000 + index), website: `ceh${index}.test`, email: `info@ceh${index}.test` }));
    const info = exhaustedInfo(MEAT_TASK, {
      construct: { bc_job_id: 'bc-dry', status: 'dispatched', dispatched_at: '2026-09-22T00:00:00Z' },
      search_policy: { version: 1, phase: 'paid', deferred_rows: [], construct_rows: candidates },
      adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 1, active_source: secondKey,
        completed: [{ id: 'dry-1', source_key: secondKey, source: 'companies_directory', candidates: 60, new_ready: 0,
          started_at: '2026-09-22T00:00:00Z', finished_at: '2026-09-22T00:10:00Z', poor: true,
          spend: { ai_usd: 0, serper_credits: 0, estimated_total_usd: 0, unknown_attempts: 0, complete: true } }],
        pending: { id: 'dry-2', source_key: secondKey, source: 'companies_directory', candidates: 50,
          ready_before: veReadyContactKeys(ready), started_at: '2026-09-22T00:10:00Z' } },
    });
    info.tasks!.push({ source: 'companies_directory', status: 'done', child_job_id: null, rows: candidates.length,
      task: second, harvest: candidates });
    info.plan = { tasks: [MEAT_TASK, second] };
    const db = seedBase(info, MEAT);
    await db.from('base_constructor_jobs').insert({ id: 'bc-dry', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
      data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
        ...candidates.map((row) => [row.company, row.website, row.email, row.inn, 'ok'])] });
    // Все 50 компаний — не колбасные производства.
    mockFindIrrelevantRows.mockResolvedValueOnce({ flagged: new Set(candidates.map((_, index) => index)), unchecked: new Set(),
      coverage: { checkedCompanies: 50, totalCompanies: 50, complete: true }, tokensUsed: 0, costUsd: 0 });
    const base = await wake(db);
    const result = base.collect_info as VeCollectInfo;
    expect(result.adaptive_collection?.completed.map((batch) => batch.new_ready)).toEqual([0, 0]);
    expect(base.status).toBe('analyzing');
    expect(result.target_progress).toMatchObject({ status: 'limited', ready_rows: 2 });
    expect(result.target_progress?.reason).toContain('Расширенный срез тоже дал низкий выход: последние 110 компаний дали 0 новых готовых контактов');
    expect(result.adaptive_collection?.replan_needed).toBe(false);
    expect(callLLMWithSchema).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), { model: 'test-collection-model' });
  });

  it('новый срез из каталога Яндекс Карт берёт только компании с сайтом или почтой', async () => {
    // Планировщик при исчерпании плана может выбрать не реестр, а каталог карт.
    // Компания без сайта и почты оттуда ушла бы в платный поиск сайта (Serper).
    const catalogTask = { source: 'yandex_maps' as const, widened: 'replan' as const,
      rationale: 'Новый срез того же рынка: мясокомбинаты из готового каталога Яндекс Карт.',
      maps_query: { queries: ['Мясокомбинаты'], geo: 'Россия' } };
    const info = exhaustedInfo(MEAT_TASK, { adaptive_collection: { ...newVeAdaptiveCollection(),
      widenings: 2, replan_attempts: 1, switches: 1, active_source: veSourceStrategyKey(catalogTask) } });
    info.tasks!.push({ source: 'yandex_maps', status: 'pending', child_job_id: null, rows: 0, task: catalogTask,
      catalog: { version: 1, filters: { categories: ['Мясокомбинаты'], countries: ['Россия'] } } });
    info.plan = { tasks: [MEAT_TASK, catalogTask] };
    const db = seedBase(info, MEAT);
    const page = [
      { yandex_id: '1', name: 'Мясокомбинат Ромашка', website: 'romashka.test', email: 'info@romashka.test',
        address: 'Москва, Мясная улица, 1', categories: 'Мясокомбинаты' },
      { yandex_id: '2', name: 'Колбасный цех Безсайтов', address: 'Москва, Колбасная улица, 2', categories: 'Мясокомбинаты' },
      { yandex_id: '3', name: 'Мясная лавка Почтовая', email: 'shop@pochta-lavka.test',
        address: 'Москва, Почтовая улица, 3', categories: 'Мясокомбинаты' },
    ];
    const originalRpc = db.rpc;
    db.rpc = ((name: string, params: Record<string, unknown>) => {
      const operation = name === 'yandex_maps_catalog_search'
        ? Promise.resolve({ data: params.p_after ? [] : page, error: null }) : originalRpc(name, params);
      return Object.assign(operation, { abortSignal: () => operation });
    }) as typeof db.rpc;

    const base = await wake(db);
    const catalog = (base.collect_info as VeCollectInfo).tasks![1];
    expect(catalog).toMatchObject({ status: 'done', exhausted: true, rows: 2, catalog: { after: '3' } });
    expect(catalog.harvest!.map((row) => row.company)).toEqual(['Мясокомбинат Ромашка', 'Мясная лавка Почтовая']);
    // Компания без контакта — не «исключена соседней базой», её просто не берём.
    expect(catalog.excluded_during_fetch).toBeUndefined();
    const child = db.getRows('base_constructor_jobs')[0];
    expect((child.data as string[][]).slice(1).map((row) => row[0]).sort())
      .toEqual(['Мясная лавка Почтовая', 'Мясокомбинат Ромашка']);
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalledWith('', expect.anything());

    // Sparse existing-only pages fill a batch within the existing four-page
    // allowance. A restart cannot reset it or grow deferred JSON indefinitely.
    for (const mode of ['bounded_batch', 'restart', 'old_pending_harvest', 'full_before_page_end', 'no_contacts', 'zero_streak'] as const) {
      const noContacts = mode === 'no_contacts' || mode === 'zero_streak';
      const contactEvery = mode === 'full_before_page_end' ? 3 : 5;
      const sparseTask = { source: 'yandex_maps' as const, rationale: 'Existing catalog only',
        maps_query: { queries: ['Мясокомбинаты'], geo: 'Россия' } };
      const catalogRows = Array.from({ length: mode === 'zero_streak' ? 6_000 : 600 }, (_, index) => ({ yandex_id: String(index + 1),
        name: `Мясокомбинат Каталожный ${index + 1}`, address: `Москва, Заводская улица, ${index + 1}`,
        categories: 'Мясокомбинаты', ...(!noContacts && index % contactEvery === contactEvery - 1
          ? { website: `catalog-${index + 1}.test`, email: `info@catalog-${index + 1}.test` } : {}) }));
      const raw = catalogRows.map((row) => unifiedRow({ company: row.name, address: row.address,
        category: row.categories, website: row.website ?? '', email: row.email ?? '', source_detail: 'яндекс.карты' }));
      const sparseInfo = exhaustedInfo(sparseTask, {
        cost_policy: { version: 1, website_discovery: 'existing_only' },
        search_policy: { version: 1, phase: 'existing', deferred_rows: [] },
        adaptive_collection: { ...newVeAdaptiveCollection(), active_source: veSourceStrategyKey(sparseTask) },
        tasks: [{ source: 'yandex_maps', status: 'pending', child_job_id: null, task: sparseTask,
          rows: mode === 'old_pending_harvest' ? 100 : 0,
          harvest: mode === 'old_pending_harvest' ? raw.slice(0, 100) : [],
          catalog: { version: 1, filters: { categories: ['Мясокомбинаты'], countries: ['Россия'] },
            ...(mode === 'old_pending_harvest' ? { after: '100' } : {}) } },
        { source: 'companies_directory', status: 'pending', child_job_id: null, rows: 0, task: MEAT_TASK, harvest: [] }],
      });
      if (mode === 'zero_streak') {
        sparseInfo.tasks = sparseInfo.tasks!.slice(0, 1);
        sparseInfo.adaptive_collection!.replan_attempts = 2;
        sparseInfo.adaptive_collection!.widenings = 2;
      }
      sparseInfo.plan = { tasks: sparseInfo.tasks!.map((task) => task.task) };
      const sparseDb = seedBase(sparseInfo, MEAT, {}, [{ id: 'already-owned-company', project_id: PROJECT.id,
        hypothesis_id: 'another-hypothesis', status: 'analyzed',
        data: [{ ...raw[1], website: 'https://catalog-owned.test', email: 'info@catalog-owned.test' }] }]);
      // A free, exact company/address fact must still recover the first site
      // before that raw company is put into the deferred reserve.
      if (!noContacts) await sparseDb.from('ve_company_fact_pages').insert({ company_key: veCompanyFactKey(raw[0]), reader_version: 1,
        observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + VE_COMPANY_FACT_TTL_MS).toISOString(),
        website: 'https://catalog-recovered.test', facts: 'Мясокомбинат', inns: [], owner_inns: [] });
      if (!noContacts) await sparseDb.from('ve_company_fact_pages').insert({ company_key: veCompanyFactKey(raw[1]), reader_version: 1,
        observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + VE_COMPANY_FACT_TTL_MS).toISOString(),
        website: 'https://catalog-owned.test', facts: 'Мясокомбинат', inns: [], owner_inns: [] });
      const reads: Record<string, unknown>[] = [];
      const sparseRpc = sparseDb.rpc;
      sparseDb.rpc = ((name: string, params: Record<string, unknown>) => {
        if (name !== 'yandex_maps_catalog_search') return sparseRpc(name, params);
        reads.push(params);
        const operation = Promise.resolve({ data: catalogRows.slice(Number(params.p_after ?? 0),
          Number(params.p_after ?? 0) + Number(params.p_limit)), error: null });
        return Object.assign(operation, { abortSignal: () => operation });
      }) as typeof sparseDb.rpc;
      jest.mocked(callLLMWithSchema).mockClear();
      jest.mocked(fetchVeRelevanceEvidence).mockClear();
      if (mode === 'restart') {
        await expect(runBaseCollectStage(makeJob(), { supabase: sparseDb as unknown as SupabaseClient,
          onCheckpoint: () => {
            const saved = sparseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
            if (saved.tasks![0].catalog?.after === '100') throw new VeWorkerShutdownError();
          },
        })).rejects.toMatchObject({ name: 'VeWorkerShutdownError' });
        const saved = sparseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
        expect(saved.tasks![0]).toMatchObject({ rows: 21, status: 'pending', catalog_pages_read: 1, catalog: { after: '100' } });
        expect(saved.search_policy!.deferred_rows).toHaveLength(78);
        expect(sparseDb.getRows('base_constructor_jobs')).toHaveLength(0);
      }
      await wake(sparseDb);
      const saved = sparseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      const usableCount = noContacts ? 0 : mode === 'full_before_page_end' ? 100 : 81;
      expect(saved.tasks![0]).toMatchObject({ rows: usableCount, status: 'done',
        catalog_pages_read: mode === 'full_before_page_end' ? 3 : 4,
        catalog: { after: mode === 'full_before_page_end' ? '297' : '400' } });
      expect(saved.tasks![0].harvest).toHaveLength(usableCount);
      if (usableCount) expect(new URL(saved.tasks![0].harvest![0].website).hostname).toBe('catalog-recovered.test');
      const deferredCount = mode === 'old_pending_harvest' ? 320 : noContacts ? 400 : mode === 'full_before_page_end' ? 196 : 318;
      expect(saved.search_policy!.deferred_rows).toHaveLength(deferredCount);
      expect(new Set(saved.search_policy!.deferred_rows.map((row) => row.company)).size).toBe(deferredCount);
      if (mode === 'old_pending_harvest') expect(saved.search_policy!.deferred_rows.find((row) => row.company === raw[0].company)?.website)
        .toBe('https://catalog-recovered.test');
      expect(saved.search_policy!.deferred_rows.every((row) => (row as VeUnifiedRow & { _ve_source_strategy?: string })._ve_source_strategy === veSourceStrategyKey(sparseTask))).toBe(true);
      expect(reads.map((read) => read.p_after)).toEqual(mode === 'old_pending_harvest'
        ? ['100', '200', '300'] : mode === 'full_before_page_end' ? [null, '100', '200'] : [null, '100', '200', '300']);
      expect(reads.every((read) => Number(read.p_limit) <= 500)).toBe(true);
      const paid = sparseDb.getRows('base_constructor_jobs');
      expect(paid).toHaveLength(usableCount ? 1 : 0);
      if (!usableCount) {
        if (mode === 'zero_streak') {
          for (let tick = 0; tick < 5 && (sparseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.status === 'collecting'; tick++) {
            await wake(sparseDb);
          }
          const stopped = sparseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
          expect(stopped.target_progress).toMatchObject({ status: 'limited', idle_streak: 5, candidates_processed: 2, max_candidates: 10_000 });
          expect(stopped.search_policy!.deferred_rows).toHaveLength(2_000);
          expect(reads).toHaveLength(20);
          expect(sparseDb.getRows('base_constructor_jobs')).toHaveLength(0);
        } else {
          expect(saved.adaptive_collection!.active_source).toBe(veSourceStrategyKey(MEAT_TASK));
          expect(saved.target_progress).toMatchObject({ round: 3, candidates_processed: 2, max_rounds: 100, max_candidates: 10_000 });
        }
        expect(callLLMWithSchema).not.toHaveBeenCalled();
        expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
        continue;
      }
      expect(saved.adaptive_collection!.active_source).toBe(veSourceStrategyKey(sparseTask));
      expect(paid[0].data as string[][]).toHaveLength(usableCount + 1);
      expect((paid[0].data as string[][]).flat().some((cell) => cell.includes('catalog-owned.test'))).toBe(false);
      const snapshot = JSON.stringify(paid);
      await wake(sparseDb);
      expect(JSON.stringify(sparseDb.getRows('base_constructor_jobs'))).toBe(snapshot);
      expect(sparseDb.getRows('yandex_maps_jobs')).toHaveLength(0);
      expect(sparseDb.getRows('parser_jobs')).toHaveLength(0);
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    }

    // A specialist clinic catalogue wins over a whole-sector medical registry
    // while it remains useful. Its old cursors and the fallback's saved rows
    // survive; a deployment must not create another paid child on retry.
    const clinic = { title: 'Клиники пластической хирургии', description: 'Клиники, оказывающие услуги пластической хирургии.', broad: false };
    const registry = { ...DIRECTORY_TASK, directory_filters: { okvedCodes: ['86.2'], includeIp: false } };
    const exact = { source: 'yandex_maps' as const, rationale: 'Профильные клиники',
      maps_query: { queries: ['Пластическая хирургия'], geo: 'Россия' } };
    const broadRow = unifiedRow({ company: 'Медцентр Общий', website: 'general.test', email: 'info@general.test' });
    const exactRow = unifiedRow({ company: 'Клиника Пластики', website: 'plastic.test', email: 'info@plastic.test' });
    for (const condition of ['exact', 'exhausted', 'low_yield', 'mixed', 'mixed_category', 'broad', 'legacy', 'legacy_no_id', 'us'] as const) {
      const clinicTask = condition === 'mixed' ? { ...exact, maps_query: { ...exact.maps_query, queries: ['Пластическая хирургия', 'Косметология'] } } : exact;
      const sourceKey = veSourceStrategyKey(clinicTask);
      const policy = { ...newVeAdaptiveCollection(), active_source: veSourceStrategyKey(registry), replan_attempts: 2, widenings: 2 };
      if (condition === 'low_yield') policy.completed = [0, 1].map((index) => ({ id: `clinic-poor-${index}`,
        source: 'yandex_maps', source_key: sourceKey, candidates: 100, new_ready: 0, new_target: 0, poor: true,
        started_at: '2026-10-12T00:00:00Z', finished_at: '2026-10-12T00:01:00Z',
        spend: { ai_usd: 0.1, serper_credits: 0, estimated_total_usd: 0.1, unknown_attempts: 0, complete: true } }));
      const clinicInfo = exhaustedInfo(registry, { hypotheses: [{ id: 'h1', status: 'accepted', ...clinic,
        broad: condition === 'legacy' ? undefined : condition === 'broad' }],
        adaptive_collection: policy, search_policy: { version: 1, phase: 'existing', deferred_rows: [] } });
      clinicInfo.tasks![0] = { source: 'companies_directory', status: 'done', child_job_id: null, rows: 1,
        task: registry, harvest: [broadRow], exhausted: true, directory_cursors: { saved: 700 } };
      clinicInfo.tasks!.push({ source: 'yandex_maps', status: 'done', child_job_id: null,
        rows: condition === 'exhausted' ? 0 : 1, task: clinicTask, harvest: condition === 'exhausted' ? [] : [exactRow], exhausted: true,
        catalog: { version: 1, filters: { categories: condition === 'mixed_category'
          ? ['Пластическая хирургия', 'Медицинские центры'] : ['Пластическая хирургия'], countries: ['Россия'] }, after: 'saved-cursor' } });
      clinicInfo.plan = { tasks: clinicInfo.tasks!.map((task) => task.task) };
      const clinicDb = seedBase(clinicInfo, clinic, condition === 'legacy_no_id' ? { hypothesis_id: null } : {});
      if (condition === 'us') await clinicDb.from('ve_projects').update({ market: 'us' }).eq('id', 'p1');
      const taskSnapshot = JSON.stringify(clinicInfo.tasks);
      const counters = JSON.stringify([clinicInfo.target_checkpoint, policy.completed, policy.replan_attempts, policy.widenings]);
      jest.mocked(callLLMWithSchema).mockClear();
      if (condition === 'legacy_no_id') {
        await expect(wake(clinicDb)).rejects.toThrow('Target collection requires a scoped hypothesis base');
        expect(clinicDb.getRows('base_constructor_jobs')).toHaveLength(0);
        expect(callLLMWithSchema).not.toHaveBeenCalled();
        continue;
      }
      await wake(clinicDb);
      const saved = clinicDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      const paid = clinicDb.getRows('base_constructor_jobs');
      expect(paid).toHaveLength(1);
      expect((paid[0].data as string[][]).slice(1).map((row) => row[0]))
        .toEqual([condition === 'exact' ? exactRow.company : broadRow.company]);
      expect(JSON.stringify(saved.tasks)).toBe(taskSnapshot);
      expect(JSON.stringify([saved.target_checkpoint, saved.adaptive_collection!.completed,
        saved.adaptive_collection!.replan_attempts, saved.adaptive_collection!.widenings])).toBe(counters);
      expect(saved.target_progress).toMatchObject({ candidates_processed: 2, max_candidates: 10_000 });
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      expect(clinicDb.getRows('yandex_maps_jobs')).toHaveLength(0);
      const paidSnapshot = JSON.stringify(paid);
      await wake(clinicDb);
      expect(JSON.stringify(clinicDb.getRows('base_constructor_jobs'))).toBe(paidSnapshot);
      expect(callLLMWithSchema).not.toHaveBeenCalled();
    }
    // Old media checkpoints have only a title. Read their own hypothesis before
    // narrowing a cached mapping; keep cursors, caps and paid work immutable.
    for (const condition of ['games', 'tv', 'broad', 'us', 'capped', 'renamed'] as const) {
      const media = { title: condition === 'tv' ? 'Стриминги и ТВ' : 'Игры и анимация',
        description: '', broad: condition === 'broad' };
      const mediaTask = { source: 'yandex_maps' as const, rationale: 'Сохранённый медиа-план',
        maps_query: { queries: ['кинотеатр', 'анимация'], geo: 'Россия' } };
      const categories = condition === 'tv' ? ['Кинотеатры', 'Концертные залы', 'Студии звукозаписи']
        : ['Анимация', 'Кинотеатры', 'Азартные игры'];
      const counters = { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2,
        active_source: veSourceStrategyKey(mediaTask) };
      const legacy = exhaustedInfo(mediaTask, {
        hypotheses: [{ id: 'h1', title: media.title, status: 'accepted' }],
        tasks: [{ source: 'yandex_maps', status: 'pending', child_job_id: null, rows: 0,
          task: mediaTask, harvest: [], catalog: { version: 1, after: '600',
            filters: { categories, countries: ['Россия'] } } }],
        search_policy: { version: 1, phase: 'existing', deferred_rows: [] }, adaptive_collection: counters,
        ...(condition === 'capped' ? { target_progress: { ...createCollectionTarget('preview'), round: 3,
          ready_rows: 2, candidates_processed: 10_000 } } : {}),
      });
      const mediaDb = seedBase(legacy, condition === 'renamed' ? { ...media, title: 'Медиа и развлечения' } : media);
      if (condition === 'us') await mediaDb.from('ve_projects').update({ market: 'us' }).eq('id', 'p1');
      const catalogReads: Record<string, unknown>[] = [];
      const mediaRpc = mediaDb.rpc;
      mediaDb.rpc = ((name: string, params: Record<string, unknown>) => {
        if (name === 'yandex_maps_catalog_search') catalogReads.push(params);
        const operation = name === 'yandex_maps_catalog_search' ? Promise.resolve({ data: [], error: null }) : mediaRpc(name, params);
        return Object.assign(operation, { abortSignal: () => operation });
      }) as typeof mediaDb.rpc;
      jest.mocked(callLLMWithSchema).mockClear();
      await wake(mediaDb);
      const saved = mediaDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      if (condition === 'tv' || condition === 'capped') expect(catalogReads).toEqual([]);
      else expect(catalogReads).toEqual([expect.objectContaining({ p_after: '600',
        p_countries: ['Россия'], p_categories: condition === 'games' ? ['Анимация'] : categories })]);
      if (condition === 'tv') expect(saved.tasks![0]).toMatchObject({ status: 'done', unavailable: true,
        note: 'Сохранённые рубрики каталога не соответствуют выбранной гипотезе' });
      expect(saved.tasks![0].catalog?.after).toBe('600');
      expect(saved.tasks![0].task).toEqual(mediaTask);
      expect(saved.adaptive_collection).toMatchObject({ replan_attempts: 2, widenings: 2 });
      expect(saved.target_progress?.max_candidates).toBe(10_000);
      if (condition === 'capped') expect(saved.target_progress?.candidates_processed).toBe(10_000);
      expect(mediaDb.getRows('base_constructor_jobs')).toHaveLength(0);
      expect(mediaDb.getRows('hh_jobs')).toHaveLength(0);
      expect(mediaDb.getRows('yandex_maps_jobs')).toHaveLength(0);
      expect(callLLMWithSchema).not.toHaveBeenCalled();
    }
  });

  it('новый срез из каталога PDL тоже берёт только компании с сайтом', async () => {
    const pdlTask = { source: 'pdl' as const, widened: 'replan' as const, rationale: 'Meat processors from the PDL catalog.',
      pdl_filters: { industries: ['food production'] } };
    const info = exhaustedInfo(MEAT_TASK, { adaptive_collection: { ...newVeAdaptiveCollection(),
      widenings: 2, replan_attempts: 1, switches: 1, active_source: veSourceStrategyKey(pdlTask) } });
    info.tasks!.push({ source: 'pdl', status: 'pending', child_job_id: null, rows: 0, task: pdlTask });
    info.plan = { tasks: [MEAT_TASK, pdlTask] };
    const db = seedBase(info, MEAT);
    const originalRpc = db.rpc;
    db.rpc = ((name: string, params: Record<string, unknown>) => {
      const operation = name === 'search_pdl_companies' ? Promise.resolve({ data: [
        { id: '1', name: 'Prime Meats', website: 'primemeats.test', industry: 'food production', country: 'united states' },
        { id: '2', name: 'Nameless Sausage Co', website: '', industry: 'food production', country: 'united states' },
      ], error: null }) : originalRpc(name, params);
      return Object.assign(operation, { abortSignal: () => operation });
    }) as typeof db.rpc;
    const base = await wake(db);
    const pdl = (base.collect_info as VeCollectInfo).tasks![1];
    expect(pdl).toMatchObject({ status: 'done', rows: 1 });
    expect(pdl.harvest!.map((row) => row.company)).toEqual(['Prime Meats']);
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalledWith('', expect.anything());
  });

  it('расширенный срез не покупает поиск сайта для компании с одной почтой и честно завершает базу', async () => {
    const second = { ...MEAT_TASK, widened: 'second_queue' as const,
      directory_filters: { includeIp: false, okvedCodes: ['10.1'] } };
    // Почта есть, сайта нет. Раньше добор сайтов гейтился только глобальной
    // фазой сбора, и такая строка расширенного среза уходила в платный поиск.
    const mailOnly = unifiedRow({ company: 'Мясная лавка Почтовая', inn: '7700000301',
      email: 'shop@pochta-lavka.test', address: 'Москва, Почтовая улица, 3' });
    const info = exhaustedInfo(MEAT_TASK, {
      adaptive_collection: { ...newVeAdaptiveCollection(), widenings: 2, switches: 1, active_source: veSourceStrategyKey(second) },
      target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: 3, ready_rows: 3 },
      target_checkpoint: { completed_round: 2, seen_rows: [...processed, mailOnly], processed_rows: 3 },
    });
    info.tasks!.push({ source: 'companies_directory', status: 'done', child_job_id: null, rows: 1, task: second,
      harvest: [mailOnly], exhausted: true, note: 'реестр исчерпан' });
    info.plan = { tasks: [MEAT_TASK, second] };
    const readyMail = { ...mailOnly, _email_status: 'ok',
      _ve_company_name: { version: 1, source: mailOnly.company, website: '', status: 'ready', value: mailOnly.company } };
    const db = seedBase(info, MEAT, { data: [...ready, readyMail], row_count: 3 });

    const base = await wake(db);
    const result = base.collect_info as VeCollectInfo;
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalledWith('', expect.anything());
    expect(result.source_contact_recovery).toBeUndefined();
    expect(base.status).toBe('analyzing');
    expect(result.target_progress).toMatchObject({ status: 'exhausted', ready_rows: 3 });
    expect(result.target_progress?.reason).toContain('Срез уже расширялся автоматически (2 из 2)');
    expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
  });
});

/**
 * Старые задачи Яндекс Карт (аудит 22.09.2026). До 16.09 карты собирал живой
 * парсер: одна ссылка «<запрос> Россия» на запрос — 1 компания на «агентство
 * недвижимости» у 3cfcfbbd (задание yandex_maps_jobs 30328b8c). С 16.09 карты
 * читаются из готового каталога, но закрытая задача без закладки каталога
 * нигде не считалась продолжаемой: база вставала с «Нет подтверждённого
 * продолжения». План, запросы и числа — с прода.
 */
describe('base_collect: старая задача карт продолжается чтением каталога', () => {
  const LEGACY_JOB = '30328b8c-8af9-4599-b7f7-1072573be7db';
  const REALTY_DIRECTORY = { source: 'companies_directory' as const,
    rationale: 'Собираем малые агентства и посредников по операциям с недвижимостью, чтобы найти региональные АН с 3–30 агентами для продажи единого каталога новостроек и комиссий.',
    directory_filters: { hasEmail: false, includeIp: false, revenueTo: 300_000_000, okvedCodes: ['68.3'], employeesTo: 50, employeesFrom: 3 } };
  const REALTY_MAPS = { source: 'yandex_maps' as const,
    rationale: 'Собираем локальные агентства недвижимости с карточками и телефонами, чтобы добрать малые региональные АН, которые могут не выделяться чисто по ОКВЭД в реестре.',
    maps_query: { geo: 'Россия', queries: ['агентство недвижимости'] } };
  const directoryRows = [
    unifiedRow({ company: 'ООО Агентство Квартал', inn: '1655000001', website: 'kvartal-an.test', email: 'info@kvartal-an.test' }),
    unifiedRow({ company: 'ООО Риелторское бюро Ключ', inn: '1655000002', website: 'klyuch-an.test', email: 'office@klyuch-an.test' }),
  ];
  const parserRow = unifiedRow({ company: 'Агентство недвижимости Новый адрес', website: 'novyi-adres.test',
    email: 'hello@novyi-adres.test', address: 'Москва, Тверская улица, 7', source_detail: 'яндекс.карты' });
  const legacyTasks = (): NonNullable<VeCollectInfo['tasks']> => [
    { source: 'companies_directory', status: 'done', child_job_id: null, rows: 2, task: REALTY_DIRECTORY,
      harvest: directoryRows, exhausted: true, note: 'реестр исчерпан' },
    // Так лежит задача на проде: done, id завершённого парсера, 1 строка, без catalog.
    { source: 'yandex_maps', status: 'done', child_job_id: LEGACY_JOB, rows: 1, task: REALTY_MAPS,
      harvest: [parserRow], dispatched_at: '2026-09-09T17:09:25.546Z' },
  ];
  // Справочник и организации каталога. Числа рубрик — из
  // yandex_maps_catalog_rubrics; в России у «агентство недвижимости» (34 во
  // всём каталоге) и «Агентство недвижимости» (101) нет ни одной организации,
  // у «Агентства недвижимости» — 33 644. Функция каталога сравнивает рубрики
  // без учёта регистра, как и настоящая.
  const RUBRICS: Array<[string, number]> = [['Агентства недвижимости', 40_367], ['агентство недвижимости', 34],
    ['Агентство недвижимости', 101], ['Недвижимость', 148_830], ['Коммерческая недвижимость', 15_853]];
  const RU_COUNTS: Record<string, number> = { 'агентства недвижимости': 33_644, недвижимость: 120_000,
    'коммерческая недвижимость': 12_000 };
  const ORGANIZATIONS = [
    { yandex_id: '1000000001', name: 'АН Квадратный метр', website: 'kv-metr.test', email: 'sale@kv-metr.test',
      address: 'Казань, улица Баумана, 1', categories: 'Агентства недвижимости' },
    { yandex_id: '1000000002', name: 'Риелторский центр Дом', website: 'rc-dom.test', email: 'info@rc-dom.test',
      address: 'Самара, улица Куйбышева, 2', categories: 'Агентства недвижимости' },
  ];
  const installCatalog = (db: MockSupabaseClient, rubrics = RUBRICS) => {
    const originalFrom = db.from, originalRpc = db.rpc;
    db.from = ((table: string) => {
      if (table !== 'yandex_maps_catalog_rubrics' && table !== 'yandex_maps_catalog_places') return originalFrom(table);
      const rows = table === 'yandex_maps_catalog_rubrics' ? rubrics.map(([rubric, companies]) => ({ rubric, companies }))
        : [{ country: 'Россия', region: 'Москва и Московская область', city: 'Москва' }];
      let start = 0, end = 999;
      const query = { select: () => query, order: () => query,
        range: (from: number, to: number) => { start = from; end = to; return query; },
        abortSignal: async () => ({ data: rows.slice(start, end + 1), error: null }) };
      return query;
    }) as unknown as typeof db.from;
    db.rpc = ((name: string, params: Record<string, unknown>) => {
      const tokens = ((params.p_categories as string[] | null) ?? []).map((label) => label.toLowerCase());
      const operation = name === 'yandex_maps_catalog_count'
        ? Promise.resolve({ data: Math.min(Number(params.p_cap ?? Infinity), tokens.reduce((sum, token) => sum + (RU_COUNTS[token] ?? 0), 0)), error: null })
        : name === 'yandex_maps_catalog_search'
          ? Promise.resolve({ data: ORGANIZATIONS.filter((row) => tokens.includes(row.categories.toLowerCase())
            && (!params.p_after || row.yandex_id > String(params.p_after))).slice(0, Number(params.p_limit)), error: null })
          : originalRpc(name, params);
      if (name.startsWith('yandex_maps_catalog')) db.rpcCalls.push({ fn: name, params });
      return Object.assign(operation, { abortSignal: () => operation });
    }) as typeof db.rpc;
    return db;
  };
  const wake = async (db: MockSupabaseClient) => {
    const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect').at(-1)!;
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
    await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
      { supabase: db as unknown as SupabaseClient });
    return db.getRows('ve_bases')[0];
  };
  const expectCatalogRead = (db: MockSupabaseClient, info: VeCollectInfo) => {
    // Запросы задачи перенесены, фильтр подобран по справочнику: рубрика с
    // организациями в России, а не пустая в единственном числе.
    expect(info.tasks![1]).toMatchObject({ source: 'yandex_maps', task: { maps_query: REALTY_MAPS.maps_query },
      legacy_child_job_id: LEGACY_JOB, child_job_id: null,
      catalog: { version: 1, filters: { categories: ['Агентства недвижимости'], countries: ['Россия'] } } });
    expect(info.tasks![1].harvest!.map((row) => row.company)).toEqual(['АН Квадратный метр', 'Риелторский центр Дом']);
    expect(db.rpcCalls.filter((call) => call.fn === 'yandex_maps_catalog_search')[0].params)
      .toMatchObject({ p_categories: ['Агентства недвижимости'], p_countries: ['Россия'] });
    // Никакого живого парсера: ни новой задачи карт, ни Google Maps.
    expect(db.getRows('yandex_maps_jobs')).toHaveLength(0);
    expect(db.getRows('google_maps_jobs')).toHaveLength(0);
    const child = db.getRows('base_constructor_jobs').find((row) => row.status === 'pending')!;
    expect((child.data as string[][]).slice(1).map((row) => row[0]).sort()).toEqual(['АН Квадратный метр', 'Риелторский центр Дом']);
  };

  it('реестр исчерпан, старая задача карт закрыта: раунд продолжается чтением каталога, а не limited', async () => {
    const info: VeCollectInfo = {
      collection_mode: 'preview', ready_target: 500, limit: 2_000,
      plan: { tasks: [REALTY_DIRECTORY, REALTY_MAPS] }, tasks: legacyTasks(),
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      construct: { bc_job_id: 'bc-realty', status: 'dispatched', dispatched_at: '2026-09-09T17:30:00Z' },
      target_progress: { ...createCollectionTarget('preview'), round: 1 },
      target_checkpoint: { completed_round: 0, seen_rows: [], processed_rows: 0 },
    };
    const candidates = [...directoryRows, parserRow];
    const db = installCatalog(seed(info, { base_constructor_jobs: [{ id: 'bc-realty', status: 'completed', error_message: null,
      selected_steps: ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
      data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
        ...candidates.map((row) => [row.company, row.website, row.email, row.inn, 'ok'])] }] }));

    let base = await wake(db);
    let saved = base.collect_info as VeCollectInfo;
    expect(saved.target_progress).toMatchObject({ status: 'collecting', round: 2 });
    expect(saved.target_progress?.reason).toBeUndefined();
    expect(base.status).toBe('collecting');
    // Задача переоткрыта как чтение каталога: те же запросы, id парсера сохранён.
    expect(saved.tasks![1]).toEqual({ source: 'yandex_maps', task: REALTY_MAPS, status: 'pending', child_job_id: null,
      rows: 0, legacy_child_job_id: LEGACY_JOB });
    expect(saved.tasks![0]).toMatchObject({ status: 'done', exhausted: true });

    base = await wake(db);
    saved = base.collect_info as VeCollectInfo;
    expectCatalogRead(db, saved);
  });

  it.each([
    ['с резервом needs_review: сначала перепроверка резерва', true],
    ['без резерва: сразу к источникам', false],
  ])('«Продолжить подготовку» analyzed-базы вида 3cfcfbbd %s, затем чтение каталога', async (_label, withReserve) => {
    const needsReview = (row: VeUnifiedRow) => ({ ...row, _email_status: 'ok', _ve_relevance: { version: 2 as const,
      status: 'needs_review' as const, reason: 'Нет сведений о числе агентов; требуется подтверждение по сайту.', evidence: [],
      context_hash: 'c'.repeat(64), review_attempts: 0 } });
    const info: VeCollectInfo = {
      collection_mode: 'preview', ready_target: 500, limit: 5_000,
      plan: { tasks: [REALTY_DIRECTORY, REALTY_MAPS] }, tasks: legacyTasks(),
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      relevance_reserve: { version: 1, rows: withReserve ? directoryRows.map(needsReview) : [] },
      target_progress: { ...createCollectionTarget('preview'), round: 2, status: 'limited', max_rounds: 100,
        candidates_processed: 70, ready_rows: 0, reason: 'Нет подтверждённого продолжения источников; исчерпание рынка не доказано' },
      target_checkpoint: { completed_round: 2, seen_rows: [...directoryRows, parserRow], processed_rows: 84 },
      stats: { tasks_total: 2, tasks_done: 2, tasks_failed: 0, rows_total: 70, excluded_existing_bases: 70,
        excluded_during_fetch: 0, finished_at: '2026-09-22T11:26:28.055Z' },
    };
    const db = installCatalog(seed(info, { ve_bases: [{ ...makeBase(info), status: 'analyzed', columns: [...VE_AUTO_COLLECT_COLUMNS] }] }));
    await db.from('ve_jobs').update({ status: 'done' }).eq('id', makeJob().id);
    // Без сохранённого резерва базу тоже можно продолжить: из-за старой задачи карт.
    expect(canResumePartialPreview(db.getRows('ve_bases')[0])).toBe(true);
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000, resumeBaseId: 'b1' }))
      .resolves.toMatchObject({ ok: true, created: true, base: { id: 'b1' } });

    // Первый заход — перепроверка сохранённого резерва, без источников.
    let base = await wake(db);
    let saved = base.collect_info as VeCollectInfo;
    expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(withReserve ? 1 : 0);
    expect(db.rpcCalls.some((call) => call.fn === 'yandex_maps_catalog_search')).toBe(false);
    expect(base.status).toBe('collecting');
    expect(saved.target_progress).toMatchObject({ status: 'collecting', round: 3, ready_rows: withReserve ? 2 : 0 });
    expect(saved.relevance_review_requested).toBeUndefined();
    expect(saved.tasks![1]).toMatchObject({ status: 'pending', child_job_id: null, legacy_child_job_id: LEGACY_JOB });

    // Второй — открывает задачу карт через готовый каталог.
    base = await wake(db);
    saved = base.collect_info as VeCollectInfo;
    expectCatalogRead(db, saved);
  });

  it('адаптивная база (вид 905753d2): старая задача карт открывается добором, а не остаётся закрытой', async () => {
    const info: VeCollectInfo = {
      collection_mode: 'preview', ready_target: 500, limit: 100,
      plan: { tasks: [REALTY_DIRECTORY, REALTY_MAPS] }, tasks: legacyTasks(),
      adaptive_collection: newVeAdaptiveCollection(),
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      target_progress: { ...createCollectionTarget('preview'), round: 7, candidates_processed: 3 },
      target_checkpoint: { completed_round: 6, seen_rows: [...directoryRows, parserRow], processed_rows: 3 },
    };
    const db = installCatalog(seed(info));
    const saved = (await wake(db)).collect_info as VeCollectInfo;
    expect(saved.adaptive_collection?.active_source).toBe(veSourceStrategyKey(REALTY_MAPS));
    expectCatalogRead(db, saved);
  });

  it('следующий раунд после сбоя каталога тоже переоткрывает старую задачу карт', () => {
    const info = {
      tasks: legacyTasks(),
      target_progress: { ...createCollectionTarget('preview'), round: 2, status: 'error', reason: 'x' },
      target_checkpoint: { completed_round: 2 },
    } as unknown as Record<string, unknown>;
    expect(openNextVeCollectionRound(info)).toBe(true);
    expect((info.tasks as VeCollectInfo['tasks'])![1]).toEqual({ source: 'yandex_maps', task: REALTY_MAPS,
      status: 'pending', child_job_id: null, rows: 0, legacy_child_job_id: LEGACY_JOB });
  });

  it('рынок РФ: задача Google Maps из плана уходит в готовый каталог Яндекс Карт, а не в живой поиск', async () => {
    const google = { source: 'google_maps' as const, rationale: REALTY_MAPS.rationale, maps_query: REALTY_MAPS.maps_query };
    const db = installCatalog(seed({ collection_mode: 'preview' }));
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce({ data: { tasks: [google] }, tokensUsed: 10, costUsd: 0.01,
      promptTokens: 5, completionTokens: 5, rawResponse: '' });
    const saved = (await wake(db)).collect_info as VeCollectInfo;
    expect(saved.plan?.tasks).toEqual([{ ...google, source: 'yandex_maps' }]);
    expect(saved.tasks![0]).toMatchObject({ source: 'yandex_maps',
      catalog: { filters: { categories: ['Агентства недвижимости'], countries: ['Россия'] } } });
    expect(db.getRows('google_maps_jobs')).toHaveLength(0);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
  });

  it('неподходящий каталог сохраняет причину и не блокирует другой источник; временный сбой продолжает ту же страницу', async () => {
    for (const missingRubric of [false, true]) {
      const lonely = { ...REALTY_MAPS, maps_query: { geo: 'Россия', queries: ['агентство недвижимости'] } };
      const info: VeCollectInfo = { collection_mode: 'preview', target_progress: createCollectionTarget('preview'),
        adaptive_collection: { ...newVeAdaptiveCollection(), active_source: veSourceStrategyKey(lonely) },
        plan: { tasks: [lonely, REALTY_DIRECTORY] }, tasks: [
          { source: 'yandex_maps', status: 'pending', child_job_id: null, rows: 0, task: lonely },
          { source: 'companies_directory', status: 'pending', child_job_id: null, rows: 0, task: REALTY_DIRECTORY },
        ] };
      const db = installCatalog(seed(info), missingRubric ? [['Кафе', 100]]
        : [['агентство недвижимости', 34], ['Агентство недвижимости', 101]]);
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce({ data: { category_ids: missingRubric ? [] : [0, 1], place_ids: [] },
        tokensUsed: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, rawResponse: '' });
      const outcome = await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
      const base = db.getRows('ve_bases')[0], saved = base.collect_info as VeCollectInfo;
      const task = saved.tasks![0];
      expect(task).toMatchObject({ status: 'done', unavailable: true });
      expect(task.exhausted).not.toBe(true);
      expect(task.error).toBeUndefined();
      expect(task.note).toContain(missingRubric ? 'подходящие рубрики' : 'нет организаций по рубрикам');
      expect(isVeRenewableSourceTask(task)).toBe(false);
      expect(base.status).toBe('collecting');
      expect(outcome.result).toMatchObject({ waiting: true, next_source: 'companies_directory' });
      expect(saved.adaptive_collection?.active_source).toBe(veSourceStrategyKey(REALTY_DIRECTORY));
      expect(db.rpcCalls.some((call) => call.fn === 'yandex_maps_catalog_search')).toBe(false);
      expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
    }

    const info: VeCollectInfo = { collection_mode: 'preview', target_progress: createCollectionTarget('preview'),
      plan: { tasks: [REALTY_MAPS] }, tasks: [{ source: 'yandex_maps', status: 'pending', child_job_id: null,
        rows: 0, task: REALTY_MAPS, catalog: { version: 1,
          filters: { categories: ['Агентства недвижимости'], countries: ['Россия'] } } }] };
    const db = installCatalog(seed(info));
    const originalRpc = db.rpc;
    let reads = 0;
    db.rpc = ((name: string, params: Record<string, unknown>) => {
      if (name !== 'yandex_maps_catalog_search') return originalRpc(name, params);
      reads++;
      db.rpcCalls.push({ fn: name, params });
      const operation = Promise.resolve(reads === 1 ? { data: [ORGANIZATIONS[0]], error: null }
        : { data: null, error: { message: 'An invalid response was received from the upstream server' } });
      return Object.assign(operation, { abortSignal: () => operation });
    }) as typeof db.rpc;
    const failure = await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient })
      .then(() => { throw new Error('Expected transient catalog failure'); }, (error: Error) => error);
    expect(failure.message).toContain('invalid response was received');
    const saved = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(saved.target_progress?.status).toBe('collecting');
    expect(saved.tasks![0]).toMatchObject({ status: 'pending', rows: 1,
      catalog: { after: ORGANIZATIONS[0].yandex_id } });
    expect(saved.tasks![0].harvest).toHaveLength(1);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
    const now = Date.parse('2026-10-09T13:00:00Z');
    expect(planVeJobFailure({ ...makeJob(), attempts: 0 }, failure, now)).toMatchObject({
      status: 'pending', attempts: 1, attemptCap: 5, retryable: true, runAfter: new Date(now + 30_000).toISOString() });
    expect(planVeJobFailure({ ...makeJob(), attempts: 4 }, failure, now)).toMatchObject({ status: 'failed', attempts: 5 });
    db.rpc = originalRpc;
    const priorCalls = db.rpcCalls.length;
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const retryReads = db.rpcCalls.slice(priorCalls).filter((call) => call.fn === 'yandex_maps_catalog_search');
    expect(retryReads[0].params).toMatchObject({ p_after: ORGANIZATIONS[0].yandex_id });
    expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0].harvest).toHaveLength(2);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
  });

  it('источник, которого эта версия не читает (two_gis после отката, неизвестный), закрывается как недоступный, а не уходит в Google Maps', async () => {
    const twin = { source: 'two_gis' as const, rationale: 'Снимок 2ГИС по запросам Яндекс-задачи',
      two_gis_query: { from_queries: REALTY_MAPS.maps_query.queries, geo: REALTY_MAPS.maps_query.geo } };
    const unknown = { source: 'future_source', rationale: 'Источник будущей версии', maps_query: REALTY_MAPS.maps_query } as unknown as
      NonNullable<VeCollectInfo['plan']>['tasks'][number];
    // Строка справочника из harvest близнеца (R3) остаётся в задаче и не идёт в конструктор.
    const twinRow = unifiedRow({ company: 'АН Справочный', website: 'spravka-an.test', email: 'info@spravka-an.test',
      address: 'Казань, Республика Татарстан', source_detail: 'справочник организаций' });
    for (const task of [twin, unknown]) {
      // Активным оставлен сам источник — как после отката с R3.
      const info: VeCollectInfo = { collection_mode: 'preview', target_progress: createCollectionTarget('preview'),
        adaptive_collection: { ...newVeAdaptiveCollection(), active_source: veSourceStrategyKey(task) },
        plan: { tasks: [task] }, tasks: [{ source: task.source, status: 'pending', child_job_id: null, task,
          ...(task === twin ? { rows: 1, harvest: [twinRow], two_gis_pair_id: 'pair-1' } : { rows: 0 }) }] };
      const db = seed(info);
      await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
      const base = db.getRows('ve_bases')[0];
      const state = (base.collect_info as VeCollectInfo).tasks![0];
      expect(state).toMatchObject({ status: 'done', unavailable: true, note: 'Источник недоступен в этой версии', child_job_id: null });
      expect(state.error).toBeUndefined();
      expect(base.status).not.toBe('failed');
      expect(db.getRows('google_maps_jobs')).toHaveLength(0);
      expect(db.getRows('parser_jobs')).toHaveLength(0);
      expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
      if (task === twin) expect(state.harvest).toEqual([twinRow]);
    }
  });

  it('2ГИС: ключ близнеца не зависит от пары и плана, одинаковые близнецы сводятся к одному, пара переживает географию и jsonb', async () => {
    // Ключи прежних задач не меняются (сняты до части 2).
    expect(veSourceStrategyKey({ source: 'yandex_maps', rationale: 'r', maps_query: { geo: 'Россия', queries: ['агентство недвижимости'] } }))
      .toBe('9d88872881c5ff95b9b49d062f3a272f3f7c8ddec4a2875a82bdcfbe8088220c');
    expect(veSourceStrategyKey({ source: 'companies_directory', rationale: 'r', directory_filters: { okvedCodes: ['68.3'], includeIp: false } }))
      .toBe('8bf09126779c0b2cb021cc6d293678c7f23aa5d1e25dba59638acb4e347b4841');
    expect(veSourceStrategyKey({ source: 'hh_live', rationale: 'r', hh_query: { text: 'риелтор', area: '113' } }))
      .toBe('e200accb1a96c9b299dc62c4215944824eda2bb24a038940328c575608cb0c68');
    const moscow = { ...REALTY_MAPS, maps_query: { geo: 'Москва', queries: [...REALTY_MAPS.maps_query.queries] } };
    const plan = { tasks: [REALTY_DIRECTORY, REALTY_MAPS, moscow] };
    const first = withVeTwoGisTwins(plan), again = withVeTwoGisTwins(structuredClone(plan));
    expect(first.tasks.map((task) => task.source)).toEqual(['companies_directory', 'yandex_maps', 'two_gis', 'yandex_maps', 'two_gis']);
    expect(first.tasks[0]).toBe(REALTY_DIRECTORY);
    expect(first.tasks[2].two_gis_query).toEqual({ from_queries: REALTY_MAPS.maps_query.queries, geo: 'Россия' });
    const twinKeys = (tasks: typeof first.tasks) => tasks.filter((task) => task.source === 'two_gis').map(veSourceStrategyKey);
    expect(twinKeys(again.tasks)).toEqual(twinKeys(first.tasks));
    expect(new Set(twinKeys(first.tasks)).size).toBe(2); // те же запросы, другое geo — два ключа
    const states = first.tasks.map((task) => ({ source: task.source, task, status: 'pending' as const, child_job_id: null, rows: 0 })) as
      NonNullable<VeCollectInfo['tasks']>;
    const unpaired = veTwoGisTwinKeys(states);
    let id = 0;
    pairVeTwoGisStates(states, () => `pair-${++id}`);
    expect(states.map((state) => state.two_gis_pair_id ?? null)).toEqual([null, 'pair-1', 'pair-1', 'pair-2', 'pair-2']);
    expect(veTwoGisTwinKeys(JSON.parse(JSON.stringify(states)))).toEqual(unpaired);
    const doubled = finalizeVeTwoGisTwins(withVeTwoGisTwins({ tasks: [REALTY_MAPS, { ...REALTY_MAPS, rationale: 'Другая формулировка' }] }));
    expect(doubled).toMatchObject({ added: 1, dropped: 1 });
    const doubledStates = doubled.plan.tasks.map((task) => ({ source: task.source, task, status: 'pending' as const, child_job_id: null, rows: 0 })) as
      NonNullable<VeCollectInfo['tasks']>;
    pairVeTwoGisStates(doubledStates, () => 'only');
    expect(doubledStates.map((state) => [state.source, state.two_gis_pair_id ?? null])).toEqual([['yandex_maps', 'only'], ['two_gis', 'only'], ['yandex_maps', null]]);
    // Близнец без соседки-Яндекса с теми же запросами — «пара потеряна», без id пары.
    const [lostMaps, lostTwin] = withVeTwoGisTwins({ tasks: [REALTY_MAPS] }).tasks;
    for (const order of [[lostTwin, lostMaps], [{ ...lostMaps, maps_query: { ...lostMaps.maps_query!, queries: ['другой запрос'] } }, lostTwin]]) {
      const lost = order.map((task) => ({ source: task.source, task, status: 'pending' as const, child_job_id: null, rows: 0 })) as
        NonNullable<VeCollectInfo['tasks']>;
      pairVeTwoGisStates(lost, () => 'never');
      const twinState = lost.find((state) => state.source === 'two_gis')!;
      expect(twinState).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_PAIR_LOST_NOTE });
      expect(lost.every((state) => state.two_gis_pair_id === undefined)).toBe(true);
    }
    // География 2ГИС — только Россия: регион с кодом, город, вся страна; чужая страна и проза — не читаем.
    for (const [geo, scope] of [['Москва и МО', { region_codes: ['77', '50'] }], ['Казань', { cities: ['Казань'] }], ['Россия', {}],
      ['Россия, Москва', {}], ['Россия, Казахстан', null], ['РФ кроме Москвы', null], ['Кемеровская область', { region_codes: ['42'] }],
      ['Москва, Ханты-Мансийский АО - Югра', { region_codes: ['77', '86'] }]] as const) expect(veTwoGisQueryScope({ geo })).toEqual(scope);
    expect(veTwoGisQueryScope({})).toEqual({});
    const geography = { version: 1 as const, required: 'Москва и МО' };
    const placed = applyVeCollectionGeographyToPlan(first, geography);
    expect(placed.tasks[2].two_gis_query).toEqual({ from_queries: REALTY_MAPS.maps_query.queries, geo: 'Москва, Московская область',
      region_codes: ['77', '50'], collection_geography: geography });
    expect(JSON.stringify(applyVeCollectionGeographyToPlan(placed, geography))).toBe(JSON.stringify(placed));
    expect(finalizeVeTwoGisTwins(placed)).toMatchObject({ added: 1, dropped: 1 }); // география свела два geo к одному ключу
    expect(finalizeVeTwoGisTwins(applyVeCollectionGeographyToPlan(first, { version: 1, required: 'РФ кроме Москвы' })).added).toBe(0);

    // Тик базы: пары из jsonb (ключи по длине, затем по байтам) не дают ложного «отличается».
    const TWO_GIS_TICK_FLAG = { version: 1 as const, snapshot_id: 7, features_version: 1, max_candidates: 1000, frozen_at: '2026-10-26T12:00:00.000Z' };
    const jsonb = (value: unknown): unknown => Array.isArray(value) ? value.map(jsonb) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, jsonb(item)])) : value;
    const other = { ...REALTY_MAPS, maps_query: { geo: 'Россия', queries: ['риелтор'] } };
    const stale = { ...REALTY_MAPS, maps_query: { geo: 'Россия', queries: ['новостройки'] } };
    const [storedMaps, storedTwin, storedOther, rawOtherTwin, storedStale, rawStaleTwin] = [
      ...placed.tasks.slice(1, 3), ...applyVeCollectionGeographyToPlan({ tasks: [other] }, geography).tasks,
      ...withVeTwoGisTwins({ tasks: [other] }).tasks.slice(1), ...applyVeCollectionGeographyToPlan({ tasks: [stale] }, geography).tasks,
      ...withVeTwoGisTwins({ tasks: [stale] }).tasks.slice(1)].map((task) => jsonb(task) as typeof first.tasks[number]);
    const done = { status: 'done' as const, child_job_id: null, rows: 0, exhausted: true, catalog: { version: 1 as const,
      filters: { categories: ['Агентства недвижимости'], countries: ['Россия'] } } };
    // У ожидающего близнеца — старые города и курсор: пересчёт географии убирает оба.
    const staleOtherTwin = jsonb({ ...rawOtherTwin, two_gis_query: { ...rawOtherTwin.two_gis_query!, cities: ['Казань'] } }) as typeof rawOtherTwin;
    const [, orphanTwin] = withVeTwoGisTwins({ tasks: [{ ...REALTY_MAPS, maps_query: { geo: 'Россия', queries: ['сирота'] } }] }).tasks;
    const staleRow = unifiedRow({ company: 'АН Справочный', website: 'spravka-an.test', source_detail: 'справочник организаций' });
    const info = jsonb({ collection_mode: 'preview', collection_geography: geography,
      two_gis_source: TWO_GIS_TICK_FLAG, target_progress: createCollectionTarget('preview'),
      plan: { tasks: [storedMaps, storedTwin, storedOther, staleOtherTwin, storedStale, rawStaleTwin, orphanTwin] },
      tasks: [
        { source: 'yandex_maps', task: storedMaps, ...done, two_gis_pair_id: 'p' },
        { source: 'two_gis', task: storedTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p' },
        { source: 'yandex_maps', task: storedOther, ...done, two_gis_pair_id: 'q' },
        { source: 'two_gis', task: staleOtherTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'q',
          two_gis: { version: 1, cursor: 1 } },
        { source: 'yandex_maps', task: storedStale, ...done, two_gis_pair_id: 'r' },
        { source: 'two_gis', task: rawStaleTwin, status: 'done', child_job_id: null, rows: 1, harvest: [staleRow], two_gis_pair_id: 'r' },
        // Близнец без Яндекс-задачи с той же парой: тик закрывает его «пара потеряна».
        { source: 'two_gis', task: orphanTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 's' },
      ] }) as VeCollectInfo;
    const db = seed(info, { ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', broad: false,
      title: 'Агентства недвижимости', description: 'Агентства недвижимости с сайтом.' }] });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const base = db.getRows('ve_bases')[0];
    const saved = base.collect_info as VeCollectInfo;
    expect(base.status).not.toBe('failed');
    expect(saved.tasks!.map((state) => state.two_gis_pair_id)).toEqual(['p', 'p', 'q', 'q', 'r', 'r', 's']);
    expect(JSON.stringify(saved.tasks![1].task)).toBe(JSON.stringify(storedTwin));
    // Ожидающий близнец без географии пересчитан веткой two_gis; пара та же.
    expect(saved.tasks![3].task.two_gis_query).toEqual({ from_queries: ['риелтор'], geo: 'Москва, Московская область',
      region_codes: ['77', '50'], collection_geography: geography });
    expect(saved.tasks![3].two_gis).toBeUndefined();
    expect(saved.tasks![6]).toMatchObject({ status: 'done', unavailable: true, note: VE_TWO_GIS_PAIR_LOST_NOTE });
    // Близнец с прогрессом по прежней географии закрыт, а не валит базу; собранное осталось.
    expect(saved.tasks![5]).toMatchObject({ status: 'done', unavailable: true, rows: 1, task: rawStaleTwin,
      note: 'География сбора изменилась: справочник организаций по прежней географии не продолжается' });
    expect(saved.tasks![5].harvest).toEqual([staleRow]);

    // География брифа не сводится к местам России: ожидающий близнец закрыт на тике, база не падает.
    const prose = { version: 1 as const, required: 'РФ кроме Москвы' };
    const [proseMaps] = applyVeCollectionGeographyToPlan({ tasks: [REALTY_MAPS] }, prose).tasks;
    const [, proseTwin] = withVeTwoGisTwins({ tasks: [REALTY_MAPS] }).tasks;
    const proseInfo: VeCollectInfo = { collection_mode: 'preview', collection_geography: prose, two_gis_source: TWO_GIS_TICK_FLAG,
      target_progress: createCollectionTarget('preview'), plan: { tasks: [proseMaps, proseTwin] }, tasks: [
        { source: 'yandex_maps', task: proseMaps, ...done, two_gis_pair_id: 'p' },
        { source: 'two_gis', task: proseTwin, status: 'pending', child_job_id: null, rows: 0, two_gis_pair_id: 'p' }] };
    const proseDb = seed(proseInfo, { ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', broad: false,
      title: 'Агентства недвижимости', description: 'Агентства недвижимости с сайтом.' }] });
    await runBaseCollectStage(makeJob(), { supabase: proseDb as unknown as SupabaseClient });
    expect(proseDb.getRows('ve_bases')[0].status).not.toBe('failed');
    expect((proseDb.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![1]).toMatchObject({ status: 'done', unavailable: true,
      two_gis_pair_id: 'p', note: 'География сбора не сводится к регионам и городам России: справочник организаций не читается' });

    // Ремонт географии не оставляет близнеца живым: он в retired, пересобранная Яндекс-задача — без пары.
    const repairRows = [0, 1].map((i) => ({ company: `Агентство ${i}`, inn: `770000001${i}`, email: `a${i}@example.test`,
      address: 'Москва', _email_status: 'ok', _ve_relevance: { status: 'relevant', context_hash: 'paid' },
      _ve_company_name: { version: 1, source: `Агентство ${i}`, website: '', status: 'ready', value: `Агентство ${i}` } }));
    const [repairMaps, repairTwin] = withVeTwoGisTwins({ tasks: [REALTY_MAPS] }).tasks;
    const repairSnapshot: VeGeographyRepairSnapshot = { project_id: 'project', setup_revision: 1, selected: true, approved: false,
      frozen: false, accepted_launch: false,
      base: { id: 'repair-base', project_id: 'project', hypothesis_id: 'hypothesis', source: 'auto', status: 'analyzed',
        data: repairRows, row_count: repairRows.length, columns: ['company', 'inn', 'email', 'address'], updated_at: '2026-10-26T13:00:00Z',
        max_emails_per_company: 1, analysis: null, collect_info: { collection_mode: 'preview',
          target_progress: { mode: 'preview', ready_target: 500, ready_rows: 2, round: 3, max_rounds: 100,
            candidates_processed: 50, max_candidates: 10000, status: 'limited' },
          target_checkpoint: { completed_round: 3, seen_rows: repairRows, processed_rows: 2 },
          tasks: [{ source: 'yandex_maps', status: 'pending', child_job_id: null, rows: 0, task: repairMaps, two_gis_pair_id: 'p' },
            { source: 'two_gis', status: 'pending', child_job_id: null, rows: 0, task: repairTwin, two_gis_pair_id: 'p' }] } },
      preparation: { base_id: 'repair-base', hypothesis_id: 'hypothesis', status: 'ready', updated_at: '2026-10-26T13:00:00Z',
        paused_at: null, cancelled_at: null, pause_state: null, locked_until: null, claim_token: null, independent_control: true },
      jobs: [], children: [] };
    const repaired = planVeCollectionGeographyRepair(repairSnapshot, { repair_id: 'twin-geo', required: geography,
      reviewed_data_hash: veGeographyRepairHash(repairRows), ready_row_indices: [0, 1], prepared_at: '2026-10-26T14:00:00Z' });
    if (repaired.status === 'blocked') throw new Error(repaired.reasons.join(','));
    expect(repaired.patch.collect_info.geography_repair?.retired_task_indices).toEqual([1]);
    expect(repaired.patch.collect_info.tasks!.map((state) => state.source)).toEqual(['yandex_maps']);
    expect(repaired.patch.collect_info.plan!.tasks.map((task) => task.source)).toEqual(['yandex_maps']);
    expect(repaired.patch.collect_info.tasks![0].two_gis_pair_id).toBeUndefined();
  });
});

describe('base_collect: круг повторной отправки одних и тех же компаний', () => {
  // Настоящие строки базы b5934955 «Промышленное производство» (аудит 22.09):
  // 91 партия подряд уходили 2–3 из этих компаний, ни одного нового контакта.
  const ALROSA = unifiedRow({ company: 'АК "АЛРОСА" (ПАО)', inn: '1433000147',
    email: 'info@alrosa.ru, merkav@rambler.ru, slobodyanyukme@alrosa.ru',
    website: 'zakupki.alrosa.ru, alrosa.ru, alois.ru, metallokonstrukcii.alois.ru, alois-kovka.ru',
    source_detail: 'реестр', address: '678174, Респ. Саха, г. Мирный, ул. Ленина' });
  // Соседняя база проекта beaee143: та же АЛРОСА под другим названием и без ИНН.
  const NEIGHBOUR = { company: 'АЛРОСА', inn: '', email: 'info@alrosa.ru',
    website: 'https://www.alrosa.ru/hr/pochemu-alrosa/', address: 'Мирный (Республика Саха (Якутия))', _email_status: 'ok' };
  const KREZOL = unifiedRow({ company: 'ООО "КРЕЗОЛ-НЕФТЕСЕРВИС"', inn: '0273094417',
    email: 'kns@krezol.ru, l.kuzmina@krezol.ru, df@krezol.ru', website: 'krezol-ns.ru', source_detail: 'реестр',
    address: '450027, г. Уфа, ул. Трамвайная' });
  const HERGU = unifiedRow({ company: 'ООО "ХЭРГУ"', inn: '2825000414',
    email: 'amur-gold@mail.ru, callcentreblg@mail.ru, rabota.rosszoloto@bk.ru', website: 'rosszoloto.ru',
    source_detail: 'реестр', address: '675002, Амурская обл., г. Благовещенск' });
  // Адрес ХЭРГУ уже стоит в готовой базе у другой компании этой же базы.
  const OWN_READY = { ...unifiedRow({ company: 'АО "Росзолото"', inn: '2801000001', email: 'rabota.rosszoloto@bk.ru',
    website: 'rosszoloto.ru' }), _email_status: 'ok',
  _ve_company_name: { version: 1, source: 'АО "Росзолото"', website: 'rosszoloto.ru', status: 'ready', value: 'Росзолото' } };
  const FRESH = unifiedRow({ company: 'ООО "УРАЛМЕТ"', inn: '6670000001', email: 'info@uralmet.test',
    website: 'uralmet.test', source_detail: 'реестр' });
  // Строка карт без ИНН и без сайта: узнаётся только по отметке урезанной строки.
  const CAFE = unifiedRow({ company: 'Кафе Уют', email: 'info@uyut.test, booking@uyut.test',
    address: 'Казань, ул. Баумана, 1', source_detail: 'Яндекс Карты' });
  const constructorCompanies = (db: MockSupabaseClient) => db.getRows('base_constructor_jobs')
    .flatMap((job) => (job.data as string[][]).slice(1).map((row) => row[0]));

  it('компания с адресом, занятым другой базой, и сырой вариант уже отправленной строки не уходят снова', async () => {
    // Так движок отправил эти строки в прошлых раундах: АЛРОСА — без занятого
    // соседями адреса и с обработанным сайтом; «Крезол» — сырой (партия №5);
    // ХЭРГУ — отметкой старого формата из четырёх полей.
    const sentAlrosa = pruneBaseRowAgainstExclusion(buildBaseExclusionKeysFromRows([NEIGHBOUR]), normalizeVeSourceContacts(ALROSA))!;
    expect(sentAlrosa).toMatchObject({ email: 'merkav@rambler.ru, slobodyanyukme@alrosa.ru',
      website: 'https://zakupki.alrosa.ru/, https://alrosa.ru/, https://alois.ru/' });
    const sentHergu = normalizeVeSourceContacts({ ...HERGU, email: 'amur-gold@mail.ru, callcentreblg@mail.ru' });
    const legacyHergu = { company: sentHergu.company, inn: sentHergu.inn, email: sentHergu.email, website: sentHergu.website };
    const cafeNeighbour = { company: 'Уют', email: 'info@uyut.test', _email_status: 'ok' };
    const sentCafe = { ...CAFE, email: 'booking@uyut.test' };
    const info: VeCollectInfo = { ...collectInfo([ALROSA, KREZOL, HERGU, CAFE, FRESH]), collection_mode: 'preview',
      target_progress: { ...createCollectionTarget('preview'), round: 11, candidates_processed: 900, ready_rows: 1 },
      target_checkpoint: { completed_round: 10, seen_rows: [sentAlrosa, KREZOL, legacyHergu, sentCafe], processed_rows: 4 } };
    info.tasks![0].exhausted = true;
    const db = seed(info, { ve_bases: [{ ...makeBase(info), data: [OWN_READY], row_count: 1, columns: [...VE_AUTO_COLLECT_COLUMNS] },
      { ...makeBase({}), id: 'beaee143', hypothesis_id: 'h2', status: 'analyzed', columns: [...VE_AUTO_COLLECT_COLUMNS],
        data: [NEIGHBOUR, cafeNeighbour] }] });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    expect(constructorCompanies(db)).toEqual([FRESH.company]);

    // Both entry points must match the immutable receipt of an already pruned
    // observation, including a new site whose old email was stripped.
    for (const email of [`${FRESH.email}, new@uralmet.test`, FRESH.email]) {
      const incoming = { ...FRESH, email, website: 'new-uralmet.test' };
      const pruned = { ...incoming, email: email.includes(',') ? 'new@uralmet.test' : '' };
      const keys = { ...buildBaseExclusionKeysFromRows([]), seen: buildVeSeenCompanies([FRESH]),
        receipts: new Set([veAcquisitionReceipt(pruned)]) };
      expect(pruneBaseRowAgainstExclusion(keys, incoming)).toBeNull();
      expect(baseRowMatchesExclusion(keys, incoming)).toBe(true);
    }

    // A previous supply batch only checked these companies. Preserve its
    // observations across multiple bases, but accept genuinely new contacts.
    for (const source of ['saved', 'directory', 'catalog'] as const) {
      const observed = (n: number) => unifiedRow({ company: `Клиника ${n}`, inn: `77000000${String(n).padStart(2, '0')}`,
        website: `clinic-${n}.test`, email: `old@clinic-${n}.test`, source_detail: 'реестр' });
      const a = observed(11), b = observed(12), c = observed(13), owned = observed(14), current = observed(15);
      const unrelated = observed(16), sameEmailOtherInn = { ...observed(17), email: a.email };
      const cSecond = { ...c, email: 'second@clinic-13.test' };
      const ownRepeat = observed(18), anonymous = unifiedRow({ company: 'Без идентификатора', source_detail: 'реестр' });
      const inputs = [
        { ...a, email: `${a.email}, new@clinic-11.test` },
        ...(source === 'catalog' ? [] : [{ ...b, website: 'new-clinic-12.test' }]),
        { ...c, email: `${c.email}, ${cSecond.email}`, source_detail: 'из другого источника' },
        { ...owned, email: 'new@clinic-14.test' },
        { ...current, email: 'new@clinic-15.test' },
        unrelated, sameEmailOtherInn, ownRepeat, anonymous,
      ];
      const info: VeCollectInfo = { ...collectInfo(source === 'saved' ? inputs : []), collection_mode: 'preview',
        search_policy: { version: 1, phase: 'existing', deferred_rows: [] },
        target_progress: { ...createCollectionTarget('preview'), round: 3, candidates_processed: 20 },
        target_checkpoint: { completed_round: 2, seen_rows: [current, ownRepeat], processed_rows: 2 } };
      if (source === 'saved') info.tasks![0].exhausted = true;
      if (source === 'directory') info.tasks![0].status = 'pending';
      if (source === 'catalog') {
        const task = { source: 'yandex_maps' as const, rationale: 'Профильные клиники',
          maps_query: { queries: ['Стоматология'], geo: 'Россия' } };
        info.plan = { tasks: [task] };
        info.tasks = [{ source: 'yandex_maps', status: 'pending', child_job_id: null, rows: 0, task,
          catalog: { version: 1, filters: { categories: ['Стоматология'], countries: ['Россия'] }, after: 'prior-cursor' } }];
      }
      const prior = (id: string, rows: VeUnifiedRow[]) => ({ ...makeBase({
        target_checkpoint: { completed_round: 1, seen_rows: rows, processed_rows: rows.length },
      }), id, status: 'analyzed', columns: [...VE_AUTO_COLLECT_COLUMNS] });
      const nextDb = seed(info, { ve_bases: [makeBase(info), prior('prior-a', [a, b, c, anonymous]),
        prior('prior-b', [cSecond]), { ...prior('other-hypothesis', [unrelated]), hypothesis_id: 'h2',
          data: [{ ...owned, _email_status: 'ok' }] }] });
      const priorSnapshot = JSON.stringify(nextDb.getRows('ve_bases').slice(1));
      jest.mocked(searchRows).mockReset();
      jest.mocked(searchRows).mockResolvedValue({ rows: [] });
      if (source === 'directory') jest.mocked(searchRows).mockResolvedValueOnce({ rows: inputs.map((row) => ({
        name: row.company, inn: row.inn, website: row.website, email: row.email,
      })) });
      if (source === 'catalog') {
        const originalRpc = nextDb.rpc;
        nextDb.rpc = ((name: string, params: Record<string, unknown>) => {
          if (name !== 'yandex_maps_catalog_search') return originalRpc(name, params);
          nextDb.rpcCalls.push({ fn: name, params });
          const operation = Promise.resolve({ data: params.p_after === 'prior-cursor' ? inputs.map((row, i) => ({
            yandex_id: String(i + 1), name: row.company, website: row.website, email: row.email,
          })) : [], error: null });
          return Object.assign(operation, { abortSignal: () => operation });
        }) as typeof nextDb.rpc;
      }
      jest.mocked(callLLMWithSchema).mockClear();
      jest.mocked(fetchVeRelevanceEvidence).mockClear();
      await runBaseCollectStage(makeJob(), { supabase: nextDb as unknown as SupabaseClient });
      expect(constructorCompanies(nextDb).sort()).toEqual([
        a.company, ...(source === 'catalog' ? [] : [b.company]), current.company, unrelated.company, sameEmailOtherInn.company,
      ].sort());
      const paid = nextDb.getRows('base_constructor_jobs');
      expect(paid).toHaveLength(1);
      const grid = paid[0].data as string[][];
      const emailIndex = grid[0].indexOf('Email');
      expect(grid.find((row) => row[0] === a.company)![emailIndex]).toBe('new@clinic-11.test');
      if (source !== 'catalog') expect(grid.find((row) => row[0] === b.company)![emailIndex]).toBe('');
      expect(JSON.stringify(nextDb.getRows('ve_bases').slice(1))).toBe(priorSnapshot);
      const saved = nextDb.getRows('ve_bases')[0].collect_info as VeCollectInfo;
      expect(saved.target_progress).toMatchObject({ candidates_processed: 20, max_candidates: 10_000, max_rounds: 100 });
      expect(saved.target_checkpoint).toEqual(info.target_checkpoint);
      if (source === 'catalog') expect(nextDb.rpcCalls.find((call) => call.fn === 'yandex_maps_catalog_search')!.params.p_after).toBe('prior-cursor');
      const paidSnapshot = JSON.stringify(paid);
      await runBaseCollectStage(makeJob(), { supabase: nextDb as unknown as SupabaseClient });
      expect(JSON.stringify(nextDb.getRows('base_constructor_jobs'))).toBe(paidSnapshot);
      expect(callLLMWithSchema).not.toHaveBeenCalled();
      expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
      expect(nextDb.getRows('parser_jobs')).toHaveLength(0);
      expect(nextDb.getRows('yandex_maps_jobs')).toHaveLength(0);
    }
  });

  it('холостой раунд не тратит бюджет раундов, а несколько холостых подряд честно останавливают сбор', () => {
    const atLimit = { ...createCollectionTarget('preview'), round: 100, max_rounds: 100, candidates_processed: 1414, ready_rows: 83 };
    const round = { readyRows: 83, exhausted: false, canContinue: true, error: null };
    // Раунд с новыми компаниями на пределе по-прежнему последний.
    expect(finishCollectionRound(atLimit, { ...round, candidates: 3 }))
      .toMatchObject({ status: 'limited', reason: expect.stringContaining('защитный предел') });
    // Холостой раунд (ничего нового или пусто) бюджет не расходует.
    const idle = finishCollectionRound(atLimit, { ...round, candidates: 0, validationRetry: true, idle: true } as Parameters<typeof finishCollectionRound>[1]);
    expect(idle).toMatchObject({ status: 'collecting', round: 101, max_rounds: 101 });
    // Защита от бесконечного круга: холостые раунды подряд ограничены.
    let progress = idle;
    let idleRounds = 1;
    while (progress.status === 'collecting' && idleRounds < 50) {
      progress = finishCollectionRound(progress, { ...round, candidates: 0, validationRetry: true, idle: true } as Parameters<typeof finishCollectionRound>[1]);
      idleRounds += 1;
    }
    expect(idleRounds).toBeLessThanOrEqual(10);
    expect(progress).toMatchObject({ status: 'limited', reason: expect.stringContaining('подряд') });
    expect(progress.reason).toContain('не принесли ни одной новой компании');
    // Раунд с новыми компаниями сбрасывает счёт холостых.
    const fresh = finishCollectionRound({ ...idle, round: 50, max_rounds: 100 }, { ...round, candidates: 40 });
    expect(fresh).toMatchObject({ status: 'collecting', round: 51, max_rounds: 100 });
    expect(finishCollectionRound(fresh, { ...round, candidates: 0, validationRetry: true, idle: true } as Parameters<typeof finishCollectionRound>[1]))
      .toMatchObject({ status: 'collecting', round: 52, max_rounds: 101 });
  });

  it('analyzed-база на пределе раундов с живым реестром после «Продолжить подготовку» получает новый бюджет и открывает раунд', async () => {
    const processed = [
      unifiedRow({ company: 'Завод Прогресс', inn: '7700000411', website: 'progress.test', email: 'info@progress.test', source_detail: 'реестр' }),
      unifiedRow({ company: 'Литейный завод Урал', inn: '7700000412', website: 'lit-ural.test', email: 'sales@lit-ural.test', source_detail: 'реестр' }),
    ];
    const ready = processed.map((row) => ({ ...row, _email_status: 'ok',
      _ve_company_name: { version: 1, source: row.company, website: row.website, status: 'ready', value: row.company } }));
    const info: VeCollectInfo = { ...collectInfo(processed), collection_mode: 'preview', ready_target: 500,
      adaptive_collection: newVeAdaptiveCollection(), search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      // Состояние b5934955 после круга: 100 из 100 раундов, реестр не исчерпан.
      target_progress: { ...createCollectionTarget('preview'), status: 'limited', round: 100, max_rounds: 100,
        candidates_processed: 1414, ready_rows: ready.length, reason: 'Достигнут защитный предел кандидатов или раундов; цель ещё не набрана' },
      target_checkpoint: { completed_round: 100, seen_rows: processed, processed_rows: processed.length } };
    const db = seed(info, { ve_bases: [{ ...makeBase(info), status: 'analyzed', data: ready, row_count: ready.length,
      columns: [...VE_AUTO_COLLECT_COLUMNS] }] });
    await db.from('ve_jobs').update({ status: 'done' }).eq('id', makeJob().id);
    expect(canResumePartialPreview(db.getRows('ve_bases')[0])).toBe(true);
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000, resumeBaseId: 'b1' }))
      .resolves.toMatchObject({ ok: true, created: true });
    expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).target_progress?.max_rounds).toBeGreaterThanOrEqual(200);
    const wake = async () => {
      const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect' && row.status === 'pending').at(-1)!;
      // Like claimVeJob, persist and pass the same invocation timestamp.
      // A fabricated old started_at correctly loses the queue-write fence.
      const startedAt = new Date().toISOString();
      await db.from('ve_jobs').update({ status: 'running', started_at: startedAt }).eq('id', queued.id);
      await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'], started_at: startedAt },
        { supabase: db as unknown as SupabaseClient });
      return db.getRows('ve_bases')[0];
    };
    let base = await wake();
    expect(base.status).toBe('collecting');
    expect((base.collect_info as VeCollectInfo).target_progress).toMatchObject({ status: 'collecting', round: 101 });
    // Следующий раунд читает реестр дальше и отдаёт новую компанию в конструктор.
    jest.mocked(searchRows).mockResolvedValue({ rows: [
      { name: 'Завод Новый', inn: '7700000413', email: 'info@novy.test', website: 'novy.test', employees_count: 120, revenue: 900_000_000 },
    ] });
    base = await wake();
    expect(base.status).toBe('collecting');
    expect(constructorCompanies(db)).toEqual(['Завод Новый']);
  });
});

/**
 * Мелкие дефекты, найденные аудитом 22.09.2026. Строки, коды ОКВЭД, запрос hh и
 * результат конструктора — настоящие, из разобранных баз прода.
 */
describe('base_collect: мелкие дефекты аудита 22.09', () => {
  const pendingWake = async (db: MockSupabaseClient, logs: string[] = []) => {
    const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect' && row.status !== 'done').at(-1)!;
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
    await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
      { supabase: db as unknown as SupabaseClient, log: (message: string) => logs.push(message) });
    return db.getRows('ve_bases')[0];
  };
  const constructorCompanies = (db: MockSupabaseClient) => db.getRows('base_constructor_jobs')
    .flatMap((job) => (job.data as string[][]).slice(1).map((row) => row[0]));

  describe('«уже есть в других базах» считает только другие базы', () => {
    // 6b475d8c «Кондитерские фабрики»: 1 100 «исключений» — почти все свои уже
    // просмотренные строки. Строки — из её seen_rows и из соседней базы 8026034e.
    const OWN = unifiedRow({ company: 'ООО "АПЕКС ПЛЮС"', inn: '6168060650', email: 'apex@apexplus.ru, tender@apexplus.ru',
      website: 'apexplus.ru', source_detail: 'реестр' });
    const OTHER = unifiedRow({ company: 'ООО "ЕВРОХЛЕБ"', inn: '7839321110', email: 'zakaz@evrohleb.ru',
      website: 'https://evrohleb.ru/', source_detail: 'реестр' });
    const FRESH = unifiedRow({ company: 'ООО "СКИДКИНО"', inn: '5837078851', email: 'anastasia.ismatova@mail.ru',
      website: 'karavan58.ru', source_detail: 'реестр' });
    const neighbour = { ...makeBase({}), id: '8026034e', hypothesis_id: 'h2', status: 'collecting',
      columns: [...VE_AUTO_COLLECT_COLUMNS], data: [{ ...OTHER, _email_status: 'ok' }] };
    const target = { collection_mode: 'preview' as const,
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 100, ready_rows: 3 },
      target_checkpoint: { completed_round: 1, seen_rows: [OWN], processed_rows: 1 } };

    it('при разборе запаса: свои просмотренные строки — отдельный счётчик', async () => {
      const info: VeCollectInfo = { ...collectInfo([OWN, OTHER, FRESH]), ...target };
      info.tasks![0].exhausted = true;
      const db = seed(info, { ve_bases: [makeBase(info), neighbour] });
      const logs: string[] = [];
      await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient, log: (message) => logs.push(message) });
      expect(constructorCompanies(db)).toEqual([FRESH.company]);
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).stats)
        .toMatchObject({ excluded_existing_bases: 1, excluded_existing_bases_before_construct: 1, excluded_already_seen: 1 });
      expect(logs).toContain('[base_collect] исключено 1 строк — компании уже есть в других базах проекта');
      expect(logs).toContain('[base_collect] пропущено 1 строк — эта база их уже просматривала');
    });

    it('на выборке реестра: то же разделение', async () => {
      const info: VeCollectInfo = { ...collectInfo([]), ...target, search_policy: { version: 1, phase: 'paid', deferred_rows: [] } };
      Object.assign(info.tasks![0], { status: 'pending', rows: 0 });
      const db = seed(info, { ve_bases: [makeBase(info), neighbour] });
      const directoryRow = (row: VeUnifiedRow) => ({ name: row.company, inn: row.inn, email: row.email, website: row.website,
        okved_code: '10.82', okved_name: 'Производство какао, шоколада и сахаристых кондитерских изделий' });
      jest.mocked(searchRows).mockResolvedValueOnce({ rows: [OWN, OTHER, FRESH].map(directoryRow) } as never)
        .mockResolvedValue({ rows: [] } as never);
      const logs: string[] = [];
      await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient, log: (message) => logs.push(message) });
      const task = (db.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0];
      expect(task.harvest!.map((row) => row.company)).toEqual([FRESH.company]);
      expect(task).toMatchObject({ excluded_during_fetch: 1, already_seen_during_fetch: 1 });
      expect(logs).toContain('[base_collect] реестр: 1 строк пропущено на выборке — компании уже есть в других базах проекта');
      expect(logs).toContain('[base_collect] реестр: 1 строк пропущено на выборке — эта база их уже просматривала');
    });
  });

  it('сохранённые строки реестра с голым кодом ОКВЭД получают название, строки резерва с вердиктом — нет', async () => {
    // 1a69cda6 «Энергетические компании»: 200 строк запаса реестра с одним «35.1».
    const ROSENERGOATOM = unifiedRow({ company: 'АО "КОНЦЕРН РОСЭНЕРГОАТОМ"', inn: '7721632827', email: 'info@rosenergoatom.ru',
      website: 'rosenergoatom.ru', address: '109507, г. Москва, ул. Ферганская, Д.25', category: '35.1', source_detail: 'реестр' });
    const MOSENERGOSBYT = unifiedRow({ company: 'АО "МОСЭНЕРГОСБЫТ"', inn: '7736520080', email: 'info@mosenergosbyt.ru',
      website: 'mosenergosbyt.ru', category: '35.1', source_detail: 'реестр' });
    // Уже проверенная строка резерва: её category входит в ключ оплаченного вердикта.
    const checked = { ...unifiedRow({ company: 'ПАО "РОССЕТИ"', inn: '4716016979', email: 'info@rosseti.ru', category: '35.1' }),
      _email_status: 'ok', _ve_relevance: { version: 2, status: 'needs_review', reason: 'Нет сведений о деятельности', evidence: [],
        context_hash: 'c'.repeat(64), review_attempts: 1 } };
    const info: VeCollectInfo = { ...collectInfo([ROSENERGOATOM, MOSENERGOSBYT]), collection_mode: 'preview',
      relevance_reserve: { version: 1, rows: [checked] },
      target_progress: { ...createCollectionTarget('preview'), round: 2, candidates_processed: 100 },
      target_checkpoint: { completed_round: 1, seen_rows: [], processed_rows: 0 } };
    info.tasks![0].exhausted = true;
    const db = seed(info, { okved_reference: [
      { code: '35.1', name: 'Производство, передача и распределение электроэнергии', parent_code: '35', section: 'D', level: 2 },
      { code: '35.11', name: 'Производство электроэнергии', parent_code: '35.1', section: 'D', level: 3 }] });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const saved = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
    expect(saved.tasks![0].harvest!.map((row) => row.category))
      .toEqual(Array(2).fill('Производство, передача и распределение электроэнергии\n35.1'));
    // Классификатору уходит название, а не код.
    const grid = db.getRows('base_constructor_jobs')[0].data as string[][];
    const categoryIndex = grid[0].indexOf('Категория');
    expect(grid.slice(1).map((row) => row[categoryIndex]))
      .toEqual(Array(2).fill('Производство, передача и распределение электроэнергии\n35.1'));
    expect(readVeRelevanceReserveRows(saved)[0]).toMatchObject({ category: '35.1', _ve_relevance: { status: 'needs_review' } });
  });

  it('«Продолжить подготовку» снимает запись конструктора, пережившую раунд, и переносит его результат в проверку', async () => {
    // 3cfcfbbd «Малые агентства недвижимости»: задача d0abb3ea завершилась
    // 16.09, раунд закрылся без её результата, запись dispatched висела неделю.
    const BC_JOB = 'd0abb3ea-9c68-47b1-a921-a81d58990db6';
    const PSG = unifiedRow({ company: 'ООО "ПСГ"', inn: '8614000871', email: 'pypova@mail.ru, priobstroygarant@yandex.ru',
      address: '628109, Ханты-Мансийский АО., Октябрьский р-н, с. Перегребное, ул. Строителей, д. 51', category: '68.32',
      employees: '17', revenue: '52636000', source_detail: 'реестр' });
    const output = (email: string, status: string) => ['ООО "ПСГ"', '', email, '+7 (34678) 3-82-90', '', PSG.address, '68.32', '17',
      '52636000', '8614000871', 'реестр', '', status, 'free'];
    const info: VeCollectInfo = { ...collectInfo([PSG], { bc_job_id: BC_JOB, status: 'dispatched', dispatched_at: '2026-09-16T13:55:22.519Z' }),
      collection_mode: 'preview', ready_target: 500, limit: 5_000,
      search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      target_progress: { ...createCollectionTarget('preview'), round: 2, status: 'limited', max_rounds: 100,
        candidates_processed: 70, ready_rows: 0, reason: 'Нет подтверждённого продолжения источников; исчерпание рынка не доказано' },
      target_checkpoint: { completed_round: 2, seen_rows: [PSG], processed_rows: 84 } };
    info.tasks![0].exhausted = true;
    const db = seed(info, {
      ve_bases: [{ ...makeBase(info), status: 'analyzed', columns: [...VE_AUTO_COLLECT_COLUMNS] }],
      base_constructor_jobs: [{ id: BC_JOB, status: 'completed', error_message: null,
        selected_steps: ['find_emails', 'enrich_descriptions', 'split_emails', 'dedup_email', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник',
          'Описание', 'Email Статус', 'Email Провайдер'],
        output('pypova@mail.ru', 'catch_all'), output('priobstroygarant@yandex.ru', 'ok'), output('priobstroygarant@yande.ru', 'catch_all')] }],
    });
    await db.from('ve_jobs').update({ status: 'done' }).eq('id', makeJob().id);
    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, { projectId: 'p1', verticalId: 'v1',
      verticalName: VERTICAL.name, hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000, resumeBaseId: 'b1' }))
      .resolves.toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
    const logs: string[] = [];
    const base = await pendingWake(db, logs);
    const saved = base.collect_info as VeCollectInfo;
    expect(saved.construct).toBeUndefined();
    expect(logs).toContain(`[base_collect] конструктор ${BC_JOB} (completed) остался от закрытого раунда: 3 строк перенесено в резерв на проверку, запись снята`);
    // Результат конструктора прошёл обычную проверку резерва, а не пропал.
    const reviewed = mockFindIrrelevantRows.mock.calls.flatMap(([input]) => (input as { rows: Array<{ email: string }> }).rows.map((row) => row.email));
    expect(reviewed).toEqual(expect.arrayContaining(['priobstroygarant@yandex.ru', 'pypova@mail.ru']));
    expect((base.data as Array<{ email: string; _email_status: string }>).map((row) => [row.email, row._email_status]))
      .toContainEqual(['priobstroygarant@yandex.ru', 'ok']);
    // Новый обход того же входа не покупается.
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
  });

  describe('hh_live: длинный запрос без вакансий — не исчерпание', () => {
    // b5934955: семь обязательных слов — 0 вакансий, задача закрылась пустой.
    const HH_TASK = { source: 'hh_live' as const, rationale: 'Работодатели, нанимающие инженеров и технологов на производство',
      hh_query: { text: 'инженер технолог производство завод рабочий качество HSE', date_from: '2026-08-16', date_to: '2026-09-15' } };

    it('повторяет задачу один раз по короткому запросу', async () => {
      const info: VeCollectInfo = { plan: { tasks: [HH_TASK] }, tasks: [{ source: 'hh_live', status: 'dispatched',
        child_job_id: '6d5a83ab-241e-4545-aa02-2db7cd4babf8', rows: 0, task: HH_TASK, dispatched_at: new Date().toISOString() }] };
      const db = seed(info, { parser_jobs: [{ id: '6d5a83ab-241e-4545-aa02-2db7cd4babf8', status: 'completed', started_at: null }],
        hh_vacancies: [] });
      let base = await pendingWake(db);
      expect(base.status).toBe('collecting');
      expect((base.collect_info as VeCollectInfo).tasks![0]).toMatchObject({ status: 'pending', child_job_id: null,
        hh_short_query: 'инженер технолог производство' });
      base = await pendingWake(db);
      const retry = db.getRows('parser_jobs').find((row) => row.id !== '6d5a83ab-241e-4545-aa02-2db7cd4babf8')!;
      expect(retry.config).toMatchObject({ text: 'инженер технолог производство', date_from: '2026-08-16', date_to: '2026-09-15' });
      expect((base.collect_info as VeCollectInfo).tasks![0]).toMatchObject({ status: 'dispatched', child_job_id: retry.id,
        task: HH_TASK });
      // Вторая пустая выдача — честный конец задачи, без третьего запроса.
      await db.from('parser_jobs').update({ status: 'completed' }).eq('id', retry.id);
      await pendingWake(db).catch(() => undefined);
      expect(db.getRows('parser_jobs')).toHaveLength(2);
      expect((db.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0]).toMatchObject({ status: 'done', rows: 0 });

      // A completed HH child already owns the employer evidence. Read it
      // with the vacancy and pass it into the existing constructor grid.
      const evidenceInfo: VeCollectInfo = { plan: { tasks: [HH_TASK] }, tasks: [{ source: 'hh_live', status: 'dispatched',
        child_job_id: 'hh-evidence', rows: 0, task: HH_TASK, dispatched_at: new Date().toISOString() }] };
      const evidenceDb = seed(evidenceInfo, { parser_jobs: [{ id: 'hh-evidence', status: 'completed', started_at: null }],
        hh_vacancies: [{ job_id: 'hh-evidence', name: 'Художник', company_name: 'Студия игр',
          company_site_url: 'https://games.test', area: 'Москва', industries: ['Разработка компьютерных игр'],
          company_description: '<p>Разрабатываем и издаём компьютерные игры.</p>' }] });
      const evidenceBase = await pendingWake(evidenceDb);
      expect(evidenceDb.selects.filter((query) => query.table === 'hh_vacancies')).toEqual([
        { table: 'hh_vacancies', columns: 'name, company_name, company_site_url, area, company_description, industries' },
      ]);
      expect((evidenceBase.collect_info as VeCollectInfo).tasks![0].harvest![0]).toMatchObject({
        category: 'Разработка компьютерных игр', description: 'Разрабатываем и издаём компьютерные игры.',
      });
      const evidenceConstructor = evidenceDb.getRows('base_constructor_jobs')[0];
      const grid = evidenceConstructor.data as string[][];
      expect(grid[1][grid[0].indexOf('Категория')]).toBe('Разработка компьютерных игр');
      expect(grid[1][grid[0].indexOf('Описание')]).toBe('Разрабатываем и издаём компьютерные игры.');
      expect(evidenceConstructor.selected_steps).toEqual(expect.arrayContaining(['find_emails', 'validate_emails']));
      expect(evidenceBase.data).toEqual([]);
      await pendingWake(evidenceDb);
      expect(evidenceDb.getRows('parser_jobs')).toHaveLength(1);
      expect(evidenceDb.getRows('base_constructor_jobs')).toHaveLength(1);
      expect(evidenceDb.selects.filter((query) => query.table === 'hh_vacancies')).toHaveLength(1);
    });

    it('не трогает короткие запросы и запросы на языке поиска hh', () => {
      expect(veShortHhQuery(HH_TASK.hh_query.text)).toBe('инженер технолог производство');
      expect(veShortHhQuery('инженер-технолог')).toBeNull();
      expect(veShortHhQuery('технолог пищевого производства')).toBeNull();
      expect(veShortHhQuery('инженер-технолог OR технолог производства OR инженер по качеству')).toBeNull();
      expect(veShortHhQuery('NAME:(технолог) AND завод')).toBeNull();
    });
  });
});

/**
 * Сухие источники (решение владельца 23.09.2026). Истории партий, гипотезы и
 * задачи плана — с прода, проект Когнитус: 99a8fadd «Инклюзивные частные
 * школы», 1806863e «Центры диагностики РАС», caf2581d «Фонды помощи аутизму».
 * Срезы одного источника сведены в одну задачу, как в разборе: школы — карты
 * 3 376 компаний → 4 контакта, РАС — реестр 4 275 → 2.
 */
describe('base_collect: сухие источники завершают базу сами', () => {
  const HYPOTHESES = {
    schools: { title: 'Инклюзивные частные школы', description: 'Частные школы и сады с инклюзией, где психологическая служба оценивает детей для адаптации обучения.' },
    ras: { title: 'Центры диагностики РАС', description: 'Частные психологические и нейропсихологические центры, которые принимают детей с подозрением на аутизм и хотят стандартизировать заключения.' },
    funds: { title: 'Фонды помощи аутизму', description: 'НКО и фонды, которые финансируют диагностику, обучают специалистов или развивают сеть помощи людям с РАС.' },
  };
  type Task = NonNullable<VeCollectInfo['plan']>['tasks'][number];
  type TaskState = NonNullable<VeCollectInfo['tasks']>[number];
  const PLAN = {
    schools: {
      r: { source: 'companies_directory', rationale: 'Частные школы и детские сады с инклюзивными программами (ОКВЭД 85.1, 85.11).',
        directory_filters: { includeIp: false, okvedCodes: ['85.1', '85.11'] } },
      h: { source: 'hh_live', rationale: 'Частные школы, нанимающие психологов и дефектологов.',
        hh_query: { area: '113', text: 'педагог-психолог OR дефектолог OR инклюзивное образование' } },
      m: { source: 'yandex_maps', rationale: 'Локальные частные инклюзивные школы и детские сады по рубрикам каталога.',
        maps_query: { geo: 'Россия', queries: ['инклюзивная школа', 'инклюзивный детский сад', 'частная школа с инклюзией'] } },
    },
    ras: {
      r: { source: 'companies_directory', rationale: 'Частные центры дополнительного образования детей по ОКВЭД 85.41 и 88.91.',
        directory_filters: { okvedCodes: ['85.41', '88.91'] } },
      h: { source: 'hh_live', rationale: 'Вакансии детских психологов, нейропсихологов и логопедов.',
        hh_query: { text: 'детский психолог OR нейропсихолог OR логопед OR дефектолог AND коррекционный OR развитие OR диагностика' } },
      g: { source: 'google_maps', rationale: 'Специализированные центры в Google Maps.',
        maps_query: { geo: 'Россия', queries: ['детский коррекционный центр', 'центр диагностики аутизма', 'нейропсихологический центр'] } },
      m: { source: 'yandex_maps', rationale: 'Локальные центры коррекции и диагностики.',
        maps_query: { geo: 'Россия', queries: ['детский коррекционный центр', 'нейропсихологический центр для детей', 'центр ранней помощи детям', 'ABA-центр', 'логопедический центр детский'] } },
    },
    funds: {
      r: { source: 'companies_directory', rationale: 'НКО и фонды по ОКВЭД общественных организаций.',
        directory_filters: { okvedCodes: ['94', '94.9'] } },
      h: { source: 'hh_live', rationale: 'Вакансии фондов и НКО в сфере помощи людям с аутизмом.',
        hh_query: { text: '(аутизм OR РАС) AND (фонд OR НКО OR некоммерческая)' } },
      m: { source: 'yandex_maps', rationale: 'Организации, связанные с аутизмом, из готового каталога Яндекса.',
        maps_query: { geo: 'Россия', queries: ['аутизм центр', 'фонд помощи аутизму', 'РАС помощь'] } },
    },
  } as unknown as Record<'schools' | 'ras' | 'funds', Record<string, Task>>;
  const spend = { ai_usd: 0, serper_credits: 0, estimated_total_usd: 0, unknown_attempts: 0, complete: true };
  /** Партии с прода; срез r1/r2/m2 → задача своего источника. */
  const history = (base: 'schools' | 'ras' | 'funds') => (cognitus[base] as string).split(', ').map((item, index) => {
    const [slice, candidates, ready] = item.split(' ');
    const task = PLAN[base][slice[0]];
    return { id: `${base}-${index + 1}`, source_key: veSourceStrategyKey(task), source: task.source,
      candidates: Number(candidates), new_ready: Number(ready), poor: false, spend,
      started_at: '2026-09-22T05:00:00Z', finished_at: '2026-09-22T05:10:00Z' };
  });
  const orgs = (prefix: string, slug: string, count: number, from = 0) => Array.from({ length: count }, (_, index) => unifiedRow({
    company: `${prefix} ${from + index}`, website: `${slug}${from + index}.test`, email: `info@${slug}${from + index}.test`,
    source_detail: prefix }));
  const readyOf = (rows: VeUnifiedRow[]) => rows.map((row) => ({ ...row, _email_status: 'ok',
    _ve_company_name: { version: 1, source: row.company, website: row.website, status: 'ready', value: row.company } }));
  const state = (task: Task, extra: Partial<TaskState> = {}): TaskState => ({ source: task.source, status: 'done',
    child_job_id: null, rows: extra.harvest?.length ?? 0, task, harvest: [], ...extra });
  const CATALOG = { version: 1 as const, filters: { countries: ['Россия'], categories: ['Детские коррекционные центры'] } };

  /** Пробуждение, в котором дочерний конструктор уже проверил партию: ни одной новой компании по гипотезе. */
  const finishBatch = async (args: { hypothesis: { title: string; description: string }; tasks: TaskState[];
    completed: ReturnType<typeof history>; batch: VeUnifiedRow[]; batchTask: Task; ready: VeUnifiedRow[];
    seen: VeUnifiedRow[]; replanAttempts?: number; widenings?: number; phase?: 'existing' | 'paid'; reserve?: Array<Record<string, unknown>> }) => {
    const readyRows = readyOf(args.ready);
    const batchKey = veSourceStrategyKey(args.batchTask);
    const processed = args.completed.reduce((sum, batch) => sum + batch.candidates, 0);
    const info: VeCollectInfo = {
      plan: { tasks: args.tasks.map((task) => task.task) }, tasks: args.tasks,
      collection_mode: 'preview', ready_target: 500,
      ...(args.reserve ? { relevance_reserve: { version: 1 as const, rows: args.reserve } } : {}),
      construct: { bc_job_id: 'bc-dry', status: 'dispatched', dispatched_at: '2026-09-23T09:00:00Z' },
      search_policy: { version: 1, phase: args.phase ?? 'paid', deferred_rows: [], construct_rows: args.batch },
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: args.replanAttempts ?? 2,
        ...(args.widenings ? { widenings: args.widenings } : {}), active_source: batchKey, completed: args.completed,
        pending: { id: 'dry-pending', source_key: batchKey, source: args.batchTask.source, candidates: args.batch.length,
          ready_before: veReadyContactKeys(readyRows), started_at: '2026-09-23T09:00:00Z' } },
      target_progress: { ...createCollectionTarget('preview'), round: 5, candidates_processed: processed, ready_rows: readyRows.length },
      target_checkpoint: { completed_round: 4, seen_rows: args.seen, processed_rows: args.seen.length },
    };
    const db = seed(info, {
      ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', ...args.hypothesis }],
      ve_bases: [{ ...makeBase(info), data: readyRows, row_count: readyRows.length, columns: [...VE_AUTO_COLLECT_COLUMNS] }],
      base_constructor_jobs: [{ id: 'bc-dry', status: 'completed', selected_steps: ['split_emails', 'validate_emails'],
        data: [['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
          ...args.batch.map((row) => [row.company, row.website, row.email, row.inn, 'ok'])] }],
    });
    // Все компании партии проверены и не подошли гипотезе.
    mockFindIrrelevantRows.mockResolvedValueOnce({ flagged: new Set(args.batch.map((_, index) => index)), unchecked: new Set(),
      coverage: { checkedCompanies: args.batch.length, totalCompanies: args.batch.length, complete: true }, tokensUsed: 0, costUsd: 0 });
    await wakeQueued(db);
    return db;
  };
  const wakeQueued = async (db: MockSupabaseClient) => {
    const queued = db.getRows('ve_jobs').filter((row) => row.stage === 'base_collect').at(-1)!;
    await db.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
    await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
      { supabase: db as unknown as SupabaseClient });
    return db.getRows('ve_bases')[0];
  };
  const infoOf = (db: MockSupabaseClient) => db.getRows('ve_bases')[0].collect_info as VeCollectInfo;

  // Школы: карты 3 376 компаний → 4 контакта, реестр исчерпан, вакансии разобраны.
  const schools = () => {
    const completed = history('schools');
    const last = completed.pop()!;
    const batch = orgs('Частная школа', 'school', last.candidates);
    const ready = orgs('Инклюзивная школа', 'inclusive', 6, 100);
    return { completed, batch, ready, hypothesis: HYPOTHESES.schools, batchTask: PLAN.schools.m, seen: [...ready],
      tasks: [state(PLAN.schools.r, { exhausted: true, note: 'реестр исчерпан' }), state(PLAN.schools.h),
        state(PLAN.schools.m, { catalog: CATALOG, harvest: batch })] };
  };

  it('школы: все живые источники сухие, расширять нечем — база завершается с понятной причиной', async () => {
    const db = await finishBatch(schools());
    const base = db.getRows('ve_bases')[0];
    const info = infoOf(db);
    expect(info.adaptive_collection?.completed.at(-1)).toMatchObject({ candidates: 58, new_ready: 0, new_target: 0 });
    expect(base.status).toBe('analyzing');
    expect(info.target_progress).toMatchObject({ status: 'limited', ready_rows: 6, round: 5 });
    expect(info.target_progress?.reason).toBe('Источники перестали давать контакты: последние 1530 компаний из Яндекс Карт '
      + 'дали 4 контакта. Расширить срез автоматически нечем. Сбор завершён, чтобы не тратить проверки впустую; '
      + 'собрано 6 из 500, контакты сохранены.');
    expect(info.adaptive_collection).toMatchObject({ replan_needed: false, note: 'Источники перестали давать контакты: сбор остановлен.' });
    // Ни нового дочернего конструктора, ни подбора среза.
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(callLLMWithSchema).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), { model: 'test-collection-model' });
    // Тот же сухой источник не становится полезным после очередного нажатия.
    expect(canResumePartialPreview({ ...base, status: 'analyzed' })).toBe(false);
  });

  it('школы: пока подбор нового среза не израсходован, сухие источники сначала расширяют срез', async () => {
    const db = await finishBatch({ ...schools(), replanAttempts: 1 });
    const info = infoOf(db);
    expect(info.target_progress).toMatchObject({ status: 'collecting', round: 6 });
    expect(info.target_progress).not.toHaveProperty('reason');
    expect(info.adaptive_collection).toMatchObject({ widenings: 1, replan_needed: true, replan_reason: 'plan_exhausted',
      note: 'Источники перестали давать контакты: подбираем новый срез того же рынка.' });
  });

  it('школы после выкладки: история уже сухая — новую партию не покупаем, база завершается той же причиной', async () => {
    // Состояние на проде 23.09: вся история партий есть, партии в полёте нет,
    // в выдаче карт остались непросмотренные компании.
    const { completed, ready, tasks } = schools();
    const tail = orgs('Частная школа', 'school', 30, 500);
    tasks[2].harvest = tail;
    const readyRows = readyOf(ready);
    const info: VeCollectInfo = { plan: { tasks: tasks.map((task) => task.task) }, tasks,
      collection_mode: 'preview', ready_target: 500, search_policy: { version: 1, phase: 'paid', deferred_rows: [] },
      adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, active_source: veSourceStrategyKey(PLAN.schools.m),
        completed },
      target_progress: { ...createCollectionTarget('preview'), round: 5, candidates_processed: 3_852, ready_rows: 6 },
      target_checkpoint: { completed_round: 4, seen_rows: ready, processed_rows: ready.length } };
    const db = seed(info, {
      ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', ...HYPOTHESES.schools }],
      ve_bases: [{ ...makeBase(info), data: readyRows, row_count: 6, columns: [...VE_AUTO_COLLECT_COLUMNS] }],
    });
    await wakeQueued(db);
    const after = infoOf(db);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(after.adaptive_collection).not.toHaveProperty('pending');
    expect(after.target_progress).toMatchObject({ status: 'limited', ready_rows: 6 });
    expect(after.target_progress?.reason).toContain('Источники перестали давать контакты: последние 1530 компаний из Яндекс Карт дали 4 контакта.');
    // Непросмотренные компании не потеряны: выдача карт цела.
    expect(after.tasks![2].harvest).toHaveLength(30);

    // Confirmed Web3-shaped repetition: held raw buffers, renewable/pending
    // task and untagged old deferred rows cannot buy a new parser/lookup or
    // turn existing stock into permission for paid relevance search.
    const weakTask = PLAN.funds.r;
    const weakKey = veSourceStrategyKey(weakTask);
    const weakHistory = Array.from({ length: 5 }, (_, index) => ({
      id: `weak-${index}`, source: weakTask.source, source_key: weakKey, candidates: 100,
      new_ready: index === 4 ? 2 : 0, new_target: index === 4 ? 2 : 0, poor: true, spend,
      started_at: '2026-10-10T00:00:00Z', finished_at: '2026-10-10T00:10:00Z',
    }));
    for (const phase of ['existing', 'paid'] as const) for (const status of ['pending', 'done'] as const) {
      const stock = orgs('Непроверенная компания', 'weakstock', 5, 500);
      const noSite = unifiedRow({ company: 'Сохранённая компания без сайта' });
      const heldInfo: VeCollectInfo = {
        plan: { tasks: [weakTask] }, tasks: [state(weakTask, { status, harvest: [...stock, noSite], existing_contacts_only: true })],
        collection_mode: 'preview', ready_target: 500,
        search_policy: { version: 1, phase, deferred_rows: [noSite] },
        adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, active_source: weakKey, completed: weakHistory },
        target_progress: { ...createCollectionTarget('preview'), round: 6, candidates_processed: 500, ready_rows: 6 },
        target_checkpoint: { completed_round: 5, seen_rows: ready, processed_rows: ready.length },
      };
      const heldDb = seed(heldInfo, {
        ve_hypotheses: [{ id: 'h1', project_id: 'p1', vertical_id: 'v1', status: 'accepted', ...HYPOTHESES.funds }],
        ve_bases: [{ ...makeBase(heldInfo), data: readyRows, row_count: 6, columns: [...VE_AUTO_COLLECT_COLUMNS] }],
      });
      const modelCalls = jest.mocked(callLLMWithSchema).mock.calls.length;
      const relevanceCalls = mockFindIrrelevantRows.mock.calls.length;
      await wakeQueued(heldDb);
      const held = infoOf(heldDb);
      expect(held.target_progress).toMatchObject({ status: 'limited', stop_cause: 'low_yield', ready_rows: 6 });
      expect(held.search_policy?.phase).toBe(phase);
      expect(held.tasks![0]).toMatchObject({ status, existing_contacts_only: true });
      expect(held.tasks![0].harvest).toHaveLength(6);
      expect(held.search_policy!.deferred_rows.length).toBeGreaterThanOrEqual(1);
      expect(heldDb.getRows('base_constructor_jobs')).toHaveLength(0);
      expect(jest.mocked(callLLMWithSchema).mock.calls).toHaveLength(modelCalls);
      expect(mockFindIrrelevantRows.mock.calls).toHaveLength(relevanceCalls);
      expect(searchRows).not.toHaveBeenCalled();
      expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    }

    // The fifth closed batch establishes the hold at completion, not before:
    // import its already-paid constructor, keep reserve, and close a valid
    // checkpoint without opening another round or a paid phase.
    const ownedBatch = orgs('Сохранённая проверяемая компания', 'owned', 100);
    const ownedDb = await finishBatch({ completed: weakHistory.slice(0, 4), batch: ownedBatch,
      batchTask: weakTask, ready, seen: ready, hypothesis: HYPOTHESES.funds, phase: 'existing',
      tasks: [state(weakTask, { harvest: ownedBatch, exhausted: true, existing_contacts_only: true })],
      reserve: [{ ...unifiedRow({ company: 'Нужны доказательства', website: 'deferred.test', email: 'saved@deferred.test' }),
        _email_status: 'ok', _relevance_unchecked: true,
        _ve_relevance: { version: 2, status: 'needs_review', reason: 'search deferred', context_hash: 'a'.repeat(64),
          evidence: [], review_attempts: 0, search_deferred: true } }],
    });
    const owned = infoOf(ownedDb);
    expect(owned.adaptive_collection?.completed).toHaveLength(5);
    expect(owned.adaptive_collection?.pending).toBeUndefined();
    expect(owned.target_progress).toMatchObject({ status: 'limited', stop_cause: 'low_yield', ready_rows: 6, round: 5 });
    expect(owned.target_checkpoint?.completed_round).toBe(5);
    expect(owned.search_policy?.phase).toBe('existing');
    expect(readVeRelevanceReserveRows(owned).length).toBeGreaterThanOrEqual(101);
    expect(readVeRelevanceReserveRows(owned).find((row) => row.email === 'saved@deferred.test')).toMatchObject({
      _ve_relevance: { status: 'needs_review', search_deferred: true } });
    expect(ownedDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(ownedDb.getRows('ve_jobs').filter((row) => row.stage === 'base_collect' && row.status === 'pending')).toHaveLength(0);
    expect(searchRows).not.toHaveBeenCalled();
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();

  });

  // РАС: реестр 4 275 → 2 (сухой, ещё читается), карты 1 049 → 2 (мало, но не доказано).
  const ras = (extraMaps: number) => {
    const completed = history('ras');
    const last = completed.pop()!;
    const mapsKey = veSourceStrategyKey(PLAN.ras.m);
    // Карты и дальше дают ноль: те же партии по 60 компаний.
    for (let index = 0; index < extraMaps; index++) completed.push({ ...last, id: `ras-extra-${index}`, candidates: 60 });
    const batch = orgs('Коррекционный центр', 'correction', last.candidates);
    const ready = orgs('Центр диагностики', 'diagnostics', 5, 100);
    expect(last.source_key).toBe(mapsKey);
    return { completed, batch, ready, hypothesis: HYPOTHESES.ras, batchTask: PLAN.ras.m, seen: [...ready],
      tasks: [state(PLAN.ras.r), state(PLAN.ras.m, { catalog: CATALOG, harvest: batch }), state(PLAN.ras.h), state(PLAN.ras.g)] };
  };

  it('РАС: правило не срабатывает, пока у карт меньше 1 500 компаний, и завершает базу, когда карты тоже высохли', async () => {
    const early = infoOf(await finishBatch(ras(0)));
    expect(early.adaptive_collection?.completed.filter((batch) => batch.source_key === veSourceStrategyKey(PLAN.ras.m))
      .reduce((sum, batch) => sum + batch.candidates, 0)).toBe(1_049);
    expect(early.target_progress).toMatchObject({ status: 'collecting' });
    expect(early.target_progress).not.toHaveProperty('reason');

    const late = infoOf(await finishBatch(ras(8)));
    expect(late.target_progress).toMatchObject({ status: 'limited', ready_rows: 5 });
    expect(late.target_progress?.reason).toContain('Источники перестали давать контакты: последние 1576 компаний из реестра '
      + 'дали 1 контакт; последние 1529 компаний из Яндекс Карт дали 2 контакта.');
  });

  it('фонды: карты с выходом 2,6 % держат базу, а следующая партия идёт из карт, не из сухого реестра', async () => {
    // Партия 66: карты дали два бедных окна подряд и попросили смену источника.
    // Раньше выбор уходил на реестр (0 из 3 786) — так шли 30 партий реестра подряд.
    const completed = history('funds').slice(0, 66);
    const last = completed.pop()!;
    expect(last).toMatchObject({ source: 'yandex_maps', candidates: 50, new_ready: 0 });
    const batch = orgs('Фонд помощи', 'fund', last.candidates);
    const nextMaps = orgs('Благотворительный фонд', 'charity', 20, 100);
    const registry = orgs('НКО поддержки', 'nko', 20, 200);
    const ready = orgs('Фонд аутизм', 'autism', 53, 300);
    const db = await finishBatch({ completed, batch, ready, hypothesis: HYPOTHESES.funds, batchTask: PLAN.funds.m,
      seen: [...ready], replanAttempts: 2,
      tasks: [state(PLAN.funds.r, { harvest: registry }), state(PLAN.funds.h),
        state(PLAN.funds.m, { catalog: CATALOG, harvest: [...batch, ...nextMaps] })] });
    const afterBatch = infoOf(db);
    expect(afterBatch.target_progress).toMatchObject({ status: 'collecting', ready_rows: 53 });
    expect(afterBatch.adaptive_collection?.replan_needed).toBe(true);

    await wakeQueued(db);
    const next = infoOf(db);
    expect(next.adaptive_collection?.pending).toMatchObject({ source: 'yandex_maps', source_key: veSourceStrategyKey(PLAN.funds.m) });
    const child = db.getRows('base_constructor_jobs').find((row) => row.status === 'pending')!;
    expect((child.data as string[][]).slice(1).map((row) => row[0]).every((name) => name.startsWith('Благотворительный фонд'))).toBe(true);
  });
});

function readVeRelevanceReserveRows(info: VeCollectInfo): Array<Record<string, unknown>> {
  return (info.relevance_reserve as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? [];
}

describe('base_collect geography inheritance integration', () => {
  it('passes the approved geography-only contract through a new supply plan and completed constructor to relevance', async () => {
    const geography = { version: 1 as const, required: 'Москва и МО' };
    const info: VeCollectInfo = { collection_mode: 'supply', supply_batch_id: 'geo-batch', ready_target: 1 };
    const task = { ...DIRECTORY_TASK, directory_filters: { ...DIRECTORY_TASK.directory_filters, regionCodes: ['77', '50'] } };
    const db = seed(info, {
      ve_projects: [{ ...PROJECT, brief: { client_brief: { icp: { geo: 'Казань' } } } }],
      ve_bases: [makeBase(info), { id: 'approved-geo-preview', project_id: 'p1', hypothesis_id: 'h1',
        status: 'analyzed', source: 'auto', collection_geography: geography,
        collect_info: { collection_geography: geography }, data: [], columns: [], row_count: 0 }],
      ve_contact_supply_batches: [{ id: 'geo-batch', base_id: 'b1', plan_id: 'geo-plan' }],
      ve_contact_supply_plans: [{ id: 'geo-plan', project_id: 'p1', hypothesis_id: 'h1', item_id: 'geo-launch' }],
      ve_launch_queue_items: [{ id: 'geo-launch', project_id: 'p1', hypothesis_id: 'h1', base_id: 'approved-geo-preview' }],
    });
    const originalRpc = db.rpc;
    db.rpc = (name, params) => name === 've_require_contact_supply_active'
      ? Promise.resolve({ data: { id: 'geo-plan' }, error: null }) : originalRpc(name, params);
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce({ data: { tasks: [task] }, tokensUsed: 0, costUsd: 0,
      promptTokens: 0, completionTokens: 0, rawResponse: '' });
    jest.mocked(searchRows).mockResolvedValue({ rows: [{ name: 'Клиника Столица', website: 'capital.test',
      email: 'hello@capital.test', inn: '7701000001', address: 'Москва, ул. Примерная, 10', activity_type: 'Частные клиники' }] });

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const pinned = db.getRows('ve_bases').find((base) => base.id === 'b1')!.collect_info as VeCollectInfo;
    expect(pinned.collection_geography).toEqual(geography);
    expect(pinned.audience_snapshot).toBeUndefined();
    expect(searchRows).toHaveBeenCalledWith(expect.objectContaining({ regionCodes: ['77', '50'] }), expect.any(Number), 0);
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    const children = db.getRows('base_constructor_jobs');
    expect(children).toHaveLength(1);
    const child = children[0], grid = child.data as string[][];
    // The constructor can contain a merged registry+HH observation; only the
    // original registry address establishes the company's own location.
    const mixed = grid.slice(1).map((row) => row.map((value, index) => grid[0][index] === 'Адрес'
      ? `${value}\nКазань` : grid[0][index] === 'Источник' ? `${value}\nhh: врач` : value));
    await db.from('base_constructor_jobs').update({ status: 'completed',
      data: [[...grid[0], 'Email Статус'], ...mixed.map((row) => [...row, 'ok'])] }).eq('id', child.id);
    await db.from('ve_jobs').update({ status: 'running', started_at: makeJob().started_at }).eq('id', makeJob().id);

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    expect(mockFindIrrelevantRows).toHaveBeenCalledTimes(1);
    expect(mockFindIrrelevantRows.mock.calls[0][0]).toMatchObject({ geography: 'Москва и МО',
      rows: [expect.objectContaining({ email: 'hello@capital.test', address: 'Москва, ул. Примерная, 10\nКазань' })],
      evidenceRows: [expect.objectContaining({ inn: '7701000001', address: 'Москва, ул. Примерная, 10',
        source_detail: 've:geography-source' })] });
    const savedInfo = db.getRows('ve_bases').find((base) => base.id === 'b1')!.collect_info as VeCollectInfo;
    expect(savedInfo.relevance_reserve?.source_rows?.filter((row) => row._ve_geography_source === true))
      .toEqual([expect.objectContaining({ address: 'Москва, ул. Примерная, 10' })]);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(db.getRows('ve_projects')[0].brief).toEqual({ client_brief: { icp: { geo: 'Казань' } } });
  });
});

describe('explicit saved-preview geography repair planner', () => {
  const fixture = (): VeGeographyRepairSnapshot => {
    const rows = [0, 1, 2].map((i) => ({ company: `Company ${i}`, inn: `770000000${i}`, email: `contact${i}@example.test`,
      address: i === 1 ? 'Казань' : 'Москва', _email_status: 'ok', _ve_relevance: { status: 'relevant', context_hash: 'paid-context' },
      _ve_company_name: { version: 1, source: `Company ${i}`, website: '', status: 'ready', value: `Company ${i}` } }));
    return { project_id: 'project', setup_revision: 18, selected: true, approved: false, frozen: false, accepted_launch: false,
      base: { id: 'same-base', project_id: 'project', hypothesis_id: 'hypothesis', source: 'auto', status: 'analyzed',
        data: rows, row_count: rows.length, columns: ['company', 'inn', 'email', 'address'], updated_at: '2026-10-22T13:00:00Z',
        max_emails_per_company: 1, analysis: { saved: 'paid analysis' }, collect_info: { collection_mode: 'preview',
          target_progress: { mode: 'preview', ready_target: 500, ready_rows: 3, round: 88, max_rounds: 100,
            candidates_processed: 6806, max_candidates: 10000, status: 'limited' },
          target_checkpoint: { completed_round: 88, seen_rows: rows },
          preview_pipeline: { version: 1, revision: 8, batches: [], completed_batches: 88, job_ids: ['saved-child'] },
          relevance_reserve: { version: 1, rows: [rows[1]] },
          tasks: [{ source: 'companies_directory', status: 'done', child_job_id: null, rows: 300,
            task: { source: 'companies_directory', rationale: 'Original source', directory_filters: { okvedCodes: ['10'] } },
            directory_cursors: { existing: 2000 }, harvest: rows as unknown as NonNullable<VeCollectInfo['tasks']>[number]['harvest'] },
          { source: 'hh_live', status: 'done', child_job_id: 'saved-child', rows: 50,
            task: { source: 'hh_live', rationale: 'Historical live source', hh_query: { text: 'food', area: '113' } } }] } },
      preparation: { base_id: 'same-base', hypothesis_id: 'hypothesis', status: 'ready', updated_at: '2026-10-22T13:00:00Z',
        paused_at: null, cancelled_at: null, pause_state: null, locked_until: null, claim_token: null, independent_control: true },
      jobs: [{ id: 'saved-parent', stage: 'base_collect', status: 'done', payload: { base_id: 'same-base' },
        result: { relevance_checkpoint: { verdicts: { later: 'newer-paid-result' } } }, updated_at: '2026-10-22T13:00:00Z',
        started_at: null, finished_at: '2026-10-22T13:00:00Z' }],
      children: [{ id: 'saved-child', status: 'completed', updated_at: '2026-10-22T12:00:00Z' }] };
  };
  const request = (s: VeGeographyRepairSnapshot) => ({ repair_id: 'solo-geo-v1', required: { version: 1 as const, required: 'Москва и МО' },
    reviewed_data_hash: veGeographyRepairHash(s.base.data), ready_row_indices: [0, 2], prepared_at: '2026-10-22T14:00:00Z' });

  it('projects reviewed rows without paid replay, archives old sources and preserves exact budgets/checkpoints/job results', () => {
    const original = fixture(); const before = JSON.stringify(original);
    const plan = planVeCollectionGeographyRepair(original, request(original));
    expect(plan.status).toBe('prepared'); if (plan.status === 'blocked') throw new Error(plan.reasons.join(','));
    expect(JSON.stringify(original)).toBe(before);
    expect(plan.patch.data).toEqual([original.base.data[0], original.base.data[2]]);
    expect(plan.patch.data[0]).toBe(original.base.data[0]);
    expect(plan.patch.collect_info.geography_repair?.held_ready_rows).toEqual([original.base.data[1]]);
    expect(plan.patch.collect_info.relevance_reserve).toBeUndefined();
    expect(plan.patch.collect_info.geography_repair?.held_candidate_buffers.relevance_reserve).toEqual(original.base.collect_info.relevance_reserve);
    expect(plan.patch.collect_info.target_checkpoint).toBe(original.base.collect_info.target_checkpoint);
    expect(plan.patch.collect_info.preview_pipeline).toBe(original.base.collect_info.preview_pipeline);
    expect(plan.patch.collect_info.geography_repair?.previous_tasks).toBe(original.base.collect_info.tasks);
    expect(plan.patch.collect_info.tasks).toHaveLength(1);
    expect(plan.patch.collect_info.tasks?.[0]).toMatchObject({ status: 'pending', child_job_id: null, rows: 0,
      task: { directory_filters: { okvedCodes: ['10'], regionCodes: ['77', '50'] } } });
    expect(plan.patch.collect_info.tasks?.[0].directory_cursors).toBeUndefined();
    expect(plan.budget).toEqual({ max_candidates: 10000, candidates_processed: 6806, candidates_remaining: 3194,
      max_rounds: 100, round: 88, rounds_remaining: 12 });
    expect(plan.continuation.allowed).toBe(true);
    expect(stripTaskHarvest({ collect_info: plan.patch.collect_info }).collect_info).not.toHaveProperty('geography_repair');
    expect(plan.preserved_job_results).toEqual([{ id: 'saved-parent', result_hash: veGeographyRepairHash(original.jobs[0].result) }]);
    expect(plan.patch.analysis).toBeNull();
    expect(plan.patch.collect_info.geography_repair?.previous_analysis).toBe(original.base.analysis);
    expect(plan.patch).not.toHaveProperty('letters');
    // The worker applies niche normalization both before and after planning.
    // Neither path may replace the repair's frozen source keys and then drop
    // those sources from acquisition or reject the next saved checkpoint.
    const repairedBeforeNiche = JSON.stringify(plan.patch.collect_info);
    expect(applyVeNicheSourceSelection(plan.patch.collect_info, 'payments')).toBe(false);
    expect(JSON.stringify(plan.patch.collect_info)).toBe(repairedBeforeNiche);
    expect(() => readVeGeographyRepair(plan.patch.collect_info)).not.toThrow();
    // The superseded all-Russia source receipt must not reject the newly
    // scoped task; its prior paid/source history stays available for audit.
    const restaurant = fixture();
    const oldMap = { source: 'yandex_maps' as const, rationale: 'Restaurant catalog', maps_query: { queries: ['Рестораны'], geo: 'Россия' } };
    const previousTask = restaurant.base.collect_info.tasks![1];
    previousTask.rows = 0;
    restaurant.base.collect_info.tasks = [{ source: 'yandex_maps', status: 'done', child_job_id: null, rows: 0, task: oldMap }];
    restaurant.base.collect_info.restaurant_source_refresh = { version: 1, source_key: veSourceStrategyKey(oldMap),
      previous_task: { ...previousTask }, held_review_companies: [] };
    const restaurantPlan = planVeCollectionGeographyRepair(restaurant, request(restaurant));
    if (restaurantPlan.status === 'blocked') throw new Error(restaurantPlan.reasons.join(','));
    expect(restaurantPlan.patch.collect_info.restaurant_source_refresh).toBeUndefined();
    expect(restaurantPlan.patch.collect_info.geography_repair?.previous_restaurant_source_refresh)
      .toEqual(restaurant.base.collect_info.restaurant_source_refresh);
    expect(restaurantPlan.patch.collect_info.tasks?.[0].task.maps_query?.geo).toBe('Москва, Московская область');
    expect(prepareVeGeographyRepairContinuation(restaurantPlan.patch.collect_info).can_continue).toBe(true);
  });

  it('fails closed on stale review, launch/approval, foreign pause, active work or an undrained completed child', () => {
    for (const change of [
      (s: VeGeographyRepairSnapshot) => { s.approved = true; },
      (s: VeGeographyRepairSnapshot) => { s.accepted_launch = true; },
      (s: VeGeographyRepairSnapshot) => { s.frozen = true; },
      (s: VeGeographyRepairSnapshot) => { s.jobs[0].status = 'running'; },
      (s: VeGeographyRepairSnapshot) => { s.preparation.claim_token = 'another-worker'; },
      (s: VeGeographyRepairSnapshot) => { s.preparation.paused_at = '2026-10-22T12:00:00Z'; },
      (s: VeGeographyRepairSnapshot) => { s.base.collect_info.preview_pipeline!.batches = [{ id: 'saved-child', rows: [], dispatched_at: '2026-10-22T12:00:00Z' }]; },
      (s: VeGeographyRepairSnapshot) => { s.children = []; },
    ]) {
      const snapshot = fixture(); change(snapshot);
      expect(planVeCollectionGeographyRepair(snapshot, request(snapshot)).status).toBe('blocked');
    }
    const snapshot = fixture(); const reviewed = request(snapshot); snapshot.base.data[0].address = 'Казань';
    expect(planVeCollectionGeographyRepair(snapshot, reviewed)).toMatchObject({ status: 'blocked', reasons: ['reviewed_rows_changed'] });
    expect(planVeCollectionGeographyRepair(fixture(), { ...request(fixture()), ready_row_indices: [0, 0] }))
      .toMatchObject({ status: 'blocked', reasons: ['invalid_reviewed_indices'] });
  });

  it('is idempotent and can adopt only its own drained pause; exhaustion never grants a new budget', () => {
    const snapshot = fixture(); const at = '2026-10-22T13:30:00Z';
    snapshot.preparation = { ...snapshot.preparation, status: 'collecting', paused_at: at, cancelled_at: at,
      pause_state: { version: 1, jobs: [{ id: 'saved-parent', status: 'running' }] } };
    snapshot.jobs[0] = { ...snapshot.jobs[0], status: 'cancelled', finished_at: at };
    snapshot.base.collect_info.target_progress!.round = 100;
    snapshot.base.collect_info.target_checkpoint!.completed_round = 100;
    const reviewed = { ...request(snapshot), owned_pause_at: at };
    const first = planVeCollectionGeographyRepair(snapshot, reviewed);
    expect(first.status).toBe('prepared'); if (first.status === 'blocked') throw new Error(first.reasons.join(','));
    expect(first.continuation.reasons).toContain('original_budget_exhausted');
    expect(first.patch.collect_info.target_progress?.max_rounds).toBe(100);
    const second = planVeCollectionGeographyRepair({ ...snapshot, base: { ...snapshot.base, ...first.patch } }, reviewed);
    expect(second.status).toBe('already_prepared');
    if (second.status === 'blocked') throw new Error(second.reasons.join(','));
    expect(second.patch.collect_info.geography_repair).toEqual(first.patch.collect_info.geography_repair);
    expect(second.patch.collect_info.target_checkpoint).toBe(snapshot.base.collect_info.target_checkpoint);
    const ordinaryContinue = { ...first.patch.collect_info };
    grantVeResumeRoundBudget(ordinaryContinue);
    expect(ordinaryContinue.target_progress?.max_rounds).toBe(100);
    expect(prepareVeGeographyRepairContinuation(first.patch.collect_info)).toMatchObject({ can_continue: false, reason: 'round_limit' });
    expect(getVeCollectionContinuation({ ...snapshot.base, ...first.patch })).toMatchObject({ available: false, code: 'round_limit' });
    const corrupt = structuredClone(first.patch.collect_info);
    corrupt.target_progress!.max_rounds += 100;
    expect(() => readVeGeographyRepair(corrupt)).toThrow('bounded geography repair');
    const held = fixture(); held.base.collect_info.target_progress!.stop_cause = 'low_yield';
    const heldPlan = planVeCollectionGeographyRepair(held, request(held));
    if (heldPlan.status === 'blocked') throw new Error(heldPlan.reasons.join(','));
    expect(heldPlan.continuation).toMatchObject({ allowed: false, reasons: ['existing_economic_hold'] });
    expect(prepareVeGeographyRepairContinuation(heldPlan.patch.collect_info)).toMatchObject({ can_continue: false, reason: 'existing_economic_hold' });
    expect(getVeCollectionContinuation({ ...held.base, ...heldPlan.patch })).toMatchObject({ available: false, code: 'low_yield' });
  });

  it('runs the final remaining round without replaying old contacts, buying a replan or regenerating analysis/letters', async () => {
    const snapshot = fixture();
    snapshot.base.collect_info.target_progress!.round = 99;
    snapshot.base.collect_info.target_checkpoint!.completed_round = 99;
    const projected = planVeCollectionGeographyRepair(snapshot, request(snapshot));
    if (projected.status === 'blocked') throw new Error(projected.reasons.join(','));
    const next = prepareVeGeographyRepairContinuation(projected.patch.collect_info);
    expect(next.can_continue).toBe(true);
    expect(next.collect_info.target_progress).toMatchObject({ round: 100, max_rounds: 100, candidates_processed: 6806 });
    expect(next.collect_info.target_checkpoint?.completed_round).toBe(99);
    expect(prepareVeGeographyRepairContinuation(next.collect_info).can_continue).toBe(false);
    const db = seed(next.collect_info, { ve_bases: [{ ...makeBase(next.collect_info), data: projected.patch.data,
      row_count: projected.patch.row_count, columns: [...VE_AUTO_COLLECT_COLUMNS], analysis: projected.patch.analysis }],
      ve_templates: [{ id: 'keep-template', base_id: 'b1', status: 'ready', letters: [{ body: 'Original letters' }] }] });
    jest.mocked(searchRows).mockReset(); jest.mocked(searchRows).mockResolvedValue({ rows: [] });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
    const saved = db.getRows('ve_bases')[0];
    expect((saved.collect_info as VeCollectInfo).target_progress).toMatchObject({ max_rounds: 100, max_candidates: 10000, candidates_processed: 6806 });
    expect((saved.collect_info as VeCollectInfo).target_progress!.round).toBeLessThanOrEqual(100);
    expect((saved.collect_info as VeCollectInfo).target_progress?.reason)
      .toBe('Доступный источник в выбранной географии обработан. Проверенные контакты сохранены.');
    expect(saved.analysis).toBeNull();
    expect((saved.collect_info as VeCollectInfo).geography_repair?.previous_analysis).toEqual(snapshot.base.analysis);
    expect(saved.status).toBe('analyzed');
    expect(db.getRows('ve_templates')[0].letters).toEqual([{ body: 'Original letters' }]);
    expect(db.getRows('ve_jobs').some((job) => ['base_analyze', 'template'].includes(String(job.stage)))).toBe(false);
    expect(db.getRows('base_constructor_jobs')).toHaveLength(0);
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    expect(mockFindIrrelevantRows).not.toHaveBeenCalled();
    expect(fetchVeRelevanceEvidence).not.toHaveBeenCalled();
    expect(searchRows).toHaveBeenCalledWith(expect.objectContaining({ regionCodes: ['77', '50'] }), expect.any(Number), 0);
  });
});
