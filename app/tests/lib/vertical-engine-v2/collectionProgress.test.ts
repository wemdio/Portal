/** @jest-environment node */

import { getCollectionProgress, getCollectionQueue, isPartialPreview } from '@/components/vertical-engine-v2/engine/collectionProgress';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { loadVeProjectDetail } from '@/lib/verticalEngineV2/projectDetail';
import { createVeCollectionContinuationCache, readVeCollectionContinuationCache, saveVeCollectionContinuationCache } from '@/lib/verticalEngineV2/collectionContinuationCache';
import { selectHypothesisLetters } from '@/components/vertical-engine-v2/engine/letterSelection';
import { getPreparationActionNotice, getPreparationPresentation, refreshPreparationRequestNotice } from '@/components/vertical-engine-v2/engine/PreparationProgress';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import { groupVeHypotheses } from '@/components/vertical-engine-v2/engine/hypothesisGroups';

jest.mock('@/lib/verticalEngineV2/actualsReconcile', () => ({ reconcileProjectVerticals: jest.fn(async () => {}) }));

function base(id: string, createdAt: string, info: VeBaseSummary['collect_info'] = {}): VeBaseSummary {
  return {
    id, created_at: createdAt, collect_info: info, status: 'collecting', source: 'auto',
    vertical_id: id, hypothesis_id: null, filename: id, row_count: 0,
    analysis: null, columns: [], sample_rows: [],
  };
}

