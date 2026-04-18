/**
 * @jest-environment node
 */
import { buildHhRequestHeaders } from '@/lib/parsers/hhParser';

describe('buildHhRequestHeaders', () => {
  const originalEnv = process.env.HH_ACCESS_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HH_ACCESS_TOKEN;
    } else {
      process.env.HH_ACCESS_TOKEN = originalEnv;
    }
  });

  test('always includes User-Agent and Accept headers', () => {
    delete process.env.HH_ACCESS_TOKEN;
    const headers = buildHhRequestHeaders();
    expect(headers['User-Agent']).toBe('Portal/1.0 (HH parser)');
    expect(headers.Accept).toBe('application/json');
  });

  test('omits Authorization when HH_ACCESS_TOKEN is unset', () => {
    delete process.env.HH_ACCESS_TOKEN;
    expect(buildHhRequestHeaders().Authorization).toBeUndefined();
  });

  test('omits Authorization when HH_ACCESS_TOKEN is empty string', () => {
    process.env.HH_ACCESS_TOKEN = '';
    expect(buildHhRequestHeaders().Authorization).toBeUndefined();
  });

  test('omits Authorization when HH_ACCESS_TOKEN is whitespace only', () => {
    process.env.HH_ACCESS_TOKEN = '   ';
    expect(buildHhRequestHeaders().Authorization).toBeUndefined();
  });

  test('includes Authorization: Bearer when HH_ACCESS_TOKEN is set', () => {
    process.env.HH_ACCESS_TOKEN = 'real_hh_token_xyz';
    expect(buildHhRequestHeaders().Authorization).toBe('Bearer real_hh_token_xyz');
  });

  test('trims surrounding whitespace from token', () => {
    process.env.HH_ACCESS_TOKEN = '  spaced_token  ';
    expect(buildHhRequestHeaders().Authorization).toBe('Bearer spaced_token');
  });

  test('uses default User-Agent when no argument is passed', () => {
    delete process.env.HH_ACCESS_TOKEN;
    expect(buildHhRequestHeaders()['User-Agent']).toBe('Portal/1.0 (HH parser)');
  });

  test('uses custom User-Agent when provided as argument', () => {
    delete process.env.HH_ACCESS_TOKEN;
    const headers = buildHhRequestHeaders('Portal/1.0 (NashOutreach signal collector)');
    expect(headers['User-Agent']).toBe('Portal/1.0 (NashOutreach signal collector)');
  });

  test('combines custom User-Agent with Authorization header', () => {
    process.env.HH_ACCESS_TOKEN = 'tok123';
    const headers = buildHhRequestHeaders('CustomAgent/2.0 (test@example.com)');
    expect(headers['User-Agent']).toBe('CustomAgent/2.0 (test@example.com)');
    expect(headers.Authorization).toBe('Bearer tok123');
    expect(headers.Accept).toBe('application/json');
  });

  test('falls back to default User-Agent when empty string passed', () => {
    delete process.env.HH_ACCESS_TOKEN;
    expect(buildHhRequestHeaders('')['User-Agent']).toBe('Portal/1.0 (HH parser)');
  });
});
