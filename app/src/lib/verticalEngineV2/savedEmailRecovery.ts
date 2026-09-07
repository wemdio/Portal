import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { VeJob } from './types';
import type { VeStageContext } from './stages/shared';
import { VeRelevanceCheckpointError } from './relevanceCheckpoint';
import { veRelevanceDecisionSchema } from './relevanceDecision';
import { needsVeSavedEmailReview, singleVeSavedEmail as singleEmail } from './savedEmailReviewEligibility';

export { needsVeSavedEmailReview } from './savedEmailReviewEligibility';

const EMAIL_BATCH = 200;
const EMAIL_WAIT_MS = 6 * 60 * 60 * 1000;
const emailResult = z.enum(['ok', 'invalid', 'disposable', 'catch_all', 'unknown']);
const stateSchema = z.object({
  version: z.literal(1), attempt_id: z.string().min(1),
  checked: z.record(z.string(), emailResult),
  batch: z.object({ id: z.string().uuid(), started_at: z.string(), emails: z.array(z.string()).min(1).max(EMAIL_BATCH) }).optional(),
  error: z.string().optional(),
});
export type VeSavedEmailRecoveryState = z.infer<typeof stateSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function applyResults(rows: Array<Record<string, unknown>>, state: VeSavedEmailRecoveryState) {
  return rows.map((row) => {
    const email = singleEmail(row);
    const status = email ? state.checked[hash(email)] : undefined;
    if (!status || !needsVeSavedEmailReview(row)) return row;
    const relevance = veRelevanceDecisionSchema.safeParse(row._ve_relevance);
    const explicitlyRelevant = relevance.success && relevance.data.status === 'relevant' && relevance.data.evidence.length > 0;
    return { ...row, email, _email_status: status,
      // Recovering SMTP delivery proves nothing about the target hypothesis.
      // Legacy rows have no explicit decision: force the real relevance gate
      // before the newly valid address can enter the launchable projection.
      ...(status === 'ok' && !explicitlyRelevant ? { _relevance_unchecked: true } : {}),
    };
  });
}

/** Saved addresses only. Existing constructor worker supplies its normal SMTP
 * retries/checkpoints; the VE2 worker never blocks through those backoffs. */
