/** @jest-environment node */

import { computeVerticalPct } from '@/lib/hypothesisEngine/stages/clustering';

describe('computeVerticalPct', () => {
  it('вертикаль-одиночка наследует % гипотезы', () => {
    expect(computeVerticalPct([40])).toBe(40);
    expect(computeVerticalPct([0])).toBe(0);
  });

  it('max участников + 2 п.п. за каждого дополнительного', () => {
    expect(computeVerticalPct([40, 35, 30])).toBe(44);
    expect(computeVerticalPct([50, 50])).toBe(52);
  });

  it('кап 95: ни ширина, ни 100% гипотеза не выводят на плато', () => {
    expect(computeVerticalPct([94, 90, 88])).toBe(95);
    expect(computeVerticalPct([100])).toBe(95);
  });

  it('нефинитные значения считаются нулём', () => {
    expect(computeVerticalPct([Number.NaN, 50])).toBe(52);
  });
});
