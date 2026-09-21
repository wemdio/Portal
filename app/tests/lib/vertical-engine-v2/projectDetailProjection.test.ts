/** @jest-environment node */
/**
 * Проекция collect_info на стороне PostgREST: карточка проекта получает те же
 * ключи, но рабочее состояние воркера (relevance_reserve, чекпойнты,
 * tasks[].harvest, deferred_rows) не выбирается в БД и не едет по проводу.
 * Повод — «Аврора»: 586 878 670 байт ответа при пределе строки V8 536 870 888.
 */
import {
  VE_BASE_COLLECT_INFO_KEYS, VE_BASE_LIST_COLUMNS, VE_BASE_TASK_SLOTS,
  assembleVeBaseCollectInfo, stripTaskHarvest,
} from '@/lib/verticalEngineV2/projectDetail';

jest.mock('@/lib/verticalEngineV2/actualsReconcile', () => ({ reconcileProjectVerticals: jest.fn(async () => {}) }));

const projectedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'base-1', status: 'collecting',
  ci_collection_mode: 'preview', ci_limit: 500, ci_ready_target: 300,
  ci_supply_hold: false, ci_validation_retry: true,
  ci_target_progress: { mode: 'preview', ready_rows: 12, ready_target: 300 },
  ci_construct: { status: 'running', progress: { status: 'processing', current_step_key: 'validate_emails' } },
  ci_plan: { tasks: [{ source: 'companies_directory', rationale: 'основной каталог' }] },
  ci_stats: { rows_total: 400, launchable_rows: 12 },
  ci_search_policy_version: 1, ci_search_policy_phase: 'existing',
  ci_task_0_source: 'companies_directory', ci_task_0_status: 'done', ci_task_0_rows: 12,
  ci_task_1_source: 'hh_live', ci_task_1_status: 'dispatched', ci_task_1_rows: null,
  ...overrides,
});

const nulls = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, null]));

