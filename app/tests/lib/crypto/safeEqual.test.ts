import { safeEqual } from '@/lib/crypto/safeEqual';

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('returns false for different same-length strings', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false (never throws) for different-length strings', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('x', '')).toBe(false);
  });
});