export async function recoverVeSavedEmails(input: {
  ctx: VeStageContext; job: VeJob; baseId: string; rows: Array<Record<string, unknown>>;
  state?: unknown;
  save: (state: VeSavedEmailRecoveryState, rows: Array<Record<string, unknown>>) => Promise<void>;
}): Promise<{ rows: Array<Record<string, unknown>>; state: VeSavedEmailRecoveryState; waiting: boolean; error?: string }> {
  const { ctx, job, baseId } = input;
  ctx.signal?.throwIfAborted();
  const parsed = input.state === undefined ? null : stateSchema.safeParse(input.state);
  if (parsed && !parsed.success) throw new VeRelevanceCheckpointError('Saved email recovery checkpoint is invalid');
  let state: VeSavedEmailRecoveryState = parsed?.success ? parsed.data : { version: 1, attempt_id: job.id, checked: {} };
  if (state.attempt_id !== job.id) {
    // A previous parent may have failed while its child kept working. Reuse
    // that child, not a second concurrent validation of the same addresses.
    state = { version: 1, attempt_id: job.id, checked: {}, ...(state.batch ? { batch: state.batch } : {}) };
  }
  let rows = applyResults(input.rows, state);
  const save = async () => {
    ctx.signal?.throwIfAborted();
    try { await input.save(state, rows); }
    catch (error) {
      ctx.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new VeRelevanceCheckpointError(error instanceof Error ? error.message : 'Email recovery save failed');
    }
    ctx.signal?.throwIfAborted();
  };
  const pending = () => [...new Set(rows.filter(needsVeSavedEmailReview).map(singleEmail).filter((email): email is string => !!email))]
    .filter((email) => !state.checked[hash(email)]).sort();
  if (state.error) return { rows, state, waiting: false, error: state.error };
  if (!state.batch) {
    const emails = pending().slice(0, EMAIL_BATCH);
    if (!emails.length) return { rows, state, waiting: false };
    const digest = hash(['ve2-saved-email', baseId, job.id, emails]);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    state.batch = { id, emails, started_at: new Date().toISOString() };
    await save(); // Durable intent precedes the child INSERT, including ambiguous failures.
  }
  const batch = state.batch;
  const label = `VE2 · Проверка сохранённых email · ${baseId}`;
  const readChild = async () => {
    const result = await ctx.supabase.from('base_constructor_jobs')
      .select('id, user_id, file_name, status, selected_steps, data')
      .eq('id', batch.id).maybeSingle();
    ctx.signal?.throwIfAborted();
    if (result.error) throw new Error(`Saved email child read: ${result.error.message}`);
    return result.data;
  };
  let child = await readChild();
  if (!child) {
    const { data: project, error: ownerError } = await ctx.supabase.from('ve_projects')
      .select('created_by').eq('id', job.project_id).single();
    ctx.signal?.throwIfAborted();
    if (ownerError || !project?.created_by) throw new Error('Saved email validation owner is unavailable');
    const { error: insertError } = await ctx.supabase.from('base_constructor_jobs').insert({
      id: batch.id, user_id: project.created_by, file_name: label, status: 'pending', locale: 'ru',
      selected_steps: ['validate_emails'], step_config: { validate_emails: { keepUnverifiable: true } },
      data: [['Email', 'VE2 Key'], ...batch.emails.map((email) => [email, hash(email)])],
      initial_row_count: batch.emails.length, total_steps: 1,
    });
    ctx.signal?.throwIfAborted();
    // Do not generate a new child UUID after an ambiguous insertion response.
    child = await readChild();
    if (!child) throw new Error(`Saved email child enqueue unconfirmed: ${insertError?.message ?? 'missing child'}`);
  }
  if (child.file_name !== label || !Array.isArray(child.selected_steps)
    || child.selected_steps.length !== 1 || child.selected_steps[0] !== 'validate_emails') {
    throw new Error('Saved email child does not match the requested validation-only operation');
  }
  if (['pending', 'processing'].includes(child.status)) {
    const started = Date.parse(batch.started_at);
    if (!Number.isFinite(started) || Date.now() - started > EMAIL_WAIT_MS) {
      state.error = 'Проверка сохранённых email не завершилась за 6 часов. Контакты сохранены; проверьте состояние конструктора перед повтором.';
      await save();
      return { rows, state, waiting: false, error: state.error };
    }
    return { rows, state, waiting: true };
  }
  if (!['completed', 'failed', 'cancelled'].includes(child.status)) throw new Error('Unexpected saved email child status');
  const grid: unknown = child.data;
  const values = new Map<string, z.infer<typeof emailResult>>();
  const conflicting = new Set<string>();
  if (Array.isArray(grid) && Array.isArray(grid[0])) {
    const header = grid[0].map((cell: unknown) => String(cell ?? '').trim());
    const emailIndex = header.indexOf('Email'), keyIndex = header.indexOf('VE2 Key'), statusIndex = header.indexOf('Email Статус');
    const expected = new Set(batch.emails);
    if (emailIndex >= 0 && keyIndex >= 0 && statusIndex >= 0) for (const raw of grid.slice(1)) {
      if (!Array.isArray(raw)) continue;
      const email = String(raw[emailIndex] ?? '').trim().toLowerCase();
      const status = emailResult.safeParse(String(raw[statusIndex] ?? '').trim().toLowerCase());
      if (!expected.has(email) || raw[keyIndex] !== hash(email)) continue;
      // A matching row with a missing/technical/unrecognised verdict is not
      // positive evidence. Include it in duplicate conflict detection as unknown.
      const verdict = status.success ? status.data : 'unknown';
      // Contradictory duplicate output cannot silently upgrade an address.
      if (values.has(email) && values.get(email) !== verdict) conflicting.add(email);
      values.set(email, conflicting.has(email) ? 'unknown' : verdict);
    }
  }
  for (const email of batch.emails) state.checked[hash(email)] = values.get(email) ?? 'unknown';
  // The constructor omits invalid rows from its final grid. Absence alone is
  // not copied as a negative verdict: keep the original contact as unknown.
  delete state.batch;
  if (child.status !== 'completed') state.error = 'Проверка сохранённых email завершилась не полностью. Подтверждённые результаты сохранены; остальные можно проверить повторно.';
  rows = applyResults(rows, state);
  await save();
  return { rows, state, waiting: !state.error && pending().length > 0, ...(state.error ? { error: state.error } : {}) };
}
