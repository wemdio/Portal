import { authFetch, authFetchJson } from '@/lib/authFetch';

const BASE = '/api/tools/sender';

export interface MailboxDto {
  id: string;
  provider: string;
  email: string;
  display_name: string | null;
  username: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string | null;
  imap_port: number;
  status: 'pending' | 'verified' | 'failed' | 'disabled';
  daily_campaign_limit: number;
  last_verified_at: string | null;
  last_error: string | null;
  last_send_at: string | null;
}

export interface CampaignDto {
  id: string;
  name: string;
  /** Пул ящиков кампании — боковая колонка вкладки «Письма». */
  mailboxes: { id: string; email: string }[];
  status: 'draft' | 'running' | 'paused' | 'done';
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[];
  created_at: string;
  stats: { recipients: number; replied: number; sent: number; scheduled: number; failed: number } | null;
}

export interface ImportMailboxesResult {
  imported: number;
  /** Провайдер → сколько ящиков портал к нему отнёс. Ключи — значения колонки provider. */
  detected: Record<string, number>;
  errors: { line: number | null; email: string | null; message: string }[];
}

/** Строка представления sender_threads: одна переписка с получателем. */
export interface ThreadDto {
  recipient_id: string;
  campaign_id: string;
  campaign_name: string;
  recipient_email: string;
  recipient_name: string | null;
  status: string;
  replied_at: string | null;
  mailbox_id: string | null;
  mailbox_email: string | null;
  sent_count: number;
  last_sent_at: string | null;
  reply_count: number;
  last_reply_at: string | null;
  has_human_reply: boolean;
  last_activity_at: string;
}

/** Письмо переписки: наше исходящее или ответ получателя. */
export interface ThreadItemDto {
  id: string;
  direction: 'out' | 'in';
  subject: string | null;
  body: string | null;
  at: string | null;
  note: string | null;
  fromEmail: string | null;
}

export interface ImportRecipientsResult {
  imported: number;
  skippedInvalid: number;
  skippedDuplicates: number;
  skippedSuppressed: number;
}

export interface StepInput {
  delayDays: number;
  subject: string;
  body: string;
}

async function upload<T>(url: string, file: File, fields?: Record<string, string>): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields ?? {})) form.append(key, value);
  // Content-Type не ставим: браузер сам подставит boundary для multipart.
  const res = await authFetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Ошибка ${res.status}`);
  return data as T;
}

export function fetchMailboxes(params: { page?: number; search?: string; pageSize?: number } = {}) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.search) query.set('search', params.search);
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  return authFetchJson<{ mailboxes: MailboxDto[]; total: number }>(
    `${BASE}/mailboxes?${query.toString()}`,
  );
}

export function importMailboxes(file: File) {
  return upload<ImportMailboxesResult>(`${BASE}/mailboxes`, file);
}

/** Итог загрузки ящиков напрямую из каталога Google Workspace. */
export interface ImportGoogleResult {
  imported: number;
  skipped: number;
  total: number;
}

export function googleWorkspaceStatus() {
  return authFetchJson<{ configured: boolean }>(`${BASE}/mailboxes/google`);
}

export function importFromGoogleWorkspace() {
  return authFetchJson<ImportGoogleResult>(`${BASE}/mailboxes/google`, { method: 'POST' });
}

export function patchMailbox(id: string, body: Record<string, unknown>) {
  return authFetchJson<{ ok: true }>(`${BASE}/mailboxes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteMailbox(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/mailboxes/${id}`, { method: 'DELETE' });
}

export type BulkMailboxAction = 'recheck' | 'enable' | 'disable' | 'delete';

/** Действие над выборкой одним запросом: двести ящиков — это не двести запросов. */
export function bulkMailboxes(ids: string[], action: BulkMailboxAction) {
  return authFetchJson<{ ok: true; affected: number }>(`${BASE}/mailboxes`, {
    method: 'PATCH',
    body: JSON.stringify({ ids, action }),
  });
}

export function fetchCampaigns() {
  return authFetchJson<{ campaigns: CampaignDto[] }>(`${BASE}/campaigns`);
}

export function createCampaign(body: {
  name: string;
  mailboxIds: string[];
  steps: StepInput[];
  sendHourFrom: number;
  sendHourTo: number;
  /** Дни недели, когда кампании разрешено отправлять: 1 = понедельник … 7 = воскресенье. */
  sendWeekdays: number[];
}) {
  return authFetchJson<{ id: string }>(`${BASE}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fetchThreads(params: {
  page?: number;
  campaignId?: string;
  mailboxId?: string;
  search?: string;
  onlyReplied?: boolean;
} = {}) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.campaignId) query.set('campaignId', params.campaignId);
  if (params.mailboxId) query.set('mailboxId', params.mailboxId);
  if (params.search) query.set('search', params.search);
  if (params.onlyReplied) query.set('onlyReplied', '1');
  return authFetchJson<{ threads: ThreadDto[]; total: number; pageSize: number }>(
    `${BASE}/threads?${query.toString()}`,
  );
}

export function fetchThread(recipientId: string) {
  return authFetchJson<{
    thread: {
      recipient_id: string;
      campaign_name: string;
      recipient_email: string;
      recipient_name: string | null;
      status: string;
      mailbox_email: string | null;
      reply_count: number;
    };
    items: ThreadItemDto[];
  }>(`${BASE}/threads/${recipientId}`);
}

/** Входящее письмо, которое не удалось связать с получателем кампании. */
export interface UnlinkedReplyDto {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  body: string | null;
  kind: string;
  at: string | null;
  mailboxEmail: string | null;
}

export function fetchUnlinkedReplies(page = 1) {
  return authFetchJson<{ replies: UnlinkedReplyDto[]; total: number; pageSize: number }>(
    `${BASE}/replies?page=${page}`,
  );
}

export function patchCampaign(id: string, action: 'start' | 'pause' | 'finish') {
  return authFetchJson<{ ok: true; status: string }>(`${BASE}/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

export function uploadRecipients(campaignId: string, file: File) {
  return upload<ImportRecipientsResult>(`${BASE}/campaigns/${campaignId}/recipients`, file);
}
