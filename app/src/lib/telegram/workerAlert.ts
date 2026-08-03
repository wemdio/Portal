/**
 * Отправка TG-алерта из воркеров при сбое синка / отчёта.
 *
 * Используется в one-shot cron-воркерах (leadsReportCron, salesReportCron,
 * leadsReportSummaryCron): если prod-запуск упал по любой причине —
 * администраторы получают короткое сообщение в TG «что-то не так и почему»,
 * вместо того чтобы обнаружить пропущенный отчёт через день.
 *
 * Env-переменные:
 *  - WORKER_ALERT_TG_BOT_TOKEN / WORKER_ALERT_TG_ADMIN_IDS — приоритетно.
 *  - LEADS_REPORT_TG_BOT_TOKEN / LEADS_REPORT_TG_ADMIN_IDS — fallback,
 *    чтобы алерты работали «из коробки» на уже настроенном боте отчётов.
 *
 * Никогда не бросает — если TG API отвалился, просто логирует в stderr
 * и возвращает управление. Один сбойный алерт не должен маскировать
 * реальную ошибку воркера, которая его вызвала.
 */

const MAX_MSG_LEN = 3800; // TG hard-limit 4096, оставляем запас на форматирование

function loadCreds(): { token: string; chatIds: string[] } | null {
  const token =
    process.env.WORKER_ALERT_TG_BOT_TOKEN ??
    process.env.LEADS_REPORT_TG_BOT_TOKEN ??
    '';
  const raw =
    process.env.WORKER_ALERT_TG_ADMIN_IDS ??
    process.env.LEADS_REPORT_TG_ADMIN_IDS ??
    '';
  const chatIds = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token || chatIds.length === 0) return null;
  return { token, chatIds };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type WorkerAlert = {
  /** Идентификатор воркера, например 'leads-report-cron'. */
  workerId: string;
  /** Короткий заголовок причины: «report failed», «monthly sheet missing». */
  subject: string;
  /** Полный текст ошибки (Error.message / stack / plain string). */
  error: unknown;
  /** Опциональный контекст: имя таблицы, config, spreadsheetId и т.п. */
  context?: Record<string, string | number | null | undefined>;
};

export async function sendWorkerAlert(alert: WorkerAlert): Promise<void> {
  const creds = loadCreds();
  if (!creds) {
    console.warn(
      `[worker-alert] no TG creds (${alert.workerId}: ${alert.subject}) — skip send`,
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`🚨 <b>${escapeHtml(alert.workerId)}</b>: ${escapeHtml(alert.subject)}`);
  lines.push('');
  lines.push(`<code>${escapeHtml(formatError(alert.error))}</code>`);
  if (alert.context) {
    lines.push('');
    for (const [k, v] of Object.entries(alert.context)) {
      if (v === null || v === undefined || v === '') continue;
      lines.push(`• <i>${escapeHtml(k)}</i>: <code>${escapeHtml(String(v))}</code>`);
    }
  }
  const text = lines.join('\n').slice(0, MAX_MSG_LEN);

  for (const chatId of creds.chatIds) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${creds.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(
          `[worker-alert] TG API rejected (${res.status}) for chat=${chatId}: ${body}`,
        );
      }
    } catch (e) {
      console.warn(`[worker-alert] TG send failed for chat=${chatId}:`, e);
    }
  }
}
