import { buildEnrichmentAoa, sourceColumnCount } from '@/lib/innEnrich/workbook';
import type { EnrichRow } from '@/lib/innEnrich/fields';

describe('buildEnrichmentAoa', () => {
  it('keeps ragged extra cells that are longer than the header', () => {
    const rows = [
      ['Компания', 'ИНН'],
      ['ООО А', '7707083893', 'хвост'],
    ];
    expect(sourceColumnCount(rows)).toBe(3);
    const matches = new Map<string, EnrichRow>([
      ['7707083893', { inn: '7707083893', name: 'А', phones: '1' }],
    ]);
    const aoa = buildEnrichmentAoa({ rows, columnIndex: 1, hasHeader: true, matches });
    expect(aoa[0][0]).toBe('Компания');
    expect(aoa[0][2]).toBe('Колонка 3');
    expect(aoa[1][2]).toBe('хвост');
    expect(aoa[1][3]).toBe('да');
    expect(aoa[1][4]).toBe('А');
  });

  it('synthesizes Колонка N headers when there is no header row', () => {
    const rows = [['7707083893', 'ООО А']];
    const aoa = buildEnrichmentAoa({
      rows,
      columnIndex: 0,
      hasHeader: false,
      matches: new Map(),
    });
    expect(aoa[0][0]).toBe('Колонка 1');
    expect(aoa[1][0]).toBe('7707083893');
    expect(aoa[1][2]).toBe('нет');
  });
});
