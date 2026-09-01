/**
 * @jest-environment node
 *
 * Контракты resume-логики runBaseConstructorJob.
 *
 * Главные сценарии (закрепляем поведение, чтобы при будущих рефакторингах
 * resume не сломался незаметно):
 *
 *   1. Свежий запуск (status=pending, current_step=0) — стартуем с шага 0,
 *      проходим весь pipeline.
 *
 *   2. Resume с last step finished (current_step=N, progress=100) —
 *      пропускаем 1..N-1, выполняем шаг N+1 (если есть). У Вероники
 *      именно этот сценарий: find_emails 3/4 100% → нужно выполнить
 *      только clean_names (4/4).
 *
 *   3. Resume с mid-step (current_step=N, progress=50) — перезапускаем
 *      шаг N. Все наши шаги идемпотентны: enrich пропускает строки
 *      с непустым target, find_emails — с непустым email.
 */

import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import {
  EMAIL_VALIDATION_CHECKPOINT_STATE_COL,
  ENRICH_CHECKPOINT_ATTEMPTED_COL,
  stepValidateEmails,
} from '@/lib/tools/processingSteps';

// Мокаем supabase клиент чтобы наблюдать какие шаги/обновления случились.
// Используем jest.mock для перехвата импорта.
jest.mock('@/lib/supabaseAdmin', () => {
  const updates: Array<Record<string, unknown>> = [];
  let currentJob: Record<string, unknown> = {};

  const builder = {
    select: () => builder,
    insert: () => builder,
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      currentJob = { ...currentJob, ...patch };
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    neq: () => builder,
    single: async () => ({ data: currentJob, error: null }),
    maybeSingle: async () => ({ data: currentJob, error: null }),
  };

  return {
    supabaseAdmin: {
      from: () => builder,
      __setCurrentJob: (job: Record<string, unknown>) => { currentJob = { ...job }; },
      __getUpdates: () => updates,
      __reset: () => { updates.length = 0; currentJob = {}; },
    },
  };
});

// Мокаем сами шаги — они тяжёлые (HTTP-скрапинг, AI calls), нам не нужно
// их реально гонять. Возвращают данные с фейковой колонкой-маркером,
// чтобы тест мог проверить какие шаги отработали.
jest.mock('@/lib/tools/processingSteps', () => {
  const stepNoop = async (data: string[][]) => data;
  const stepValidateEmails = jest.fn(async (
    data: string[][],
    onProgress: (progress: number) => Promise<void>,
  ) => {
    // A resumed step may internally report progress relative to its remaining
    // tail. The worker owns the persisted UI percentage and must clamp these
    // callbacks to the pre-restart floor.
    await onProgress(10);
    return data;
  });
  const original = jest.requireActual('@/lib/tools/processingSteps');
  return {
    ...original,
    stepRemoveEmpty: stepNoop,
    stepFullDedup: stepNoop,
    stepEmailDedup: stepNoop,
    stepFindEmails: stepNoop,
    stepSplitEmails: stepNoop,
    stepSiteCheck: stepNoop,
    stepEnrich: stepNoop,
    stepNameCleanup: stepNoop,
    stepValidateEmails,
    stepTAScore: stepNoop,
    stepPersonalize: stepNoop,
  };
});

interface MockedAdmin {
  __setCurrentJob: (job: Record<string, unknown>) => void;
  __getUpdates: () => Array<Record<string, unknown>>;
  __reset: () => void;
}

const validateEmailsMock = jest.mocked(stepValidateEmails);

