/**
 * @jest-environment node
 *
 * Tests for buildMarkdownLink — the «Вставить ссылку» behaviour in the client
 * launch wizard.
 *
 * The client selects a word (e.g. «Егор» / «наш сайт») and inserts a UTM URL;
 * the button wraps it as markdown `[Егор](https://…)`. toInstantlyHtmlBody
 * later turns that into `<a href>` so the word is clickable and the URL is
 * hidden from the recipient. Nothing else the client types can become HTML.
 */

import { buildMarkdownLink } from '@/lib/clientLaunch/linkSnippet';

describe('buildMarkdownLink', () => {
  it('wraps the selected word as a markdown link hiding the URL', () => {
    expect(buildMarkdownLink('Егор', 'https://polzaagency.ru/?utm_source=x')).toBe(
      '[Егор](https://polzaagency.ru/?utm_source=x)',
    );
  });

  it('no selected word → the URL becomes its own clickable text', () => {
    expect(buildMarkdownLink('', 'https://example.com')).toBe(
      '[https://example.com](https://example.com)',
    );
  });

  it('trims whitespace around the anchor', () => {
    expect(buildMarkdownLink('  наш сайт  ', 'https://x.ru')).toBe('[наш сайт](https://x.ru)');
  });

  it('whitespace-only anchor → URL as its own text', () => {
    expect(buildMarkdownLink('   ', 'https://x.ru')).toBe('[https://x.ru](https://x.ru)');
  });

  it('anchor identical to the URL → URL as its own text (re-link over existing)', () => {
    expect(buildMarkdownLink('https://x.ru', 'https://x.ru')).toBe('[https://x.ru](https://x.ru)');
  });

  it('preserves multi-word anchors', () => {
    expect(buildMarkdownLink('перейти на сайт', 'https://x.ru')).toBe(
      '[перейти на сайт](https://x.ru)',
    );
  });

  it('sanitizes anchor chars that would break the markdown parse (] and newlines)', () => {
    // The link regex forbids `]` and newlines inside the anchor — strip/collapse
    // them so a selection containing those still produces a valid link.
    expect(buildMarkdownLink('a] b\nc', 'https://x.ru')).toBe('[a  b c](https://x.ru)');
  });
});
