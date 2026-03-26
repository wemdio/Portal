import {
  buildCisLeadImportObjectName,
  getFilenameExtension,
} from '@/lib/cisLeads/cisLeadImportStoragePath';

describe('cisLeadImportStoragePath', () => {
  describe('getFilenameExtension', () => {
    it('returns lowercased extension', () => {
      expect(getFilenameExtension('foo.XLSX')).toBe('.xlsx');
    });
    it('returns empty when no extension', () => {
      expect(getFilenameExtension('noext')).toBe('');
    });
  });

  describe('buildCisLeadImportObjectName', () => {
    it('uses uuid and preserves extension from cyrillic / special-char names', () => {
      expect(buildCisLeadImportObjectName('Скрипты (1).xlsx', 'fixed-id')).toBe('fixed-id.xlsx');
    });
    it('supports csv', () => {
      expect(buildCisLeadImportObjectName('data.CSV', 'id')).toBe('id.csv');
    });
    it('omits extension when original has none', () => {
      expect(buildCisLeadImportObjectName('name', 'id')).toBe('id');
    });
  });
});
