import { INTERNAL_ROLES } from '@/lib/roles';

export const CLIENT_CONSTRUCTOR_ERROR =
  'Не удалось завершить обработку базы. Обратитесь в поддержку — мы проверим причину и поможем получить результат.';

type JobDiagnostics = {
  error_message?: string | null;
  result_stats?: Record<string, unknown> | null;
};

/** Provider responses belong in staff diagnostics, never in the client API. */
export function presentConstructorJob<T extends JobDiagnostics>(job: T, role: string | null): T {
  if (INTERNAL_ROLES.some((internalRole) => internalRole === role)) return job;
  const stats = job.result_stats ? { ...job.result_stats } : job.result_stats;
  if (stats) {
    delete stats.ta_scoring_errors;
    delete stats.ta_scoring_telemetry;
  }
  return {
    ...job,
    result_stats: stats,
    error_message: job.error_message ? CLIENT_CONSTRUCTOR_ERROR : job.error_message,
  };
}
