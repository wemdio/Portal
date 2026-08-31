/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('middleware пропускает витрину', () => {
  const source = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8');

  it('в isPublicApiPath есть /api/bench/', () => {
    // Витрина авторизуется своим ключом, поэтому не должна упираться в
    // штатный staff-only гейт. Тест держит эту строку на месте: без неё
    // всякий внешний запрос получал бы 403 ещё до нашего кода.
    const fn = source.slice(source.indexOf('function isPublicApiPath'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain("'/api/bench/'");
  });

  it('витрина не попала в клиентский allowlist по ошибке', () => {
    const fn = source.slice(source.indexOf('function isClientApiPath'));
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toContain('/api/bench');
  });
});
