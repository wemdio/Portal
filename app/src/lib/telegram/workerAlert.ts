/**
 * Отправка TG-алерта из воркеров при сбое синка / отчёта.
 *
 * Используется в one-shot cron-воркерах (leadsReportCron,
 * leadsReportSummaryCron): если prod-запуск упал по любой причине —
 * администраторы получают короткое сообщение в TG «что-то не так и почему»,
 * вместо того чтобы обнаружить пропущенный отчёт через день.
 *
 * Дефолтно юзаем существующий health-check бот (он и так шлёт админам
 * каждые 30 мин статус подключения к БД и т.п. — алерты сбоев ложатся в
 * тот же канал, отдельно настраивать ничего не нужно).
 *
 * Env-переменные, в порядке приоритета:
 *  - WORKER_ALERT_TG_BOT_TOKEN / WORKER_ALERT_TG_ADMIN_IDS — override,
 *    если хочется отдельный канал под алерты сбоев.
 *  - TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID — health-check бот.
 *  - TELEGRAM_BOT_TOKEN — общий fallback token.
 *  - LEADS_REPORT_TG_BOT_TOKEN / LEADS_REPORT_TG_ADMIN_IDS — последний
 *    fallback (бот отчётов leads).
 *
 * Никогда не бросает — если TG API отвалился, просто логирует в stderr
 * и возвращает управление. Один сбойный алерт не должен маскировать
 * реальную ошибку воркера, которая его вызвала.
 *
 * Возвращает, принял ли сообщение ХОТЯ БЫ ОДИН чат (true), или не принял
 * никто: нет кредов, TG ответил ошибкой, сеть (false). Значение аддитивное —
 * крон-воркеры (leadsReportCron, leadsReportSummaryCron, gisSignalOutreachCron,
 * gisSignalWatchdogCron) и gisSignalOutreach/pipelineRunner его не читают;
 * читает hypothesisEngine/opsAlert, чтобы не взводить окно дедупликации на
 * алерте, который никуда не ушёл.
 *
 * Длинное сообщение режется ДО экранирования (`formatAlertText`): срез уже
 * собранного HTML мог попасть внутрь тега или сущности, и TG отклонял
 * сообщение целиком (parse error) — алерт пропадал молча. Сообщение, которое
 * влезает в лимит, собирается байт-в-байт как раньше.
 */

const MAX_MSG_LEN = 3800; // TG hard-limit 4096, оставляем запас на форматирование
/**
 * Сколько символов причины (после экранирования) остаётся при любой длине
 * контекста: строки контекста отбрасываются с хвоста раньше, чем причина
 * сожмётся сильнее.
 */
const MIN_ERROR_LEN = 300;
/** Потолок заголовка (воркер + тема) в сообщении, которое пришлось резать. */
const MAX_HEAD_LEN = 600;
const MAX_HEAD_WORKER_LEN = 100;
/** Метка среза: обычный символ — не тег и не сущность. */
const CUT_MARK = '…';

