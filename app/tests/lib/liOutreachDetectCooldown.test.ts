import { detectAccountCooldownError } from '@/lib/liOutreach/accountCooldown';
import { UnipileError } from '@/lib/liOutreach/unipileClient';

/**
 * Unit tests for `detectAccountCooldownError`.
 *
 * The campaign runner relies on this helper to decide whether a thrown error
 * means the LinkedIn account itself should be parked in cooldown (so we stop
 * hammering Unipile / LinkedIn and let limits reset). We must classify only
 * the well-known LinkedIn-side signals — never let a transient 5xx or a
 * profile-not-found accidentally pause the whole account.
 */

describe('detectAccountCooldownError', () => {
  // ---- kind: 'invitation_limit' ------------------------------------------

  it('detects HTTP 429 from Unipile as invitation_limit', () => {
    expect(
      detectAccountCooldownError(new UnipileError('Unipile 429: Too many requests', 429, 'Too many requests')),
    ).toEqual({ kind: 'invitation_limit' });
  });

  it('detects "invitation_limit_reached" body as invitation_limit', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, '{"type":"invitation_limit_reached"}')),
    ).toEqual({ kind: 'invitation_limit' });
  });

  it('detects "weekly invitation limit" body as invitation_limit', () => {
    expect(
      detectAccountCooldownError(
        new UnipileError('msg', 400, 'You have reached the weekly invitation limit.'),
      ),
    ).toEqual({ kind: 'invitation_limit' });
  });

  it('detects "reached your invitation limit" body as invitation_limit', () => {
    expect(
      detectAccountCooldownError(
        new UnipileError('msg', 400, 'You have reached your invitation limit for this week'),
      ),
    ).toEqual({ kind: 'invitation_limit' });
  });

  it('detects "too many invitations" body as invitation_limit', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, 'Too many invitations sent recently')),
    ).toEqual({ kind: 'invitation_limit' });
  });

  // ---- kind: 'already_invited' -------------------------------------------

  it('detects "already_invited" body', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, '{"type":"already_invited"}')),
    ).toEqual({ kind: 'already_invited' });
  });

  it('detects "cannot_resend_yet" body', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, 'cannot_resend_yet: wait 3 weeks')),
    ).toEqual({ kind: 'already_invited' });
  });

  it('detects "invitation already exists" body', () => {
    expect(
      detectAccountCooldownError(
        new UnipileError('msg', 400, 'An invitation already exists for this user'),
      ),
    ).toEqual({ kind: 'already_invited' });
  });

  it('detects "already sent" body', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, 'You already sent an invitation')),
    ).toEqual({ kind: 'already_invited' });
  });

  // ---- kind: 'account_restricted' ----------------------------------------

  it('detects HTTP 403 with "restricted" as account_restricted', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 403, 'Account temporarily restricted')),
    ).toEqual({ kind: 'account_restricted' });
  });

  it('detects "account_restricted" body as account_restricted (any status)', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, '{"type":"account_restricted"}')),
    ).toEqual({ kind: 'account_restricted' });
  });

  it('detects "spam" body as account_restricted', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 403, 'Marked as spam by LinkedIn')),
    ).toEqual({ kind: 'account_restricted' });
  });

  // ---- null: should NOT trigger cooldown ---------------------------------

  it('returns null for non-UnipileError objects (network, plain Error, primitives)', () => {
    expect(detectAccountCooldownError(new Error('ECONNRESET'))).toBeNull();
    expect(detectAccountCooldownError('plain string')).toBeNull();
    expect(detectAccountCooldownError(null)).toBeNull();
    expect(detectAccountCooldownError(undefined)).toBeNull();
    expect(detectAccountCooldownError({ status: 429 })).toBeNull();
  });

  it('returns null for 5xx server errors from Unipile (transient, not LinkedIn limit)', () => {
    expect(detectAccountCooldownError(new UnipileError('msg', 500, 'Internal Server Error'))).toBeNull();
    expect(detectAccountCooldownError(new UnipileError('msg', 502, 'Bad Gateway'))).toBeNull();
    expect(detectAccountCooldownError(new UnipileError('msg', 503, 'Service Unavailable'))).toBeNull();
  });

  it('returns null for 404 (profile not found is per-lead, not per-account)', () => {
    expect(detectAccountCooldownError(new UnipileError('msg', 404, 'User not found'))).toBeNull();
  });

  it('returns null for 400 with unrelated validation errors', () => {
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, 'Invalid provider_id format')),
    ).toBeNull();
    expect(
      detectAccountCooldownError(new UnipileError('msg', 400, 'Missing required field: account_id')),
    ).toBeNull();
  });

  it('returns null for 401 (auth — config issue, not LinkedIn limit)', () => {
    expect(detectAccountCooldownError(new UnipileError('msg', 401, 'Invalid API key'))).toBeNull();
  });
});
