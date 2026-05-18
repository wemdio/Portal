import { appendUtm, looksLikeUrl } from '@/lib/clientLaunch/utm';

describe('appendUtm', () => {
  const utm = { utm_source: 'email', utm_medium: 'cold_outreach', utm_campaign: 'q2' };

  it('adds https:// to a bare domain and appends utm params', () => {
    const r = appendUtm('polzaagency.ru', utm);
    expect(r.startsWith('https://polzaagency.ru/')).toBe(true);
    expect(r).toContain('utm_source=email');
    expect(r).toContain('utm_medium=cold_outreach');
    expect(r).toContain('utm_campaign=q2');
  });

  it('appends utm to a full URL', () => {
    expect(appendUtm('https://polzaagency.ru', utm)).toContain('utm_source=email');
  });

  it('keeps an existing query string and joins with &', () => {
    const r = appendUtm('https://x.ru/?ref=1', utm);
    expect(r).toContain('ref=1');
    expect(r).toContain('utm_source=email');
  });

  it('preserves the path', () => {
    expect(appendUtm('https://x.ru/landing', utm)).toContain('/landing?');
  });

  it('skips empty utm params', () => {
    const r = appendUtm('x.ru', { utm_source: 'email', utm_medium: '', utm_campaign: '   ' });
    expect(r).toContain('utm_source=email');
    expect(r).not.toContain('utm_medium');
    expect(r).not.toContain('utm_campaign');
  });

  it('overwrites an existing utm param instead of duplicating', () => {
    const r = appendUtm('https://x.ru/?utm_source=old', utm);
    expect(r).toContain('utm_source=email');
    expect(r).not.toContain('utm_source=old');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(appendUtm('Спасибо за внимание!', utm)).toBe('Спасибо за внимание!');
  });

  it('returns empty string for empty input', () => {
    expect(appendUtm('', utm)).toBe('');
  });
});

describe('looksLikeUrl', () => {
  it.each(['polzaagency.ru', 'https://x.ru', 'http://a.b.com/path', 'x.ru/landing'])(
    'is true for "%s"',
    (s) => expect(looksLikeUrl(s)).toBe(true),
  );

  it.each(['', '   ', 'Спасибо', 'hello world', 'noTLD'])(
    'is false for "%s"',
    (s) => expect(looksLikeUrl(s)).toBe(false),
  );
});
