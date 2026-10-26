import {
  EXTRA_SUMMARY_CHANNELS,
  MAIN_SUMMARY_CHANNELS,
  type SummaryChannelName,
} from '@/lib/leadsReport/channels';
import type { ChannelMetrics } from '@/lib/leadsReport/metrics';
import { shortMskDate } from '@/lib/leadsReport/weekWindow';

type Counts = Omit<ChannelMetrics, 'channel'>;

function section(metric: ChannelMetrics): string {
  return line(metric.channel.displayName, metric);
}

/**
 * Две строки на канал (Дмитрий, 26.10.2026): лиды и встречи, каждая «по
 * когорте» и «без когорты» — термины переключателя дашборда первички. По
 * когорте — всё, что случилось за неделю, в том числе по старым сделкам; без
 * когорты — только по пришедшим за неделю, как отчёт считал до 26.10.
 */
function line(title: string, metric: Counts): string {
  return `${title}\n`
    + `Пришло — ${metric.arrived} | `
    + `Лидов по когорте — ${metric.qualifiedLeadsCohort}`
    + `${metric.requalifiedCohort > 0 ? ` (повторно ${metric.requalifiedCohort})` : ''} | `
    + `Лидов без когорты — ${metric.qualifiedLeads}\n`
    + `Встреч по когорте (Было/Запланировано) — `
    + `${metric.meetingsHeldCohort}/${metric.meetingsScheduledCohort} | `
    + `Встреч без когорты — ${metric.meetingsHeld}/${metric.meetingsScheduled}`;
}

function pick(
  metrics: ChannelMetrics[],
  names: readonly SummaryChannelName[],
): ChannelMetrics[] {
  const byName = new Map(metrics.map((metric) => [metric.channel.name, metric]));
  return names
    .map((name) => byName.get(name))
    .filter((metric): metric is ChannelMetrics => metric !== undefined);
}

export function formatSummary(
  periodStart: Date,
  periodEnd: Date,
  metrics: ChannelMetrics[],
): string {
  const header = `📊 Отчёт продаж — ${shortMskDate(periodStart)}–${shortMskDate(periodEnd)}`;
  const sections = metrics.map(section);
  return [header, ...sections].join('\n\n');
}

/**
 * Отчёт как он уходит в Telegram: ДВА сообщения.
 *
 * Первое — каналы, под которые в ручном отчёте есть строки; его сверяют
 * построчно. Второе — конференции и SDR: в ручном отчёте их нет вовсе, завели
 * 31.08.2026, чтобы поток перестал быть невидимым, но мешать их с основными
 * нельзя — сверка превратится в поиск нужных строк глазами.
 *
 * Разделение именно на сообщения, а не на абзацы одного: Telegram режет
 * длинные сообщения по границе 4096 символов, то есть в произвольном месте.
 * Решение Дмитрия, встреча 31.08.2026.
 *
 * Второе сообщение уходит ВСЕГДА, даже когда во всех дополнительных каналах
 * нули: «нулей нет» и «сообщение не пришло» иначе неотличимы, а именно этим
 * молчанием отчёт уже дважды скрывал потерянные сделки.
 */
export function formatSummaryMessages(
  periodStart: Date,
  periodEnd: Date,
  metrics: ChannelMetrics[],
): string[] {
  const period = `${shortMskDate(periodStart)}–${shortMskDate(periodEnd)}`;
  const main = pick(metrics, MAIN_SUMMARY_CHANNELS.map((c) => c.name));
  const extra = pick(metrics, EXTRA_SUMMARY_CHANNELS.map((c) => c.name));

  const messages = [
    [`📊 Отчёт продаж — ${period}`, ...main.map(section)].join('\n\n'),
  ];
  if (extra.length > 0) {
    messages.push(
      [
        `➕ Дополнительные каналы — ${period}`,
        ...extra.map(section),
      ].join('\n\n'),
    );
  }

  // Сумма по всем каналам обоих сообщений (просьба Егора, 05.10.2026). Каналы
  // не пересекаются — сделка попадает ровно в один (`detectSummaryChannel`),
  // поэтому простое сложение ничего не задваивает. Стоит в конце последнего
  // сообщения: в первом её не сверить с ручным отчётом — там нет
  // конференций и SDR.
  const empty: Counts = {
    arrived: 0,
    qualifiedLeads: 0,
    qualifiedLeadsCohort: 0,
    requalifiedCohort: 0,
    meetingsScheduled: 0,
    meetingsScheduledCohort: 0,
    meetingsHeld: 0,
    meetingsHeldCohort: 0,
  };
  const fields = Object.keys(empty) as Array<keyof Counts>;
  const total = [...main, ...extra].reduce<Counts>((sum, metric) => {
    const next = { ...sum };
    for (const field of fields) next[field] += metric[field];
    return next;
  }, empty);
  messages[messages.length - 1] += `\n\n${line('🧮 Итого по всем каналам', total)}`;
  return messages;
}
