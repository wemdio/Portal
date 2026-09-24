// Общие типы инструмента «Персонализированные ответы на входящие».
// Модуль изолирован от квалификатора входящих: сюда ничего не импортируется
// из lib/instantly/leadQualifier.ts, leadQualificationWorker.ts,
// handoffSender.ts, replyIntake.ts.

/**
 * Бриф здесь не хранится: он всегда читается живьём из карточки проекта
 * (projects.brief_text) — к запуску кампании бриф уже заполнен.
 */
export interface KnowledgeBase {
  projectId: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  /** Запасной бриф из самой модалки: нужен, пока карточка проекта пуста. */
  localBrief: string;
  updatedAt: string;
}

/**
 * Глобальные тон/пример (singleton id=1). Приоритет в промпте: пер-проектное
 * поле, если заполнено, иначе — глобальное.
 */
export interface GlobalKnowledgeBase {
  toneNotes: string;
  exampleCase: string;
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
  /**
   * Вердикт квалификатора ('lead', 'not_lead', …) — только для синхронизированных
   * писем; у писем с живых аккаунтов null. Список его не фильтрует: отказы тоже
   * бывает нужно обработать.
   */
  qualificationStatus?: string | null;
  /**
   * Instantly не привязал письмо к кампании (папка Others, «сироты» сторожа):
   * ответить в тред нельзя, ответ уходит отдельным письмом с того же ящика.
   */
  outOfCampaign?: boolean;
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
  /** Кому адресован ответ, если не тому, кто ответил; null — в ту же переписку. */
  recipientEmail: string | null;
}

/** Строка списка «кто ответил» на экране инструмента. */
export interface ReplyListItem extends QualificationRow {
  /** По последнему черновику: 'sent' — ответили, 'skipped' — пропустили, иначе 'new'. */
  listStatus: 'new' | 'sent' | 'skipped';
  /** 'others' — строка вкладки Others (папка Others в Instantly). */
  source?: 'others';
}

/** Страница вкладки Others. */
export interface OthersPage {
  replies: ReplyListItem[];
  /** Курсор следующей страницы; null — дальше писем нет. */
  nextCursor: string | null;
  /** Что загрузить не удалось — показываем над списком. */
  notices: string[];
  missingReason: string | null;
}

/** Кампания проекта для кнопок-фильтров над списком писем. */
export interface ReplyCampaignOption {
  id: string;
  name: string;
  /** Ответов в кампании с учётом поиска; null — кампания живого аккаунта, не посчитать. */
  replyCount: number | null;
}

export interface GenerateDraftResult {
  draftId: string;
  text: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
  /** Кому адресован черновик, если не тому, кто ответил; null — в ту же переписку. */
  recipientEmail: string | null;
}