describe('VE2 project detail: точечная проекция collect_info', () => {
  it('не выбирает collect_info колонкой и не упоминает тяжёлых веток', () => {
    const columns = VE_BASE_LIST_COLUMNS.split(',').map((part) => part.trim());
    expect(columns).not.toContain('collect_info');
    for (const heavy of ['relevance_reserve', 'relevance_checkpoint', 'target_checkpoint',
      'source_contact_recovery', 'company_name_checkpoint', 'preview_pipeline',
      'deferred_rows', 'harvest', 'ready_before', 'checked', 'emails']) {
      expect(VE_BASE_LIST_COLUMNS).not.toContain(heavy);
    }
  });

  it('проецирует ровно белый список ключей и производные', () => {
    expect([...VE_BASE_COLLECT_INFO_KEYS]).toEqual([
      'collection_mode', 'ready_target', 'supply_hold', 'waiting_for_base_id', 'limit',
      'target_progress', 'construct', 'plan', 'estimate', 'stats',
      'relevance_summary', 'company_contact_cap', 'company_name_cleanup', 'company_name_recovery',
      'source_contact_discovery', 'relevance_review_requested', 'validation_retry',
      'hypothesis_id', 'hypothesis_ids', 'hypotheses', 'plan_repair', 'slice_probe',
    ]);
    for (const key of VE_BASE_COLLECT_INFO_KEYS) {
      expect(VE_BASE_LIST_COLUMNS).toContain(`ci_${key}:collect_info->${key}`);
    }
    // Слотов должно хватать на жёсткий потолок задач: план ≤4 + реплан ≤2.
    expect(VE_BASE_TASK_SLOTS).toBeGreaterThanOrEqual(6);
    expect(VE_BASE_LIST_COLUMNS).toContain(`ci_task_${VE_BASE_TASK_SLOTS}_source:`);
  });

  it('собирает объект той же формы, что отдавала stripTaskHarvest', () => {
    const assembled = assembleVeBaseCollectInfo(projectedRow());
    expect(assembled.id).toBe('base-1');
    expect(Object.keys(assembled).some((key) => key.startsWith('ci_'))).toBe(false);
    expect(assembled.collect_info).toEqual({
      collection_mode: 'preview', ready_target: 300, supply_hold: false, limit: 500,
      target_progress: { mode: 'preview', ready_rows: 12, ready_target: 300 },
      construct: { status: 'running', progress: { status: 'processing', current_step_key: 'validate_emails' } },
      plan: { tasks: [{ source: 'companies_directory', rationale: 'основной каталог' }] },
      stats: { rows_total: 400, launchable_rows: 12 },
      validation_retry: true,
      search_policy: { version: 1, phase: 'existing' },
      tasks: [
        { source: 'companies_directory', status: 'done', rows: 12 },
        { source: 'hh_live', status: 'dispatched' },
      ],
    });
  });

  it('числа остаются числами (-> , а не ->>): иначе счётчик строк на карточке потухнет', () => {
    const info = assembleVeBaseCollectInfo(projectedRow()).collect_info as { tasks: { rows?: unknown }[]; limit: unknown };
    expect(typeof info.tasks[0].rows).toBe('number');
    expect(typeof info.limit).toBe('number');
    expect((assembleVeBaseCollectInfo(projectedRow()).collect_info as { supply_hold: unknown }).supply_hold).toBe(false);
  });

  it('adaptive_collection: сводка без pending и без хэшей готовых получателей', () => {
    const completed = [{ id: 'b1', candidates: 100, new_ready: 4 }, { id: 'b2', candidates: 100, new_ready: 7 }];
    const info = assembleVeBaseCollectInfo(projectedRow({
      ci_adaptive_version: 1, ci_adaptive_switches: 2, ci_adaptive_note: 'сменили источник',
      ci_adaptive_pending_id: 'pending-1', ci_adaptive_completed: completed,
    })).collect_info as { adaptive_collection: Record<string, unknown> };
    expect(info.adaptive_collection).toEqual({
      version: 1, switches: 2, note: 'сменили источник', replan_error: undefined,
      checking_batch: true, completed_batches: 2, last_batch: { id: 'b2', candidates: 100, new_ready: 7 },
    });
    expect(JSON.stringify(info)).not.toContain('ready_before');
  });

  it('saved_email_recovery: наружу только фаза', () => {
    const pending = assembleVeBaseCollectInfo(projectedRow({
      ci_saved_email_attempt_id: 'attempt-1', ci_saved_email_batch_id: 'b0de0e2e-0000-4000-8000-000000000000',
    })).collect_info as Record<string, unknown>;
    expect(pending.saved_email_review_pending).toBe(true);
    const failed = assembleVeBaseCollectInfo(projectedRow({
      ci_saved_email_attempt_id: 'attempt-1', ci_saved_email_batch_id: 'b0de0e2e-0000-4000-8000-000000000000',
      ci_saved_email_error: 'boom',
    })).collect_info as Record<string, unknown>;
    expect(failed.saved_email_review_pending).toBe(false);
    expect(assembleVeBaseCollectInfo(projectedRow()).collect_info as Record<string, unknown>)
      .not.toHaveProperty('saved_email_review_pending');
  });

  it('база ручной загрузки: collect_info === null, а не пустой объект', () => {
    const row = { id: 'base-upload', source: 'upload', ...nulls([
      ...VE_BASE_COLLECT_INFO_KEYS.map((key) => `ci_${key}`),
      'ci_search_policy_version', 'ci_adaptive_version', 'ci_saved_email_attempt_id',
      'ci_task_0_source', 'ci_task_0_status', 'ci_task_0_rows',
    ]) };
    expect(assembleVeBaseCollectInfo(row)).toEqual({ id: 'base-upload', source: 'upload', collect_info: null });
  });

  it('переполнение слотов задач видно в логе, а карточка не падает', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const overflow: Record<string, unknown> = {};
    for (let slot = 0; slot <= VE_BASE_TASK_SLOTS; slot += 1) {
      overflow[`ci_task_${slot}_source`] = 'companies_directory';
      overflow[`ci_task_${slot}_status`] = 'done';
      overflow[`ci_task_${slot}_rows`] = slot;
    }
    const info = assembleVeBaseCollectInfo(projectedRow(overflow)).collect_info as { tasks: unknown[] };
    expect(info.tasks).toHaveLength(VE_BASE_TASK_SLOTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tasks projection truncated'));
    warn.mockRestore();
  });

  it('stripTaskHarvest не тронут: collect POST по-прежнему режет полную строку', () => {
    const stripped = stripTaskHarvest({
      id: 'base-1',
      collect_info: {
        collection_mode: 'preview',
        relevance_reserve: { rows: [{ email: 'a@b.c' }] },
        target_checkpoint: { seen_rows: ['x'] },
        search_policy: { version: 1, phase: 'existing', deferred_rows: [{ heavy: true }] },
        tasks: [{ source: 'companies_directory', status: 'done', rows: 12, harvest: [{ heavy: true }] }],
      },
    }).collect_info as Record<string, unknown>;
    expect(stripped).not.toHaveProperty('relevance_reserve');
    expect(stripped).not.toHaveProperty('target_checkpoint');
    expect(stripped.search_policy).toEqual({ version: 1, phase: 'existing' });
    expect(stripped.tasks).toEqual([{ source: 'companies_directory', status: 'done', rows: 12 }]);
  });
});
