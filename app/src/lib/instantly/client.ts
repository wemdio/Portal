import type {
  PaginationParams,
  PaginatedResponse,
  Campaign,
  CampaignCreatePayload,
  CampaignUpdatePayload,
  CampaignAnalytics,
  CampaignAnalyticsOverview,
  CampaignStepAnalytics,
  Account,
  Lead,
  LeadCreatePayload,
  LeadList,
  LeadListVerificationStats,
  CustomTag,
  BlockListEntry,
  Subsequence,
  Email,
  Webhook,
  WebhookEventType,
  EmailTemplate,
  LeadLabel,
  WarmupAnalyticsEntry,
  BackgroundJob,
} from './types';

const BASE_URL = 'https://api.instantly.ai/api/v2';

export class InstantlyApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'InstantlyApiError';
  }
}

function getApiKey(): string {
  const key = (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();
  if (!key) throw new InstantlyApiError('INSTANTLY_API_KEY is not configured', 503);
  return key;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const apiKey = getApiKey();
  const url = new URL(`${BASE_URL}${path}`);

  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: HeadersInit = { Authorization: `Bearer ${apiKey}` };
  const init: RequestInit = { method: options.method ?? 'GET', headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new InstantlyApiError(`Instantly API ${res.status}: ${text}`, res.status, text);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Fetches all pages from a paginated Instantly endpoint.
 */
async function fetchAllPages<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  maxItems?: number,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await request<PaginatedResponse<T>>(path, {
      params: { limit: 100, ...params, starting_after: startingAfter },
    });
    if (page.items?.length) all.push(...page.items);
    startingAfter = page.next_starting_after || undefined;
  } while (startingAfter && (!maxItems || all.length < maxItems));

  return maxItems ? all.slice(0, maxItems) : all;
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function listCampaigns(params?: PaginationParams & { status?: number; tag_ids?: string }) {
  return request<PaginatedResponse<Campaign>>('/campaigns', { params: params as Record<string, string | number> });
}

export async function listAllCampaigns(maxItems?: number): Promise<Campaign[]> {
  return fetchAllPages<Campaign>('/campaigns', undefined, maxItems);
}

export async function getCampaign(id: string) {
  return request<Campaign>(`/campaigns/${id}`);
}

export async function createCampaign(payload: CampaignCreatePayload) {
  return request<Campaign>('/campaigns', { method: 'POST', body: payload });
}

export async function updateCampaign(id: string, payload: CampaignUpdatePayload) {
  return request<Campaign>(`/campaigns/${id}`, { method: 'PATCH', body: payload });
}

export async function activateCampaign(id: string) {
  return request<Campaign>(`/campaigns/${id}/activate`, { method: 'POST' });
}

export async function pauseCampaign(id: string) {
  return request<Campaign>(`/campaigns/${id}/pause`, { method: 'POST' });
}

export async function duplicateCampaign(id: string) {
  return request<Campaign>(`/campaigns/${id}/duplicate`, { method: 'POST' });
}

export async function shareCampaign(id: string) {
  return request<{ share_link: string }>(`/campaigns/${id}/share`, { method: 'POST' });
}

// ─── Campaign Analytics ──────────────────────────────────────────────────────

export async function getCampaignAnalytics(params?: { id?: string; campaign_id?: string }) {
  const effectiveId = params?.id ?? params?.campaign_id;
  const query: Record<string, string> = {};
  if (effectiveId) query.id = effectiveId;
  return request<CampaignAnalytics[]>('/campaigns/analytics', { params: query });
}

export async function getCampaignAnalyticsOverview(params?: { campaign_id?: string }) {
  const query: Record<string, string> = {};
  if (params?.campaign_id) query.id = params.campaign_id;
  return request<CampaignAnalyticsOverview>('/campaigns/analytics/overview', { params: query });
}

export async function getCampaignAnalyticsDaily(params?: { campaign_id?: string; start_date?: string; end_date?: string }) {
  const query: Record<string, string> = {};
  if (params?.campaign_id) query.id = params.campaign_id;
  if (params?.start_date) query.start_date = params.start_date;
  if (params?.end_date) query.end_date = params.end_date;
  return request<unknown>('/campaigns/analytics/daily', { params: query });
}

export async function getCampaignAnalyticsSteps(params: { campaign_id: string }) {
  return request<CampaignStepAnalytics[]>('/campaigns/analytics/steps', {
    params: { campaign_id: params.campaign_id } as Record<string, string>,
  });
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export async function listAccounts(params?: PaginationParams & { search?: string; status?: number; tag_ids?: string }) {
  return request<PaginatedResponse<Account>>('/accounts', { params: params as Record<string, string | number> });
}

export async function listAllAccounts(): Promise<Account[]> {
  return fetchAllPages<Account>('/accounts');
}

export async function getAccount(email: string) {
  return request<Account>(`/accounts/${encodeURIComponent(email)}`);
}

export async function enableWarmup(emails: string[]) {
  return request<unknown>('/accounts/warmup/enable', { method: 'POST', body: { emails } });
}

export async function disableWarmup(emails: string[]) {
  return request<unknown>('/accounts/warmup/disable', { method: 'POST', body: { emails } });
}

export async function getWarmupAnalytics(body: { emails?: string[]; start_date?: string; end_date?: string }) {
  return request<WarmupAnalyticsEntry[]>('/accounts/warmup-analytics', { method: 'POST', body });
}

export async function getAccountAnalyticsDaily(params?: { start_date?: string; end_date?: string }) {
  return request<unknown>('/accounts/analytics/daily', { params: params as Record<string, string> });
}

export async function testAccountVitals(body: { emails: string[] }) {
  return request<unknown>('/accounts/test/vitals', { method: 'POST', body });
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function createLeads(leads: LeadCreatePayload[], options?: { skip_if_in_workspace?: boolean; skip_if_in_campaign?: boolean }) {
  return request<unknown>('/leads', { method: 'POST', body: { leads, ...options } });
}

export async function listLeads(body: {
  campaign_id?: string;
  lead_list_id?: string;
  search?: string;
  interest_status?: number;
  limit?: number;
  starting_after?: string;
}) {
  return request<PaginatedResponse<Lead>>('/leads/list', { method: 'POST', body });
}

export async function listAllLeads(campaignId: string, maxItems = 10000): Promise<Lead[]> {
  const all: Lead[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await listLeads({ campaign_id: campaignId, limit: 100, starting_after: after });
    if (page.items?.length) all.push(...page.items);
    after = page.next_starting_after || undefined;
    pages++;
    if (all.length >= maxItems || pages >= 200) break;
  } while (after);
  return all;
}

export async function getLead(id: string) {
  return request<Lead>(`/leads/${id}`);
}

export async function updateLead(id: string, payload: Partial<LeadCreatePayload>) {
  return request<Lead>(`/leads/${id}`, { method: 'PATCH', body: payload });
}

export async function updateLeadInterestStatus(body: { lead_email: string; campaign_id?: string; interest_status: number }) {
  return request<unknown>('/leads/update-interest-status', { method: 'POST', body });
}

export async function moveLeads(body: { lead_ids: string[]; to_campaign_id?: string; to_lead_list_id?: string }) {
  return request<unknown>('/leads/move', { method: 'POST', body });
}

export async function getLeadsByEmail(params: { email: string }) {
  return request<Lead[]>('/leads/by-email', { params: params as Record<string, string> });
}

export async function deleteLeadsByCampaign(campaignId: string) {
  return request<{ count: number }>('/leads', { method: 'DELETE', body: { campaign_id: campaignId } });
}

// ─── Lead Lists ───────────────────────────────────────────────────────────────

export async function listLeadLists(params?: PaginationParams) {
  return request<PaginatedResponse<LeadList>>('/lead-lists', { params: params as Record<string, string | number> });
}

export async function listAllLeadLists(): Promise<LeadList[]> {
  return fetchAllPages<LeadList>('/lead-lists');
}

export async function getLeadList(id: string) {
  return request<LeadList>(`/lead-lists/${id}`);
}

export async function createLeadList(payload: { name: string }) {
  return request<LeadList>('/lead-lists', { method: 'POST', body: payload });
}

export async function updateLeadList(id: string, payload: { name: string }) {
  return request<LeadList>(`/lead-lists/${id}`, { method: 'PATCH', body: payload });
}

export async function getLeadListVerificationStats(id: string) {
  return request<LeadListVerificationStats>(`/lead-lists/${id}/verification-stats`);
}

// ─── Block List ───────────────────────────────────────────────────────────────

export async function listBlockListEntries(params?: PaginationParams) {
  return request<PaginatedResponse<BlockListEntry>>('/block-lists-entries', {
    params: params as Record<string, string | number>,
  });
}

export async function createBlockListEntry(payload: { value: string; type?: string }) {
  return request<BlockListEntry>('/block-lists-entries', { method: 'POST', body: payload });
}

export async function updateBlockListEntry(id: string, payload: { value?: string }) {
  return request<BlockListEntry>(`/block-lists-entries/${id}`, { method: 'PATCH', body: payload });
}

// ─── Custom Tags ──────────────────────────────────────────────────────────────

function normalizeTag(raw: Record<string, unknown>): CustomTag {
  return {
    ...raw,
    name: (raw.name as string) || (raw.label as string) || '',
  } as CustomTag;
}

export async function listCustomTags(params?: PaginationParams) {
  const res = await request<PaginatedResponse<CustomTag>>('/custom-tags', {
    params: params as Record<string, string | number>,
  });
  res.items = res.items?.map((t) => normalizeTag(t as unknown as Record<string, unknown>));
  return res;
}

export async function listAllCustomTags(): Promise<CustomTag[]> {
  const tags = await fetchAllPages<CustomTag>('/custom-tags');
  return tags.map((t) => normalizeTag(t as unknown as Record<string, unknown>));
}

export async function createCustomTag(payload: { name: string }) {
  const raw = await request<Record<string, unknown>>('/custom-tags', { method: 'POST', body: { label: payload.name } });
  return normalizeTag(raw);
}

export async function updateCustomTag(id: string, payload: { name: string }) {
  const raw = await request<Record<string, unknown>>(`/custom-tags/${id}`, { method: 'PATCH', body: { label: payload.name } });
  return normalizeTag(raw);
}

export async function toggleTagResource(body: { tag_id: string; resource_id: string; resource_type: string }) {
  return request<unknown>('/custom-tags/toggle-resource', { method: 'POST', body });
}

export async function listCustomTagMappings(params?: PaginationParams & { tag_id?: string; resource_type?: string }) {
  return request<PaginatedResponse<{ id: string; tag_id: string; resource_id: string; resource_type: string }>>(
    '/custom-tag-mappings',
    { params: params as Record<string, string | number> },
  );
}

export async function listAllCustomTagMappings(resourceType?: string): Promise<{ id: string; tag_id: string; resource_id: string; resource_type: string }[]> {
  return fetchAllPages<{ id: string; tag_id: string; resource_id: string; resource_type: string }>(
    '/custom-tag-mappings',
    resourceType ? { resource_type: resourceType } : undefined,
  );
}

// ─── Subsequences ─────────────────────────────────────────────────────────────

export async function listSubsequences(params?: PaginationParams & { campaign_id?: string }) {
  return request<PaginatedResponse<Subsequence>>('/subsequences', {
    params: params as Record<string, string | number>,
  });
}

export async function getSubsequence(id: string) {
  return request<Subsequence>(`/subsequences/${id}`);
}

export async function createSubsequence(payload: { name?: string; campaign_id: string; sequences?: unknown }) {
  return request<Subsequence>('/subsequences', { method: 'POST', body: payload });
}

export async function updateSubsequence(id: string, payload: Partial<Subsequence>) {
  return request<Subsequence>(`/subsequences/${id}`, { method: 'PATCH', body: payload });
}

export async function duplicateSubsequence(id: string) {
  return request<Subsequence>(`/subsequences/${id}/duplicate`, { method: 'POST' });
}

export async function pauseSubsequence(id: string) {
  return request<Subsequence>(`/subsequences/${id}/pause`, { method: 'POST' });
}

export async function resumeSubsequence(id: string) {
  return request<Subsequence>(`/subsequences/${id}/resume`, { method: 'POST' });
}

// ─── Emails ───────────────────────────────────────────────────────────────────

export async function listEmails(params?: PaginationParams & { campaign_id?: string; lead_id?: string }) {
  return request<PaginatedResponse<Email>>('/emails', { params: params as Record<string, string | number> });
}

export async function getEmail(id: string) {
  return request<Email>(`/emails/${id}`);
}

export async function replyToEmail(body: { reply_to_uuid: string; from_email: string; body: string }) {
  return request<Email>('/emails/reply', { method: 'POST', body });
}

export async function forwardEmail(body: { email_uuid: string; from_email: string; to_email: string }) {
  return request<Email>('/emails/forward', { method: 'POST', body });
}

export async function getUnreadCount() {
  return request<{ count: number }>('/emails/unread/count');
}

export async function markThreadAsRead(threadId: string) {
  return request<unknown>(`/emails/threads/${threadId}/mark-as-read`, { method: 'POST' });
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export async function listWebhooks(params?: PaginationParams) {
  return request<PaginatedResponse<Webhook>>('/webhooks', { params: params as Record<string, string | number> });
}

export async function createWebhook(payload: { name: string; url: string; event_types: string[] }) {
  return request<Webhook>('/webhooks', { method: 'POST', body: payload });
}

export async function getWebhook(id: string) {
  return request<Webhook>(`/webhooks/${id}`);
}

export async function updateWebhook(id: string, payload: Partial<{ name: string; url: string; event_types: string[]; enabled: boolean }>) {
  return request<Webhook>(`/webhooks/${id}`, { method: 'PATCH', body: payload });
}

export async function listWebhookEventTypes() {
  return request<WebhookEventType[]>('/webhooks/event-types');
}

export async function testWebhook(id: string) {
  return request<unknown>(`/webhooks/${id}/test`, { method: 'POST' });
}

// ─── Email Templates ─────────────────────────────────────────────────────────

export async function listEmailTemplates(params?: PaginationParams) {
  return request<PaginatedResponse<EmailTemplate>>('/email-templates', {
    params: params as Record<string, string | number>,
  });
}

export async function createEmailTemplate(payload: { name: string; subject?: string; body?: string }) {
  return request<EmailTemplate>('/email-templates', { method: 'POST', body: payload });
}

export async function updateEmailTemplate(id: string, payload: Partial<{ name: string; subject: string; body: string }>) {
  return request<EmailTemplate>(`/email-templates/${id}`, { method: 'PATCH', body: payload });
}

// ─── Lead Labels ──────────────────────────────────────────────────────────────

export async function listLeadLabels(params?: PaginationParams) {
  return request<PaginatedResponse<LeadLabel>>('/lead-labels', {
    params: params as Record<string, string | number>,
  });
}

export async function createLeadLabel(payload: { name: string; color?: string }) {
  return request<LeadLabel>('/lead-labels', { method: 'POST', body: payload });
}

export async function updateLeadLabel(id: string, payload: Partial<{ name: string; color: string }>) {
  return request<LeadLabel>(`/lead-labels/${id}`, { method: 'PATCH', body: payload });
}

// ─── Background Jobs ─────────────────────────────────────────────────────────

export async function listBackgroundJobs(params?: PaginationParams) {
  return request<PaginatedResponse<BackgroundJob>>('/background-jobs', {
    params: params as Record<string, string | number>,
  });
}

export async function getBackgroundJob(id: string) {
  return request<BackgroundJob>(`/background-jobs/${id}`);
}

// ─── Account-Campaign Mapping ─────────────────────────────────────────────────

export async function getAccountCampaignMappings(email: string) {
  return request<unknown>(`/account-campaign-mappings/${encodeURIComponent(email)}`);
}

// ─── Email Verification ──────────────────────────────────────────────────────

export async function verifyEmail(email: string) {
  return request<unknown>('/email-verification', { method: 'POST', body: { email } });
}

export async function getEmailVerification(email: string) {
  return request<unknown>(`/email-verification/${encodeURIComponent(email)}`);
}
