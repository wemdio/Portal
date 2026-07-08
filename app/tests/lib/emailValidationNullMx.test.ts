/** @jest-environment node */
/**
 * deliverableMxHosts: RFC 7505 null-MX (домен явно НЕ принимает почту) → пустой
 * список хостов → в lookupMX это станет found:false → 'invalid'. Раньше пустой
 * exchange уходил как mxHost="" → прокси "Missing required fields" → ложный
 * 'unknown' (наблюдалось на invent.group, MX exchange="").
 */

import { deliverableMxHosts } from '@/lib/emailValidation/validator';

describe('deliverableMxHosts (RFC 7505 null-MX)', () => {
  it('обычные MX → хосты по приоритету', () => {
    expect(deliverableMxHosts([
      { exchange: 'mx2.example.com', priority: 20 },
      { exchange: 'mx1.example.com', priority: 10 },
    ])).toEqual(['mx1.example.com', 'mx2.example.com']);
  });

  it('null-MX (пустой exchange, как у invent.group) → [] (домен не принимает почту)', () => {
    expect(deliverableMxHosts([{ exchange: '', priority: 0 }])).toEqual([]);
  });

  it('null-MX в форме "." → []', () => {
    expect(deliverableMxHosts([{ exchange: '.', priority: 0 }])).toEqual([]);
  });

  it('смешанные: валидные остаются, пустые/точка отбрасываются', () => {
    expect(deliverableMxHosts([
      { exchange: '.', priority: 0 },
      { exchange: 'mx.example.com', priority: 10 },
      { exchange: '', priority: 5 },
    ])).toEqual(['mx.example.com']);
  });

  it('пробелы вокруг exchange не ломают фильтр', () => {
    expect(deliverableMxHosts([{ exchange: '  ', priority: 0 }])).toEqual([]);
    expect(deliverableMxHosts([{ exchange: ' mx.example.com ', priority: 0 }])).toEqual(['mx.example.com']);
  });
});
