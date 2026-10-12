import 'server-only';
import { datasetQuery } from '@/lib/instantlyDataset';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

/**
 * Исходы рассылки Instantly по дням: отправлено → отбои → ответы → лиды.
 *
 * Блок внизу страницы «Нагрузка почт» (просьба Ника 09.10.2026): та страница
 * отвечает на вопрос «выбран ли дневной потолок отправок», а рядом всегда
 * нужен второй — «а что эти отправки принесли». Разрез один, по всему
 * воркспейсу: страница и так про общий ресурс ящиков, разрез по клиентам
 * живёт в карточке проекта.
 *
 * Источник — аналитический датасет `instantly_dataset` (ночной синк), поэтому
 * день здесь тот же, что и у остальной страницы: последний ПОЛНЫЙ день.
 *
 * Откуда что берётся (намеренно из разных мест, см. wiki/concepts/key-metrics.md):
 *  - отправлено:  `raw_emails` ue_type=1 — то же, что считает сама страница,
 *                 поэтому плитка «Отправлено» сходится с цифрой наверху.
 *  - ответы:       `raw_emails` ue_type=2, один ответ на человека за день.
 *                 Повторы автоответчиков (до 12 строк на лида, 20% ue2) иначе
 *                 раздули бы ответы вдвое — тот же дедуп, что в `v_reply_facts`.
 *  - лиды:         наша ИИ-квалификация ответов для проектов. Один лид = один
 *                 выбранный тред проекта, который идёт в TG и таблицу лидов;
 *                 метки interested от Instantly здесь не участвуют.
 *  - отбои:       timestamped `email_bounced` webhooks, received by Portal.
 *                 Instantly's daily analytics omits bounces. Before webhook
 *                 coverage begins, the daily value is unknown (never zero).
 *  - невалидные:  ответ с исходом `invalid_contact` (i_status=-3) — «не тот
 *                 человек / адрес недостижим». Это разбор ответа, а не отбой,
 *                 поэтому не входит в число недоставленных писем.
 */

/** Сколько дней показываем на графике, включая выбранный. */
export const OUTCOMES_WINDOW_DAYS = 30;

export type OutcomeDay = {
  day: string; // 'YYYY-MM-DD'
  sent: number;
  bounced: number | null;
  invalid: number;
  replies: number;
  leads: number;
};

