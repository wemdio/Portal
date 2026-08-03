import {
  normalizeSource,
  resolveChannel,
  type SourceChannelRow,
} from '@/lib/firstSales/sourceChannels';

const map: SourceChannelRow[] = [
  { source: 'email outreach', channel: 'outreach', display_name: 'Email Outreach' },
  { source: 'партнер', channel: 'partners', display_name: 'Партнёр' },
  { source: 'сайт', channel: 'unassigned', display_name: 'Сайт' },
];

const raw = (fields: Record<string, string>) => ({
  custom_fields_values: Object.entries(fields).map(([field_name, value]) => ({
    field_name,
    values: [{ value }],
  })),
});

describe('normalizeSource', () => {
  it('обрезает пробелы и приводит к нижнему регистру', () => {
    expect(normalizeSource('  Email Outreach ')).toBe('email outreach');
  });

  it('схлопывает ё в е', () => {
    expect(normalizeSource('Партнёр')).toBe('партнер');
  });

  it('пустое значение даёт пустую строку', () => {
    expect(normalizeSource(null)).toBe('');
    expect(normalizeSource('   ')).toBe('');
  });
});

describe('resolveChannel', () => {
  it('находит канал по справочнику', () => {
    expect(resolveChannel(raw({ Источник: 'Email Outreach' }), map).channel)
      .toBe('outreach');
  });

  it('не зависит от регистра и ё', () => {
    expect(resolveChannel(raw({ Источник: 'ПАРТНЁР' }), map).channel)
      .toBe('partners');
  });

  it('источник вне справочника даёт unassigned, но сохраняет исходное значение', () => {
    const res = resolveChannel(raw({ Источник: 'Нейровыдача' }), map);
    expect(res.channel).toBe('unassigned');
    expect(res.source).toBe('нейровыдача');
    expect(res.known).toBe(false);
  });

  it('источник в справочнике со значением unassigned считается известным', () => {
    const res = resolveChannel(raw({ Источник: 'Сайт' }), map);
    expect(res.channel).toBe('unassigned');
    expect(res.known).toBe(true);
  });

  it('пустой источник даёт unassigned с пустым source', () => {
    const res = resolveChannel(raw({}), map);
    expect(res.channel).toBe('unassigned');
    expect(res.source).toBe('');
    expect(res.known).toBe(false);
  });

  it('«Контур = Маркетинг» без источника даёт marketing', () => {
    const res = resolveChannel(raw({ Контур: 'Маркетинг' }), map);
    expect(res.channel).toBe('marketing');
  });

  it('заполненный источник приоритетнее «Контур = Маркетинг»', () => {
    const res = resolveChannel(
      raw({ Контур: 'Маркетинг', Источник: 'Email Outreach' }),
      map,
    );
    expect(res.channel).toBe('outreach');
  });

  it('«Контур = Маркетинг» с источником вне справочника всё равно marketing', () => {
    const res = resolveChannel(
      raw({ Контур: 'Маркетинг', Источник: 'Нейровыдача' }),
      map,
    );
    expect(res.channel).toBe('marketing');
  });
});
