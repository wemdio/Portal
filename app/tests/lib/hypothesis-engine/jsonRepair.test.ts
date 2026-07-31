import { tryRepairTruncatedJson } from '@/lib/hypothesisEngine/llm';

describe('tryRepairTruncatedJson — ремонт JSON, обрезанного по max_tokens', () => {
  it('спасает целые объекты из усечённого массива кандидатов', () => {
    const truncated =
      '{"hypotheses": [{"tier":1,"title":"A","description":"x","fit_rationale":"y","rationale":"z","potential_pct":70,"search_queries":["q1"]},{"tier":2,"title":"B","description":"обрезано посре';
    const out = tryRepairTruncatedJson(truncated) as { hypotheses: unknown[] } | null;
    expect(out).not.toBeNull();
    expect(out!.hypotheses).toHaveLength(1);
    expect((out!.hypotheses[0] as { title: string }).title).toBe('A');
  });

  it('обрезка посередине строки: закрывает строку и структуру', () => {
    const out = tryRepairTruncatedJson('{"a": "незаконченная стро') as { a: string } | null;
    expect(out).not.toBeNull();
    expect(typeof out!.a).toBe('string');
  });

  it('валидный JSON возвращает как есть (граничный суффикс "")', () => {
    const out = tryRepairTruncatedJson('{"a": [1, 2]}') as { a: number[] } | null;
    expect(out).toEqual({ a: [1, 2] });
  });

  it('не JSON — null', () => {
    expect(tryRepairTruncatedJson('plain text')).toBeNull();
    expect(tryRepairTruncatedJson('')).toBeNull();
  });

  it('мусорный хвост после валидного JSON — отрезает его', () => {
    const out = tryRepairTruncatedJson('{"a": 1} trailing garbage}') as { a: number } | null;
    expect(out).not.toBeNull();
    expect(out!.a).toBe(1);
  });
});
