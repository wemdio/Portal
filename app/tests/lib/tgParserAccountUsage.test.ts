import { isLimitReached, remainingCapacity, usagePercent } from '@/lib/tgParser/accountUsage';

describe('tgParser account daily usage', () => {
  describe('isLimitReached', () => {
    it('returns false when sent is below limit', () => {
      expect(isLimitReached(10, 30)).toBe(false);
    });

    it('returns true when sent equals limit', () => {
      expect(isLimitReached(30, 30)).toBe(true);
    });

    it('returns true when sent exceeds limit', () => {
      expect(isLimitReached(35, 30)).toBe(true);
    });

    it('returns true immediately for zero limit', () => {
      expect(isLimitReached(0, 0)).toBe(true);
    });

    it('returns false when nothing sent and limit is positive', () => {
      expect(isLimitReached(0, 30)).toBe(false);
    });
  });

  describe('remainingCapacity', () => {
    it('returns difference when under limit', () => {
      expect(remainingCapacity(10, 30)).toBe(20);
    });

    it('returns 0 when at limit', () => {
      expect(remainingCapacity(30, 30)).toBe(0);
    });

    it('returns 0 when over limit', () => {
      expect(remainingCapacity(40, 30)).toBe(0);
    });

    it('returns full limit when nothing sent', () => {
      expect(remainingCapacity(0, 100)).toBe(100);
    });
  });

  describe('usagePercent', () => {
    it('returns 0 when nothing sent', () => {
      expect(usagePercent(0, 30)).toBe(0);
    });

    it('returns 50 when half used', () => {
      expect(usagePercent(15, 30)).toBe(50);
    });

    it('returns 100 when at limit', () => {
      expect(usagePercent(30, 30)).toBe(100);
    });

    it('caps at 100 when over limit', () => {
      expect(usagePercent(50, 30)).toBe(100);
    });

    it('returns 100 for zero limit', () => {
      expect(usagePercent(0, 0)).toBe(100);
    });
  });
});
