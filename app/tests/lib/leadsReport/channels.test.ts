import {
  detectSummaryChannel,
  type SummaryChannelName,
} from '@/lib/leadsReport/channels';

function raw(fields: Record<string, string>): unknown {
  return {
    custom_fields_values: Object.entries(fields).map(([field_name, value]) => ({
      field_name,
      values: [{ value }],
    })),
  };
}

describe('detectSummaryChannel', () => {
  it.each<[Record<string, string>, SummaryChannelName]>([
    [{ Источник: 'Telegram Outreach' }, 'tg_outreach'],
    [{ Источник: 'Партнер' }, 'partners'],
    [{ Источник: 'Партнёрка' }, 'partners'],
    [{ Источник: 'Email Outreach' }, 'outreach'],
    [{ Источник: 'Аутрич' }, 'outreach'],
    [{ Источник: 'SMM' }, 'smm'],
    [{ Источник: 'Сайт', utm_medium: 'smm' }, 'smm'],
    [{ Источник: 'Сайт' }, 'marketing'],
  ])('classifies %p as %s', (fields, expected) => {
    expect(detectSummaryChannel(raw(fields))).toBe(expected);
  });
});
