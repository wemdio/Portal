/** @jest-environment node */

import { detectEnterpriseLogos } from '@/lib/enrich/extractors/enterpriseLogosDetector';

describe('detectEnterpriseLogos', () => {
  it('returns true when customer list contains a known RU enterprise (Сбер)', () => {
    expect(detectEnterpriseLogos(['Сбербанк', 'ООО Ромашка'])).toBe(true);
  });

  it('returns true for matches across RU/EN spellings', () => {
    expect(detectEnterpriseLogos(['Yandex'])).toBe(true);
    expect(detectEnterpriseLogos(['Tinkoff'])).toBe(true);
    expect(detectEnterpriseLogos(['Газпром нефть'])).toBe(true);
    expect(detectEnterpriseLogos(['Microsoft'])).toBe(true);
  });

  it('is case-insensitive and ignores extra whitespace/punctuation', () => {
    expect(detectEnterpriseLogos(['  СБЕРБАНК  '])).toBe(true);
    expect(detectEnterpriseLogos(['"X5 Group"'])).toBe(true);
  });

  it('returns false when no known enterprise names are present', () => {
    expect(detectEnterpriseLogos(['ООО Ромашка', 'ИП Иванов', 'Local Studio'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(detectEnterpriseLogos([])).toBe(false);
  });
});
