import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_AUTOMATIC_AGE_MS = 24 * 60 * 60_000;
const cache = new WeakMap<object, { until: number; notBefore: number }>();

/** Persisted once by migration, never reset by a worker restart/redeploy. */
export async function qualificationAutomationPolicy(db: Pick<SupabaseClient, 'from'>): Promise<number> {
  const cached = cache.get(db);
  if (cached && cached.until > Date.now()) return cached.notBefore;
  const { data, error } = await db.from('instantly_qualification_automation_policy')
    .select('not_before').eq('id', true).single();
  const notBefore = Date.parse(data?.not_before ?? '');
  if (error || !Number.isFinite(notBefore)) {
    // No fail-open catch-up during a code-first rollout or a database outage.
    throw new Error('Reply ownership deferred: automatic processing policy unavailable');
  }
  cache.set(db, { until: Date.now() + 60_000, notBefore });
  return notBefore;
}

export function replyAutomationExpired(
  notBefore: number,
  row: { reply_timestamp?: string | null; timestamp_email?: string | null;
    timestamp_created?: string | null; created_at?: string | null },
  now = Date.now(),
): boolean {
  const times = [row.reply_timestamp, row.timestamp_email, row.timestamp_created, row.created_at]
    .map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  // An absent provider timestamp is not proof of an old reply. Durable rows
  // still have created_at, so technical retries cannot get an unlimited life.
  if (!times.length) return false;
  const started = Math.min(...times);
  return started < notBefore || started <= now - MAX_AUTOMATIC_AGE_MS;
}
