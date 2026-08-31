/** @jest-environment node */

import { BENCH_KEY_PREFIX, generateBenchKey, hashBenchKey, keyLast4 } from '@/lib/bench/keys';

describe('bench keys', () => {
  it('выдаёт ключ с опознаваемым префиксом', () => {
    expect(generateBenchKey().startsWith(`${BENCH_KEY_PREFIX}_`)).toBe(true);
  });

  it('не повторяется', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateBenchKey()));
    expect(keys.size).toBe(200);
  });

  it('отпечаток — 64 hex-символа и стабилен', () => {
    const hash = hashBenchKey('bench_live_example');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBenchKey('bench_live_example')).toBe(hash);
  });

  it('разные ключи дают разные отпечатки', () => {
    expect(hashBenchKey('bench_live_a')).not.toBe(hashBenchKey('bench_live_b'));
  });

  it('пробелы по краям не делают из ключа другой ключ', () => {
    expect(hashBenchKey('  bench_live_example  ')).toBe(hashBenchKey('bench_live_example'));
  });

  it('отдаёт последние 4 символа для показа в админке', () => {
    expect(keyLast4('bench_live_abcdef12')).toBe('ef12');
  });
});
