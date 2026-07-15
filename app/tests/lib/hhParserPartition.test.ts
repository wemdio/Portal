/**
 * @jest-environment node
 */
import { shouldSplitByPipe } from '@/lib/parsers/hhParser';

/**
 * Locks the DEFAULT ('split') OR-query behavior that every existing caller
 * (Mailganer auto-pipeline, Nash, dfyb, manual parser) relies on, and verifies
 * the opt-in 'combined' mode never splits. Pure function — no HH network.
 */
describe('shouldSplitByPipe', () => {
  it('splits a multi-term OR query in default (split) mode', () => {
    expect(shouldSplitByPipe('A | B | C')).toBe(true);
    expect(shouldSplitByPipe('A | B | C', 'split')).toBe(true);
  });

  it('never splits in combined mode (reproduces HH combined query)', () => {
    expect(shouldSplitByPipe('A | B | C', 'combined')).toBe(false);
    expect(shouldSplitByPipe('Оператор | Инженер | Технолог', 'combined')).toBe(false);
  });

  it('does not split a single-term query', () => {
    expect(shouldSplitByPipe('Оператор технологических установок')).toBe(false);
    // a trailing/empty pipe still leaves a single real term
    expect(shouldSplitByPipe('single|')).toBe(false);
    expect(shouldSplitByPipe('| single |')).toBe(false);
  });

  it('handles empty / whitespace / undefined', () => {
    expect(shouldSplitByPipe(undefined)).toBe(false);
    expect(shouldSplitByPipe('')).toBe(false);
    expect(shouldSplitByPipe('   ')).toBe(false);
  });
});
