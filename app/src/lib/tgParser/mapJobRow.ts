import type { ParsedUser } from '@/lib/tgParser/types';
import { formatParseStopMessage } from '@/lib/tgParser/parseMessages';

export type TgParserJobApiRow = {
  id: string;
  user_id: string;
  created_at: string;
  status: string;
  config: {
    links?: string[];
    account_label?: string;
    links_summary?: string;
  };
  account_id: string | null;
  result_users?: ParsedUser[] | null;
  user_count?: number;
  stop_reason: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Прогресс идущей задачи: заполняется по ходу обхода, не только в конце. */
  found_count?: number | null;
  progress_note?: string | null;
  progress_at?: string | null;
};

export type ParseJobStatus = 'running' | 'done' | 'error';

export type ParseJobUi = {
  id: string;
  userId: string;
  accountId: string;
  accountLabel: string;
  linkCount: number;
  linksSummary: string;
  status: ParseJobStatus;
  users: ParsedUser[];
  userCount: number;
  error?: string;
  warning?: string;
  startedAt: number;
  isTarget?: boolean;
  /** Сколько собрано на текущий момент у идущей задачи. */
  foundCount?: number;
  /** Чем задача занята прямо сейчас: источник и этап обхода. */
  progressNote?: string;
  progressAt?: number;
};

/** Совместимо с прежним именем в UI страницы tg-parser */
export type ParseJob = ParseJobUi;

export function tgParserApiRowToUi(row: TgParserJobApiRow): ParseJobUi {
  const cfg = row.config ?? {};
  const links = Array.isArray(cfg.links) ? cfg.links : [];
  const dbStatus = row.status;
  const uiStatus: ParseJobStatus =
    dbStatus === 'error' ? 'error' : dbStatus === 'done' ? 'done' : 'running';

  let warning: string | undefined;
  if (dbStatus === 'done' && row.stop_reason) {
    warning = formatParseStopMessage(row.stop_reason, row.error_message ?? undefined);
  }

  const users = Array.isArray(row.result_users) ? row.result_users : [];
  const userCount = row.user_count ?? users.length;

  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id ?? '',
    accountLabel: cfg.account_label ?? '—',
    linkCount: links.length,
    linksSummary: cfg.links_summary ?? '',
    status: uiStatus,
    users,
    userCount,
    error: row.error_message ?? undefined,
    warning,
    startedAt: new Date(row.started_at ?? row.created_at).getTime(),
    isTarget: (cfg as Record<string, unknown>).is_target as boolean | undefined,
    foundCount: row.found_count ?? undefined,
    progressNote: row.progress_note ?? undefined,
    progressAt: row.progress_at ? new Date(row.progress_at).getTime() : undefined,
  };
}
