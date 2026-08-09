import type {
  ClientReportPeriodPreset,
  ClientReportScoreFilter,
} from './filters';

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
  metrics: {
    contactsAddedConfirmed: number;
    contactsSubmittedLegacy: number;
    uniqueRecipients: number;
    emailsSent: number;
    liveReplies: number;
    processedReplies: number;
    targetLeads: number;
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
    analyticsAt: string | null;
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
