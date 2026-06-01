/**
 * @jest-environment node
 */

import { deduplicateByEmail } from '@/lib/tools/dfybUtils';

describe('deduplicateByEmail', () => {
  it('keeps identical company rows when emails are different', () => {
    const data = [
      ['Company', 'Site', 'Email'],
      ['Acme', 'acme.test', 'sales@acme.test'],
      ['Acme', 'acme.test', 'info@acme.test'],
    ];

    expect(deduplicateByEmail(data)).toEqual(data);
  });

  it('collapses duplicate email rows case-insensitively', () => {
    const data = [
      ['Company', 'Site', 'Email', 'Phone'],
      ['Acme', 'acme.test', 'Sales@acme.test', ''],
      ['Acme', 'acme.test', 'sales@acme.test', '+79990000000'],
    ];

    expect(deduplicateByEmail(data)).toEqual([
      ['Company', 'Site', 'Email', 'Phone'],
      ['Acme', 'acme.test', 'sales@acme.test', '+79990000000'],
    ]);
  });
});
