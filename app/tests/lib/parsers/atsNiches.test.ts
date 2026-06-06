/** @jest-environment node */

import { resolveAtsMatch, nicheLabel, ATS_NICHES } from '@/lib/parsers/atsNiches';

describe('atsNiches', () => {
  it('returns the preset RegExp source for a known niche', () => {
    const src = resolveAtsMatch('fleet_logistics');
    expect(src).toContain('fleet');
    expect(new RegExp(src, 'i').test('Fleet Manager')).toBe(true);
  });

  it('custom keywords override the niche and compile to a valid regex', () => {
    const src = resolveAtsMatch('fleet_logistics', 'head of growth, demand gen');
    const re = new RegExp(src, 'i');
    expect(re.test('Head of Growth')).toBe(true);
    expect(re.test('Demand Gen Manager')).toBe(true);
    expect(re.test('Fleet Manager')).toBe(false);
  });

  it('escapes regex-special characters in custom input', () => {
    const src = resolveAtsMatch(undefined, 'c++ developer');
    expect(() => new RegExp(src, 'i')).not.toThrow();
    expect(new RegExp(src, 'i').test('C++ Developer')).toBe(true);
  });

  it('falls back to marketing/sales when nothing is provided', () => {
    expect(resolveAtsMatch()).toBe(ATS_NICHES[0].match);
    expect(resolveAtsMatch('', '   ')).toBe(ATS_NICHES[0].match);
  });

  it('resolves human labels', () => {
    expect(nicheLabel('fleet_logistics')).toBe('Флот и логистика');
    expect(nicheLabel('unknown_key')).toBe('unknown_key');
    expect(nicheLabel(undefined)).toBe('');
  });
});
