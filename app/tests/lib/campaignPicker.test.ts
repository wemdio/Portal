import { buildCampaignPickerEntries } from '@/lib/projects/campaignPicker';

const campaigns = [
  { id: 'c1', name: 'Profit gateaway фин агрегаторы' },
  { id: 'c2', name: 'StaffLine агрокомплексы' },
  { id: 'c3', name: 'Profit gateaway Инфобизнес' },
  { id: 'c4', name: 'VELAR-air 2gis' },
];

describe('buildCampaignPickerEntries', () => {
  it('hides campaigns already linked to this project', () => {
    const entries = buildCampaignPickerEntries(campaigns, ['c1'], {}, '');
    expect(entries.map((e) => e.campaign.id)).toEqual(['c2', 'c3', 'c4']);
  });

  it('filters by search regardless of case and padding', () => {
    const entries = buildCampaignPickerEntries(campaigns, [], {}, '  GATEAWAY  ');
    expect(entries.map((e) => e.campaign.id)).toEqual(['c1', 'c3']);
  });

  it('puts free campaigns first and marks the owner of taken ones', () => {
    const taken = { c1: 'Profit-Gateway', c2: 'StaffLine' };
    const entries = buildCampaignPickerEntries(campaigns, [], taken, '');

    expect(entries.map((e) => e.campaign.id)).toEqual(['c3', 'c4', 'c1', 'c2']);
    expect(entries.map((e) => e.takenBy)).toEqual([null, null, 'Profit-Gateway', 'StaffLine']);
  });

  it('keeps recency order inside each group and applies the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, name: `Кампания ${i}` }));
    // Первые пять — заняты: без сортировки они бы съели весь лимит.
    const taken = Object.fromEntries(many.slice(0, 5).map((c) => [c.id, 'Другой проект']));
    const entries = buildCampaignPickerEntries(many, [], taken, '', 6);

    expect(entries).toHaveLength(6);
    expect(entries.slice(0, 6).map((e) => e.campaign.id)).toEqual(['x5', 'x6', 'x7', 'x8', 'x9', 'x10']);
    expect(entries.every((e) => e.takenBy === null)).toBe(true);
  });

  it('returns an empty list when nothing matches, so the UI can say «Не найдено»', () => {
    expect(buildCampaignPickerEntries(campaigns, [], {}, 'нет такой')).toEqual([]);
  });
});
