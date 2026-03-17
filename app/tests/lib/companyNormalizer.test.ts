/** @jest-environment node */

import {
  normalizeCompanyName,
  companyDedupKey,
  companyNamesMatch,
} from '@/lib/cisLeads/companyNormalizer';

describe('companyNormalizer', () => {
  describe('normalizeCompanyName', () => {
    it('strips ООО and normalizes spaces', () => {
      expect(normalizeCompanyName('  ООО   Рога и копыта  ')).toBe('Рога и копыта');
    });

    it('strips ЗАО, ОАО, ПАО', () => {
      expect(normalizeCompanyName('ЗАО Альфа')).toBe('Альфа');
      expect(normalizeCompanyName('ОАО Газпром')).toBe('Газпром');
      expect(normalizeCompanyName('ПАО Сбербанк')).toBe('Сбербанк');
    });

    it('lowercase when option set', () => {
      expect(normalizeCompanyName('ООО Альфа', { lowercase: true })).toBe('альфа');
    });

    it('can skip stripOpf', () => {
      expect(normalizeCompanyName('ООО Альфа', { stripOpf: false })).toBe('ООО Альфа');
    });

    it('returns empty for null/undefined', () => {
      expect(normalizeCompanyName(null)).toBe('');
      expect(normalizeCompanyName(undefined)).toBe('');
    });
  });

  describe('companyDedupKey', () => {
    it('returns lowercase normalized name without OPF', () => {
      expect(companyDedupKey('ООО Рога и копыта')).toBe('рога и копыта');
    });

    it('same key for same company different OPF', () => {
      expect(companyDedupKey('ООО Альфа')).toBe(companyDedupKey('ЗАО Альфа'));
    });
  });

  describe('companyNamesMatch', () => {
    it('returns true for same company name', () => {
      expect(companyNamesMatch('ООО Альфа', 'ЗАО Альфа')).toBe(true);
    });

    it('returns false for different names', () => {
      expect(companyNamesMatch('ООО Альфа', 'ООО Бета')).toBe(false);
    });

    it('returns false when one is empty', () => {
      expect(companyNamesMatch('Альфа', '')).toBe(false);
      expect(companyNamesMatch('', 'Альфа')).toBe(false);
    });
  });
});
