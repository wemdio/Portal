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
  errors: { line: number; email: string | null; message: string }[];
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

export function fetchMailboxes(page = 1) {
  return authFetchJson<{ mailboxes: MailboxDto[]; total: number }>(
    `${BASE}/mailboxes?page=${page}`,
  );
}

export function importMailboxes(file: File, provider: string) {
  return upload<ImportMailboxesResult>(`${BASE}/mailboxes`, file, { provider });
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

export function fetchCampaigns() {
  return authFetchJson<{ campaigns: CampaignDto[] }>(`${BASE}/campaigns`);
}

export function createCampaign(body: {
  name: string;
  mailboxIds: string[];
  steps: StepInput[];
  sendHourFrom: number;
  sendHourTo: number;
}) {
  return authFetchJson<{ id: string }>(`${BASE}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