describe('VE2 collection progress presentation', () => {
  it('keeps old public previews and active supply visible beyond the server page cap, without loading completed supply history', async () => {
    const makeBase = (id: string, mode: string | null, status: string, createdAt: string) => ({
      ...base(id, createdAt), project_id: 'project-1', vertical_id: 'vertical-1', status,
      // The shared mock filters literal column names; this mirrors the PostgREST JSON text path.
      'collect_info->>collection_mode': mode,
      collect_info: mode ? { collection_mode: mode, target_checkpoint: { processed_rows: [{ private: true }] }, tasks: [{ status: 'done', rows: 3, harvest: [{ private: true }] }] } : null,
    });
    const publicBases = [
      makeBase('preview-old', 'preview', 'analyzed', '2026-09-01T10:00:00Z'),
      makeBase('legacy-old', null, 'analyzed', '2026-09-01T11:00:00Z'),
      makeBase('preview-new', 'preview', 'collecting', '2026-09-01T12:00:00Z'),
    ];
    const historical = ['1', '2', '3'].map((id) => makeBase(`supply-${id}`, 'supply', 'analyzed', `2026-09-02T1${id}:00:00Z`));
    const db = createMockSupabase({ enforceQueryWindows: true, maxRowsPerQuery: 2, tables: {
      ve_projects: [{ id: 'project-1' }], ve_verticals: [{ id: 'vertical-1', project_id: 'project-1', rank: 1 }],
      ve_bases: [...publicBases, ...historical, makeBase('supply-active', 'supply', 'collecting', '2026-09-02T14:00:00Z')],
      ve_templates: [...publicBases, ...historical].map((row) => ({
        id: `template-${row.id}`, base_id: row.id, vertical_id: 'vertical-1', created_at: row.created_at,
        supply_batch_id: row['collect_info->>collection_mode'] === 'supply' ? `batch-${row.id}` : null,
      })),
    } });
    const result = await loadVeProjectDetail(db as never, 'project-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const bases = result.detail.bases as VeBaseSummary[];
    expect(bases.map((row) => row.id)).toEqual(['supply-active', 'preview-new', 'legacy-old', 'preview-old']);
    expect(result.detail.templates.map((row) => (row as { id: string }).id)).toEqual(['template-preview-new', 'template-legacy-old', 'template-preview-old']);
    expect(['ve_bases', 've_templates'].map((table) => db.selects.filter((query) => query.table === table).length)).toEqual([2, 2]);
    // Рабочее состояние воркера отсекает БД, а не Node: деталка просит у
    // ve_bases вычисляемую колонку ve_base_public_info и НИКОГДА сырой
    // collect_info. Полный документ проекта «Аврора» — 587 МБ, он не проходил
    // через предел строки V8 и четверо суток держал специалиста без проекта.
    // Здесь проверяется именно запрос: мок SQL-функцию исполнить не может.
    const baseSelect = db.selects.find((query) => query.table === 've_bases')!.columns;
    expect(baseSelect).toContain('collect_info:public_info');
    expect(baseSelect).not.toMatch(/(^|,)\s*collect_info\s*(,|$)/);
    expect(getCollectionQueue(bases, [{ stage: 'base_collect', status: 'running', payload: { base_id: 'supply-active' } }]).current?.id).toBe('supply-active');

    // Polling consumes only the small verdict. A legacy base or changed policy
    // remains unknown until a full-state preflight; it must not silently become
    // "no remaining work" or reuse a verdict from before the latest write.
    const priorTriage = process.env.VE_RELEVANCE_TRIAGE;
    const priorProjects = process.env.VE_RELEVANCE_TRIAGE_PROJECTS;
    try {
      process.env.VE_RELEVANCE_TRIAGE = 'off';
      process.env.VE_RELEVANCE_TRIAGE_PROJECTS = 'project-1';
      const snapshot = { id: 'checked', project_id: 'project-1', status: 'analyzed',
        updated_at: '2026-10-12T10:00:00Z', max_emails_per_company: null, contact_cap_applied: 3,
        collection_continuation_revision: 4, collect_info: { private: 'unchanged' } };
      const verdict = { available: false, action: null, code: 'sources_exhausted', reason: 'Источники обработаны.' } as const;
      const cache = createVeCollectionContinuationCache(snapshot, { ...verdict, private: 'must not leak' } as typeof verdict);
      expect(cache?.decision).toEqual(verdict);
      const cached = { ...snapshot, collection_continuation: cache };
      expect(readVeCollectionContinuationCache(cached)).toEqual(verdict);
      expect(readVeCollectionContinuationCache(snapshot)).toBeNull();
      for (const patch of [
        { updated_at: '2026-10-12T10:00:01Z' }, { status: 'collecting' }, { collection_continuation_revision: 5 },
        { max_emails_per_company: 5 }, { contact_cap_applied: null }, { max_emails_per_company: undefined },
        { collection_continuation: { ...cache, version: 0 } },
        { collection_continuation: { ...cache, decision: { ...verdict, available: true } } },
      ]) expect(readVeCollectionContinuationCache({ ...cached, ...patch })).toBeNull();
      process.env.VE_RELEVANCE_TRIAGE = 'jev';
      expect(readVeCollectionContinuationCache(cached)).toBeNull();
      process.env.VE_RELEVANCE_TRIAGE = 'off';
      const cacheDb = createMockSupabase({ tables: { ve_bases: [snapshot] } });
      expect(await saveVeCollectionContinuationCache(cacheDb as never, snapshot, verdict)).toBe(true);
      expect(cacheDb.updates[0].patch).toEqual({ collection_continuation: cache });
      expect(cacheDb.getRows('ve_bases')[0]).toMatchObject(snapshot);
      expect(cacheDb.inserts).toEqual([]);
      const raced = createMockSupabase({ tables: { ve_bases: [snapshot] }, beforeFirstUpdates: {
        ve_bases: (rows) => rows.map((row) => ({ ...row, collection_continuation_revision: 5, collection_continuation: null })),
      } });
      expect(await saveVeCollectionContinuationCache(raced as never, snapshot, verdict)).toBe(false);
      expect(raced.getRows('ve_bases')[0].collection_continuation).toBeNull();
      const unavailableDb = createMockSupabase({ tables: { ve_bases: [snapshot] }, errorTables: { ve_bases: 'offline' } });
      expect(await saveVeCollectionContinuationCache(unavailableDb as never, snapshot, verdict)).toBe(false);

      // Template/coordination changes do not touch the collection cache. They
      // must still expose preparation repair, including outside recent jobs.
      const checkedBases = ['letters-failed', 'link-error', 'ready-partial', 'busy-1', 'busy-2', 'busy-3', 'request-pending', 'lease-live', 'launched'].map((id) => {
        const row = { ...makeBase(id, 'preview', 'analyzed', '2026-10-12T10:00:00Z'), ...snapshot,
          id, hypothesis_id: `h-${id}`, vertical_id: 'vertical-1', row_count: 22, collect_info: { collection_mode: 'preview' } };
        return { ...row, collection_continuation: createVeCollectionContinuationCache(row, verdict) };
      });
      const projectionDb = createMockSupabase({ enforceQueryWindows: true, maxRowsPerQuery: 2, tables: {
        ve_projects: [{ id: 'project-1' }], ve_verticals: [{ id: 'vertical-1', project_id: 'project-1' }],
        ve_bases: checkedBases,
        ve_outreach_preparations: checkedBases.map((row) => ({ project_id: 'project-1', hypothesis_id: row.hypothesis_id,
          base_id: row.id, template_id: `t-${row.id}`,
          status: row.id === 'request-pending' ? 'pending' : row.id === 'link-error' ? 'error' : 'ready',
          locked_until: row.id === 'lease-live' ? new Date(Date.now() + 60000).toISOString() : null })),
        ve_templates: checkedBases.map((row) => ({ id: `t-${row.id}`, base_id: row.id, vertical_id: 'vertical-1',
          status: row.id === 'letters-failed' ? 'failed' : 'ready', supply_batch_id: null,
          created_at: '2026-10-12T10:00:00Z', launch_info: row.id === 'launched' ? { campaign_id: 'existing' } : null })),
        ve_jobs: [
          ...Array.from({ length: 35 }, (_, index) => ({ id: `done-${index}`, project_id: 'project-1', stage: 'template',
            status: 'done', created_at: '2026-10-12T12:00:00Z', payload: { base_id: 'other' } })),
          ...['busy-1', 'busy-2', 'busy-3'].map((id) => ({ id: `old-${id}`, project_id: 'project-1', stage: 'template',
            status: 'running', created_at: '2026-10-11T12:00:00Z', payload: { base_id: id } })),
        ],
      } });
      const projected = await loadVeProjectDetail(projectionDb as never, 'project-1');
      if (!projected.ok) throw new Error(projected.message);
      const decisions = new Map((projected.detail.bases as VeBaseSummary[]).map((row) => [row.id, row.collection_continuation]));
      for (const id of ['letters-failed', 'link-error']) expect(decisions.get(id))
        .toMatchObject({ available: true, action: 'resume_preparation', code: 'preparation_incomplete' });
      expect(decisions.get('ready-partial')).toEqual(verdict);
      expect(decisions.get('launched')).toMatchObject({ available: false, code: 'launched' });
      expect(projected.detail.jobs.every((job) => (job as { status: string }).status === 'done')).toBe(true);
      for (const id of ['busy-1', 'busy-2', 'busy-3', 'request-pending', 'lease-live']) expect(decisions.get(id))
        .toMatchObject({ available: false, code: 'already_running' });
    } finally {
      if (priorTriage === undefined) delete process.env.VE_RELEVANCE_TRIAGE;
      else process.env.VE_RELEVANCE_TRIAGE = priorTriage;
      if (priorProjects === undefined) delete process.env.VE_RELEVANCE_TRIAGE_PROJECTS;
      else process.env.VE_RELEVANCE_TRIAGE_PROJECTS = priorProjects;
    }

    const preparation: VeOutreachPreparation = { project_id: 'project-1', hypothesis_id: 'h1', base_id: 'new',
      template_id: null, status: 'error', language: 'ru', last_error: 'Serper billing: insufficient search credits.' };
    const letterBases = [
      { ...base('old', '2026-09-01'), hypothesis_id: 'h1' },
      { ...base('new', '2026-09-03'), hypothesis_id: 'h1', status: 'failed' as const },
      { ...base('other', '2026-09-04'), hypothesis_id: 'h2' },
      { ...base('supply', '2026-09-05', { collection_mode: 'supply' }), hypothesis_id: 'h1' },
    ];
    const template = (id: string, baseId: string, createdAt: string) => ({ id, base_id: baseId, created_at: createdAt,
      status: 'ready' as const, letters: [{ step: 1, wait_days: 0, subject: 'Subject', body: 'Letter' }] });
    const savedLetters = template('t-old', 'old', '2026-09-01');
    const letters = [template('t-other', 'other', '2026-09-04'), template('t-supply', 'supply', '2026-09-05'), savedLetters];
    expect(selectHypothesisLetters('h1', preparation, letterBases, letters)).toEqual({ template: savedLetters, previous: true });
    expect(selectHypothesisLetters('h3', undefined, letterBases, letters)).toEqual({ template: null, previous: false });
    preparation.template_id = 't-other'; // A stale pointer must never cross hypotheses.
    expect(selectHypothesisLetters('h1', preparation, letterBases, letters).template?.id).toBe('t-old');
    const current = template('t-new', 'new', '2026-09-03');
    preparation.template_id = current.id;
    expect(selectHypothesisLetters('h1', preparation, letterBases, [...letters, current]))
      .toEqual({ template: current, previous: false });
    preparation.template_id = null;
    expect(getPreparationPresentation({ preparation, base: letterBases[1], jobs: [], context: 'letters' }))
      .toMatchObject({ tone: 'muted', currentStep: 0 });
    expect(getPreparationPresentation({ preparation, base: letterBases[1], jobs: [], context: 'base' }).tone).toBe('err');
    const failedLetters = { ...preparation, status: 'generating' as const, template_id: null };
    expect(getPreparationPresentation({ preparation: failedLetters, base: { ...letterBases[1], status: 'analyzed' },
      jobs: [{ id: 'template-job', stage: 'template', status: 'failed', attempts: 1, started_at: null, finished_at: null,
        payload: { base_id: 'new' }, error: 'generation failed' }],
      context: 'letters' }).tone).toBe('err');
  });

  it('selects the working project base, not the newest vertical base, and releases stale waits', () => {
    const active = base('active', '2026-09-02T12:10:00Z', { tasks: [{ source: 'registry', status: 'done', rows: 1477 }] });
    const waiting = base('waiting', '2026-09-02T12:10:01Z', { waiting_for_base_id: 'active' });
    const newest = base('newest', '2026-09-02T12:10:02Z', { waiting_for_base_id: 'active' });
    const bases = [newest, waiting, active];
    expect(getCollectionQueue(bases)).toEqual({ current: active, queued: [waiting, newest] });
    // Even before the next worker snapshot, a finished predecessor cannot block the UI.
    active.status = 'analyzed';
    expect(getCollectionQueue(bases)).toEqual({ current: waiting, queued: [newest] });
    // Equal creation times follow the worker's deterministic ID order; input stays untouched.
    newest.created_at = waiting.created_at;
    expect(getCollectionQueue(bases).current).toBe(newest);
    expect(bases.map((b) => b.id)).toEqual(['newest', 'waiting', 'active']);
    expect(getCollectionQueue([])).toEqual({ current: undefined, queued: [] });
    const orphan = base('orphan', '2026-09-01T12:10:00Z', { tasks: [{ status: 'done', rows: 10 }] });
    waiting.collect_info = { tasks: [{ status: 'dispatched' }] };
    const recentJobs = [{ stage: 'base_collect' as const, status: 'pending' as const, payload: { base_id: waiting.id } }];
    expect(getCollectionQueue([orphan, waiting], recentJobs).current).toBe(waiting);
    const unclaimed = base('unclaimed', '2026-09-02T12:11:00Z');
    const held = base('held', '2026-09-01T12:10:00Z', { collection_mode: 'supply', supply_hold: true, tasks: [{ status: 'dispatched' }] });
    expect(getCollectionQueue([held, waiting], recentJobs)).toEqual({ current: waiting, queued: [] });
    // The active collector may have fallen outside the latest-30-jobs response.
    expect(getCollectionQueue([waiting, unclaimed], [
      { stage: 'base_collect', status: 'pending', payload: { base_id: unclaimed.id } },
    ]).current).toBe(waiting);
    const parallel = base('parallel', '2026-09-02T12:12:00Z', { construct: { progress: { status: 'processing' } } });
    expect(getCollectionQueue([waiting, parallel], recentJobs).queued).toEqual([]);
    expect(getCollectionProgress({ source_contact_discovery: { checked: 16, remaining: 100 } }).phase).toBe('discovering_sites');
  });

  it('keeps unknown counts, source rows, candidates and step progress distinct from the run cap', () => {
    const preview = base('preview', '2026-09-16', { collection_mode: 'preview', target_progress: {
      mode: 'preview', ready_rows: 523, ready_target: 500, candidates_processed: 1000,
      round: 10, max_rounds: 100, max_candidates: 10000, status: 'target_reached',
    } });
    // Reaching the count does not finish an active or failed preparation.
    expect(isPartialPreview(preview)).toBe(true);
    expect(isPartialPreview({ ...preview, status: 'failed' })).toBe(true);
    expect(isPartialPreview({ ...preview, status: 'analyzed' })).toBe(false);
    preview.collect_info!.target_progress!.ready_rows = 22;
    preview.collect_info!.target_progress!.status = 'exhausted';
    expect(isPartialPreview({ ...preview, status: 'analyzed' })).toBe(true);
    expect(isPartialPreview(base('uploaded', '2026-09-16'))).toBe(false);
    const collecting = base('active', '2026-09-02T12:10:00Z', { limit: 10000 });
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'planning', candidates: null, sourceRows: null, stepPercent: null });
    collecting.collect_info = {
      limit: 10000,
      tasks: [{ status: 'done', rows: 1477 }, { status: 'dispatched', rows: 0 }, { status: 'failed', rows: 99 }],
    };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'collecting', candidates: null, sourceRows: 1477, stepPercent: null });
    collecting.collect_info.stats = { rows_total: 1250 };
    collecting.collect_info.construct = { status: 'dispatched', progress: { status: 'pending' } };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'construct_queued', candidates: 1250, stepPercent: null });
    collecting.collect_info.construct.progress = { status: 'processing', current_step_key: 'validate_emails', current_step_progress: 37 };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'processing', candidates: 1250, stepPercent: 37 });
    const preparation: VeOutreachPreparation = { project_id: 'project', hypothesis_id: 'hypothesis', base_id: collecting.id,
      template_id: null, status: 'collecting', language: 'ru', last_error: null };
    const parent = { id: 'parent', stage: 'base_collect' as const, status: 'pending' as const, attempts: 0,
      started_at: null, finished_at: null, error: null, payload: { base_id: collecting.id } };
    // The coordinator yields while its constructor is active; pending must not
    // hide that activity or display the step's percentage as whole-base progress.
    expect(getPreparationPresentation({ preparation, base: collecting, jobs: [parent] }))
      .toMatchObject({ title: 'Проверяем email', tone: 'info', currentStep: 0,
        guidance: { action: 'wait', title: 'От вас сейчас ничего не требуется' } });
    expect(getPreparationPresentation({ preparation, base: collecting, jobs: [{ ...parent, status: 'failed', error: 'Stopped' }] }))
      .toMatchObject({ tone: 'err', guidance: { action: 'continue' } });
    expect(getPreparationPresentation({ preparation, base: { ...collecting, collect_info: {} }, jobs: [parent] }))
      .toMatchObject({ tone: 'muted', guidance: { action: 'wait' } });
    collecting.collect_info.construct.progress.current_step_progress = 130;
    expect(getCollectionProgress(collecting.collect_info).stepPercent).toBeNull();
    collecting.collect_info.construct.progress = { status: 'completed', current_step_progress: 100 };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ phase: 'finishing', stepPercent: null });
    expect(getPreparationPresentation({ preparation, base: collecting, jobs: [parent] }))
      .toMatchObject({ tone: 'muted', currentStep: 0 });
    // A stale checkpoint must not make a stopped or unconfirmed job look busy.
    collecting.collect_info.relevance_review_requested = true;
    const interrupted = { ...preparation, status: 'error' as const,
      last_error: 'Задача сбора завершилась, но база не готова. Нажмите «Продолжить подготовку»' };
    expect(getPreparationPresentation({ preparation: interrupted, base: collecting, jobs: [{ ...parent, status: 'done' }] }))
      .toMatchObject({ tone: 'err', currentStep: null });
    expect(getPreparationPresentation({ preparation: { ...interrupted, status: 'pending' }, base: collecting, jobs: [{ ...parent, status: 'done' }] }))
      .toMatchObject({ tone: 'muted', currentStep: null });
    for (const status of ['failed', 'analyzing'] as const) {
      expect(getPreparationPresentation({ preparation: interrupted, base: { ...collecting, status }, jobs: [] }).tone).toBe('err');
      expect(getPreparationPresentation({ preparation: { ...interrupted, status: 'pending' }, base: { ...collecting, status }, jobs: [] }).tone).toBe('muted');
    }
    expect(getPreparationPresentation({ preparation, base: collecting, jobs: [{ ...parent, status: 'running' }] }))
      .toMatchObject({ tone: 'info', currentStep: 0 });
    expect(getPreparationPresentation({ preparation: interrupted, base: collecting, jobs: [{ ...parent, status: 'running' }] }))
      .toMatchObject({ tone: 'info', currentStep: 0 });
    for (const readyRows of [0, 22]) {
      const stopped = { ...preview, id: collecting.id, status: 'analyzed' as const,
        collect_info: { ...preview.collect_info, target_progress: { ...preview.collect_info!.target_progress!, ready_rows: readyRows } } };
      const presentation = getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: stopped, jobs: [] });
      expect(presentation).toMatchObject({ tone: readyRows > 0 ? 'ok' : 'muted', currentStep: readyRows > 0 ? 3 : null, canContinue: false });
      expect(presentation.title).toBe(readyRows > 0 ? 'База и письма готовы к согласованию' : 'Готовых контактов пока нет');
      expect(presentation.guidance?.action).toBe(readyRows > 0 ? 'review' : 'check');
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: stopped, jobs: [], approved: true }).guidance.action)
        .toBe(readyRows > 0 ? 'launch' : 'check');
      const unavailable = { available: false, action: null, code: 'sources_exhausted', reason: 'Доступные источники обработаны.' } as const;
      const blocked = { ...stopped, collection_continuation: unavailable };
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: blocked, jobs: [] }))
        .toMatchObject({ canContinue: false, continueHint: unavailable.reason });
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'pending' }, base: blocked, jobs: [] }))
        .toMatchObject({ canContinue: false, guidance: { action: 'check' } });
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: { ...blocked,
        collection_continuation: { available: true, action: 'resume_collection', code: 'fresh_sources', reason: 'Есть новые источники.' } }, jobs: [] }))
        .toMatchObject({ canContinue: true, continueLabel: 'Продолжить добор' });
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: { ...blocked,
        collection_continuation: { available: true, action: 'resume_preparation', code: 'state_unchecked', reason: 'Нужно проверить состояние.' } }, jobs: [] }))
        .toMatchObject({ canContinue: true, continueLabel: 'Проверить и продолжить' });
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: { ...blocked,
        collection_continuation: { ...unavailable, code: 'already_running', reason: 'Подготовка уже выполняется.' } }, jobs: [] }))
        .toMatchObject({ tone: 'info', guidance: { action: 'wait' } });
      // A collection limit must not prevent repair of failed letters.
      expect(getPreparationPresentation({ preparation: { ...preparation, status: 'error' }, base: { ...blocked, row_count: 22 },
        jobs: [{ ...parent, stage: 'template', status: 'failed' }] })).toMatchObject({ canContinue: true });
    }
    const goalReached = { ...preview, id: collecting.id, status: 'analyzed' as const, row_count: 523,
      collect_info: { ...preview.collect_info, target_progress: { ...preview.collect_info!.target_progress!, status: 'target_reached' as const,
        ready_rows: 523 } }, collection_continuation: { available: true, action: 'resume_preparation' as const,
        code: 'preparation_incomplete', reason: 'Нужно подготовить письма.' } };
    expect(getPreparationPresentation({ preparation, base: goalReached, jobs: [] }))
      .toMatchObject({ canContinue: true, continueLabel: 'Продолжить подготовку', currentStep: 2, guidance: { action: 'continue' } });
    // A stale ready preparation does not turn failed/missing letters into a
    // completed audience just because the collection itself is finished.
    expect(getPreparationPresentation({ preparation: { ...preparation, status: 'ready' }, base: goalReached, jobs: [], approved: true }))
      .toMatchObject({ tone: 'muted', canContinue: true, title: 'Нужно завершить подготовку', guidance: { action: 'continue' } });
    for (const status of ['queued', 'already_running', 'unavailable', 'ready'] as const) {
      expect(getPreparationActionNotice({ status, reason: 'Ответ сервера', hypothesis_id: 'h1' }))
        .toEqual({ tone: status === 'unavailable' ? 'error' : 'info', message: 'Ответ сервера' });
    }
    expect(getPreparationActionNotice()).toEqual({ tone: 'info', message: 'Обновляем состояние подготовки.' });
    const freshState = { preparations: [preparation], bases: [goalReached], jobs: [] };
    const queuedNotice = { hypothesisId: preparation.hypothesis_id, tone: 'info' as const, message: 'Запрос принят.' };
    expect(refreshPreparationRequestNotice(queuedNotice, freshState)).toBeNull();
    const pendingNotice = { ...queuedNotice, checking: true };
    expect(refreshPreparationRequestNotice(pendingNotice, freshState)).toBe(pendingNotice);
    const blockedNotice = { ...queuedNotice, tone: 'error' as const, keepUntilStateChanges: true, message: 'Источники обработаны.' };
    const savedNotice = refreshPreparationRequestNotice(blockedNotice, freshState);
    expect(savedNotice?.message).toBe(blockedNotice.message);
    expect(refreshPreparationRequestNotice(savedNotice, freshState)).toBe(savedNotice);
    expect(refreshPreparationRequestNotice(savedNotice, { ...freshState,
      preparations: [{ ...preparation, status: 'ready' }] })).toBeNull();
    collecting.collect_info.relevance_review_requested = false;
    collecting.collect_info.construct.progress = { status: 'processing', current_step_key: 'validate_emails', current_step_progress: 37 };
    for (const history of [[], [{ ...parent, status: 'done' as const }]]) {
      expect(getPreparationPresentation({ preparation, base: collecting, jobs: history }))
        .toMatchObject({ tone: 'muted', guidance: { action: history.length ? 'continue' : 'check' } });
    }
    collecting.collect_info = { stats: { rows_total: Number.NaN }, tasks: [{ status: 'done', rows: -1 }] };
    expect(getCollectionProgress(collecting.collect_info)).toMatchObject({ candidates: null, sourceRows: null });
    collecting.collect_info.stats = { rows_total: 0 };
    expect(getCollectionProgress(collecting.collect_info).candidates).toBe(0);
  });

  it('shows broad hypotheses as a separate block above the verticals; projects without them list as before', () => {
    const verticals = [{ id: 'v-med', name: 'Частная медицина' }, { id: 'v-lab', name: 'Лаборатории' }, { id: 'v-empty', name: 'Пустая' }];
    const hypotheses = [
      { id: 'labs', vertical_id: 'v-lab', broad: false },
      { id: 'medicine', vertical_id: 'v-med', broad: true },
      { id: 'franchise', vertical_id: 'v-lab' },
      { id: 'unclustered', vertical_id: null, broad: true },
    ];
    const groups = groupVeHypotheses(verticals, hypotheses);
    expect(groups.broad.map((h) => h.id)).toEqual(['medicine']);
    expect(groups.verticals.map(({ vertical, hypotheses: own }) => [vertical.id, own.map((h) => h.id)]))
      .toEqual([['v-lab', ['labs', 'franchise']], ['v-empty', []]]);
    const old = groupVeHypotheses(verticals, hypotheses.map(({ broad: _broad, ...h }) => h));
    expect(old.broad).toEqual([]);
    expect(old.verticals.map(({ vertical }) => vertical.id)).toEqual(['v-med', 'v-lab', 'v-empty']);
  });
});
