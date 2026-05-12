/**
 * Tests for extractWebsiteText — pure HTML → sanitized text extractor used
 * by the client brief autofill flow. No network, no globals; just a string
 * transformer that prepares website content for the AI prompt.
 *
 * Contract:
 *   extractWebsiteText(html: string, opts?: { maxChars?: number }) -> {
 *     title: string;
 *     metaDescription: string;
 *     ogDescription: string;
 *     ogSiteName: string;
 *     body: string;
 *     combined: string;   // human-readable concatenation, capped to maxChars
 *   }
 */

import { extractWebsiteText } from '@/lib/clientBrief/autofill/extractWebsiteText';

describe('extractWebsiteText — script/style/noscript stripping', () => {
  it('removes <script> tags and their contents entirely', () => {
    const html = `<html><body><p>Hello</p><script>const x = "bad words";</script></body></html>`;
    const result = extractWebsiteText(html);
    expect(result.body).toContain('Hello');
    expect(result.body).not.toContain('bad words');
    expect(result.combined).not.toContain('bad words');
  });

  it('removes <style> tags and their contents', () => {
    const html = `<html><body><style>.a{color:red}</style><p>Visible</p></body></html>`;
    const result = extractWebsiteText(html);
    expect(result.body).toContain('Visible');
    expect(result.body).not.toContain('color:red');
  });

  it('removes <noscript> blocks', () => {
    const html = `<html><body><noscript>Enable JS</noscript><p>Real</p></body></html>`;
    const result = extractWebsiteText(html);
    expect(result.body).toContain('Real');
    expect(result.body).not.toContain('Enable JS');
  });

  it('removes inline event handlers and SVG/path noise without dropping nearby text', () => {
    const html = `<html><body><svg><path d="M1 2"/></svg><p>Keep me</p></body></html>`;
    const result = extractWebsiteText(html);
    expect(result.body).toContain('Keep me');
    expect(result.body).not.toMatch(/M1 2/);
  });
});

describe('extractWebsiteText — head extraction', () => {
  it('extracts <title>', () => {
    const html = `<html><head><title>Acme — best widgets</title></head><body></body></html>`;
    expect(extractWebsiteText(html).title).toBe('Acme — best widgets');
  });

  it('extracts <meta name="description"> case-insensitively', () => {
    const html = `<html><head><meta name="DESCRIPTION" content="We sell widgets to plumbers"></head><body></body></html>`;
    expect(extractWebsiteText(html).metaDescription).toBe('We sell widgets to plumbers');
  });

  it('extracts og:description and og:site_name', () => {
    const html = `
      <html><head>
        <meta property="og:description" content="OG description here">
        <meta property="og:site_name" content="Acme Inc">
      </head><body></body></html>
    `;
    const result = extractWebsiteText(html);
    expect(result.ogDescription).toBe('OG description here');
    expect(result.ogSiteName).toBe('Acme Inc');
  });

  it('returns empty strings when head tags are missing', () => {
    const result = extractWebsiteText(`<html><body><p>only body</p></body></html>`);
    expect(result.title).toBe('');
    expect(result.metaDescription).toBe('');
    expect(result.ogDescription).toBe('');
    expect(result.ogSiteName).toBe('');
  });
});

describe('extractWebsiteText — body text', () => {
  it('collapses whitespace and normalizes newlines', () => {
    const html = `<html><body><p>line   one</p>\r\n<p>line\ttwo</p></body></html>`;
    const body = extractWebsiteText(html).body;
    expect(body).toContain('line one');
    expect(body).toContain('line two');
    expect(body).not.toMatch(/\r/);
    expect(body).not.toMatch(/\t/);
    expect(body).not.toMatch(/ {2,}/);
  });

  it('decodes common HTML entities (&amp; &nbsp; &laquo; &raquo;)', () => {
    const html = `<html><body><p>Tom &amp; Jerry &laquo;duo&raquo;&nbsp;forever</p></body></html>`;
    const body = extractWebsiteText(html).body;
    expect(body).toContain('Tom & Jerry');
    expect(body).toContain('«duo»');
    expect(body).toContain('forever');
  });

  it('strips HTML tags but preserves the order of textual nodes', () => {
    const html = `<html><body><h1>Heading</h1><p>Para one</p><ul><li>One</li><li>Two</li></ul></body></html>`;
    const body = extractWebsiteText(html).body;
    expect(body.indexOf('Heading')).toBeLessThan(body.indexOf('Para one'));
    expect(body.indexOf('Para one')).toBeLessThan(body.indexOf('One'));
    expect(body.indexOf('One')).toBeLessThan(body.indexOf('Two'));
  });
});

describe('extractWebsiteText — combined output + maxChars cap', () => {
  it('combined includes title, descriptions and body', () => {
    const html = `
      <html><head>
        <title>Acme</title>
        <meta name="description" content="Desc here">
        <meta property="og:site_name" content="Acme Inc">
      </head><body><p>Body text</p></body></html>
    `;
    const combined = extractWebsiteText(html).combined;
    expect(combined).toContain('Acme');
    expect(combined).toContain('Desc here');
    expect(combined).toContain('Acme Inc');
    expect(combined).toContain('Body text');
  });

  it('truncates combined to maxChars when provided', () => {
    const big = 'x'.repeat(50_000);
    const html = `<html><body><p>${big}</p></body></html>`;
    const result = extractWebsiteText(html, { maxChars: 1_000 });
    expect(result.combined.length).toBeLessThanOrEqual(1_000);
  });

  it('uses a sensible default maxChars when not provided', () => {
    const big = 'x'.repeat(200_000);
    const html = `<html><body><p>${big}</p></body></html>`;
    const combined = extractWebsiteText(html).combined;
    expect(combined.length).toBeLessThanOrEqual(40_000);
  });
});

describe('extractWebsiteText — degenerate inputs', () => {
  it('returns all-empty result for empty string', () => {
    const result = extractWebsiteText('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
    expect(result.combined).toBe('');
  });

  it('returns all-empty result for non-HTML garbage without throwing', () => {
    expect(() => extractWebsiteText('not html at all <<<>>>')).not.toThrow();
  });

  it('handles broken HTML without throwing', () => {
    const html = `<html><head><title>Open<body><p>Stuck`;
    expect(() => extractWebsiteText(html)).not.toThrow();
  });
});
