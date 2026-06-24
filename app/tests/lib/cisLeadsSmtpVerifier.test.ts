/**
 * @jest-environment node
 *
 * Contract: the cisLeads SMTP verifier delegates to the shared validateEmail
 * engine (which routes through the smtp-proxy / throws — never a direct port-25
 * connection from the app host) and maps its verdicts to VerifyResult.
 */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/emailValidation/validator', () => ({ validateEmail: jest.fn() }));

import { validateEmail } from '@/lib/emailValidation/validator';
import { verifyEmail } from '@/lib/cisLeads/smtpEmailVerifier';

const mockValidate = (result: string) =>
  (validateEmail as jest.Mock).mockResolvedValue({ result });

beforeEach(() => (validateEmail as jest.Mock).mockReset());

describe('cisLeads verifyEmail → delegates to shared engine', () => {
  it('maps ok → valid', async () => {
    mockValidate('ok');
    expect(await verifyEmail('a@b.ru')).toBe('valid');
  });

  it('maps catch_all → catch_all', async () => {
    mockValidate('catch_all');
    expect(await verifyEmail('a@b.ru')).toBe('catch_all');
  });

  it('maps invalid → invalid and disposable → invalid', async () => {
    mockValidate('invalid');
    expect(await verifyEmail('a@b.ru')).toBe('invalid');
    mockValidate('disposable');
    expect(await verifyEmail('a@b.ru')).toBe('invalid');
  });

  it('maps unknown → unknown', async () => {
    mockValidate('unknown');
    expect(await verifyEmail('a@b.ru')).toBe('unknown');
  });

  it('engine throw (e.g. no proxy configured) → unknown, never a direct fallback', async () => {
    (validateEmail as jest.Mock).mockRejectedValue(
      new Error('SMTP_PROXY_URLS is not configured'),
    );
    expect(await verifyEmail('a@b.ru')).toBe('unknown');
  });

  it('malformed address short-circuits to invalid without calling the engine', async () => {
    expect(await verifyEmail('not-an-email')).toBe('invalid');
    expect(validateEmail).not.toHaveBeenCalled();
  });
});
