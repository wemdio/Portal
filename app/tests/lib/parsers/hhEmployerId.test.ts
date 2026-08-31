import { resolveHhEmployerId } from '@/lib/parsers/hhEmployerId';

describe('resolveHhEmployerId', () => {
  it('prefers the stored HH employer ID', () => {
    expect(resolveHhEmployerId('456', 'https://hh.ru/employer/789')).toBe('456');
  });

  it('falls back to the employer ID from the HH URL', () => {
    expect(resolveHhEmployerId(null, 'https://hh.ru/employer/789')).toBe('789');
  });

  it('returns an empty string when neither source contains an ID', () => {
    expect(resolveHhEmployerId(undefined, 'https://example.com/company')).toBe('');
  });
});
