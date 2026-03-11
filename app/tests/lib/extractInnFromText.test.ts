import { extractInnFromText } from '@/lib/enrich/innExtractor';

describe('extractInnFromText', () => {
  it('extracts 10-digit INN after "ИНН:"', () => {
    expect(extractInnFromText('ИНН: 7707083893')).toBe('7707083893');
  });

  it('extracts 12-digit INN after "ИНН"', () => {
    expect(extractInnFromText('ИНН 123456789012')).toBe('123456789012');
  });

  it('extracts INN with em-dash separator', () => {
    expect(extractInnFromText('ИНН — 7707083893')).toBe('7707083893');
  });

  it('extracts INN with en-dash separator', () => {
    expect(extractInnFromText('ИНН–7707083893')).toBe('7707083893');
  });

  it('is case-insensitive for latin "inn"', () => {
    expect(extractInnFromText('INN: 7707083893')).toBe('7707083893');
    expect(extractInnFromText('Inn 7707083893')).toBe('7707083893');
  });

  it('finds INN in a larger text block', () => {
    const text = 'ООО "Рога и Копыта" ИНН: 7707083893 ОГРН 1027700132195 Москва';
    expect(extractInnFromText(text)).toBe('7707083893');
  });

  it('returns null when no INN present', () => {
    expect(extractInnFromText('Телефон: +7 (495) 123-45-67')).toBeNull();
  });

  it('returns null for empty / falsy input', () => {
    expect(extractInnFromText('')).toBeNull();
    expect(extractInnFromText(null as unknown as string)).toBeNull();
    expect(extractInnFromText(undefined as unknown as string)).toBeNull();
  });

  it('ignores digit strings that are not preceded by IНН keyword', () => {
    expect(extractInnFromText('Код 7707083893')).toBeNull();
  });

  it('prefers 12-digit match when both patterns overlap', () => {
    const text = 'ИНН: 123456789012';
    expect(extractInnFromText(text)).toBe('123456789012');
  });
});
