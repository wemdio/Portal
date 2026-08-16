import { describe, expect, test } from '@jest/globals';
import { normalizeDomain } from '@/lib/espScan/spfResolver';
import { scoreSpf, matchEspInSpf, ESP_GRADE_THRESHOLDS } from '@/lib/espScan/scoreSpf';
import { ESP_DICTIONARY } from '@/lib/espScan/espDictionary';

describe('normalizeDomain', () => {
  test('bare domain passes through', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
  });
  test('lowercases and strips www', () => {
    expect(normalizeDomain('WWW.Example.COM')).toBe('example.com');
  });
  test('strips scheme, path, query and hash', () => {
    expect(normalizeDomain('https://www.shop.co.uk/products/x?a=1#top')).toBe('shop.co.uk');
    expect(normalizeDomain('http://plain.org/some/path')).toBe('plain.org');
  });
  test('null/empty/invalid → null', () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('a.')).toBeNull();
    expect(normalizeDomain('no space allowed.com')).toBeNull();
    expect(normalizeDomain('https://')).toBeNull();
  });
});

describe('matchEspInSpf', () => {
  test('finds mailchimp via mcsv include', () => {
    const matched = matchEspInSpf('v=spf1 include:_spf.google.com include:servers.mcsv.net ~all');
    const keys = matched.map((m) => m.key);
    expect(keys).toContain('mailchimp');
    expect(keys).toContain('google_workspace');
  });
  test('case-insensitive matching', () => {
    const matched = matchEspInSpf('v=spf1 include:SPF.SendGrid.net ~all');
    expect(matched.map((m) => m.key)).toContain('sendgrid');
  });
  test('one match per entry even if several markers present', () => {
    const matched = matchEspInSpf('v=spf1 include:servers.mcsv.net include:mailchimp.com ~all');
    const mailchimp = matched.filter((m) => m.key === 'mailchimp');
    expect(mailchimp).toHaveLength(1);
  });
  test('null/empty/unknown spf → no matches', () => {
    expect(matchEspInSpf(null)).toEqual([]);
    expect(matchEspInSpf('')).toEqual([]);
    expect(matchEspInSpf('v=spf1 include:spf.unknown-esp.example ~all')).toEqual([]);
  });
});

describe('scoreSpf', () => {
  test('no spf → zero score, no grade, no matches', () => {
    const res = scoreSpf(null);
    expect(res.score).toBe(0);
    expect(res.grade).toBeNull();
    expect(res.matched).toEqual([]);
  });

  test('corporate-only SPF scores zero but keeps matches for info', () => {
    const res = scoreSpf('v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all');
    expect(res.score).toBe(0);
    expect(res.grade).toBeNull();
    expect(res.matched.map((m) => m.key).sort()).toEqual(['google_workspace', 'microsoft_365']);
  });

  test('transactional-only SPF (SendGrid) scores zero — транзакционные письма ≠ рассылки', () => {
    const res = scoreSpf('v=spf1 include:sendgrid.net ~all');
    expect(res.score).toBe(0);
    expect(res.matched.map((m) => m.key)).toEqual(['sendgrid']);
  });

  test('single marketing platform → B', () => {
    const res = scoreSpf('v=spf1 include:_spf.google.com include:servers.mcsv.net ~all');
    expect(res.score).toBe(50);
    expect(res.grade).toBe('B');
  });

  test('marketing automation only (HubSpot) → C', () => {
    const res = scoreSpf('v=spf1 include:spf.hubspotemail.net ~all');
    expect(res.score).toBe(40);
    expect(res.grade).toBe('C');
  });

  test('platform + automation → A', () => {
    const res = scoreSpf('v=spf1 include:servers.mcsv.net include:spf.hubspotemail.net ~all');
    expect(res.score).toBe(90);
    expect(res.grade).toBe('A');
  });
});

describe('ESP dictionary sanity', () => {
  test('keys are unique', () => {
    const keys = ESP_DICTIONARY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test('markers are lowercase (matching is case-insensitive by lowercased spf)', () => {
    for (const entry of ESP_DICTIONARY) {
      for (const marker of entry.markers) {
        expect(marker).toBe(marker.toLowerCase());
      }
    }
  });
  test('only marketing entries have non-zero weight', () => {
    for (const entry of ESP_DICTIONARY) {
      if (entry.category !== 'marketing') {
        expect(entry.weight).toBe(0);
      } else {
        expect(entry.weight).toBeGreaterThan(0);
      }
    }
  });
  test('grade thresholds consistent: single automation < B-threshold < single platform', () => {
    expect(ESP_GRADE_THRESHOLDS.B).toBeGreaterThan(40);
    expect(ESP_GRADE_THRESHOLDS.B).toBeLessThanOrEqual(50);
  });
});
