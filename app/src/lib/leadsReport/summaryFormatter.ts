import type { ChannelMetrics } from '@/lib/leadsReport/metrics';
import { shortMskDate } from '@/lib/leadsReport/weekWindow';

export function formatSummary(
  start: Date,
  end: Date,
  metrics: ChannelMetrics[],
): string {
  const header =
    `📊 Отчёт продаж — ${shortMskDate(start)}–${shortMskDate(end)}`;
  const sections = metrics.map(
    (metric) =>
      `${metric.channel.displayName}\n` +
      `Пришло — ${metric.arrived} | ` +
      `Лидов — ${metric.qualifiedLeads} | ` +
      `Встреч (Было/Запланировано) — ` +
      `${metric.meetingsHeld}/${metric.meetingsScheduled}`,
  );
  return [header, ...sections].join('\n\n');
}
