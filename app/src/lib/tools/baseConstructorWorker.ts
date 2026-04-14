import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  stepRemoveEmpty,
  stepFullDedup,
  stepEmailDedup,
  stepFindEmails,
  stepSplitEmails,
  stepSiteCheck,
  stepEnrich,
  stepTAScore,
  stepNameCleanup,
  stepPersonalize,
  stepValidateEmails,
  type StepKey,
  type ProgressFn,
  type CancelCheckFn,
} from './processingSteps';
import { extractEmail, findColumnIndex } from './dfybUtils';

const admin = supabaseAdmin!;

interface StepConfig {
  brief?: string;
  prompt?: string;
}

async function updateJobProgress(
  jobId: string,
  stepIndex: number,
  stepKey: string,
  progress: number,
) {
  await admin
    .from('base_constructor_jobs')
    .update({
      current_step: stepIndex + 1,
      current_step_key: stepKey,
      current_step_progress: Math.min(100, Math.max(0, Math.round(progress))),
      status: 'processing',
    })
    .eq('id', jobId);
}

async function isCancelled(jobId: string): Promise<boolean> {
  const { data } = await admin.from('base_constructor_jobs').select('status').eq('id', jobId).single();
  return data?.status === 'cancelled';
}

type StepRunner = (
  data: string[][],
  onProgress: ProgressFn,
  isCancelled: CancelCheckFn,
  config: StepConfig,
) => Promise<string[][]>;

const STEP_RUNNERS: Record<StepKey, StepRunner> = {
  remove_empty: (data, prog) => stepRemoveEmpty(data, prog),
  dedup_full: (data, prog) => stepFullDedup(data, prog),
  dedup_email: (data, prog) => stepEmailDedup(data, prog),
  clean_names: (data, prog, cancel) => stepNameCleanup(data, prog, cancel),
  find_emails: (data, prog, cancel) => stepFindEmails(data, prog, cancel),
  split_emails: (data, prog) => stepSplitEmails(data, prog),
  validate_emails: (data, prog) => stepValidateEmails(data, prog),
  check_sites: (data, prog, cancel) => stepSiteCheck(data, prog, cancel),
  enrich_descriptions: (data, prog, cancel) => stepEnrich(data, prog, cancel),
  ta_scoring: (data, prog, cancel, cfg) => stepTAScore(data, cfg.brief || '', prog, cancel),
  personalization: (data, prog, cancel, cfg) => stepPersonalize(data, cfg.prompt || '', prog, cancel),
};

export async function runBaseConstructorJob(jobId: string): Promise<void> {
  try {
    const { data: job, error } = await admin
      .from('base_constructor_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) throw new Error(`Job not found: ${error?.message}`);

    const selectedSteps: StepKey[] = job.selected_steps || [];
    const stepConfig: StepConfig = job.step_config || {};

    if (selectedSteps.length === 0) throw new Error('Не выбрано ни одного шага');

    await admin.from('base_constructor_jobs').update({
      started_at: new Date().toISOString(),
      status: 'processing',
      total_steps: selectedSteps.length,
    }).eq('id', jobId);

    let data: string[][] = job.data || [];
    if (data.length === 0) throw new Error('Нет данных для обработки');

    const cancelCheck: CancelCheckFn = () => isCancelled(jobId);

    for (let i = 0; i < selectedSteps.length; i++) {
      const stepKey = selectedSteps[i];
      const runner = STEP_RUNNERS[stepKey];
      if (!runner) {
        console.warn(`[base-constructor] Unknown step: ${stepKey}, skipping`);
        continue;
      }

      if (await isCancelled(jobId)) return;

      const progressFn: ProgressFn = (progress) => updateJobProgress(jobId, i, stepKey, progress);
      await progressFn(0);

      data = await runner(data, progressFn, cancelCheck, stepConfig);

      await admin.from('base_constructor_jobs').update({ data }).eq('id', jobId);
    }

    const header = data[0] || [];
    const body = data.slice(1);
    const emailIdx = findColumnIndex(header, 'email');
    const scoreIdx = findColumnIndex(header, 'ца балл', 'цабалл', 'ta score');
    const emailsFound = emailIdx >= 0 ? body.filter((r) => extractEmail(r[emailIdx] || '')).length : 0;
    const avgScore = scoreIdx >= 0
      ? body.reduce((s, r) => s + (parseInt(r[scoreIdx], 10) || 0), 0) / (body.length || 1)
      : 0;

    await admin.from('base_constructor_jobs').update({
      data,
      status: 'completed',
      completed_at: new Date().toISOString(),
      current_step: selectedSteps.length,
      current_step_key: 'done',
      current_step_progress: 100,
      result_stats: {
        total_rows: body.length,
        emails_found: emailsFound,
        avg_ta_score: Math.round(avgScore * 10) / 10,
        columns: header.length,
      },
    }).eq('id', jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[base-constructor] Job ${jobId} failed:`, message);
    await admin.from('base_constructor_jobs').update({
      status: 'failed',
      error_message: message.slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
  }
}
