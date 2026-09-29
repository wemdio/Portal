import { authFetchJson } from '@/lib/authFetch';
import type {
  LeadHistoryDto,
  LeadHistoryFilter,
  LeadSettingsDto,
  LeadSettingsInput,
  LeadVerdict,
  ThreadVerdictDto,
} from '@/lib/senderLeads/history';

const BASE = '/api/tools/sender-leads';

export function fetchLeadHistory(params: { folder: string; filter: LeadHistoryFilter; page: number }) {
  const query = new URLSearchParams({ folder: params.folder, filter: params.filter, page: String(params.page) });
  return authFetchJson<LeadHistoryDto>(`${BASE}?${query.toString()}`);
}

export function fetchLeadSettings(folder: string) {
  return authFetchJson<LeadSettingsDto>(`${BASE}/settings?folder=${encodeURIComponent(folder)}`);
}

export function saveLeadSettings(folder: string, body: LeadSettingsInput) {
  return authFetchJson<LeadSettingsDto>(`${BASE}/settings?folder=${encodeURIComponent(folder)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function setLeadVerdict(recipientId: string, verdict: LeadVerdict) {
  return authFetchJson<{ ok: true; verdict: LeadVerdict; verdictSource: 'manual'; verdictAt: string }>(`${BASE}/verdict`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientId, verdict }),
  });
}

export function fetchThreadVerdict(recipientId: string) {
  return authFetchJson<ThreadVerdictDto>(`${BASE}/verdict?recipientId=${encodeURIComponent(recipientId)}`);
}