describe('runBaseConstructorJob resume logic', () => {
  let admin: MockedAdmin;

  beforeEach(async () => {
    const mod = await import('@/lib/supabaseAdmin');
    admin = mod.supabaseAdmin as unknown as MockedAdmin;
    admin.__reset();
    jest.clearAllMocks();
  });

  it('fresh start: status=pending → runs all steps from 0', async () => {
    admin.__setCurrentJob({
      id: 'job-1',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'pending',
      selected_steps: ['remove_empty', 'dedup_full'],
      step_config: {},
      current_step: 0,
      current_step_progress: 0,
      data: [['col'], ['a'], ['b']],
    });

    await runBaseConstructorJob('job-1');

    const updates = admin.__getUpdates();
    // Должны быть updateJobProgress для обоих шагов (по 2-3 раза каждый).
    const stepKeys = updates
      .map((u) => u.current_step_key)
      .filter((s): s is string => typeof s === 'string');
    expect(stepKeys).toContain('remove_empty');
    expect(stepKeys).toContain('dedup_full');
  });

  it('resume with last step finished (progress=100): skips done steps, runs next', async () => {
    // Сценарий Вероники: find_emails 3/4 100%, должен запуститься только
    // последний шаг (4-й = clean_names).
    admin.__setCurrentJob({
      id: 'job-2',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'processing',
      selected_steps: ['dedup_full', 'check_sites', 'find_emails', 'clean_names'],
      step_config: {},
      current_step: 3,
      current_step_progress: 100,
      total_steps: 4,
      data: [['col'], ['a'], ['b']],
    });

    await runBaseConstructorJob('job-2');

    const updates = admin.__getUpdates();
    const stepKeys = updates
      .map((u) => u.current_step_key)
      .filter((s): s is string => typeof s === 'string');
    // Должны увидеть только clean_names — остальные пропустили.
    expect(stepKeys).toContain('clean_names');
    expect(stepKeys).not.toContain('dedup_full');
    expect(stepKeys).not.toContain('check_sites');
    expect(stepKeys).not.toContain('find_emails');
  });

  it('resume with mid-step (progress<100): re-runs current step', async () => {
    // Шаг 2 завис на 50% — на resume перезапускаем именно его.
    admin.__setCurrentJob({
      id: 'job-3',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'processing',
      selected_steps: ['remove_empty', 'dedup_full', 'find_emails'],
      step_config: {},
      current_step: 2,
      current_step_progress: 50,
      total_steps: 3,
      data: [['col'], ['a'], ['b']],
    });

    await runBaseConstructorJob('job-3');

    const updates = admin.__getUpdates();
    const stepKeys = updates
      .map((u) => u.current_step_key)
      .filter((s): s is string => typeof s === 'string');
    // remove_empty (1-й) — пропустили; dedup_full (2-й, тот что висел) — перезапустили; find_emails (3-й) — выполнили.
    expect(stepKeys).not.toContain('remove_empty');
    expect(stepKeys).toContain('dedup_full');
    expect(stepKeys).toContain('find_emails');
  });

  it('resume validate_emails never reports less than the saved 45%', async () => {
    admin.__setCurrentJob({
      id: 'job-validation-progress-floor',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'processing',
      selected_steps: ['validate_emails'],
      step_config: {},
      current_step: 1,
      current_step_key: 'validate_emails',
      current_step_progress: 45,
      total_steps: 1,
      data: [
        ['Email', 'Email Статус', 'Email Провайдер'],
        ['pending@example.com', '', ''],
      ],
    });

    await runBaseConstructorJob('job-validation-progress-floor');

    const updates = admin.__getUpdates();
    const validationProgress = updates
      .filter((update) => update.current_step_key === 'validate_emails')
      .map((update) => update.current_step_progress)
      .filter((progress): progress is number => typeof progress === 'number');

    expect(validationProgress.length).toBeGreaterThan(0);
    expect(Math.min(...validationProgress)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...validationProgress)).toBeLessThanOrEqual(99);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'completed',
        current_step_key: 'done',
        current_step_progress: 100,
      }),
    ]));
  });

  it('updateJobProgress bumps started_at as heartbeat', async () => {
    admin.__setCurrentJob({
      id: 'job-4',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'pending',
      selected_steps: ['remove_empty'],
      step_config: {},
      current_step: 0,
      current_step_progress: 0,
      data: [['col'], ['a']],
    });

    await runBaseConstructorJob('job-4');

    const updates = admin.__getUpdates();
    // Хотя бы один updateJobProgress должен включать started_at — это
    // heartbeat. Без него autoCompleteIfStuck/claimStaleResumable
    // не сможет отличить «работает» от «умерло».
    const heartbeats = updates.filter(
      (u) => 'current_step_progress' in u && 'started_at' in u,
    );
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it('resume после завершённого enrich не передаёт checkpoint metadata дальше', async () => {
    admin.__setCurrentJob({
      id: 'job-5',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'processing',
      selected_steps: ['enrich_descriptions', 'ta_scoring'],
      step_config: {},
      current_step: 1,
      current_step_progress: 100,
      total_steps: 2,
      data: [
        ['Компания', 'Сайт', 'Описание', ENRICH_CHECKPOINT_ATTEMPTED_COL],
        ['Alpha', 'https://alpha.example', '', '1'],
      ],
    });

    await runBaseConstructorJob('job-5');

    const finalUpdate = admin.__getUpdates().find((update) => update.status === 'completed');
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate?.data as string[][])[0]).toEqual(['Компания', 'Сайт', 'Описание']);
  });

  it('resume после validate_emails=100 не экспортирует private validation state', async () => {
    admin.__setCurrentJob({
      id: 'job-validation-finished-before-persist',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'processing',
      selected_steps: ['validate_emails'],
      step_config: {},
      current_step: 1,
      current_step_key: 'validate_emails',
      current_step_progress: 100,
      total_steps: 1,
      data: [
        ['Email', 'Email Статус', EMAIL_VALIDATION_CHECKPOINT_STATE_COL],
        [
          'ok@example.com',
          'ok',
          '{"ok@example.com":{"attempts":1,"result":"ok"}}',
        ],
      ],
    });

    await runBaseConstructorJob('job-validation-finished-before-persist');

    expect(validateEmailsMock).toHaveBeenCalledTimes(1);
    const updates = admin.__getUpdates();
    const replayProgress = updates
      .filter((update) => update.current_step_key === 'validate_emails')
      .map((update) => update.current_step_progress)
      .filter((progress): progress is number => typeof progress === 'number');
    expect(Math.min(...replayProgress)).toBeGreaterThanOrEqual(99);
    const finalUpdate = updates.find((update) => update.status === 'completed');
    expect(finalUpdate).toBeDefined();
    expect((finalUpdate?.data as string[][])[0]).toEqual(['Email', 'Email Статус']);
    expect(finalUpdate?.result_stats).toEqual(expect.objectContaining({ columns: 2 }));
  });
});
