import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import { formatSummary } from '@/lib/leadsReport/summaryFormatter';

describe('formatSummary', () => {
  it('форматирует все пять каналов по шаблону вечернего отчёта', () => {
    const metrics = SUMMARY_CHANNELS.map((channel, index) => ({
      channel,
      arrived: 10 + index,
      qualifiedLeads: 5 + index,
      meetingsHeld: index,
      meetingsScheduled: index + 1,
    }));

    expect(
      formatSummary(
        new Date('2026-07-19T21:00:00.000Z'),
        new Date('2026-07-24T15:00:00.000Z'),
        metrics,
      ),
    ).toBe(
      [
        '📊 Отчёт продаж — 20.07–24.07',
        'Маркетинг\nПришло — 10 | Лидов — 5 | Встреч (Было/Запланировано) — 0/1',
        'SMM\nПришло — 11 | Лидов — 6 | Встреч (Было/Запланировано) — 1/2',
        'Аутрич\nПришло — 12 | Лидов — 7 | Встреч (Было/Запланировано) — 2/3',
        'Партнёрка\nПришло — 13 | Лидов — 8 | Встреч (Было/Запланировано) — 3/4',
        'TG Outreach\nПришло — 14 | Лидов — 9 | Встреч (Было/Запланировано) — 4/5',
      ].join('\n\n'),
    );
  });
});
