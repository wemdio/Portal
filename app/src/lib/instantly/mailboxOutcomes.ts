import 'server-only';
import { datasetQuery } from '@/lib/instantlyDataset';

/**
 * Исходы рассылки Instantly по дням: отправлено → негатив → ответы → лиды.
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
 *  - ответы/лиды: `raw_emails` ue_type=2, ОДИН лид = один ответ за день.
 *                 Повторы автоответчиков (до 12 строк на лида, 20% ue2) иначе
 *                 раздули бы ответы вдвое — тот же дедуп, что в `v_reply_facts`.
 *                 Лид = Instantly или наш классификатор поставил «interested».
 *  - отбои:       в `raw_emails` событий отбоя НЕТ вовсе (ue_type только 1-4),
 *                 единственный дневной источник — аналитика Instantly
 *                 (`v_campaign_daily_canonical.bounced`). Поэтому отбои могут
 *                 не сходиться с остальными плитками по охвату: аналитика
 *                 приходит по кампаниям, активным на ночь синка.
 *  - невалидные:  ответ с исходом `invalid_contact` (i_status=-3) — «не тот
 *                 человек / адрес недостижим». Это разбор ответа, а не отбой,
 *                 поэтому считается отдельно и складывается с отбоями только
 *                 в плитке «негатива».
 */

/** Сколько дней показываем на графике, включая выбранный. */
export const OUTCOMES_WINDOW_DAYS = 30;

export type OutcomeDay = {
  day: string; // 'YYYY-MM-DD'
  sent: number;
  bounced: number;
  invalid: number;
  replies: number;
  leads: number;
};

export type MailboxOutcomes = {
  day: string;
  /** Цифры выбранного дня. */
  totals: Omit<OutcomeDay, 'day'>;
  /** Ряд по дням, по возрастанию даты; дни без событий — нулями. */
  days: OutcomeDay[];
  /** Отбои не доехали (аналитика Instantly недоступна) — рисуем прочерк, не ноль. */
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
type ReplyRow = { day: string; replies: string; leads: string; invalid: string };
type BounceRow = { day: string; bounced: string };

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
  const [sentRows, replyRows] = await Promise.all([
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
                FILTER (WHERE i_status = 1 OR ai_interest_value = 1))::text AS leads,
              (count(DISTINCT coalesce(lead_id, id))
                FILTER (WHERE i_status = -3))::text AS invalid
         FROM raw_emails
        WHERE ue_type = 2
          AND timestamp_email >= $1::date
          AND timestamp_email < ($2::date + 1)
        GROUP BY 1`,
      [from, day],
    ),
  ]);

  // Отбои — отдельно и некритично: аналитика Instantly может быть недоступна
  // (или пустой по этим дням), и это не повод ронять весь блок.
  let bounceRows: BounceRow[] = [];
  let bounceUnavailable = false;
  try {
    bounceRows = await datasetQuery<BounceRow>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS day, coalesce(sum(bounced), 0)::text AS bounced
         FROM v_campaign_daily_canonical
        WHERE date >= $1::date AND date <= $2::date
        GROUP BY 1`,
      [from, day],
    );
    if (bounceRows.length === 0) {
      bounceUnavailable = true;
      notes.push('Отбои за этот период не приходили из аналитики Instantly — показаны прочерком, а не нулём.');
    }
  } catch (e) {
    bounceUnavailable = true;
    console.error('[mailbox-outcomes] bounce query failed:', (e as Error).message);
    notes.push('Отбои не загрузились — остальные цифры верны.');
  }

  const sentBy = new Map(sentRows.map((r) => [r.day, num(r.sent)]));
  const bounceBy = new Map(bounceRows.map((r) => [r.day, num(r.bounced)]));
  const replyBy = new Map(replyRows.map((r) => [r.day, r]));

  const series: OutcomeDay[] = days.map((d) => {
    const reply = replyBy.get(d);
    return {
      day: d,
      sent: sentBy.get(d) ?? 0,
      bounced: bounceBy.get(d) ?? 0,
      invalid: num(reply?.invalid),
      replies: num(reply?.replies),
      leads: num(reply?.leads),
    };
  });

  const last = series[series.length - 1];
  notes.push('Отбои — из аналитики Instantly (приходит по активным кампаниям), остальное — по письмам датасета.');

  return {
    day,
    totals: {
      sent: last?.sent ?? 0,
      bounced: last?.bounced ?? 0,
      invalid: last?.invalid ?? 0,
      replies: last?.replies ?? 0,
      leads: last?.leads ?? 0,
    },
    days: series,
    bounceUnavailable,
    notes,
  };
}
