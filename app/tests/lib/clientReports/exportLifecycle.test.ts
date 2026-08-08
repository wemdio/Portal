/** @jest-environment node */

import {
  CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS,
  CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS,
  isActiveClientReportExportStatus,
  isTerminalClientReportExportStatus,
} from '@/lib/clientReports/exportLifecycle';
import { CLIENT_REPORT_EXPORT_STATUSES } from '@/lib/clientReports/types';

describe('client report export lifecycle contract', () => {
  it('keeps the UI polling window long enough for million-row exports', () => {
    expect(CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS).toBe(5_000);
    expect(CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS).toBe(30 * 60_000);
    expect(CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS / CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS)
      .toBe(360);
  });

  it('treats cancelled as terminal, never active or retryable in place', () => {
    expect(CLIENT_REPORT_EXPORT_STATUSES).toContain('cancelled');
    expect(isActiveClientReportExportStatus('pending')).toBe(true);
    expect(isActiveClientReportExportStatus('running')).toBe(true);
    expect(isActiveClientReportExportStatus('cancelled')).toBe(false);
    expect(isTerminalClientReportExportStatus('cancelled')).toBe(true);
    expect(isTerminalClientReportExportStatus('failed')).toBe(true);
    expect(isTerminalClientReportExportStatus('completed')).toBe(true);
  });
});
