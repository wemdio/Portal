/** @jest-environment node */

/**
 * Unit coverage for the pure helpers behind the Instantly activity feed
 * (webhook receiver + partner API). These are dependency-free, so we test the
 * normalization and MSK windowing directly without mocking Supabase/Instantly.
 */

import {
  mapActivityKind,
  normalizeActivityEvent,
  mskDayWindowUtc,
  toMskIso,
} from '@/lib/instantly/activity';

describe('mapActivityKind', () => {
  it('maps opened / replied event types', () => {
    expect(mapActivityKind('email_opened')).toBe('opened');
    expect(mapActivityKind('opened')).toBe('opened');
    expect(mapActivityKind('reply_received')).toBe('replied');
    expect(mapActivityKind('email_replied')).toBe('replied');
  });

  it('ignores events we do not persist', () => {
    expect(mapActivityKind('email_sent')).toBeNull();
    expect(mapActivityKind('email_link_clicked')).toBeNull();
    expect(mapActivityKind('email_bounced')).toBeNull();
    expect(mapActivityKind('lead_unsubscribed')).toBeNull();
    expect(mapActivityKind('')).toBeNull();
    expect(mapActivityKind(undefined)).toBeNull();
  });
});

describe('normalizeActivityEvent', () => {
  const RECEIVED = '2026-06-02T10:00:00.000Z';

  it('normalizes an open event and keys dedup on the event id', () => {
    const ev = normalizeActivityEvent(
      {
        id: 'evt-123',
        event_type: 'email_opened',
        lead_email: 'Lead@Example.com',
        campaign_id: 'camp-9',
        timestamp: '2026-06-02T08:30:00.000Z',
      },
      'account-2',
      RECEIVED,
    );
    expect(ev).toEqual({
      eventType: 'opened',
      leadEmail: 'lead@example.com',
      campaignId: 'camp-9',
      occurredAt: '2026-06-02T08:30:00.000Z',
      eventId: 'evt-123',
      dedupKey: 'id:account-2:evt-123',
    });
  });

  it('extracts a nested lead object email for replies', () => {
    const ev = normalizeActivityEvent(
      { event: 'reply_received', lead: { email: 'Reply@Foo.io' } },
      'main',
      RECEIVED,
    );
    expect(ev?.eventType).toBe('replied');
    expect(ev?.leadEmail).toBe('reply@foo.io');
  });

  it('falls back to received time and a composite dedup key when fields are missing', () => {
    const ev = normalizeActivityEvent(
      { event_type: 'email_opened', lead_email: 'a@b.com' },
      'main',
      RECEIVED,
    );
    expect(ev?.occurredAt).toBe(RECEIVED);
    expect(ev?.campaignId).toBeNull();
    expect(ev?.eventId).toBeNull();
    expect(ev?.dedupKey).toBe('main:opened:a@b.com:2026-06-02T10:00:00.000Z');
  });

  it('returns null for irrelevant events or missing lead email', () => {
    expect(normalizeActivityEvent({ event_type: 'email_sent', lead_email: 'a@b.com' }, 'main', RECEIVED)).toBeNull();
    expect(normalizeActivityEvent({ event_type: 'email_opened' }, 'main', RECEIVED)).toBeNull();
    expect(normalizeActivityEvent({ event_type: 'email_opened', lead_email: 'not-an-email' }, 'main', RECEIVED)).toBeNull();
  });
});

describe('mskDayWindowUtc', () => {
  it('computes the UTC half-open window for an MSK day', () => {
    expect(mskDayWindowUtc('2026-06-02')).toEqual({
      startUtc: '2026-06-01T21:00:00.000Z',
      endUtc: '2026-06-02T21:00:00.000Z',
    });
  });

  it('rejects malformed dates', () => {
    expect(mskDayWindowUtc('2026-6-2')).toBeNull();
    expect(mskDayWindowUtc('nope')).toBeNull();
    expect(mskDayWindowUtc('')).toBeNull();
  });
});

describe('toMskIso', () => {
  it('renders UTC as MSK wall-clock with +03:00', () => {
    expect(toMskIso('2026-06-01T21:00:00.000Z')).toBe('2026-06-02T00:00:00.000+03:00');
  });
});
