/**
 * @jest-environment node
 *
 * Regression for the pipeline-ordering bug surfaced by polza@polza.ru
 * job constructor_2026-05-27 (1).csv: find_emails(target='separate')
 * created `Найденный Email` with multiple scraped addresses per company,
 * but the final mergeFoundEmailColumn() ran AFTER split_emails — so
 * split only saw a single original email per row, and the final merge
 * put N scraped addresses back into a single cell. Result: multi-email
 * cells in the output that Instantly validates as one (invalid) string
 * and drops.
 *
 * Fix (in baseConstructorWorker.ts): eagerly run mergeFoundEmailColumn
 * at the START of every iteration whose `data` still has FOUND_EMAIL_COL.
 * This guarantees split_emails always sees a single email column with
 * all scraped addresses, so it explodes them into separate rows.
 *
 * This test verifies that contract end-to-end by:
 *   - mocking stepFindEmails to add FOUND_EMAIL_COL with multi-email cells
 *   - capturing what stepSplitEmails sees as input
 *   - asserting it sees a single, merged email column (no FOUND_EMAIL_COL).
 */

jest.mock('@/lib/supabaseAdmin', () => {
  let currentJob: Record<string, unknown> = {};
  const builder = {
    select: () => builder,
    insert: () => builder,
    update: (patch: Record<string, unknown>) => {
      currentJob = { ...currentJob, ...patch };
      return builder;
    },
    eq: () => builder,
    single: async () => ({ data: currentJob, error: null }),
    maybeSingle: async () => ({ data: currentJob, error: null }),
  };
  return {
    supabaseAdmin: {
      from: () => builder,
      __setCurrentJob: (job: Record<string, unknown>) => { currentJob = { ...job }; },
      __reset: () => { currentJob = {}; },
    },
  };
});

// Capture what each step receives, so we can assert the eager merge
// already happened before split_emails runs.
const stepInputs: Record<string, string[][]> = {};

jest.mock('@/lib/tools/processingSteps', () => {
  const original = jest.requireActual('@/lib/tools/processingSteps');
  return {
    ...original,
    stepRemoveEmpty: async (data: string[][]) => data,
    stepFullDedup: async (data: string[][]) => data,
    stepEmailDedup: async (data: string[][]) => data,
    stepSiteCheck: async (data: string[][]) => data,
    stepNameCleanup: async (data: string[][]) => data,
    stepValidateEmails: async (data: string[][]) => data,
    stepEnrich: async (data: string[][]) => data,
    stepTAScore: async (data: string[][]) => data,
    stepPersonalize: async (data: string[][]) => data,

    // find_emails: simulate target='separate' adding FOUND_EMAIL_COL with
    // multi-email cells like a real scraper would.
    stepFindEmails: async (data: string[][]) => {
      stepInputs['find_emails'] = data.map((r) => [...r]);
      const FOUND_EMAIL_COL = 'Найденный Email';
      const newHeader = [...data[0], FOUND_EMAIL_COL];
      const newBody = data.slice(1).map((row, i) => {
        const found = i === 0
          ? 'a@x.ru, b@x.ru, c@x.ru'   // company 0: 3 scraped emails
          : 'd@y.ru';                   // company 1: 1 scraped email
        return [...row, found];
      });
      return [newHeader, ...newBody];
    },

    // split_emails: snapshot what it receives — this is the assertion
    // surface. The real step would explode multi-email cells; for the
    // test we just record the input.
    stepSplitEmails: async (data: string[][]) => {
      stepInputs['split_emails'] = data.map((r) => [...r]);
      return data;
    },
  };
});

import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';

beforeEach(async () => {
  const mod = await import('@/lib/supabaseAdmin');
  (mod.supabaseAdmin as unknown as { __reset: () => void }).__reset();
  for (const k of Object.keys(stepInputs)) delete stepInputs[k];
});

describe('eager merge of FOUND_EMAIL_COL before subsequent steps', () => {
  it('split_emails receives data WITHOUT FOUND_EMAIL_COL — merge already happened', async () => {
    const mod = await import('@/lib/supabaseAdmin');
    (mod.supabaseAdmin as unknown as {
      __setCurrentJob: (j: Record<string, unknown>) => void;
    }).__setCurrentJob({
      id: 'job-em-1',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'pending',
      selected_steps: ['find_emails', 'split_emails'],
      step_config: {},
      current_step: 0,
      current_step_progress: 0,
      data: [
        ['компания', 'сайт', 'email'],
        ['Acme', 'acme.com', 'orig-a@x.ru'],
        ['Beta', 'beta.io', 'orig-b@y.ru'],
      ],
    });

    await runBaseConstructorJob('job-em-1');

    // find_emails ran first and saw the original 3-col input.
    expect(stepInputs['find_emails']).toBeDefined();
    expect(stepInputs['find_emails'][0]).toEqual(['компания', 'сайт', 'email']);

    // split_emails ran next. Its input MUST NOT include FOUND_EMAIL_COL —
    // the eager-merge step would have folded it into the existing email
    // column before split's runner was called.
    expect(stepInputs['split_emails']).toBeDefined();
    const splitInputHeader = stepInputs['split_emails'][0];
    expect(splitInputHeader).not.toContain('Найденный Email');
    // Original col count = 3. Merge collapses FOUND_EMAIL_COL into `email`,
    // so split also sees 3 columns.
    expect(splitInputHeader).toHaveLength(3);

    // The merged `email` cell must contain all addresses (original + scraped),
    // case-insensitive deduped — split_emails would then explode these into
    // separate rows in the real implementation.
    const splitInputBody = stepInputs['split_emails'].slice(1);
    expect(splitInputBody[0][2]).toBe('orig-a@x.ru, a@x.ru, b@x.ru, c@x.ru');
    expect(splitInputBody[1][2]).toBe('orig-b@y.ru, d@y.ru');
  });

  it('no-op when find_emails is not in selected steps', async () => {
    // Sanity: without find_emails, FOUND_EMAIL_COL never appears, eager
    // merge is a no-op. split_emails just sees the original data unchanged.
    const mod = await import('@/lib/supabaseAdmin');
    (mod.supabaseAdmin as unknown as {
      __setCurrentJob: (j: Record<string, unknown>) => void;
    }).__setCurrentJob({
      id: 'job-em-2',
      user_id: 'u',
      file_name: 'test.csv',
      status: 'pending',
      selected_steps: ['split_emails'],
      step_config: {},
      current_step: 0,
      current_step_progress: 0,
      data: [
        ['компания', 'email'],
        ['Acme', 'a@x.ru'],
      ],
    });

    await runBaseConstructorJob('job-em-2');

    expect(stepInputs['split_emails']).toBeDefined();
    expect(stepInputs['split_emails'][0]).toEqual(['компания', 'email']);
    expect(stepInputs['split_emails'][1]).toEqual(['Acme', 'a@x.ru']);
  });
});
