/**
 * Pure tests for the support-chat input validation + preview helpers.
 *
 * The DB (CHECK on client_support_messages.body) and both route handlers
 * delegate to validateMessageBody so length/empty rules are guaranteed
 * consistent. This file pins those contracts.
 */

import {
  buildMessagePreview,
  SUPPORT_MESSAGE_MAX_LEN,
  validateMessageBody,
} from '@/lib/clientSupport/types';

describe('validateMessageBody', () => {
  it('rejects non-strings', () => {
    expect(validateMessageBody(undefined).ok).toBe(false);
    expect(validateMessageBody(null).ok).toBe(false);
    expect(validateMessageBody(123).ok).toBe(false);
    expect(validateMessageBody({}).ok).toBe(false);
    expect(validateMessageBody([]).ok).toBe(false);
  });

  it('rejects empty/whitespace-only strings', () => {
    expect(validateMessageBody('').ok).toBe(false);
    expect(validateMessageBody('   ').ok).toBe(false);
    expect(validateMessageBody('\n\t').ok).toBe(false);
  });

  it('rejects strings longer than SUPPORT_MESSAGE_MAX_LEN', () => {
    const tooLong = 'a'.repeat(SUPPORT_MESSAGE_MAX_LEN + 1);
    const res = validateMessageBody(tooLong);
    expect(res.ok).toBe(false);
  });

  it('accepts and trims a normal message', () => {
    const res = validateMessageBody('   Привет менеджер   ');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toBe('Привет менеджер');
  });

  it('accepts string of exactly SUPPORT_MESSAGE_MAX_LEN', () => {
    const exact = 'b'.repeat(SUPPORT_MESSAGE_MAX_LEN);
    const res = validateMessageBody(exact);
    expect(res.ok).toBe(true);
  });
});

describe('buildMessagePreview', () => {
  it('collapses whitespace and trims', () => {
    expect(buildMessagePreview('  hello  \n\n world  ')).toBe('hello world');
  });

  it('truncates with ellipsis above maxLen', () => {
    const out = buildMessagePreview('a'.repeat(200), 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns the full string when shorter than maxLen', () => {
    expect(buildMessagePreview('short', 100)).toBe('short');
  });
});
