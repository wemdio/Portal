import {
  EXTRA_SUMMARY_CHANNELS,
  MAIN_SUMMARY_CHANNELS,
  SUMMARY_CHANNELS,
} from '@/lib/leadsReport/channels';
import {
  formatSummary,
  formatSummaryMessages,
} from '@/lib/leadsReport/summaryFormatter';

const START = new Date('2026-07-19T21:00:00.000Z');
const END = new Date('2026-07-24T15:00:00.000Z');

function metricsFor(channels: typeof SUMMARY_CHANNELS) {
  return channels.map((channel, index) => ({
    channel,
    arrived: 10 + index,
    qualifiedLeads: 5 + index,
    meetingsHeld: index,
    meetingsScheduled: index + 1,
  }));
}

describe('formatSummary', () => {
  it('форматирует переданные каналы по шаблону вечернего отчёта', () => {
    expect(formatSummary(START, END, metricsFor(MAIN_SUMMARY_CHANNELS))).toBe(
      [
        '📊 Отчёт продаж — 20.07–24.07',
        'Маркетинг\nПришло — 10 | Лидов — 5 | Встреч (Было/Запланировано) — 0/1',
        'SMM\nПришло — 11 | Лидов — 6 | Встреч (Было/Запланировано) — 1/2',
        'Аутрич\nПришло — 12 | Лидов — 7 | Встреч (Было/Запланировано) — 2/3',
        'Партнёрка + сарафан\nПришло — 13 | Лидов — 8 | Встреч (Было/Запланировано) — 3/4',
        'TG Outreach\nПришло — 14 | Лидов — 9 | Встреч (Было/Запланировано) — 4/5',
        'Автоаутрич\nПришло — 15 | Лидов — 10 | Встреч (Было/Запланировано) — 5/6',
        'ENG TG Outreach\nПришло — 16 | Лидов — 11 | Встреч (Было/Запланировано) — 6/7',
        'ENG Email Outreach\nПришло — 17 | Лидов — 12 | Встреч (Было/Запланировано) — 7/8',
      ].join('\n\n'),
    );
  });
});

describe('formatSummaryMessages', () => {
  it('делит отчёт на основное и дополнительное сообщения', () => {
    const messages = formatSummaryMessages(
      START,
      END,
      metricsFor(SUMMARY_CHANNELS),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(
      [
        '📊 Отчёт продаж — 20.07–24.07',
        'Маркетинг\nПришло — 10 | Лидов — 5 | Встреч (Было/Запланировано) — 0/1',
        'SMM\nПришло — 11 | Лидов — 6 | Встреч (Было/Запланировано) — 1/2',
        'Аутрич\nПришло — 12 | Лидов — 7 | Встреч (Было/Запланировано) — 2/3',
        'Партнёрка + сарафан\nПришло — 13 | Лидов — 8 | Встреч (Было/Запланировано) — 3/4',
        'TG Outreach\nПришло — 14 | Лидов — 9 | Встреч (Было/Запланировано) — 4/5',
        'Автоаутрич\nПришло — 15 | Лидов — 10 | Встреч (Было/Запланировано) — 5/6',
        'ENG TG Outreach\nПришло — 16 | Лидов — 11 | Встреч (Было/Запланировано) — 6/7',
        'ENG Email Outreach\nПришло — 17 | Лидов — 12 | Встреч (Было/Запланировано) — 7/8',
      ].join('\n\n'),
    );
    expect(messages[1]).toBe(
      [
        '➕ Дополнительные каналы — 20.07–24.07',
        'Конференции\nПришло — 18 | Лидов — 13 | Встреч (Было/Запланировано) — 8/9',
        'SDR\nПришло — 19 | Лидов — 14 | Встреч (Было/Запланировано) — 9/10',
      ].join('\n\n'),
    );
  });

  it('второе сообщение уходит даже когда в дополнительных каналах нули', () => {
    const messages = formatSummaryMessages(
      START,
      END,
      SUMMARY_CHANNELS.map((channel) => ({
        channel,
        arrived: 0,
        qualifiedLeads: 0,
        meetingsHeld: 0,
        meetingsScheduled: 0,
      })),
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('Конференции');
    expect(messages[1]).toContain('Пришло — 0');
  });

  it('порядок строк не зависит от порядка метрик на входе', () => {
    const reversed = [...metricsFor(SUMMARY_CHANNELS)].reverse();
    const messages = formatSummaryMessages(START, END, reversed);

    expect(messages[0].indexOf('Маркетинг')).toBeLessThan(
      messages[0].indexOf('ENG Email Outreach'),
    );
    expect(messages[1].indexOf('Конференции')).toBeLessThan(
      messages[1].indexOf('SDR'),
    );
  });

  it('основные и дополнительные каналы не пересекаются и покрывают все', () => {
    const main = MAIN_SUMMARY_CHANNELS.map((c) => c.name);
    const extra = EXTRA_SUMMARY_CHANNELS.map((c) => c.name);
    expect(main.filter((name) => extra.includes(name))).toEqual([]);
    expect([...main, ...extra].sort()).toEqual(
      SUMMARY_CHANNELS.map((c) => c.name).sort(),
    );
  });
});
