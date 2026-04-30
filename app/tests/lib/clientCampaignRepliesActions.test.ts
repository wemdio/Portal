import {
  isValidEmail,
  parseEmailList,
  validateReplyInput,
  validateForwardInput,
} from '@/lib/clientCampaignReplies/validate';
import { findEaccountForReply } from '@/lib/clientCampaignReplies/findEaccount';
import { mapInstantlyEmailToThreadMessage } from '@/lib/clientCampaignReplies/mapEmail';
import type { Email } from '@/lib/instantly/types';

// ─── isValidEmail ────────────────────────────────────────────────────────────

describe('isValidEmail', () => {
  it.each([
    ['user@example.com', true],
    ['a.b+tag@sub.example.co.uk', true],
    ['кир@почта.рф', true], // unicode local + tld
    ['no-at-sign', false],
    ['@no-local.com', false],
    ['no-domain@', false],
    ['  spaces around@example.com  ', false],
    ['', false],
  ])('isValidEmail(%j) === %j', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
});

// ─── parseEmailList ──────────────────────────────────────────────────────────

describe('parseEmailList', () => {
  it('пустая строка — пустой результат', () => {
    expect(parseEmailList('')).toEqual({ valid: [], invalid: [] });
  });

  it('один email', () => {
    expect(parseEmailList('alice@example.com')).toEqual({
      valid: ['alice@example.com'],
      invalid: [],
    });
  });

  it('comma-separated', () => {
    expect(parseEmailList('alice@x.com, bob@y.com,carol@z.com')).toEqual({
      valid: ['alice@x.com', 'bob@y.com', 'carol@z.com'],
      invalid: [],
    });
  });

  it('semicolon тоже разделитель', () => {
    expect(parseEmailList('alice@x.com; bob@y.com')).toEqual({
      valid: ['alice@x.com', 'bob@y.com'],
      invalid: [],
    });
  });

  it('mixed valid+invalid', () => {
    const r = parseEmailList('alice@x.com, broken-string, bob@y.com');
    expect(r.valid).toEqual(['alice@x.com', 'bob@y.com']);
    expect(r.invalid).toEqual(['broken-string']);
  });

  it('дедуплицирует case-insensitive', () => {
    const r = parseEmailList('Alice@X.com, alice@x.com, ALICE@X.COM');
    expect(r.valid).toEqual(['alice@x.com']);
  });

  it('игнорирует пустые сегменты', () => {
    expect(parseEmailList(',, , alice@x.com,')).toEqual({
      valid: ['alice@x.com'],
      invalid: [],
    });
  });
});

// ─── validateReplyInput ──────────────────────────────────────────────────────

describe('validateReplyInput', () => {
  it('требует body_text', () => {
    const r = validateReplyInput({ body_text: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/тело|body/i);
  });

  it('обрезает body до лимита (100k символов)', () => {
    const r = validateReplyInput({ body_text: 'A'.repeat(200_000) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/слишком|длин/i);
  });

  it('минимальный валидный — только body_text, без cc/bcc', () => {
    const r = validateReplyInput({ body_text: 'Hi there' });
    expect(r.ok).toBe(true);
    expect(r.cc).toBeUndefined();
    expect(r.bcc).toBeUndefined();
    expect(r.body_text).toBe('Hi there');
  });

  it('cc нормализуется в comma-string', () => {
    const r = validateReplyInput({ body_text: 'Hi', cc: 'alice@x.com; bob@y.com' });
    expect(r.ok).toBe(true);
    expect(r.cc).toBe('alice@x.com,bob@y.com');
  });

  it('некорректный cc — ошибка с указанием невалидных адресов', () => {
    const r = validateReplyInput({ body_text: 'Hi', cc: 'broken, alice@x.com' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/broken/);
  });

  it('обрезает trailing пробелы у body_text', () => {
    const r = validateReplyInput({ body_text: '  Hello!  \n' });
    expect(r.ok).toBe(true);
    expect(r.body_text).toBe('Hello!');
  });
});

// ─── validateForwardInput ────────────────────────────────────────────────────

describe('validateForwardInput', () => {
  it('требует валидный to_email', () => {
    expect(validateForwardInput({ to_email: '' }).ok).toBe(false);
    expect(validateForwardInput({ to_email: 'not-email' }).ok).toBe(false);
  });

  it('успешно для одного валидного email', () => {
    const r = validateForwardInput({ to_email: 'colleague@company.ru' });
    expect(r.ok).toBe(true);
    expect(r.to_email).toBe('colleague@company.ru');
  });

  it('запрещает несколько адресов (forward — 1-к-1)', () => {
    const r = validateForwardInput({ to_email: 'a@x.com, b@y.com' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/одн|single/i);
  });

  it('тримит и lowercase', () => {
    const r = validateForwardInput({ to_email: '  X@Y.com  ' });
    expect(r.ok).toBe(true);
    expect(r.to_email).toBe('x@y.com');
  });
});

// ─── findEaccountForReply ────────────────────────────────────────────────────

function ema(o: Partial<Email> = {}): Email {
  return { id: 'e', ...o };
}

describe('findEaccountForReply', () => {
  it('берёт eaccount прямо из исходного письма, если есть', () => {
    const original = ema({ id: 'r1', eaccount: 'us@polza.ru', thread_id: 't1', ue_type: 2 });
    expect(findEaccountForReply({ originalEmail: original, threadEmails: [] })).toBe('us@polza.ru');
  });

  it('падёт на thread: ищет последнее outbound письмо (ue_type=1 или 3) того же thread_id', () => {
    const original = ema({ id: 'r1', thread_id: 't1', ue_type: 2 });
    const thread = [
      ema({ id: 'a', thread_id: 't1', ue_type: 1, eaccount: 'us-old@polza.ru', timestamp_email: '2026-04-01T00:00:00Z' }),
      ema({ id: 'b', thread_id: 't1', ue_type: 3, eaccount: 'us-new@polza.ru', timestamp_email: '2026-04-15T00:00:00Z' }),
      ema({ id: 'c', thread_id: 'other', ue_type: 1, eaccount: 'foreign@polza.ru' }),
    ];
    expect(findEaccountForReply({ originalEmail: original, threadEmails: thread })).toBe('us-new@polza.ru');
  });

  it('возвращает null, если eaccount нигде не найден', () => {
    const original = ema({ id: 'r1', thread_id: 't1', ue_type: 2 });
    expect(findEaccountForReply({ originalEmail: original, threadEmails: [] })).toBeNull();
  });

  it('игнорирует входящие письма (ue_type=2) при выборе outbound eaccount', () => {
    const original = ema({ id: 'r1', thread_id: 't1', ue_type: 2 });
    const thread = [
      ema({ id: 'a', thread_id: 't1', ue_type: 2, eaccount: 'lead-leak@x.com' }),
    ];
    expect(findEaccountForReply({ originalEmail: original, threadEmails: thread })).toBeNull();
  });
});

// ─── mapInstantlyEmailToThreadMessage ────────────────────────────────────────

describe('mapInstantlyEmailToThreadMessage', () => {
  it('ue_type=1 (initial outbound) → direction=outbound', () => {
    const m = mapInstantlyEmailToThreadMessage(ema({ id: '1', ue_type: 1, eaccount: 'us@x.com', body: { text: 'Hi lead' } }));
    expect(m.direction).toBe('outbound');
    expect(m.from_email).toBe('us@x.com');
  });

  it('ue_type=2 (lead reply) → direction=inbound', () => {
    const m = mapInstantlyEmailToThreadMessage(
      ema({ id: '2', ue_type: 2, from_address_email: 'lead@x.com', body: { text: 'Hello' } }),
    );
    expect(m.direction).toBe('inbound');
    expect(m.from_email).toBe('lead@x.com');
  });

  it('ue_type=3 (our manual reply) → direction=outbound', () => {
    const m = mapInstantlyEmailToThreadMessage(
      ema({ id: '3', ue_type: 3, eaccount: 'us@x.com', body: { text: 'Reply' } }),
    );
    expect(m.direction).toBe('outbound');
    expect(m.from_email).toBe('us@x.com');
  });

  it('не протекают служебные поля', () => {
    const m = mapInstantlyEmailToThreadMessage(
      ema({ id: '1', ue_type: 1, eaccount: 'us@x.com', i_status: 5, is_focused: 1, body: { text: 'x' } }),
    ) as unknown as Record<string, unknown>;
    expect(m.eaccount).toBeUndefined();
    expect(m.i_status).toBeUndefined();
    expect(m.is_focused).toBeUndefined();
  });
});
