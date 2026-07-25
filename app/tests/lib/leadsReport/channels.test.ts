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
  it.each<[Record<string, string>, SummaryChannelName | null]>([
    // Явный маркер маркетинга через новое поле «Контур» — приоритет над всем.
    [{ Контур: 'Маркетинг' }, 'marketing'],
    [{ Контур: 'Маркетинг', Источник: 'Email Outreach' }, 'marketing'],
    // Остальные каналы — по «Источник» как раньше.
    [{ Источник: 'Telegram Outreach' }, 'tg_outreach'],
    [{ Источник: 'Партнер' }, 'partners'],
    [{ Источник: 'Партнёрка' }, 'partners'],
    [{ Источник: 'Email Outreach' }, 'outreach'],
    [{ Источник: 'Аутрич' }, 'outreach'],
    [{ Источник: 'SMM' }, 'smm'],
    [{ Источник: 'Сайт', utm_medium: 'smm' }, 'smm'],
    [{ Источник: 'Личный бренд (инст /ютуб)' }, 'smm'],
    [{ Источник: 'Личный бренд (инст /ютуб)', utm_medium: 'instagram' }, 'smm'],
    // Без «Контур»=«Маркетинг» и без известного источника — сделка не считается.
    [{ Источник: 'Сайт' }, null],
    [{ Источник: 'Лидскан' }, null],
    [{}, null],
  ])('classifies %p as %s', (fields, expected) => {
    expect(detectSummaryChannel(raw(fields))).toBe(expected);
  });
});
