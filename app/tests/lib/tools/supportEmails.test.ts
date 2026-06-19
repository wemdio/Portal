/**
 * @jest-environment node
 *
 * «Убрать почты поддержки» — support/service mailbox detection + the pipeline
 * step that drops rows whose only email is a support inbox (support@, help@,
 * zakaz@, billing@ …). Good general inboxes (info@, sales@, contact@) are KEPT.
 */
import { isSupportEmail, isRoleLocalPart } from '@/lib/tools/supportEmails';
import { stepRemoveSupportEmails, FOUND_EMAIL_COL } from '@/lib/tools/processingSteps';

const noop = async () => {};

describe('isSupportEmail / isRoleLocalPart', () => {
  it('flags support / service / system / orders / finance mailboxes', () => {
    for (const e of [
      'support@x.com', 'help@x.ru', 'helpdesk@x.com', 'service@x.com',
      'podderzhka@x.ru', 'zakaz@x.ru', 'order@x.com', 'dostavka@x.ru',
      'billing@x.com', 'buh@x.ru', 'accounts@x.com',
      'noreply@x.com', 'no-reply@x.com', 'abuse@x.com', 'HELP@X.COM',
    ]) {
      expect(isSupportEmail(e)).toBe(true);
    }
  });

  it('KEEPS good general inboxes (info@, sales@, contact@) AND HR (hr@, jobs@ …)', () => {
    for (const e of [
      'info@x.ru', 'sales@x.com', 'contact@x.com', 'contacts@x.com',
      'office@x.ru', 'hello@x.com', 'hi@x.com', 'mail@x.ru', 'general@x.com',
      'marketing@x.com', 'reklama@x.ru', 'press@x.com',
      'hr@x.com', 'jobs@x.com', 'vacancy@x.ru', 'career@x.com', 'rekrut@x.ru',
      'info.msk@x.ru', 'sales2@x.com', // role word NOT in the support set
    ]) {
      expect(isSupportEmail(e)).toBe(false);
    }
  });

  it('flags support word + separator/digit, but NOT support word + letters', () => {
    expect(isSupportEmail('support.team@x.com')).toBe(true);
    expect(isSupportEmail('zakaz-spb@x.ru')).toBe(true);
    expect(isSupportEmail('support2@x.com')).toBe(true);
    expect(isSupportEmail('billing.dept@x.com')).toBe(true);
    expect(isSupportEmail('supportive@x.com')).toBe(false);
  });

  it('does NOT flag personal addresses, empties or junk', () => {
    for (const e of [
      'ivan@x.com', 'ivan.petrov@x.ru', 'j.smith@x.com', 'a.kozlov@company.com',
      'boss@x.ru', '', 'not-an-email', '@x.com',
    ]) {
      expect(isSupportEmail(e)).toBe(false);
    }
  });

  it('isRoleLocalPart works on the bare local part', () => {
    expect(isRoleLocalPart('SUPPORT')).toBe(true);
    expect(isRoleLocalPart('info')).toBe(false);
    expect(isRoleLocalPart('ivan')).toBe(false);
  });
});

describe('stepRemoveSupportEmails', () => {
  it('drops support-type rows; KEEPS info@ / personal / emailless rows', async () => {
    const data = [
      ['компания', 'email'],
      ['A', 'support@x.ru'], // drop
      ['B', 'ivan@x.ru'],    // keep (personal)
      ['C', ''],             // keep (no email)
      ['D', 'zakaz@x.ru'],   // drop
      ['E', 'info@x.ru'],    // keep (good general box)
    ];
    const out = await stepRemoveSupportEmails(data, noop);
    expect(out.map((r) => r[0])).toEqual(['компания', 'B', 'C', 'E']);
  });

  it('strips a support email from a mixed cell but keeps the row + the personal one', async () => {
    const out = await stepRemoveSupportEmails(
      [['компания', 'email'], ['A', 'support@x.ru, ivan@x.ru']],
      noop,
    );
    expect(out).toHaveLength(2);
    expect(out[1][1]).toBe('ivan@x.ru');
  });

  it('also filters the found-email column (find_emails target=separate)', async () => {
    const data = [
      ['компания', 'email', FOUND_EMAIL_COL],
      ['A', '', 'support@x.ru'],          // only a found support@ → drop
      ['B', '', 'ivan@x.ru'],             // found personal → keep
      ['C', 'boss@x.ru', 'support@x.ru'], // personal original + found support → keep, found stripped
    ];
    const out = await stepRemoveSupportEmails(data, noop);
    expect(out.map((r) => r[0])).toEqual(['компания', 'B', 'C']);
    const cRow = out.find((r) => r[0] === 'C')!;
    expect(cRow[2]).toBe('');
  });

  it('is a no-op when there is no email column', async () => {
    const data = [['компания', 'сайт'], ['A', 'x.ru']];
    const out = await stepRemoveSupportEmails(data, noop);
    expect(out).toEqual(data);
  });
});
