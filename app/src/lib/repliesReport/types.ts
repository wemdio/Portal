import type { ClientReply } from '@/lib/clientCampaignReplies/types';

/** Ответ лида для отчёта = публично-безопасный ClientReply + ящик, на который пришёл (eaccount). */
export interface ReportReply extends ClientReply {
  eaccount: string | null;
}

/** Сводные метрики кампании (из Instantly analytics, как в автоотчёте). */
export interface CampaignMetrics {
  contacts: number;
  emailsSent: number;
  opened: number;
  replies: number;
  leads: number;
  bounced: number;
}

export interface CampaignReplies {
  id: string;
  name: string;
  metrics: CampaignMetrics;
  replies: ReportReply[];
  /** true, если упёрлись в лимит и часть ответов не вошла */
  truncated: boolean;
  /** true, если данные по кампании не удалось загрузить */
  failed?: boolean;
}

export interface RepliesReportResult {
  campaigns: CampaignReplies[];
  generatedAt: string; // ISO
  since: string | null; // ISO | null
  until: string | null; // ISO | null
}
