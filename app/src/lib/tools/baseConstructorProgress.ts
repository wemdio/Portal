/** Display-only telemetry. Never use it to resume, complete or filter a job. */
export type ConstructorProgressDetail = {
  phase: 'checking' | 'retry_wait' | 'retrying' | 'saving';
  /** Counts refer to this pass, including the remaining pass after a resume. */
  completed?: number;
  total?: number;
};

export type ConstructorProgressSnapshot = ConstructorProgressDetail & {
  step_index: number;
  step_key: string;
  updated_at: string;
};

export function describeConstructorProgress(job: {
  status: string;
  current_step: number;
  current_step_key: string;
  current_step_progress: number;
  result_stats?: { step_progress?: unknown } | null;
}): string | null {
  if (job.status !== 'processing') return null;
  const raw = job.result_stats?.step_progress;
  const detail = raw && typeof raw === 'object' ? raw as ConstructorProgressSnapshot : null;
  if (detail?.step_index === job.current_step && detail.step_key === job.current_step_key) {
    if (detail.phase === 'saving') return 'Сохраняем результат этапа';
    if (job.current_step_key === 'validate_emails') {
      const hasCounts = Number.isInteger(detail.completed) && Number.isInteger(detail.total)
        && detail.completed! >= 0 && detail.total! > 0 && detail.completed! <= detail.total!;
      const counts = hasCounts
        ? `${detail.completed!.toLocaleString('ru-RU')} из ${detail.total!.toLocaleString('ru-RU')}` : null;
      if (detail.phase === 'checking') return counts
        ? `Проверено адресов в текущем проходе: ${counts}` : 'Проверяем адреса';
      if (detail.phase === 'retry_wait') return 'Пауза перед повторной проверкой временных ошибок';
      if (detail.phase === 'retrying') return counts
        ? `Повторная проверка временных ошибок: ${counts}` : 'Повторно проверяем временные ошибки';
    }
  }
  // Old workers have no phase telemetry. Do not invent retry counts or an ETA.
  if (job.current_step_key === 'validate_emails' && job.current_step_progress >= 99) {
    return 'Проверка почт ещё не завершена. Возможны повторные проверки и сохранение результатов.';
  }
  return null;
}
