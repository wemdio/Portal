import { buildSearchDiagnostics } from '@/lib/parsers/searchParserDiagnostics';

describe('searchParserDiagnostics', () => {
  it('returns blocked status with message', () => {
    const result = buildSearchDiagnostics({
      totalResults: 0,
      blockedMessage: 'Google blocked the request (captcha)',
    });
    expect(result.status).toBe('blocked');
    expect(result.hint).toContain('Google');
  });

  it('returns empty status with a hint', () => {
    const result = buildSearchDiagnostics({
      totalResults: 0,
      blockedMessage: null,
    });
    expect(result.status).toBe('empty');
    expect(result.hint).toContain('Результатов нет');
  });

  it('returns ok when results exist', () => {
    const result = buildSearchDiagnostics({
      totalResults: 3,
      blockedMessage: null,
    });
    expect(result.status).toBe('ok');
    expect(result.hint).toBeNull();
  });
});
