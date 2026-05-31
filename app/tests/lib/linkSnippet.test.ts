/**
 * @jest-environment node
 *
 * Tests for buildPlainTextLinkSnippet — the «Вставить ссылку» behaviour in
 * the client launch wizard.
 *
 * Bug it fixes: client selected «Егор», inserted a UTM link, and the link
 * REPLACED «Егор» (the word vanished). Since client emails are plain-text
 * (no HTML anchors possible), the fix keeps the word and appends the URL
 * next to it: `Егор (https://…)`.
 */

import { buildPlainTextLinkSnippet } from '@/lib/clientLaunch/linkSnippet';

describe('buildPlainTextLinkSnippet', () => {
  it('keeps the selected word and appends the URL in parens', () => {
    expect(buildPlainTextLinkSnippet('Егор', 'https://polzaagency.ru/?utm_source=x')).toBe(
      'Егор (https://polzaagency.ru/?utm_source=x)',
    );
  });

  it('no selected word → just the URL', () => {
    expect(buildPlainTextLinkSnippet('', 'https://example.com')).toBe('https://example.com');
  });

  it('trims whitespace around both anchor and url', () => {
    expect(buildPlainTextLinkSnippet('  наш сайт  ', '  https://x.ru  ')).toBe(
      'наш сайт (https://x.ru)',
    );
  });

  it('whitespace-only anchor is treated as empty → just the URL', () => {
    expect(buildPlainTextLinkSnippet('   ', 'https://x.ru')).toBe('https://x.ru');
  });

  it('anchor identical to the URL collapses to one (re-insert over an existing link)', () => {
    // Avoids «https://x.ru (https://x.ru)» when the selection was already
    // the same URL.
    expect(buildPlainTextLinkSnippet('https://x.ru', 'https://x.ru')).toBe('https://x.ru');
  });

  it('preserves multi-word anchors', () => {
    expect(buildPlainTextLinkSnippet('перейти на сайт', 'https://x.ru')).toBe(
      'перейти на сайт (https://x.ru)',
    );
  });
});
