import type { ClientReportExportStatus } from './types';

/** Large COPY exports can legitimately take many minutes on production data. */
export const CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS = 5_000;
export const CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS = 30 * 60_000;

const ACTIVE_STATUSES: ReadonlySet<string> = new Set<ClientReportExportStatus>([
  'pending',
  'running',
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<ClientReportExportStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function isActiveClientReportExportStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isTerminalClientReportExportStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
