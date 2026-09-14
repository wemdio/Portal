// Общие типы инструмента «Персонализированные ответы на входящие».
// Модуль изолирован от квалификатора входящих: сюда ничего не импортируется
// из lib/instantly/leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts.

export interface KnowledgeBase {
  projectId: string;
  brief: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  instantlyAccountId: string;
  updatedAt: string;
}

export interface QualificationRow {
  id: string;
  campaignId: string;
  campaignName: string | null;
  leadEmail: string;
  companyName: string | null;
  threadId: string | null;
  replySubject: string | null;
  replyBody: string | null;
  lastOutboundPreview: string | null;
  instantlyEmailId: string | null;
  eaccount: string | null;
  replyTimestamp: string | null;
}

export interface ThreadMessage {
  fromUs: boolean;
  text: string;
  timestamp?: string;
}

export type DraftStatus = 'draft' | 'sent' | 'skipped';

export interface DraftRow {
  id: string;
  projectId: string;
  qualificationId: string;
  status: DraftStatus;
  generatedText: string | null;
  factsUsed: string | null;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
  model: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Строка списка «кто ответил» на экране инструмента. */
export interface ReplyListItem extends QualificationRow {
  /** 'new' — ни одного 'sent' черновика по этому qualification_id. */
  listStatus: 'new' | 'sent';
}

export interface GenerateDraftResult {
  draftId: string;
  text: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
}
