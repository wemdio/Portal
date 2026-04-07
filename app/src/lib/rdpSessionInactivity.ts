import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

function getInactivityTimeoutMs(): number {
  const raw = process.env.RDP_SESSION_INACTIVITY_TIMEOUT_MS;
  if (!raw) return DEFAULT_INACTIVITY_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INACTIVITY_TIMEOUT_MS;
  }

  return parsed;
}

export async function closeStaleRdpSessions(admin: SupabaseClient): Promise<void> {
  const now = new Date();
  const timeoutMs = getInactivityTimeoutMs();
  const cutoffIso = new Date(now.getTime() - timeoutMs).toISOString();
  const nowIso = now.toISOString();

  await admin
    .from('rdp_sessions')
    .update({ status: 'ended', ended_at: nowIso })
    .eq('status', 'active')
    .lt('last_activity_at', cutoffIso);
}
