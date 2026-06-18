/**
 * @jest-environment node
 *
 * «Убрать почты поддержки» — role/generic mailbox detection + the pipeline step
 * that drops rows whose only email is a generic inbox (support@, info@, zakaz@…).
 */
import { isSupportEmail, isRoleLocalPart } from '@/lib/tools/supportEmails';
import { stepRemoveSupportEmails, FOUND_EMAIL_COL } from '@/lib/tools/processingSteps';

const noop = async () => {};

describe('isSupportEmail / isRoleLocalPart', () => {
  it('flags generic/role mailboxes (EN + RU translit, case-insensitive)', () => {
    for (const e of [
      'support@x.com', 'info@x.ru', 'sales@x.com', 'help@x.com', 'zakaz@x.ru',
      'billing@x.com', 'hr@x.com', 'noreply@x.com', 'no-reply@x.com', 'HR@X.COM',
      'Support@Mail.ru', 'podderzhka@x.ru', 'reklama@x.ru', 'buh@x.ru',
    ]) {
      expect(isSupportEmail(e)).toBe(true);
    }
  });

  it('flags role word + separator/digit, but NOT role word + letters', () => {
    expect(isSupportEmail('support.team@x.com')).toBe(true);
    expect(isSupportEmail('info-msk@x.ru')).toBe(true);
    expect(isSupportEmail('sales2@x.com')).toBe(true);
    expect(isSupportEmail('zakaz_spb@x.ru')).toBe(true);
    expect(isSupportEmail('saleshouse@x.com')).toBe(false);
    expect(isSupportEmail('infomir@x.ru')).toBe(false);
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
    expect(isRoleLocalPart('ivan')).toBe(false);
  });
});

describe('stepRemoveSupportEmails', () => {
  it('drops rows whose only email is role-based; keeps personal + emailless rows', async () => {
    const data = [
      ['компания', 'email'],
      ['A', 'support@x.ru'],
      ['B', 'ivan@x.ru'],
      ['C', ''],
      ['D', 'info@x.ru'],
    ];
    const out = await stepRemoveSupportEmails(data, noop);
    expect(out.map((r) => r[0])).toEqual(['компания', 'B', 'C']);
  });

  it('strips a role email from a mixed cell but keeps the row + the personal one', async () => {
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
      ['C', 'boss@x.ru', 'sales@x.ru'],   // personal original + found role → keep, found stripped
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
