import type { Email } from '@/lib/instantly/types';
import {
  getEmailRecipients,
  computeReplyAllCc,
  mergeCcLists,
} from '@/lib/clientCampaignReplies/participants';

function email(partial: Partial<Email>): Email {
  return { id: 'e1', ...partial } as Email;
}

describe('getEmailRecipients', () => {
  it('parses to/cc from the *_json form (with names)', () => {
    const { to, cc } = getEmailRecipients(
      email({
        to_address_json: [{ address: 'a@x.com', name: 'A' }],
        cc_address_json: [{ address: 'c@x.com' }],
      }),
    );
    expect(to).toEqual([{ email: 'a@x.com', name: 'A' }]);
    expect(cc).toEqual([{ email: 'c@x.com', name: null }]);
  });

  it('falls back to the *_email_list comma-string and dedupes case-insensitively', () => {
    const { to } = getEmailRecipients(
      email({
        to_address_json: [{ address: 'a@x.com', name: 'A' }],
        to_address_email_list: 'A@x.com, b@y.com',
      }),
    );
    expect(to).toEqual([
      { email: 'a@x.com', name: 'A' },
      { email: 'b@y.com', name: null },
    ]);
  });
});

describe('computeReplyAllCc', () => {
  // The production incident: lead (Юля) replied and put the line producer
  // (Sveta) in To alongside our mailbox. Reply-all must keep Sveta.
  it('keeps a participant the lead looped in, dropping us and the lead', () => {
    const original = email({
      from_address_email: 'j.generalova@rocketf.com',
      to_address_json: [
        { address: 'admin@pitchstudio.ru', name: 'Анастасия' },
        { address: 's.bespalova@rocketf.com', name: 'Svetlana' },
      ],
    });
    expect(
      computeReplyAllCc(original, {
        eaccount: 'admin@pitchstudio.ru',
        leadEmail: 'j.generalova@rocketf.com',
      }),
    ).toEqual(['s.bespalova@rocketf.com']);
  });

  it('excludes our mailbox and the lead case-insensitively + includes CC participants', () => {
    const original = email({
      from_address_email: 'Lead@Co.com',
      to_address_email_list: 'OURBOX@us.com, keep@co.com',
      cc_address_json: [{ address: 'boss@co.com' }, { address: 'lead@co.com' }],
    });
    expect(
      computeReplyAllCc(original, { eaccount: 'ourbox@us.com', leadEmail: 'lead@co.com' }),
    ).toEqual(['keep@co.com', 'boss@co.com']);
  });

  it('returns [] when nobody else is on the thread', () => {
    const original = email({
      from_address_email: 'lead@co.com',
      to_address_json: [{ address: 'ourbox@us.com' }],
    });
    expect(computeReplyAllCc(original, { eaccount: 'ourbox@us.com', leadEmail: 'lead@co.com' })).toEqual([]);
  });
});

describe('mergeCcLists', () => {
  it('merges case-insensitively, preserves first spelling, drops non-emails', () => {
    expect(mergeCcLists(['a@x.com', 'bad'], ['A@x.com', 'b@y.com', ''])).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
});