export type MailboxOutcomes = {
  day: string;
  /** Цифры выбранного дня. */
  totals: Omit<OutcomeDay, 'day'>;
  /** Ряд по дням; отбои до подключения вебхука — null. */
  days: OutcomeDay[];
  /** На выбранный день нет полного покрытия вебхуком — рисуем прочерк. */
  bounceUnavailable: boolean;
  notes: string[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

type SentRow = { day: string; sent: string };
type ReplyRow = { day: string; replies: string; invalid: string };
type LeadRow = { day: string; leads: number };
type BounceRow = { day: string; bounced: number };

/** Список дней окна: ['YYYY-MM-DD', …] по возрастанию, последний — `day`. */
function windowDays(day: string, length: number): string[] {
  const end = new Date(`${day}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = length - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export async function buildMailboxOutcomes(day: string): Promise<MailboxOutcomes> {
  if (!isCalendarDay(day)) throw new Error(`bad day: ${day}`);
  const days = windowDays(day, OUTCOMES_WINDOW_DAYS);
  const from = days[0];
  const notes: string[] = [];

  // Отправки и ответы — двумя запросами, а не одним с FILTER по ue_type:
  // отправок за 30 дней сотни тысяч, и у них свой покрывающий индекс
  // (ue_type, timestamp_email, eaccount), тогда как ответам нужна куча ради
  // lead_id/i_status. Один общий запрос лишил бы отправки index-only-плана.
  if (!supabaseInstantly) throw new Error('Instantly qualification DB unavailable');
  const [sentRows, replyRows, leadResponse] = await Promise.all([
    datasetQuery<SentRow>(
      `SELECT to_char(timestamp_email::date, 'YYYY-MM-DD') AS day, count(*)::text AS sent
         FROM raw_emails
        WHERE ue_type = 1
          AND timestamp_email >= $1::date
          AND timestamp_email < ($2::date + 1)
        GROUP BY 1`,
      [from, day],
    ),
    datasetQuery<ReplyRow>(
      // coalesce(lead_id, id): у части ответов лида нет (письмо не сматчилось с
      // карточкой) — с голым lead_id они просто исчезли бы из счёта.
      `SELECT to_char(timestamp_email::date, 'YYYY-MM-DD') AS day,
              count(DISTINCT coalesce(lead_id, id))::text AS replies,
              (count(DISTINCT coalesce(lead_id, id))
                FILTER (WHERE i_status = -3))::text AS invalid
         FROM raw_emails
        WHERE ue_type = 2
          AND timestamp_email >= $1::date
          AND timestamp_email < ($2::date + 1)
        GROUP BY 1`,
      [from, day],
    ),
    // Квалификатор живёт в операционной БД Instantly. Его решение по проекту
    // закрепляется за одним тредом, поэтому повторные ответы не дают лидов.
    supabaseInstantly.rpc('instantly_project_leads_daily', { p_from: from, p_to: day }),
  ]);
  if (leadResponse.error) throw leadResponse.error;
  const leadRows = (leadResponse.data ?? []) as LeadRow[];

  // Отбои живут в Portal DB: Instantly's daily API has no bounce metric.
  // Only full UTC days after registration are allowed to show a true zero.
  let bounceRows: BounceRow[] = [];
  let bounceAvailableFrom: string | null = null;
  try {
    if (!supabaseAdmin) throw new Error('Portal DB unavailable');
    const { data: coverage, error: coverageError } = await supabaseAdmin
      .from('instantly_bounce_coverage')
      .select('started_at')
      .eq('instantly_account_id', 'main')
      .maybeSingle();
    if (coverageError) throw coverageError;
    if (coverage?.started_at) {
      const start = new Date(coverage.started_at);
      if (Number.isNaN(start.getTime())) throw new Error('Invalid bounce coverage start');
      bounceAvailableFrom = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1))
        .toISOString().slice(0, 10);
      if (bounceAvailableFrom <= day) {
        const { data, error } = await supabaseAdmin.rpc('instantly_bounces_daily', {
          p_from: from > bounceAvailableFrom ? from : bounceAvailableFrom,
          p_to: day,
        });
        if (error) throw error;
        bounceRows = (data ?? []) as BounceRow[];
      }
    }
  } catch (e) {
    bounceAvailableFrom = null;
    console.error('[mailbox-outcomes] bounce query failed:', (e as Error).message);
    notes.push('Данные по отбоям сейчас недоступны — остальные цифры верны.');
  }
  const bounceUnavailable = !bounceAvailableFrom || day < bounceAvailableFrom;
  if (bounceUnavailable && !notes.length) {
    notes.push('Отбои за этот день ещё не собирались. Ноль не означает отсутствие недоставок.');
  }

  const sentBy = new Map(sentRows.map((r) => [r.day, num(r.sent)]));
  const bounceBy = new Map(bounceRows.map((r) => [r.day, num(r.bounced)]));
  const replyBy = new Map(replyRows.map((r) => [r.day, r]));
  const leadBy = new Map(leadRows.map((r) => [r.day, num(r.leads)]));

  const series: OutcomeDay[] = days.map((d) => {
    const reply = replyBy.get(d);
    return {
      day: d,
      sent: sentBy.get(d) ?? 0,
      bounced: bounceAvailableFrom && d >= bounceAvailableFrom ? bounceBy.get(d) ?? 0 : null,
      invalid: num(reply?.invalid),
      replies: num(reply?.replies),
      leads: leadBy.get(d) ?? 0,
    };
  });

  const last = series[series.length - 1];
  notes.push('Отбои — по событиям Instantly с момента подключения; лиды — по нашей квалификации для проектов, один на переписку.');

  return {
    day,
    totals: {
      sent: last?.sent ?? 0,
      bounced: last?.bounced ?? null,
      invalid: last?.invalid ?? 0,
      replies: last?.replies ?? 0,
      leads: last?.leads ?? 0,
    },
    days: series,
    bounceUnavailable,
    notes,
  };
}
