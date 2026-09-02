/**
 * @jest-environment node
 *
 * Durable resume contract for the Base Constructor email-validation step.
 *
 * Production incident (01.09.2026): a deploy recreated the constructor
 * workers while Lyuba's validation was around 45%. Public status/provider
 * columns let us skip conclusive rows, but retryable unknowns had no durable
 * attempt counter and the resumed progress was reported relative to the
 * remaining tail (45% -> 0%). A rejected checkpoint write was also swallowed
 * by processInPool, so the UI could claim progress that was never persisted.
 *
 * These tests deliberately exercise the step through its public callbacks;
 * they do not prescribe the private checkpoint encoding beyond the existing
 * `__portal_*` convention.
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

jest.mock('@/lib/emailValidation/validator', () => ({
  validateEmail: jest.fn(),
}));

import { validateEmail, type ValidationResult } from '@/lib/emailValidation/validator';
import {
  EMAIL_VALIDATION_CHECKPOINT_STATE_COL,
  stepValidateEmails,
} from '@/lib/tools/processingSteps';

const validateEmailMock = jest.mocked(validateEmail);
const cloneRows = (rows: string[][]): string[][] => rows.map((row) => [...row]);
const privateColumns = (header: string[]): string[] =>
  header.filter((column) => column.startsWith('__portal_'));

function okResult(): ValidationResult {
  return {
    result: 'ok',
    quality: 'good',
    is_free: false,
    is_role: false,
    is_disposable: false,
    is_catch_all: false,
    did_you_mean: null,
    mx_found: true,
    smtp_code: 250,
    details: {},
    error: '',
  };
}

function retryableUnknownResult(): ValidationResult {
  return {
    result: 'unknown',
    quality: 'risky',
    is_free: false,
    is_role: false,
    is_disposable: false,
    is_catch_all: false,
    did_you_mean: null,
    mx_found: true,
    smtp_code: 451,
    details: {},
    error: 'SMTP timeout; retry later',
  };
}

describe('stepValidateEmails durable checkpoint/resume', () => {
  beforeEach(() => {
    validateEmailMock.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resumes a partial checkpoint without probing conclusive addresses again', async () => {
    let nowMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    validateEmailMock.mockResolvedValue(okResult());

    const total = 120;
    const input = [
      ['Email'],
      ...Array.from({ length: total }, (_, index) => [`person-${index}@domain-${index}.example`]),
    ];

    let cancelled = false;
    let latestProgress = 0;
    let checkpoint: string[][] | undefined;

    await expect(stepValidateEmails(
      input,
      async (progress) => {
        latestProgress = progress;
        // Force the time-based checkpoint around the incident's 45% mark;
        // the pool may have a few already-in-flight probes, which is fine.
        if (progress >= 45 && !checkpoint) nowMs = 60_001;
      },
      async () => cancelled,
      {
        onCheckpoint: async (rows) => {
          if (!checkpoint) {
            checkpoint = cloneRows(rows);
            cancelled = true; // simulate SIGTERM immediately after durable save
          }
        },
      },
    )).rejects.toThrow('Отменено');

    expect(checkpoint).toBeDefined();
    expect(latestProgress).toBeGreaterThanOrEqual(45);

    const saved = checkpoint!;
    const emailIdx = saved[0].indexOf('Email');
    const statusIdx = saved[0].indexOf('Email Статус');
    const conclusiveEmails = saved
      .slice(1)
      .filter((row) => ['ok', 'invalid', 'disposable', 'catch_all'].includes(row[statusIdx]))
      .map((row) => row[emailIdx]);

    expect(conclusiveEmails.length).toBeGreaterThanOrEqual(45);
    expect(conclusiveEmails.length).toBeLessThan(total);

    cancelled = false;
    validateEmailMock.mockClear();
    const resumedProgress: number[] = [];
    const out = await stepValidateEmails(
      saved,
      async (progress) => { resumedProgress.push(progress); },
      async () => false,
    );

    const probedOnResume = new Set(
      validateEmailMock.mock.calls.map(([email]) => String(email).toLowerCase()),
    );
    for (const email of conclusiveEmails) {
      expect(probedOnResume).not.toContain(email.toLowerCase());
    }
    expect(probedOnResume.size).toBe(total - conclusiveEmails.length);
    expect(out).toHaveLength(total + 1);
  });

  it('persists and bounds attempts for retryable unknown across a restart', async () => {
    let nowMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    validateEmailMock.mockResolvedValue(retryableUnknownResult());

    let cancelled = false;
    let checkpoint: string[][] | undefined;
    await expect(stepValidateEmails(
      [['Email'], ['greylisted@example.com']],
      async () => {},
      async () => cancelled,
      {
        onCheckpoint: async (rows) => {
          checkpoint = cloneRows(rows);
          cancelled = true; // crash after attempt #1 was saved
        },
      },
    )).rejects.toThrow('Отменено');

    expect(validateEmailMock).toHaveBeenCalledTimes(1);
    expect(checkpoint).toBeDefined();

    cancelled = false;
    validateEmailMock.mockReset();
    validateEmailMock.mockImplementation(async () => {
      // Eliminate the real five-minute greylist delay. The behavioural point
      // is the persisted max-attempt guard, not timers.
      nowMs += 5 * 60_000 + 1;
      return retryableUnknownResult();
    });

    const out = await stepValidateEmails(
      checkpoint!,
      async () => {},
      async () => false,
    );

    // Existing policy is one initial probe + one retry. A redeploy must not
    // reset that budget and issue a third SMTP request.
    expect(validateEmailMock).toHaveBeenCalledTimes(1);
    // Attempt count must live in the durable row matrix, not process memory.
    expect(privateColumns(checkpoint![0]).length).toBeGreaterThan(0);
    expect(out[1][0]).toBe('greylisted@example.com');
    expect(out[1][out[0].indexOf('Email Статус')]).toBe('unknown');
    // Checkpoint-only attempt metadata must never reach user data/export.
    expect(privateColumns(out[0])).toEqual([]);
  });

  it('resumes the unprobed address in a partially validated multi-email cell', async () => {
    const checkpointState = JSON.stringify({
      'bad@example.com': {
        attempts: 1,
        result: 'invalid',
        isFree: false,
        isCatchAll: false,
        errorText: '',
      },
    });
    validateEmailMock.mockResolvedValue(okResult());

    const out = await stepValidateEmails(
      [
        ['Email', 'Email Статус', 'Email Провайдер', EMAIL_VALIDATION_CHECKPOINT_STATE_COL],
        ['bad@example.com, good@example.com', 'invalid', 'example.com', checkpointState],
      ],
      async () => {},
      async () => false,
    );

    expect(validateEmailMock).toHaveBeenCalledTimes(1);
    expect(validateEmailMock).toHaveBeenCalledWith('good@example.com', expect.any(Map));
    expect(out).toHaveLength(2);
    expect(out[1][out[0].indexOf('Email Статус')]).toBe('ok');
    expect(out[1][0]).toContain('good@example.com');
  });

  it('surfaces a rejected checkpoint instead of continuing with unpersisted progress', async () => {
    validateEmailMock.mockResolvedValue(okResult());

    await expect(stepValidateEmails(
      [['Email'], ['person@example.com']],
      async () => {},
      undefined,
      {
        onCheckpoint: async () => {
          throw new Error('checkpoint storage unavailable');
        },
      },
    )).rejects.toThrow('checkpoint storage unavailable');
  });

  it('serializes checkpoint writes so an older snapshot cannot land last', async () => {
    validateEmailMock.mockResolvedValue(okResult());
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    const input = [
      ['Email'],
      ...Array.from({ length: 600 }, (_, index) => [`person-${index}@domain-${index}.example`]),
    ];

    await stepValidateEmails(
      input,
      async () => {},
      async () => false,
      {
        onCheckpoint: async () => {
          activeWrites += 1;
          maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
          await new Promise((resolve) => setTimeout(resolve, 25));
          activeWrites -= 1;
        },
      },
    );

    expect(maxConcurrentWrites).toBe(1);
  });

  it('checkpoints retry attempts before the whole second-pass pool finishes', async () => {
    let nowMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    validateEmailMock.mockImplementation(async () => {
      // Advance enough that the greylist wait is already satisfied and each
      // retry checkpoint gate is eligible without real timers.
      nowMs += 5 * 60_000 + 1;
      return retryableUnknownResult();
    });
    const total = 20;
    const attemptTwoCounts: number[] = [];

    await stepValidateEmails(
      [
        ['Email'],
        ...Array.from({ length: total }, (_, index) => [`grey-${index}@example.com`]),
      ],
      async () => {},
      async () => false,
      {
        onCheckpoint: async (rows) => {
          const stateIdx = rows[0].indexOf(EMAIL_VALIDATION_CHECKPOINT_STATE_COL);
          const count = rows.slice(1).filter((row) => {
            const state = JSON.parse(row[stateIdx] || '{}') as Record<string, { attempts?: number }>;
            return Object.values(state).some((entry) => entry.attempts === 2);
          }).length;
          if (count > 0) attemptTwoCounts.push(count);
        },
      },
    );

    expect(attemptTwoCounts.some((count) => count > 0 && count < total)).toBe(true);
    expect(attemptTwoCounts.at(-1)).toBe(total);
  });
});
