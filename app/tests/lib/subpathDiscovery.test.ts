/** @jest-environment node */

import { discoverSubpaths } from '@/lib/enrich/subpathDiscovery';

const BASE = 'https://example.com';

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe('discoverSubpaths', () => {
  it('finds /pricing link from EN anchor and returns absolute URL', () => {
    const result = discoverSubpaths(
      html(`<a href="/pricing">Pricing</a>`),
      BASE,
      ['pricing'],
    );

    expect(result.pricing).toBe('https://example.com/pricing');
  });

  it('finds RU variants of subpages by URL path', () => {
    const result = discoverSubpaths(
      html(`
        <a href="/тарифы">Тарифы</a>
        <a href="/вакансии">Вакансии</a>
        <a href="/о-компании">О нас</a>
      `),
      BASE,
      ['pricing', 'careers', 'about'],
    );

    expect(result.pricing).toMatch(/\/(тарифы|%D1%82%D0%B0)/);
    expect(result.careers).toMatch(/\/(вакансии|%D0%B2%D0%B0)/);
    expect(result.about).toMatch(/о-компании|%D0%BE-/);
  });

  it('finds RU variants by anchor text when path is not obvious', () => {
    const result = discoverSubpaths(
      html(`
        <a href="/p">Цены</a>
        <a href="/c">Клиенты</a>
        <a href="/i">Интеграции</a>
      `),
      BASE,
      ['pricing', 'cases', 'integrations'],
    );

    expect(result.pricing).toBe('https://example.com/p');
    expect(result.cases).toBe('https://example.com/c');
    expect(result.integrations).toBe('https://example.com/i');
  });

  it('finds all 6 EN subpage kinds from one page', () => {
    const result = discoverSubpaths(
      html(`
        <a href="/pricing">Pricing</a>
        <a href="/careers">Careers</a>
        <a href="/cases">Case studies</a>
        <a href="/integrations">Integrations</a>
        <a href="/about">About</a>
        <a href="/blog">Blog</a>
      `),
      BASE,
      ['pricing', 'careers', 'cases', 'integrations', 'about', 'blog'],
    );

    expect(result.pricing).toBe('https://example.com/pricing');
    expect(result.careers).toBe('https://example.com/careers');
    expect(result.cases).toBe('https://example.com/cases');
    expect(result.integrations).toBe('https://example.com/integrations');
    expect(result.about).toBe('https://example.com/about');
    expect(result.blog).toBe('https://example.com/blog');
  });

  it('returns only requested kinds even when more are present in HTML', () => {
    const result = discoverSubpaths(
      html(`
        <a href="/pricing">Pricing</a>
        <a href="/careers">Careers</a>
        <a href="/cases">Cases</a>
      `),
      BASE,
      ['pricing'],
    );

    expect(result.pricing).toBe('https://example.com/pricing');
    expect(result.careers).toBeUndefined();
    expect(result.cases).toBeUndefined();
  });

  it('ignores links to other domains', () => {
    const result = discoverSubpaths(
      html(`
        <a href="https://other-site.com/pricing">Their pricing</a>
        <a href="/pricing">Our pricing</a>
      `),
      BASE,
      ['pricing'],
    );

    expect(result.pricing).toBe('https://example.com/pricing');
  });

  it('ignores hash-only and javascript: links', () => {
    const result = discoverSubpaths(
      html(`
        <a href="#pricing">Pricing anchor</a>
        <a href="javascript:void(0)">Pricing</a>
        <a href="?tab=pricing">Pricing tab</a>
      `),
      BASE,
      ['pricing'],
    );

    expect(result.pricing).toBeUndefined();
  });

  it('returns first match when multiple links of the same kind exist', () => {
    const result = discoverSubpaths(
      html(`
        <a href="/pricing">First</a>
        <a href="/pricing-old">Old</a>
        <a href="/tariffs">Tariffs</a>
      `),
      BASE,
      ['pricing'],
    );

    expect(result.pricing).toBe('https://example.com/pricing');
  });

  it('returns empty object when HTML has no relevant links', () => {
    const result = discoverSubpaths(
      html(`<a href="/">Home</a><a href="/contact">Contact</a>`),
      BASE,
      ['pricing', 'careers', 'cases'],
    );

    expect(Object.keys(result)).toHaveLength(0);
  });
});
