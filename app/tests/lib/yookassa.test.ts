/** @jest-environment node */

import { getDefaultYookassaInvoiceExpiresAt } from '@/lib/yookassa';

describe('YooKassa invoice expiration', () => {
  it('keeps the default validity near 30 days with a safety buffer for YooKassa validation', () => {
    const now = new Date('2026-05-20T10:15:42.987Z');

    expect(getDefaultYookassaInvoiceExpiresAt(now)).toBe('2026-06-19T10:00:00.000Z');
  });
});
