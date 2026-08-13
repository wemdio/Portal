import { NO_SOURCE_KEY, NO_SOURCE_LABEL, resolveSource } from '@/lib/firstSales/sources';

/** Сырая сделка AMO с одним полем «Источник». */
const raw = (value: unknown, enumId?: unknown) => ({
  custom_fields_values: [
    {
      field_name: 'Источник',
      field_type: 'select',
      values: [enumId === undefined ? { value } : { value, enum_id: enumId }],
    },
  ],
});

describe('resolveSource', () => {
  it('ключ — enum_id, название — как в AMO', () => {
    const res = resolveSource(raw('Email Outreach', 11382049));
    expect(res.key).toBe('11382049');
    expect(res.label).toBe('Email Outreach');
  });

  it('регистр названия не трогается: ключ стабилен, показываем как завели', () => {
    const res = resolveSource(raw('портал (outreachOS)', 11383675));
    expect(res.key).toBe('11383675');
    expect(res.label).toBe('портал (outreachOS)');
  });

  it('enum_id строкой из JSON тоже принимается', () => {
    expect(resolveSource(raw('SEO', '11382055')).key).toBe('11382055');
  });

  it('значение без enum_id уходит в текстовый ключ, ё схлопывается', () => {
    const res = resolveSource(raw('Партнёр'));
    expect(res.key).toBe('text:партнер');
    expect(res.label).toBe('Партнёр');
  });

  it('нечисловой enum_id считается отсутствующим', () => {
    expect(resolveSource(raw('PR', 'abc')).key).toBe('text:pr');
  });

  it('пустое значение — «без источника»', () => {
    for (const empty of [null, '', '   ']) {
      const res = resolveSource(raw(empty, 123));
      expect(res.key).toBe(NO_SOURCE_KEY);
      expect(res.label).toBe(NO_SOURCE_LABEL);
    }
  });

  it('поля «Источник» нет вовсе — «без источника»', () => {
    const res = resolveSource({
      custom_fields_values: [{ field_name: 'Контур', values: [{ value: 'Маркетинг' }] }],
    });
    expect(res.key).toBe(NO_SOURCE_KEY);
  });

  it('битые входные данные не роняют расчёт', () => {
    for (const bad of [null, undefined, 42, 'строка', {}, { custom_fields_values: 'нет' }]) {
      expect(resolveSource(bad).key).toBe(NO_SOURCE_KEY);
    }
  });

  it('поле есть, но values пустой', () => {
    expect(resolveSource({ custom_fields_values: [{ field_name: 'Источник', values: [] }] }).key)
      .toBe(NO_SOURCE_KEY);
  });
});
