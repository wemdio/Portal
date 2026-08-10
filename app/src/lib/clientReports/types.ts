import type {
  ClientReportPeriodPreset,
  ClientReportScoreFilter,
} from './filters';

export const CLIENT_REPORT_PIPELINE_UNAVAILABLE_MESSAGE =
  'Воронка базы временно недоступна. Повторите попытку позже.';

export type ClientReportExportKind = 'rejected' | 'working' | 'submitted';
export const CLIENT_REPORT_EXPORT_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ClientReportExportStatus = typeof CLIENT_REPORT_EXPORT_STATUSES[number];

export interface ClientReportCampaign {
  id: string;
  name: string;
}

export interface ClientReportAnalyticsResponse {
  campaigns: ClientReportCampaign[];
  filters: {
    preset: ClientReportPeriodPreset;
    from: string;
    to: string;
    score: ClientReportScoreFilter;
    campaignId: string | null;
  };
  funnel: {
    scoredCompanies: number;
    workingScoreCompanies: number;
    emailFoundCompanies: number;
    validatedEmails: number;
    submittedContacts: number;
    confirmedContacts: number;
    byCampaign: Array<{
      campaignId: string;
      campaignName: string;
      scoreCode: 'A' | 'B' | 'C' | 'rejected' | 'error' | null;
      submitted: number;
      confirmed: number;
    }>;
  };
  freshness: {
    pipelineAt: string | null;
  };
  legacyNotice: string | null;
  qualityNotices: string[];
}

export interface ClientReportExportJob {
  id: string;
  kind: ClientReportExportKind;
  status: ClientReportExportStatus;
  rowCount: number | null;
  checksumSha256: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  downloadUrl?: string;
}