function loadCreds(): { token: string; chatIds: string[] } | null {
  const token =
    process.env.WORKER_ALERT_TG_BOT_TOKEN ||
    process.env.TELEGRAM_HEALTH_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.LEADS_REPORT_TG_BOT_TOKEN ||
    '';
  const raw =
    process.env.WORKER_ALERT_TG_ADMIN_IDS ||
    process.env.TELEGRAM_HEALTH_CHAT_ID ||
    process.env.LEADS_REPORT_TG_ADMIN_IDS ||
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

/**
 * Экранированный `raw` не длиннее `budget` символов. Режется СЫРОЙ текст по
 * целым символам (кодовым точкам — суррогатная пара не рвётся) и только потом
 * экранируется, поэтому сущность `&amp;` / `&lt;` пополам не попадает. У
 * многострочного текста (список проектов) срез отступает к концу последней
 * целой строки, если теряет на этом не больше половины влезшего.
 */
function escapeWithin(raw: string, budget: number): string {
  const escaped = escapeHtml(raw);
  if (escaped.length <= budget) return escaped;
  const room = budget - CUT_MARK.length;
  if (room <= 0) return '';
  let out = '';
  for (const ch of raw) {
    const piece = escapeHtml(ch);
    if (out.length + piece.length > room) break;
    out += piece;
  }
  const lastBreak = out.lastIndexOf('\n');
  if (lastBreak > 0 && lastBreak >= out.length / 2) out = out.slice(0, lastBreak + 1);
  return out + CUT_MARK;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    // undefined / функция / symbol: JSON.stringify отдаёт undefined, а не строку.
    return JSON.stringify(err) ?? String(err);
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

function joinAlert(head: string, errorHtml: string, context: string[] | null): string {
  const lines: string[] = [];
  lines.push(head);
  lines.push('');
  lines.push(`<code>${errorHtml}</code>`);
  if (context) {
    lines.push('');
    lines.push(...context);
  }
  return lines.join('\n');
}

/**
 * Текст сообщения: HTML всегда целый и не длиннее MAX_MSG_LEN.
 *
 * Влезает — собирается ровно как раньше. Не влезает — по порядку:
 *  1. причина (`error`) режется до экранирования, строки контекста целы;
 *  2. если причине при этом остаётся меньше MIN_ERROR_LEN, строки контекста
 *     отбрасываются с хвоста (целиком) и их число пишется последней строкой;
 *  3. заголовок длиннее MAX_HEAD_LEN режется так же, как причина, — без этого
 *     пункты 1–2 не гарантировали бы лимит при гигантской теме.
 */
function formatAlertText(alert: WorkerAlert): string {
  const errorRaw = formatError(alert.error);
  const contextLines = alert.context
    ? Object.entries(alert.context)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `• <i>${escapeHtml(k)}</i>: <code>${escapeHtml(String(v))}</code>`)
    : null;
  const full = joinAlert(
    `🚨 <b>${escapeHtml(alert.workerId)}</b>: ${escapeHtml(alert.subject)}`,
    escapeHtml(errorRaw),
    contextLines,
  );
  if (full.length <= MAX_MSG_LEN) return full;

  const worker = escapeWithin(alert.workerId, MAX_HEAD_WORKER_LEN);
  const head = `🚨 <b>${worker}</b>: ${escapeWithin(alert.subject, MAX_HEAD_LEN - worker.length)}`;
  const errorFullLen = escapeHtml(errorRaw).length;
  const kept = contextLines ? [...contextLines] : null;
  let dropped = 0;
  for (;;) {
    const tail = kept && dropped > 0
      ? [...kept, `• <i>не поместилось строк контекста</i>: <code>${dropped}</code>`]
      : kept;
    const budget = MAX_MSG_LEN - joinAlert(head, '', tail).length;
    if (budget >= Math.min(MIN_ERROR_LEN, errorFullLen) || !kept || kept.length === 0) {
      return joinAlert(head, escapeWithin(errorRaw, Math.max(0, budget)), tail);
    }
    kept.pop();
    dropped += 1;
  }
}

export async function sendWorkerAlert(alert: WorkerAlert): Promise<boolean> {
  try {
    return await deliverWorkerAlert(alert);
  } catch (e) {
    console.warn(`[worker-alert] alert not built (${alert.workerId}):`, e);
    return false;
  }
}

async function deliverWorkerAlert(alert: WorkerAlert): Promise<boolean> {
  const creds = loadCreds();
  if (!creds) {
    console.warn(
      `[worker-alert] no TG creds (${alert.workerId}: ${alert.subject}) — skip send`,
    );
    return false;
  }

  const text = formatAlertText(alert);
  return sendToChats(creds, text);
}

/**
 * Обычное сообщение в тот же чат (без «🚨» и блока ошибки): итоги фоновых
 * задач, которые читает человек. text — готовый HTML (parse_mode HTML),
 * экранирует вызывающий. Никогда не бросает, как и sendWorkerAlert.
 */
export async function sendWorkerNotice(text: string): Promise<void> {
  const creds = loadCreds();
  if (!creds) {
    console.warn(`[worker-alert] no TG creds — skip notice: ${text.slice(0, 120)}`);
    return;
  }
  await sendToChats(creds, text.slice(0, MAX_MSG_LEN));
}

export { escapeHtml as escapeTelegramHtml };

/** Шлёт текст во все чаты; true — хотя бы один чат его принял. */
async function sendToChats(creds: { token: string; chatIds: string[] }, text: string): Promise<boolean> {
  let accepted = false;
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
      } else {
        accepted = true;
      }
    } catch (e) {
      console.warn(`[worker-alert] TG send failed for chat=${chatId}:`, e);
    }
  }
  return accepted;
}
