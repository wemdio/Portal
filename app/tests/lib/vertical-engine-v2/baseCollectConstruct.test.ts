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
}));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn(() => 'test-bulk-model'),
  getVeActiveJobSignal: jest.fn(() => undefined),
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

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  baseRowMatchesExclusion,
  buildBaseExclusionKeysFromRows,
  dedupUnifiedRows,
  mapGoogleRow,
  pruneBaseRowAgainstExclusion,
  runBaseCollectStage,
  VE_AUTO_COLLECT_COLUMNS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';
import { selectRefillLeadRows } from '@/lib/verticalEngineV2/stages/baseCollectRefill';
import { prepareSegmentationAudience } from '@/lib/verticalEngineV2/segmentationAudit';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import {
  createCollectionTarget,
  finishCollectionRound,
  collectionRoundLimit,
  estimateRemainingReady,
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
      ve_directory_segment_stats: () => ({
        data: {
          directory_rows_total: 9_120,
          companies_unique_total: 8_410,
          // Known-any-row contact counts are dossier semantics.
          companies_with_email: 7_000,
          companies_with_phone: 7_250,
          companies_with_any_contact: 7_900,
          // Exact-plan estimate must use contacts on rows that themselves
          // match the hypothesis filters.
          matched_companies_with_email: 6_842,
          matched_companies_with_phone: 7_105,
          matched_companies_with_any_contact: 7_700,
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
    const preview = createCollectionTarget('preview', 50_000);
    expect(preview.ready_target).toBe(500);
    expect(collectionRoundLimit(preview)).toBe(100);
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
    jest.mocked(fetchVeRelevanceEvidence).mockResolvedValueOnce({ status: 'ok', text: 'Confirmed legal entity', url: 'https://found.test/', reason: 'discovered_verified_website' });
    const recoveredDb = seed(recoveredInfo);
    await runBaseCollectStage(makeJob(), { supabase: recoveredDb as unknown as SupabaseClient });
    const recoveredInput = recoveredDb.getRows('base_constructor_jobs')[0].data as string[][];
    expect(recoveredInput).toHaveLength(2);
    expect(recoveredInput[1]).toContain('https://found.test/');

    // The small cohort must reach the actual constructor and publish checked
    // rows while the same base continues collecting. Old runs retain their
    // original input scope across a deployment.
    const harvest = Array.from({ length: 1_200 }, (_, i) => unifiedRow({
      company: `Clinic ${i}`, website: `clinic-${i}.test`, email: `mail@clinic-${i}.test`,
    }));
    for (const legacy of [false, true]) {
      const target = { ...createCollectionTarget('preview') };
      if (legacy) {
        delete target.first_round_candidates;
        target.ready_target = 1_000;
      }
      const db = seed({ ...collectInfo(harvest), collection_mode: 'preview', target_progress: target });
      await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });
      const constructor = db.getRows('base_constructor_jobs')[0];
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
        const nextConstructor = db.getRows('base_constructor_jobs').find((row) => row.id !== constructor.id)!;
        const nextInput = nextConstructor.data as string[][];
        expect(nextInput).toHaveLength(481);
        await db.from('base_constructor_jobs').update({ status: 'completed',
          data: [[...nextInput[0], 'Email Статус'], ...nextInput.slice(1).map((row) => [...row, 'ok'])],
        }).eq('id', nextConstructor.id);
        await db.from('ve_jobs').update({ status: 'running' }).eq('id', makeJob().id);
        await expect(runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }))
          .resolves.toMatchObject({ result: { rows: 500, target_status: 'target_reached' } });
        const completed = db.getRows('ve_bases')[0];
        expect(completed).toMatchObject({ status: 'analyzing', row_count: 500 });
        expect(prepareSegmentationAudience({ rows: completed.data as Record<string, unknown>[],
          columns: completed.columns as string[], source: 'auto' }).rows).toHaveLength(500);
      }
    }

    // New previews overlap sources and durable constructor batches. An old
    // slow batch cannot block checked output from its completed neighbours.
    for (const failFirst of [false, true]) {
      const fastInfo: VeCollectInfo = { ...collectInfo(harvest), collection_mode: 'preview',
        target_progress: createCollectionTarget('preview'),
        preview_pipeline: { version: 1, revision: 0, batches: [] } };
      fastInfo.tasks!.push({ source: 'hh_live', status: 'dispatched', child_job_id: 'slow-hh', rows: 0,
        task: { source: 'hh_live', rationale: 'Parallel source', hh_query: { text: 'клиники' } }, dispatched_at: new Date().toISOString() });
      const db = seed(fastInfo, { parser_jobs: [{ id: 'slow-hh', status: 'running' }] });
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
      const children = db.getRows('base_constructor_jobs');
      expect(children).toHaveLength(2);
      expect(children.every((row) => (row.data as string[][]).length === 101)).toBe(true);
      expect(children[0].step_config).toMatchObject({ queue_class: 'interactive_preview',
        find_emails: { reuse_website_description: true, stop_at_first: false, max_per_site: null } });
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
        await db.from('ve_jobs').update({ status: 'failed' }).eq('id', makeJob().id);
        const resumed = await enqueueVeBaseCollect(db as unknown as SupabaseClient, {
          projectId: 'p1', verticalId: 'v1', verticalName: VERTICAL.name,
          hypothesisIds: ['h1'], collectionMode: 'preview', limit: 2000,
        });
        expect(resumed).toMatchObject({ ok: true, created: true, base: { id: 'b1' } });
        expect(db.getRows('ve_bases')).toHaveLength(1);
        const recoveredInfo = db.getRows('ve_bases')[0].collect_info as VeCollectInfo;
        expect(recoveredInfo).toMatchObject({ relevance_review_requested: true, validation_retry: true });
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
    expect(mockFindIrrelevantRows.mock.calls.map(([input]) => input.rows.length)).toEqual([2, 1]);
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
      find_emails: { stop_at_first: false, max_per_site: null, max_pages: 12, site_timeout_ms: 60_000, merge_mode: 'prefer_found_validated' },
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

    expect(db.rpcCalls).toEqual([
      {
        fn: 've_directory_segment_stats',
        params: expect.objectContaining({
          p_okved_prefixes: ['86.1', '86.2', '86.9'],
          p_include_ip: false,
          // Email is a funnel output here, not a filter on the population.
          p_require_email: false,
        }),
      },
    ]);
    const estimatePatch = db.updates.find((update) => {
      const info = update.patch.collect_info as VeCollectInfo | undefined;
      return info?.estimate?.unique_companies === 8_410;
    });
    expect((estimatePatch?.patch.collect_info as VeCollectInfo).estimate).toMatchObject({
      unique_companies: 8_410,
      companies_with_email: 6_842,
      companies_with_phone: 7_105,
      directory_rows_total: 9_120,
    });
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
