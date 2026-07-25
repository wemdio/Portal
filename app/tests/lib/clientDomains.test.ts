/** @jest-environment node */

/**
 * Pure-logic tests for the client domain picker:
 *   - extractBrand: brief website / manual input → brand SLD
 *   - generateCandidates: brand → candidate domains (affixes × TLDs)
 *   - suggestDomains: availability filter + 2N composition (soft .ru share)
 *
 * suggestDomains takes an injectable checkAvailability, so no network or
 * reg.ru credentials are involved here.
 */

import { extractBrand } from '@/lib/clientDomains/extractBrand';
import { generateCandidates } from '@/lib/clientDomains/generateCandidates';
import { suggestDomains } from '@/lib/clientDomains/suggestDomains';

const NOW = new Date('2026-07-25T12:00:00.000Z');

function allAvailable(dnames: string[]): Promise<Record<string, boolean>> {
  return Promise.resolve(Object.fromEntries(dnames.map((d) => [d, true])));
}

function availableExcept(taken: ReadonlySet<string>) {
  return (dnames: string[]): Promise<Record<string, boolean>> =>
    Promise.resolve(Object.fromEntries(dnames.map((d) => [d, !taken.has(d)])));
}

describe('extractBrand', () => {
  it('parses a full URL with protocol', () => {
    expect(extractBrand('https://example.com')).toEqual({ ok: true, brand: 'example' });
  });

  it('parses a bare domain without protocol', () => {
    expect(extractBrand('example.com')).toEqual({ ok: true, brand: 'example' });
  });

  it('strips www and path, lowercases', () => {
    expect(extractBrand('https://www.Example.COM/some/path?x=1')).toEqual({
      ok: true,
      brand: 'example',
    });
  });

  it('takes the SLD from a subdomain', () => {
    expect(extractBrand('shop.example.com')).toEqual({ ok: true, brand: 'example' });
  });

  it('handles known second-level zones (com.ru)', () => {
    expect(extractBrand('example.com.ru')).toEqual({ ok: true, brand: 'example' });
  });

  it('accepts a bare brand word (manual input)', () => {
    expect(extractBrand('my-brand')).toEqual({ ok: true, brand: 'my-brand' });
    expect(extractBrand('MyCompany')).toEqual({ ok: true, brand: 'mycompany' });
  });

  it('empty input → brand null (not an error)', () => {
    expect(extractBrand('')).toEqual({ ok: true, brand: null });
    expect(extractBrand('   ')).toEqual({ ok: true, brand: null });
    expect(extractBrand(null)).toEqual({ ok: true, brand: null });
    expect(extractBrand(undefined)).toEqual({ ok: true, brand: null });
  });

  it('cyrillic → error asking for latin', () => {
    const res = extractBrand('пример.рф');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/латиницей/);
  });

  it('cyrillic URL → error asking for latin', () => {
    const res = extractBrand('https://пример.рф');
    expect(res.ok).toBe(false);
  });

  it('garbage → error', () => {
    expect(extractBrand('not a domain at all!!').ok).toBe(false);
  });
});

describe('generateCandidates', () => {
  it('generates affixes × TLD_PRIORITY, bare brand first', () => {
    const c = generateCandidates('acme');
    expect(c.length).toBe(12 * 4);
    expect(c[0]).toEqual({ domain: 'acme.ru', tld: 'ru' });
    expect(c[1]).toEqual({ domain: 'acme.online', tld: 'online' });
    expect(c.map((x) => x.domain)).toContain('acme-hq.ru');
    expect(c.map((x) => x.domain)).toContain('get-acme.site');
    expect(c.map((x) => x.domain)).toContain('acmeofficial.ru');
  });

  it('deduplicates domains', () => {
    const c = generateCandidates('acme');
    expect(new Set(c.map((x) => x.domain)).size).toBe(c.length);
  });

  it('offset rotates the affix list ("ещё варианты")', () => {
    const first = generateCandidates('acme', 0);
    const second = generateCandidates('acme', 1);
    expect(second[0].domain).not.toBe(first[0].domain);
    expect(second[0].domain).toBe('acme-hq.ru');
  });

  it('rejects invalid brands', () => {
    expect(generateCandidates('')).toEqual([]);
    expect(generateCandidates('-bad-')).toEqual([]);
    expect(generateCandidates('пример')).toEqual([]);
  });
});

describe('suggestDomains', () => {
  it('N=3 → exactly 6 offers, ~2/3 .ru first', async () => {
    const res = await suggestDomains('acme', {
      requiredCount: 3,
      checkAvailability: allAvailable,
      now: NOW,
    });
    expect(res.length).toBe(6);
    expect(res.filter((s) => s.tld === 'ru').length).toBe(4);
    // .ru block comes before other zones.
    expect(res.slice(0, 4).every((s) => s.tld === 'ru')).toBe(true);
    expect(res.every((s) => s.available)).toBe(true);
    expect(res[0].checked_at).toBe(NOW.toISOString());
  });

  it('filters out taken domains', async () => {
    const res = await suggestDomains('acme', {
      requiredCount: 3,
      checkAvailability: availableExcept(new Set(['acme.ru'])),
      now: NOW,
    });
    expect(res.map((s) => s.domain)).not.toContain('acme.ru');
    expect(res.length).toBe(6);
  });

  it('tops up with other zones when .ru runs short', async () => {
    // Only one .ru candidate available — the offer must still reach 2N.
    const taken = new Set(
      generateCandidates('acme')
        .filter((c) => c.tld === 'ru')
        .map((c) => c.domain)
        .slice(1),
    );
    const res = await suggestDomains('acme', {
      requiredCount: 3,
      checkAvailability: availableExcept(taken),
      now: NOW,
    });
    expect(res.length).toBe(6);
    expect(res.filter((s) => s.tld === 'ru').length).toBe(1);
  });

  it('returns what is available when fewer than 2N', async () => {
    const candidates = generateCandidates('acme');
    const taken = new Set(candidates.map((c) => c.domain).slice(3));
    const res = await suggestDomains('acme', {
      requiredCount: 3,
      checkAvailability: availableExcept(taken),
      now: NOW,
    });
    expect(res.length).toBe(3);
    expect(res.every((s) => s.available)).toBe(true);
  });

  it('empty candidate set → empty offer, no check call', async () => {
    const check = jest.fn(allAvailable);
    const res = await suggestDomains('-bad-', {
      requiredCount: 3,
      checkAvailability: check,
      now: NOW,
    });
    expect(res).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('one batch check call for the whole candidate list', async () => {
    const check = jest.fn(allAvailable);
    await suggestDomains('acme', {
      requiredCount: 6,
      checkAvailability: check,
      now: NOW,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][0].length).toBe(12 * 4);
  });
});
