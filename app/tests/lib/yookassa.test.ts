/** @jest-environment node */

import { getDefaultYookassaInvoiceExpiresAt } from '@/lib/yookassa';

describe('YooKassa invoice expiration', () => {
  it('keeps the default validity at 30 days while flooring seconds and milliseconds', () => {
    const now = new Date('2026-05-20T10:15:42.987Z');

    expect(getDefaultYookassaInvoiceExpiresAt(now)).toBe('2026-06-19T10:15:00.000Z');
  });
});
