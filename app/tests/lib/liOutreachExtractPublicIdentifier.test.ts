import { extractPublicIdentifier } from '@/lib/liOutreach/leadHelpers';

describe('extractPublicIdentifier', () => {
  it('extracts slug from http://www.linkedin.com/in/<slug>', () => {
    expect(extractPublicIdentifier('http://www.linkedin.com/in/karla-therese-meyer-0b2044208'))
      .toBe('karla-therese-meyer-0b2044208');
  });

  it('extracts slug from https URL with trailing slash', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/davidlostrek/'))
      .toBe('davidlostrek');
  });

  it('strips query string from slug', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/zimmermann-sergej-2b646310b?trk=public_profile'))
      .toBe('zimmermann-sergej-2b646310b');
  });

  it('handles URL without protocol', () => {
    expect(extractPublicIdentifier('linkedin.com/in/foo')).toBe('foo');
  });

  it('handles mobile subdomain', () => {
    expect(extractPublicIdentifier('https://m.linkedin.com/in/bar')).toBe('bar');
  });

  it('returns only the slug for nested LinkedIn paths like /details/experience', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/foo/details/experience')).toBe('foo');
  });

  it('returns null for non-profile LinkedIn URLs', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/company/acme')).toBeNull();
    expect(extractPublicIdentifier('https://www.linkedin.com/feed/')).toBeNull();
  });

  it('returns null for empty / null / undefined / random strings', () => {
    expect(extractPublicIdentifier(null)).toBeNull();
    expect(extractPublicIdentifier(undefined)).toBeNull();
    expect(extractPublicIdentifier('')).toBeNull();
    expect(extractPublicIdentifier('   ')).toBeNull();
    expect(extractPublicIdentifier('not a url at all')).toBeNull();
  });

  it('strips fragment (#) from slug', () => {
    expect(extractPublicIdentifier('https://www.linkedin.com/in/baz#about')).toBe('baz');
  });

  it('trims surrounding whitespace', () => {
    expect(extractPublicIdentifier('  https://www.linkedin.com/in/qux  ')).toBe('qux');
  });
});
