/**
 * Pure helpers for the Instantly activity feed (partner API).
 *
 * No `server-only` import on purpose — these are unit-tested directly and shared
 * by both the webhook receiver (`/api/instantly/webhook/[account]`) and the
 * partner read API (`/api/partner/activity`). Keep this module dependency-free.
 */

/** Normalized activity kind exposed to the partner. */
export type ActivityKind = 'opened' | 'replied';

export interface NormalizedActivityEvent {
  eventType: ActivityKind;
  leadEmail: string;
  campaignId: string | null;
  /** ISO 8601 in UTC. */
  occurredAt: string;
  eventId: string | null;
  /** Idempotency key for upsert (Instantly retries webhooks on non-2xx). */
  dedupKey: string;
}

/** МСК — фиксированный UTC+3 (в РФ нет переходов на летнее время с 2014). */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Maps an Instantly webhook event_type to our normalized kind, or null for
 * events we intentionally ignore (sent / clicked / bounced / unsubscribed …).
 *
 * We only persist the two signals the partner asked for: replied + opened.
 */
export function mapActivityKind(rawType: unknown): ActivityKind | null {
  const t = String(rawType ?? '').toLowerCase();
  if (!t) return null;
  // Order matters: check "repl" before "open" so a hypothetical
  // "reply_with_open" can't be misclassified. clicked/bounced/etc → null.
  if (t.includes('repl')) return 'replied'; // reply_received, email_replied, replied
  if (t.includes('open')) return 'opened'; // email_opened, opened
  return null;
}

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function extractLeadEmail(payload: Record<string, unknown>): string | null {
  const direct = pickString(
    payload.lead_email,
    payload.lead,
    payload.email,
    payload.to_email,
    payload.recipient,
  );
  if (direct && direct.includes('@')) return direct.toLowerCase();

  const lead = payload.lead;
  if (lead && typeof lead === 'object') {
    const nested = pickString(
      (lead as Record<string, unknown>).email,
      (lead as Record<string, unknown>).email_address,
    );
    if (nested && nested.includes('@')) return nested.toLowerCase();
  }
  return null;
}

function extractOccurredAt(payload: Record<string, unknown>, fallbackIso: string): string {
  const raw = pickString(
    payload.timestamp,
    payload.timestamp_created,
    payload.timestamp_email,
    payload.event_timestamp,
    payload.occurred_at,
    payload.created_at,
  );
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Numeric epoch fallback (seconds or milliseconds).
  const num = payload.timestamp ?? payload.ts ?? payload.time;
  if (typeof num === 'number' && Number.isFinite(num)) {
    const ms = num > 1e12 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallbackIso;
}

function extractCampaignId(payload: Record<string, unknown>): string | null {
  const direct = pickString(payload.campaign_id, payload.campaign);
  if (direct) return direct;
  const campaign = payload.campaign;
  if (campaign && typeof campaign === 'object') {
    return pickString((campaign as Record<string, unknown>).id);
  }
  return null;
}

/**
 * Normalizes a single raw Instantly webhook payload into our event shape.
 * Returns null when the event is irrelevant (not open/reply) or unusable
 * (no lead email) — the receiver acks those with 200 and stores nothing.
 *
 * Field extraction is deliberately defensive: Instantly's pushed payload shape
 * isn't strictly documented, so we probe several plausible field names.
 */
export function normalizeActivityEvent(
  payload: Record<string, unknown>,
  accountId: string,
  receivedAtIso: string,
): NormalizedActivityEvent | null {
  const kind = mapActivityKind(payload.event_type ?? payload.event ?? payload.type);
  if (!kind) return null;

  const leadEmail = extractLeadEmail(payload);
  if (!leadEmail) return null;

  const occurredAt = extractOccurredAt(payload, receivedAtIso);
  const campaignId = extractCampaignId(payload);
  const eventId = pickString(payload.id, payload.event_id, payload.webhook_event_id);

  const dedupKey = eventId
    ? `id:${accountId}:${eventId}`
    : `${accountId}:${kind}:${leadEmail}:${occurredAt}`;

  return { eventType: kind, leadEmail, campaignId, occurredAt, eventId, dedupKey };
}

/**
 * Computes the UTC half-open window [start, end) for a given MSK calendar day.
 * Returns null if the date string isn't a valid YYYY-MM-DD.
 */
export function mskDayWindowUtc(dateStr: string): { startUtc: string; endUtc: string } | null {
  if (!DATE_RE.test(dateStr)) return null;
  const start = new Date(`${dateStr}T00:00:00.000+03:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + DAY_MS);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

/** Renders a UTC ISO timestamp as MSK wall-clock with a +03:00 suffix. */
export function toMskIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(d.getTime() + MSK_OFFSET_MS).toISOString().replace('Z', '+03:00');
}
