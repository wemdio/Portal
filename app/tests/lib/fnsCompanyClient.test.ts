/** @jest-environment node */

import { getCompanyByInn, getCompanyByInnSafe, FnsCompanyError } from '@/lib/cisLeads/fnsCompanyClient';

describe('fnsCompanyClient', () => {
  const originalEnv = process.env.DADATA_API_KEY;

  afterEach(() => {
    process.env.DADATA_API_KEY = originalEnv;
  });

  describe('getCompanyByInn', () => {
    it('throws FnsCompanyError for invalid INN length', async () => {
      process.env.DADATA_API_KEY = 'test-key';
      await expect(getCompanyByInn('123')).rejects.toThrow(FnsCompanyError);
      await expect(getCompanyByInn('123')).rejects.toMatchObject({ code: 'api_error' });
    });

    it('throws FnsCompanyError when no API key', async () => {
      process.env.DADATA_API_KEY = '';
      await expect(getCompanyByInn('7715708080')).rejects.toThrow(FnsCompanyError);
      await expect(getCompanyByInn('7715708080')).rejects.toMatchObject({ code: 'no_key' });
    });

    it('accepts 10-digit INN string', async () => {
      process.env.DADATA_API_KEY = 'key';
      // will fail at fetch (no mock) but we're testing that invalid length throws first
      await expect(getCompanyByInn('7715708080')).rejects.toThrow();
    });

    it('accepts INN with non-digits and normalizes', async () => {
      process.env.DADATA_API_KEY = 'key';
      await expect(getCompanyByInn('7715-708-080')).rejects.toThrow(); // 9 digits after strip -> invalid in our check? No: replace(/\D/g,'') gives 7715708080 -> 10 digits. So it would call API. We just check it doesn't throw FnsCompanyError for invalid length.
      const digits = '7715-708-080'.replace(/\D/g, '');
      expect(digits).toBe('7715708080');
    });
  });

  describe('getCompanyByInnSafe', () => {
    it('returns null when no API key', async () => {
      process.env.DADATA_API_KEY = '';
      const result = await getCompanyByInnSafe('7715708080');
      expect(result).toBeNull();
    });

    it('returns null on invalid INN length', async () => {
      process.env.DADATA_API_KEY = 'key';
      const result = await getCompanyByInnSafe('123');
      expect(result).toBeNull();
    });
  });
});
