import {
  EXTRA_SUMMARY_CHANNELS,
  MAIN_SUMMARY_CHANNELS,
  type SummaryChannelName,
} from '@/lib/leadsReport/channels';
import type { ChannelMetrics } from '@/lib/leadsReport/metrics';
import { shortMskDate } from '@/lib/leadsReport/weekWindow';

function section(metric: ChannelMetrics): string {
  return `${metric.channel.displayName}\n`
    + `Пришло — ${metric.arrived} | `
    + `Лидов — ${metric.qualifiedLeads} | `
    + `Встреч (Было/Запланировано) — `
    + `${metric.meetingsHeld}/${metric.meetingsScheduled}`;
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
  start: Date,
  end: Date,
  metrics: ChannelMetrics[],
): string {
  const header = `📊 Отчёт продаж — ${shortMskDate(start)}–${shortMskDate(end)}`;
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
  start: Date,
  end: Date,
  metrics: ChannelMetrics[],
): string[] {
  const period = `${shortMskDate(start)}–${shortMskDate(end)}`;
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
  return messages;
}
