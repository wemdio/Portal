/** @jest-environment node */

import { selectRefillLeadRows } from '@/lib/verticalEngineV2/stages/baseCollectRefill';
import type { VeUnifiedRow } from '@/lib/verticalEngineV2/stages/baseCollect';

function row(email: string, quality?: Record<string, unknown>): VeUnifiedRow {
  return {
    company: email.split('@')[0],
    website: '',
    email,
    phone: '',
    vacancy_title: '',
    address: '',
    category: '',
    employees: '',
    revenue: '',
    inn: '',
    source_detail: 'test',
    ...quality,
  } as VeUnifiedRow;
}

describe('selectRefillLeadRows relevance coverage', () => {
  it('fails closed for a valid-email row whose company has no relevance verdict', () => {
    const checked = row('checked@example.test');
    const unchecked = row('unchecked@example.test', { _relevance_unchecked: true });

    const result = selectRefillLeadRows([checked, unchecked], ['ok', 'ok']);

    expect(result.leadRows).toEqual([checked]);
    expect(result.withEmail).toBe(1);
    expect(result.valid).toBe(1);
  });
});
