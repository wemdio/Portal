/**
 * Shared types for the polza-reports tool.
 *
 * The Python microservice (`services/polza-reports`) is the source of truth
 * for the data shapes — these TS types mirror its dataclasses in `models.py`
 * and SSE event payloads in `main.py`. Keep them in sync.
 */

export type ReportSource = 'coldy' | 'trigga';

export type ReportJobStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Coldy login as stored encrypted in `polza_coldy_credentials`. */
export interface ColdyCredentials {
  email: string;
  password: string;
  url: string;
}

/** Server-Sent Event from the microservice. `type` discriminates the union. */
export type PolzaColdyEvent =
  | { type: 'start' }
  | { type: 'progress'; phase: 'login' }
  | { type: 'progress'; phase: 'campaigns_list'; total?: number }
  | {
      type: 'progress';
      phase: 'analytics';
      current: number;
      total: number;
      campaign_name?: string;
    }
  | { type: 'progress'; phase: 'formatting' }
  | { type: 'result'; xlsx_b64: string; campaigns_count: number }
  | { type: 'error'; message: string };

/** Snapshot of a job row, as returned from /api/tools/polza-reports/jobs. */
export interface PolzaReportJob {
  id: string;
  source: ReportSource;
  status: ReportJobStatus;
  detailed: boolean;
  include_created: boolean;
  include_base_left: boolean;
  progress: Record<string, unknown>;
  result_xlsx_path: string | null;
  result_filename: string | null;
  campaigns_count: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Public view of saved Coldy credentials (never includes plaintext password). */
export interface ColdyCredentialsView {
  email_hint: string | null;
  url: string;
  updated_at: string;
}
