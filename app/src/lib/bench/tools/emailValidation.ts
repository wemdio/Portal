import { z } from 'zod';
import { buildQueueItems } from '@/lib/emailValidation/queueItems';
import type { BenchJobTool, BenchStatus, JobRow } from '../types';

/**
 * Валидация почт (SMTP-проверка адресов).
 *
 * В портале человек загружает таблицу, а экран заливает адреса в очередь
 * `email_validation_queue`. Витрина делает то же самое из списка в запросе:
 * создаёт строку задачи и очередь от имени робота, дальше работает тот же
 * воркер, что и для людей.
 *
 * Собственные нормы. Общий счёт задач ключа объём не ограничивает — одна
 * задача бывает и на десять адресов, и на десять тысяч. А SMTP-проверка
 * идёт с наших адресов: слишком частые стуки в чужие почтовые серверы
 * загоняют их в чёрные списки, и страдает валидация всей команды. Поэтому
 * у инструмента свои потолки: адресов в задаче, адресов в сутки и одна
 * незавершённая задача за раз (у воркера всего три слота на весь портал).
 */

export const MAX_EMAILS_PER_JOB = 10_000;
export const DAILY_EMAILS_LIMIT = 30_000;
const MAX_ACTIVE_VALIDATIONS = 1;

const QUEUE_INSERT_BATCH = 500;

const paramsSchema = z
  .object({
    emails: z
      .array(z.string().max(320))
      .min(1)
      .max(MAX_EMAILS_PER_JOB)
      .describe(
        `Адреса на проверку, до ${MAX_EMAILS_PER_JOB} в задаче и до ${DAILY_EMAILS_LIMIT} в сутки. ` +
          'Порядок сохраняется: в результатах номер адреса в этом списке — row_index.',
      ),
  })
  .strict();

type Params = z.infer<typeof paramsSchema>;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapStatus(row: JobRow): BenchStatus {
  switch (row.status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'stopped';
    default:
      return 'failed';
  }
}

export const emailValidationTool: BenchJobTool = {
  id: 'email-validation',
  kind: 'job',
  title: 'Валидация почт',
  table: 'email_validation_jobs',
  paramsSchema,
  maxActiveJobs: MAX_ACTIVE_VALIDATIONS,

  /**
   * Задача заводится сразу в `running`, а не в `pending`: воркер подписан на
   * таблицу и забирает `pending` мгновенно — раньше, чем очередь успеет
   * залиться. Он увидел бы пустую очередь и закрыл задачу как выполненную,
   * а адреса так и остались бы непроверенными. В `pending` задачу переводит
   * `afterInsert`, когда очередь уже на месте. Если процесс умрёт между
   * этими шагами, задачу подберёт восстановление при старте воркера — оно
   * возвращает зависшие `running` в `pending`.
   */
  buildRow(params, ownerId) {
    const p = params as Params;
    return {
      user_id: ownerId,
      status: 'running',
      total: p.emails.length,
      processed: 0,
      success_count: 0,
      error_count: 0,
    };
  },

  async afterInsert({ db, job, params }) {
    const p = params as Params;
    const jobId = String(job.id);
    const now = new Date().toISOString();
    const { items, invalidCount } = buildQueueItems(
      p.emails.map((email, rowIndex) => ({ rowIndex, email })),
      String(job.user_id),
      now,
    );

    let insertError: string | null = null;
    for (let i = 0; i < items.length; i += QUEUE_INSERT_BATCH) {
      const batch = items.slice(i, i + QUEUE_INSERT_BATCH).map((item) => ({ ...item, job_id: jobId }));
      const { error } = await db.from('email_validation_queue').insert(batch);
      if (error) {
        insertError = error.message;
        break;
      }
    }

    if (insertError) {
      // Строку не удаляем, а закрываем провалом с причиной: так видно, что
      // произошло, а недолитую очередь уберёт штатная чистка завершённых.
      await db
        .from('email_validation_jobs')
        .update({
          status: 'failed',
          error_message: `Не удалось поставить адреса в очередь: ${insertError}`,
          completed_at: now,
        })
        .eq('id', jobId);
      throw new Error('Не удалось поставить адреса в очередь');
    }

    // Адреса с битым форматом уже закрыты вердиктом `invalid` — считаем их
    // обработанными сразу, как это делает экран портала.
    const { data, error } = await db
      .from('email_validation_jobs')
      .update({ status: 'pending', processed: invalidCount, error_count: invalidCount })
      .eq('id', jobId)
      .select()
      .single();
    if (error || !data) {
      throw new Error(error?.message ?? 'Не удалось запустить задачу');
    }
    return data as JobRow;
  },

  async checkQuota({ db, params, dayStart }) {
    const p = params as Params;
    // Проваленные задачи не в счёт: адреса в них не проверялись.
    const { data, error } = await db
      .from('email_validation_jobs')
      .select('total')
      .gte('created_at', dayStart)
      .neq('status', 'failed');
    if (error) throw new Error(`Не удалось проверить суточную норму: ${error.message}`);

    const usedToday = ((data ?? []) as Array<{ total?: number }>).reduce(
      (sum, row) => sum + num(row.total),
      0,
    );
    if (usedToday + p.emails.length > DAILY_EMAILS_LIMIT) {
      return {
        message: `Суточная норма валидации — ${DAILY_EMAILS_LIMIT} адресов; сегодня уже ${usedToday}`,
        details: {
          limit: DAILY_EMAILS_LIMIT,
          used_today: usedToday,
          requested: p.emails.length,
          resets_at: dayStart,
        },
      };
    }
    return null;
  },

  mapStatus,
  progress: (row) => ({ done: num(row.processed), total: num(row.total) }),
  rowsFound: (row) => num(row.processed),
  errorOf: (row) => text(row.error_message),
  finishedAt: (row) => text(row.completed_at),

  results: {
    kind: 'table',
    table: 'email_validation_queue',
    jobColumn: 'job_id',
    orderColumn: 'id',
    columns:
      'id, row_index, email_raw, email_normalized, status, result, quality, is_free, is_role, is_disposable, is_catch_all, did_you_mean, mx_found, smtp_code, last_error',
  },

  // Остановка настоящая: воркер проверяет статус задачи перед каждой пачкой
  // и, увидев `cancelled`, закрывает оставшиеся адреса и выходит.
  stop: { supported: true, stoppedStatus: 'cancelled' },
};
