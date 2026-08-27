/**
 * Fail-closed lifecycle helpers for an external template launch.
 *
 * A process can disappear after Instantly accepted a request but before Portal
 * persisted launch_info.  A fresh `running` reservation therefore blocks
 * retries; an expired one becomes `uncertain` and stays blocked until a
 * specialist explicitly reconciles the external state.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeSegmentationAudit } from './types';

export const VE_LAUNCH_RESERVATION_TIMEOUT_MS = 15 * 60_000;
export const VE_LAUNCH_RESERVATION_EXPIRED_ERROR =
  'Истёк срок ожидания результата запуска. Проверьте кампании в Instantly перед повтором.';

export function isVeLaunchReservationExpired(
  audit: Pick<
    VeSegmentationAudit,
    'launch_status' | 'launch_started_at' | 'launch_heartbeat_at'
  >,
  now = new Date(),
): boolean {
  if (audit.launch_status !== 'running') return false;
  const lastSeenAt = Date.parse(audit.launch_heartbeat_at ?? audit.launch_started_at ?? '');
  return !Number.isFinite(lastSeenAt) || now.getTime() - lastSeenAt >= VE_LAUNCH_RESERVATION_TIMEOUT_MS;
}

export interface ReconciledLaunchReservation {
  audit: VeSegmentationAudit;
  changed: boolean;
  error: string | null;
}

/** Compare-and-set an abandoned launch to uncertain without releasing its lock. */
export async function reconcileExpiredLaunchReservation(
  db: SupabaseClient,
  audit: VeSegmentationAudit,
  now = new Date(),
): Promise<ReconciledLaunchReservation> {
  if (!isVeLaunchReservationExpired(audit, now)) {
    return { audit, changed: false, error: null };
  }

  const changedAt = now.toISOString();
  let update = db
    .from('ve_segmentation_audits')
    .update({
      launch_status: 'uncertain',
      launch_error: VE_LAUNCH_RESERVATION_EXPIRED_ERROR,
      launch_completed_at: changedAt,
      updated_at: changedAt,
    })
    .eq('id', audit.id)
    .eq('launch_status', 'running');
  update = audit.launch_reservation_id
    ? update.eq('launch_reservation_id', audit.launch_reservation_id)
    : update.is('launch_reservation_id', null);
  // Fence against a live worker refreshing the lease after this audit was read.
  // Reservation ID alone is insufficient because heartbeat updates keep it stable.
  if (audit.launch_heartbeat_at) {
    update = update.eq('launch_heartbeat_at', audit.launch_heartbeat_at);
  } else {
    update = update.is('launch_heartbeat_at', null);
    update = audit.launch_started_at
      ? update.eq('launch_started_at', audit.launch_started_at)
      : update.is('launch_started_at', null);
  }

  const { data: changed, error: updateError } = await update.select('*').maybeSingle();
  if (updateError) {
    return { audit, changed: false, error: updateError.message };
  }
  if (changed) {
    return { audit: changed as VeSegmentationAudit, changed: true, error: null };
  }

  // Another request resolved or replaced the reservation after our read.
  const { data: latest, error: latestError } = await db
    .from('ve_segmentation_audits')
    .select('*')
    .eq('id', audit.id)
    .maybeSingle();
  return {
    audit: (latest as VeSegmentationAudit | null) ?? audit,
    changed: false,
    error: latestError?.message ?? null,
  };
}
