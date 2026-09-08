import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from './types';

/**
 * Ready-time FIFO: a cooperative yield puts the same durable job behind work
 * already waiting, instead of its original created_at reclaiming the worker.
 * Failure retries and parser polling keep their existing run_after cooldown.
 */
export async function claimVeJob(db: SupabaseClient, now = new Date()): Promise<VeJob | null> {
  const nowIso = now.toISOString();
  const { data: pending, error: readError } = await db.from('ve_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_after', nowIso)
    .order('run_after', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (readError) throw new Error(`ve_jobs queue read: ${readError.message}`);
  if (!pending) return null;

  // attempts counts failures, not claims: evidence slices and base polling can
  // claim the same job many times without consuming the provider retry budget.
  const { data: claimed, error: claimError } = await db.from('ve_jobs')
    .update({ status: 'running', started_at: nowIso, updated_at: nowIso })
    .eq('id', (pending as VeJob).id)
    .eq('status', 'pending')
    .lte('run_after', nowIso)
    .select('*')
    .maybeSingle();
  if (claimError) throw new Error(`ve_jobs queue claim: ${claimError.message}`);
  return (claimed as VeJob | null) ?? null;
}
