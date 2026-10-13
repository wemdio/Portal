import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INTERNAL_ROLES } from '@/lib/roles';
import { MAX_MANUAL_CONSTRUCTOR_JOBS } from './baseConstructorCapacity';
import { countActiveManualConstructorJobs } from './baseConstructorQueue';

type RetryResult =
  | { ok: true; status: 'pending' | 'processing' }
  | { ok: false; httpStatus: number; error: string };

const changed = (): RetryResult => ({
  ok: false, httpStatus: 409,
  error: 'Состояние задачи изменилось. Откройте её заново в истории.',
});
const unavailable = (): RetryResult => ({
  ok: false, httpStatus: 503,
  error: 'Не удалось проверить или обновить задачу. Попробуйте снова: повторное нажатие не создаст дубликат.',
});

/** Staff self-service only. Automation parents and client billing own their retries. */
export async function resumeFailedConstructorJob(
  db: SupabaseClient, userId: string, jobId: string, failedAt: string | null,
): Promise<RetryResult> {
  const { data: profile, error: profileError } = await db.from('profiles')
    .select('role').eq('id', userId).single();
  if (profileError) return unavailable();
  if (!INTERNAL_ROLES.some((role) => role === profile?.role)) {
    return { ok: false, httpStatus: 403, error: 'Возобновление доступно только сотрудникам.' };
  }

  // Only metadata and the header, never a multi-MB row blob. Ownership is
  // checked in SQL on EVERY read/write, since this is the service-role client.
  const read = () => db.from('base_constructor_jobs')
    .select('id, status, workload_origin, current_step, selected_steps, completed_at, run_token, checkpoint_header:data->0')
    .eq('id', jobId).eq('user_id', userId).maybeSingle();
  const { data: job, error } = await read();
  if (error) return unavailable();
  if (!job) return { ok: false, httpStatus: 404, error: 'Задача не найдена.' };
  if (job.workload_origin != null && job.workload_origin !== 'manual') {
    return { ok: false, httpStatus: 409, error: 'Этой задачей управляет автоматизация. Возобновите её в исходном инструменте.' };
  }
  // Lost response / two tabs: never start another run or consume another slot.
  if (job.status === 'pending' || job.status === 'processing') return { ok: true, status: job.status };
  if (job.status !== 'failed' || job.completed_at !== failedAt) return changed();
  if (!Array.isArray(job.checkpoint_header) || job.checkpoint_header.length === 0
    || !Array.isArray(job.selected_steps) || job.selected_steps.length === 0
    || !Number.isInteger(job.current_step) || job.current_step < 0
    || job.current_step > job.selected_steps.length) {
    return { ok: false, httpStatus: 409, error: 'Не найдена корректная точка восстановления. Обратитесь в поддержку, исходную задачу мы не изменили.' };
  }

  let active: number;
  try { active = await countActiveManualConstructorJobs(db, userId); }
  catch { return unavailable(); }
  if (active >= MAX_MANUAL_CONSTRUCTOR_JOBS) {
    return { ok: false, httpStatus: 409, error: `У вас уже ${MAX_MANUAL_CONSTRUCTOR_JOBS} ручных баз в работе или очереди. Дождитесь завершения одной из них и попробуйте снова.` };
  }

  // Preserve data (including private checkpoints), config, steps, progress and
  // stats. Claiming pending makes status=processing before the runner reads it,
  // so its existing resume logic skips completed steps. Rotate the token NOW,
  // not only on claim, to fence late writes from the failed worker generation.
  let update = db.from('base_constructor_jobs').update({
    status: 'pending', error_message: null, completed_at: null,
    run_token: randomUUID(),
  }).eq('id', jobId).eq('user_id', userId).eq('status', 'failed')
    .or('workload_origin.is.null,workload_origin.eq.manual');
  update = job.run_token == null ? update.is('run_token', null) : update.eq('run_token', job.run_token);
  update = failedAt === null ? update.is('completed_at', null) : update.eq('completed_at', failedAt);
  const { data: updated, error: updateError } = await update.select('id').maybeSingle();
  if (updateError) return unavailable();
  if (updated) return { ok: true, status: 'pending' };

  // Another request won the CAS. A fresh failure is NOT retried by a delayed
  // click belonging to the old failure; the user must inspect the new error.
  const { data: latest, error: latestError } = await read();
  if (latestError) return unavailable();
  if (latest && (latest.workload_origin == null || latest.workload_origin === 'manual')
    && (latest.status === 'pending' || latest.status === 'processing')) {
    return { ok: true, status: latest.status };
  }
  return changed();
}
