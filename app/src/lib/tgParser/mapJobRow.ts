import type { ParsedUser } from '@/lib/tgParser/types';
import { formatParseStopMessage } from '@/lib/tgParser/parseMessages';

export type TgParserJobApiRow = {
  id: string;
  created_at: string;
  status: string;
  config: {
    links?: string[];
    account_label?: string;
    links_summary?: string;
  };
  account_id: string | null;
  result_users: ParsedUser[] | null;
  stop_reason: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type ParseJobStatus = 'running' | 'done' | 'error';

export type ParseJobUi = {
  id: string;
  accountId: string;
  accountLabel: string;
  linkCount: number;
  linksSummary: string;
  status: ParseJobStatus;
  users: ParsedUser[];
  error?: string;
  warning?: string;
  startedAt: number;
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

  return {
    id: row.id,
    accountId: row.account_id ?? '',
    accountLabel: cfg.account_label ?? '—',
    linkCount: links.length,
    linksSummary: cfg.links_summary ?? '',
    status: uiStatus,
    users: Array.isArray(row.result_users) ? row.result_users : [],
    error: row.error_message ?? undefined,
    warning,
    startedAt: new Date(row.started_at ?? row.created_at).getTime(),
  };
}
