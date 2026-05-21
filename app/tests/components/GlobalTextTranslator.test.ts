/**
 * Regression coverage for the predicate split in GlobalTextTranslator.
 *
 * The original `shouldSkipElement` used a single rule for both text-node
 * collection and attribute collection. That meant a `<textarea>` placeholder
 * (developer-authored label) was being skipped along with the textarea's
 * child text (user-typed draft) — and the brief page's Russian placeholder
 * never got translated when the user switched locale.
 *
 * These tests pin the corrected behaviour: text inside a textarea is still
 * skipped, but its translatable attributes are not.
 */

import { shouldSkipTextIn, shouldSkipAttrsOn } from '@/components/GlobalTextTranslator';

function el(tag: string, opts: { contentEditable?: boolean; wrap?: string } = {}) {
  const node = document.createElement(tag);
  if (opts.contentEditable) (node as HTMLElement).contentEditable = 'true';
  if (opts.wrap) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute(opts.wrap, '');
    wrapper.appendChild(node);
    document.body.appendChild(wrapper);
  } else {
    document.body.appendChild(node);
  }
  return node;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldSkipTextIn — child-text rule', () => {
  test.each([['SCRIPT'], ['STYLE'], ['CODE'], ['PRE'], ['TEXTAREA']])(
    'skips text inside <%s> (code / user input)',
    (tag) => {
      expect(shouldSkipTextIn(el(tag))).toBe(true);
    },
  );

  test('skips text inside contenteditable (user input)', () => {
    // jsdom doesn't compute `isContentEditable` from the attribute the way a
    // real browser does, so we stub the getter for this assertion. Production
    // code reads HTMLElement.isContentEditable verbatim.
    const node = el('div');
    Object.defineProperty(node, 'isContentEditable', { value: true, configurable: true });
    expect(shouldSkipTextIn(node)).toBe(true);
  });

  test('skips text inside a [data-i18n-skip] subtree (overlay opt-out)', () => {
    expect(shouldSkipTextIn(el('span', { wrap: 'data-i18n-skip' }))).toBe(true);
  });

  test('does not skip text in ordinary content elements', () => {
    expect(shouldSkipTextIn(el('p'))).toBe(false);
    expect(shouldSkipTextIn(el('span'))).toBe(false);
    expect(shouldSkipTextIn(el('label'))).toBe(false);
  });

  test('skips when element is missing', () => {
    expect(shouldSkipTextIn(null)).toBe(true);
  });
});

describe('shouldSkipAttrsOn — own-attribute rule', () => {
  // The regression: textarea placeholders MUST be eligible for translation.
  test('does NOT skip <textarea> (regression: placeholder must translate)', () => {
    expect(shouldSkipAttrsOn(el('textarea'))).toBe(false);
  });

  test.each([['CODE'], ['PRE']])(
    'does NOT skip <%s> — its placeholder/title/aria-label is still authored copy',
    (tag) => {
      expect(shouldSkipAttrsOn(el(tag))).toBe(false);
    },
  );

  test('does not skip ordinary form controls', () => {
    expect(shouldSkipAttrsOn(el('input'))).toBe(false);
    expect(shouldSkipAttrsOn(el('button'))).toBe(false);
    expect(shouldSkipAttrsOn(el('select'))).toBe(false);
  });

  test.each([['SCRIPT'], ['STYLE']])('still skips <%s>', (tag) => {
    expect(shouldSkipAttrsOn(el(tag))).toBe(true);
  });

  test('still honours [data-i18n-skip] opt-out', () => {
    expect(shouldSkipAttrsOn(el('input', { wrap: 'data-i18n-skip' }))).toBe(true);
  });

  test('skips when element is missing', () => {
    expect(shouldSkipAttrsOn(null)).toBe(true);
  });
});
