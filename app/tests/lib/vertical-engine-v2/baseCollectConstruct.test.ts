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

import { createHash } from 'node:crypto';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { capVeContactsPerCompany, normalizeVeMaxEmailsPerCompany } from '@/lib/verticalEngineV2/companyContactCap';
import { canResumePartialPreview } from '@/lib/verticalEngineV2/collectionRecovery';
import { veRelevanceRowKey } from '@/lib/verticalEngineV2/relevanceReserve';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  baseRowMatchesExclusion,
  buildBaseExclusionKeysFromRows,
  dedupUnifiedRows,
  mapGoogleRow,
  pruneBaseRowAgainstExclusion,
  runBaseCollectStage,
  veShortHhQuery,
  VE_AUTO_COLLECT_COLUMNS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';
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
import { normalizeVeSourceContacts } from '@/lib/verticalEngineV2/sourceContacts';
import { veAcquisitionReceipt } from '@/lib/verticalEngineV2/collectionIdentity';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { resolveVeYandexCatalogFilters } from '@/lib/verticalEngineV2/yandexCatalog';
import { newVeAdaptiveCollection, finishVeAdaptiveBatch, chooseVeAdaptiveSource, veSourceStrategyKey, veReadyContactKeys, summarizeVeBatchSpend, readVeBatchSpend, veAdaptiveCandidateLimit } from '@/lib/verticalEngineV2/adaptiveCollection';
import { prioritizeVeCandidates } from '@/lib/verticalEngineV2/candidatePriority';
import { veCompanyFactKey, VE_COMPANY_FACT_TTL_MS } from '@/lib/verticalEngineV2/companyFacts';
import { previewRecoveryKind, openNextVeCollectionRound } from '@/lib/verticalEngineV2/collectionRecovery';

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
      expect((db.getRows('ve_bases').find((base) => base.id === 'b1')!.collect_info as VeCollectInfo).saved_email_recovery)
        .toMatchObject({ generation: complete ? 2 : 1, checked: { b: 'ok', c: 'catch_all', d: 'invalid' },
          automatic_checked: { b: 'ok', c: 'catch_all', d: 'invalid' } });
      expect((db.getRows('ve_bases').find((base) => base.id === 'b1')!.collect_info as VeCollectInfo).saved_email_recovery?.checked)
        .not.toHaveProperty('a');
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
      .toEqual([{ ...company, website: hints[0].website }, present, spare]);
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
    expect(db.rpcCalls).toEqual([
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
  const hypothesis = (text: { title: string; description: string }) =>
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
  const seedBase = (info: VeCollectInfo, text: { title: string; description: string }, base: Record<string, unknown> = {},
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

  it('пустой выбор рубрик — ошибка задачи с причиной, а не «каталог исчерпан»', async () => {
    // В справочнике только пустые в России формы запроса, модель выбирает их же.
    const lonely = { ...REALTY_MAPS, maps_query: { geo: 'Россия', queries: ['агентство недвижимости'] } };
    const info: VeCollectInfo = { plan: { tasks: [lonely] }, tasks: [{ source: 'yandex_maps', status: 'pending',
      child_job_id: null, rows: 0, task: lonely }] };
    const db = installCatalog(seed(info), [['агентство недвижимости', 34], ['Агентство недвижимости', 101]]);
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce({ data: { category_ids: [0, 1], place_ids: [] }, tokensUsed: 0,
      costUsd: 0, promptTokens: 0, completionTokens: 0, rawResponse: '' });
    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }).catch(() => undefined);
    const task = (db.getRows('ve_bases')[0].collect_info as VeCollectInfo).tasks![0];
    expect(task.status).toBe('failed');
    expect(task.exhausted).not.toBe(true);
    expect(task.error).toContain('нет организаций по рубрикам «агентство недвижимости», «Агентство недвижимости» в географии «Россия»');
    expect(db.rpcCalls.some((call) => call.fn === 'yandex_maps_catalog_search')).toBe(false);
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
      await db.from('ve_jobs').update({ status: 'running' }).eq('id', queued.id);
      await runBaseCollectStage({ ...makeJob(), id: queued.id as string, payload: queued.payload as VeJob['payload'] },
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

function readVeRelevanceReserveRows(info: VeCollectInfo): Array<Record<string, unknown>> {
  return (info.relevance_reserve as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? [];
}
