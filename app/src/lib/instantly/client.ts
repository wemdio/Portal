import type {
  Account,
  AccountWarmupConfig,
  BackgroundJob,
  BlockListEntry,
  Campaign,
  CampaignAnalytics,
  CampaignAnalyticsOverview,
  CampaignCreatePayload,
  CampaignStepAnalytics,
  CampaignUpdatePayload,
  CustomTag,
  Email,
  EmailTemplate,
  Lead,
  LeadCreatePayload,
  LeadLabel,
  LeadList,
  LeadListVerificationStats,
  PaginatedResponse,
  PaginationParams,
  Subsequence,
  WarmupAnalyticsEntry,
  Webhook,
  WebhookEventType,
} from './types';
import { getInstantlyAccountApiKey, resolveInstantlyAccountId, type InstantlyRequestOptions } from './accounts';
import { acquireInstantlyToken } from './rateLimiter';
import { InstantlyApiError } from './errors';
export { InstantlyApiError } from './errors';

const BASE_URL = 'https://api.instantly.ai/api/v2';

function getApiKey(options?: InstantlyRequestOptions): string {
  return getInstantlyAccountApiKey(options?.accountId);
}

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 4000;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string | number | boolean | undefined> } = {},
  requestOptions?: InstantlyRequestOptions,
): Promise<T> {
  // Общий распределённый rate-limiter (workspace-wide лимит Instantly). Один раз
  // на логический вызов, ДО retry-цикла. Fail-open: при любой проблеме лимитера
  // запрос проходит как раньше. По умолчанию выключен (INSTANTLY_RATE_LIMITER_ENABLED).
  if (!requestOptions?.skipRateLimiter) {
    await acquireInstantlyToken(resolveInstantlyAccountId(requestOptions?.accountId));
  }

  const apiKey = getApiKey(requestOptions);
  const url = new URL(`${BASE_URL}${path}`);

  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const rateLimitRetries = requestOptions?.retryRateLimits === false ? 0 : RATE_LIMIT_RETRIES;
  for (let attempt = 0; attempt <= rateLimitRetries; attempt++) {
    const headers: HeadersInit = { Authorization: `Bearer ${apiKey}` };
    const controller = new AbortController();
    const timeoutMs =
      typeof requestOptions?.timeoutMs === 'number' &&
      Number.isFinite(requestOptions.timeoutMs) &&
      requestOptions.timeoutMs > 0
        ? requestOptions.timeoutMs
        : 90_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const init: RequestInit = { method: options.method ?? 'GET', headers, signal: controller.signal };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.status === 429 && attempt < rateLimitRetries) {
      const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const isHtml = raw.trimStart().startsWith('<');
      const detail = isHtml ? res.statusText || 'Service unavailable' : raw.slice(0, 300);
      throw new InstantlyApiError(`Instantly API ${res.status}: ${detail}`, res.status, isHtml ? undefined : raw);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  throw new InstantlyApiError('Instantly API 429: Rate limit exceeded after retries', 429);
}

/**
 * Fetches all pages from a paginated Instantly endpoint.
 */
async function fetchAllPages<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  maxItems?: number,
  requestOptions?: InstantlyRequestOptions,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await request<PaginatedResponse<T>>(
      path,
      { params: { limit: 100, ...params, starting_after: startingAfter } },
      requestOptions,
    );
    if (page.items?.length) all.push(...page.items);
    startingAfter = page.next_starting_after || undefined;
  } while (startingAfter && (!maxItems || all.length < maxItems));

  return maxItems ? all.slice(0, maxItems) : all;
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function listCampaigns(params?: PaginationParams & { status?: number; tag_ids?: string }, requestOptions?: InstantlyRequestOptions) {
  return request<PaginatedResponse<Campaign>>('/campaigns', { params: params as Record<string, string | number> }, requestOptions);
}

export async function listAllCampaigns(maxItems?: number, requestOptions?: InstantlyRequestOptions): Promise<Campaign[]> {
  return fetchAllPages<Campaign>('/campaigns', undefined, maxItems, requestOptions);
}

export async function getCampaign(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>(`/campaigns/${id}`, {}, requestOptions);
}

export async function createCampaign(payload: CampaignCreatePayload, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>('/campaigns', { method: 'POST', body: payload }, requestOptions);
}

export async function updateCampaign(id: string, payload: CampaignUpdatePayload, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>(`/campaigns/${id}`, { method: 'PATCH', body: payload }, requestOptions);
}

export async function activateCampaign(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>(`/campaigns/${id}/activate`, { method: 'POST' }, requestOptions);
}

export async function pauseCampaign(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>(`/campaigns/${id}/pause`, { method: 'POST' }, requestOptions);
}

export async function deleteCampaign(id: string, requestOptions?: InstantlyRequestOptions): Promise<Campaign | undefined> {
  return request<Campaign | undefined>(`/campaigns/${id}`, { method: 'DELETE' }, requestOptions);
}

export async function duplicateCampaign(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Campaign>(`/campaigns/${id}/duplicate`, { method: 'POST' }, requestOptions);
}

export async function shareCampaign(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<{ share_link: string }>(`/campaigns/${id}/share`, { method: 'POST' }, requestOptions);
}

// ─── Campaign Analytics ──────────────────────────────────────────────────────

export async function getCampaignAnalytics(params?: { id?: string; campaign_id?: string }, requestOptions?: InstantlyRequestOptions) {
  const effectiveId = params?.id ?? params?.campaign_id;
  const query: Record<string, string> = {};
  if (effectiveId) query.id = effectiveId;
  return request<CampaignAnalytics[]>('/campaigns/analytics', { params: query }, requestOptions);
}

export async function getCampaignAnalyticsOverview(params?: { campaign_id?: string }, requestOptions?: InstantlyRequestOptions) {
  const query: Record<string, string> = {};
  if (params?.campaign_id) query.id = params.campaign_id;
  return request<CampaignAnalyticsOverview>('/campaigns/analytics/overview', { params: query }, requestOptions);
}

export async function getCampaignAnalyticsDaily(params?: { campaign_id?: string; start_date?: string; end_date?: string }, requestOptions?: InstantlyRequestOptions) {
  const query: Record<string, string> = {};
  // /campaigns/analytics/daily filters by `campaign_id` (NOT `id` like overview).
  // Sending `id` is silently ignored → workspace-wide series for every campaign.
  // Verified live 2026-05-30; see wiki/concepts/dataset-schema.md daily-snap caveat.
  if (params?.campaign_id) query.campaign_id = params.campaign_id;
  if (params?.start_date) query.start_date = params.start_date;
  if (params?.end_date) query.end_date = params.end_date;
  return request<unknown>('/campaigns/analytics/daily', { params: query }, requestOptions);
}

export async function getCampaignAnalyticsSteps(params: { campaign_id: string }, requestOptions?: InstantlyRequestOptions) {
  return request<CampaignStepAnalytics[]>('/campaigns/analytics/steps', {
    params: { campaign_id: params.campaign_id } as Record<string, string>,
  }, requestOptions);
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export async function listAccounts(params?: PaginationParams & { search?: string; status?: number; tag_ids?: string }, requestOptions?: InstantlyRequestOptions) {
  return request<PaginatedResponse<Account>>('/accounts', { params: params as Record<string, string | number> }, requestOptions);
}

export async function listAllAccounts(requestOptions?: InstantlyRequestOptions): Promise<Account[]> {
  return fetchAllPages<Account>('/accounts', undefined, undefined, requestOptions);
}

export async function getAccount(email: string, requestOptions?: InstantlyRequestOptions) {
  return request<Account>(`/accounts/${encodeURIComponent(email)}`, {}, requestOptions);
}

/**
 * Завести отправляющий ящик у провайдера по SMTP/IMAP-кредам.
 *
 * Это второй шаг подключения клиентской почты: сначала кабинет проверяет
 * коннект и шифрует пароль у нас (lib/byoMailbox), затем ящик заводится здесь.
 * Клиент провайдера не видит — вся форма и вся переписка идут от нашего имени.
 *
 * ВАЖНО: обновить пароль у заведённого ящика нельзя, PATCH его не принимает.
 * Ротация пароля приложения = удалить и завести заново, и это обнуляет
 * прогрев. Поэтому смена пароля — осознанное действие с предупреждением, а не
 * тихий фон.
 */
export async function createAccount(
  body: {
    email: string;
    first_name: string;
    last_name: string;
    provider_code: number;
    smtp_username: string;
    smtp_password: string;
    smtp_host: string;
    smtp_port: number;
    imap_username: string;
    imap_password: string;
    imap_host: string;
    imap_port: number;
    daily_limit?: number;
    warmup?: AccountWarmupConfig;
  },
  requestOptions?: InstantlyRequestOptions,
) {
  return request<Account>('/accounts', { method: 'POST', body }, requestOptions);
}

/** Снять ящик у провайдера (отключение клиента, ротация пароля). */
export async function deleteAccount(email: string, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>(`/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' }, requestOptions);
}

export async function enableWarmup(emails: string[], requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/accounts/warmup/enable', { method: 'POST', body: { emails } }, requestOptions);
}

export async function disableWarmup(emails: string[], requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/accounts/warmup/disable', { method: 'POST', body: { emails } }, requestOptions);
}

export async function getWarmupAnalytics(body: { emails?: string[]; start_date?: string; end_date?: string }, requestOptions?: InstantlyRequestOptions) {
  return request<WarmupAnalyticsEntry[]>('/accounts/warmup-analytics', { method: 'POST', body }, requestOptions);
}

export async function getAccountAnalyticsDaily(params?: { start_date?: string; end_date?: string }, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/accounts/analytics/daily', { params: params as Record<string, string> }, requestOptions);
}

export async function testAccountVitals(body: { emails: string[] }, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/accounts/test/vitals', { method: 'POST', body }, requestOptions);
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/**
 * Instantly's POST /leads/add ограничивает body.leads 1000 элементами
 * (иначе 400 FST_ERR_VALIDATION "body/leads must NOT have more than 1000
 * items"). Это лимит Instantly, не наш.
 */
const LEADS_PER_REQUEST = 1000;

export interface BulkLeadImportCreatedLead {
  id: string;
  email: string;
  index: number;
}

/**
 * Normalized response from Instantly's bulk lead-import endpoint.
 *
 * `leads_uploaded` is the current API field. `uploaded` is retained as a
 * compatibility alias because this wrapper historically returned that field
 * when it had to split a request into 1000-row chunks.
 */
export interface BulkLeadImportResult {
  status: string;
  total_sent: number;
  leads_uploaded: number;
  uploaded: number;
  in_blocklist: number;
  blocklist_used: string | null;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  incomplete_count: number;
  duplicate_email_count: number;
  remaining_in_plan: number | null;
  created_leads: BulkLeadImportCreatedLead[];
}

function readImportCount(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function normalizeBulkLeadImportResult(
  raw: Record<string, unknown>,
  requested: number,
): BulkLeadImportResult {
  const totalSent = readImportCount(raw, 'total_sent') ?? requested;
  const leadsUploaded =
    readImportCount(raw, 'leads_uploaded') ??
    readImportCount(raw, 'uploaded') ??
    readImportCount(raw, 'created') ??
    readImportCount(raw, 'total_uploaded');

  if (leadsUploaded === undefined) {
    throw new Error('Instantly lead import response is missing leads_uploaded');
  }
  if (totalSent > requested || leadsUploaded > totalSent) {
    throw new Error('Instantly lead import response contains invalid lead counters');
  }

  const createdLeads = Array.isArray(raw.created_leads)
    ? raw.created_leads.flatMap((item): BulkLeadImportCreatedLead[] => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const index = readImportCount(row, 'index');
        if (typeof row.id !== 'string' || typeof row.email !== 'string' || index === undefined) return [];
        return [{ id: row.id, email: row.email, index }];
      })
    : [];

  const remainingInPlan = readImportCount(raw, 'remaining_in_plan');
  return {
    status: typeof raw.status === 'string' ? raw.status : 'success',
    total_sent: totalSent,
    leads_uploaded: leadsUploaded,
    uploaded: leadsUploaded,
    in_blocklist: readImportCount(raw, 'in_blocklist') ?? 0,
    blocklist_used: typeof raw.blocklist_used === 'string' ? raw.blocklist_used : null,
    duplicated_leads: readImportCount(raw, 'duplicated_leads') ?? 0,
    skipped_count: readImportCount(raw, 'skipped_count') ?? Math.max(0, totalSent - leadsUploaded),
    invalid_email_count: readImportCount(raw, 'invalid_email_count') ?? 0,
    incomplete_count: readImportCount(raw, 'incomplete_count') ?? 0,
    duplicate_email_count: readImportCount(raw, 'duplicate_email_count') ?? 0,
    remaining_in_plan: remainingInPlan ?? null,
    created_leads: createdLeads,
  };
}

export async function createLeads(
  leads: LeadCreatePayload[],
  options?: {
    campaign_id?: string;
    list_id?: string;
    skip_if_in_workspace?: boolean;
    skip_if_in_campaign?: boolean;
    skip_if_in_list?: boolean;
  },
  requestOptions?: InstantlyRequestOptions,
): Promise<BulkLeadImportResult> {
  // До 1000 — один запрос; ответ сразу нормализуем в тот же контракт, что и
  // многочастный импорт.
  if (leads.length <= LEADS_PER_REQUEST) {
    const raw = await request<Record<string, unknown>>(
      '/leads/add',
      { method: 'POST', body: { leads, ...options } },
      requestOptions,
    );
    return normalizeBulkLeadImportResult(raw, leads.length);
  }

  // Больше 1000 — бьём на чанки и шлём последовательно, суммируя все
  // официальные счётчики. Любая ошибка прерывает импорт: вызывающий код не
  // должен активировать кампанию на основании частичного/неизвестного ответа.
  const aggregate: BulkLeadImportResult = {
    status: 'success',
    total_sent: 0,
    leads_uploaded: 0,
    uploaded: 0,
    in_blocklist: 0,
    blocklist_used: null,
    duplicated_leads: 0,
    skipped_count: 0,
    invalid_email_count: 0,
    incomplete_count: 0,
    duplicate_email_count: 0,
    remaining_in_plan: null,
    created_leads: [],
  };
  for (let i = 0; i < leads.length; i += LEADS_PER_REQUEST) {
    const chunk = leads.slice(i, i + LEADS_PER_REQUEST);
    const raw = await request<Record<string, unknown>>(
      '/leads/add',
      { method: 'POST', body: { leads: chunk, ...options } },
      requestOptions,
    );
    const result = normalizeBulkLeadImportResult(raw, chunk.length);
    aggregate.total_sent += result.total_sent;
    aggregate.leads_uploaded += result.leads_uploaded;
    aggregate.uploaded = aggregate.leads_uploaded;
    aggregate.in_blocklist += result.in_blocklist;
    aggregate.blocklist_used = result.blocklist_used ?? aggregate.blocklist_used;
    aggregate.duplicated_leads += result.duplicated_leads;
    aggregate.skipped_count += result.skipped_count;
    aggregate.invalid_email_count += result.invalid_email_count;
    aggregate.incomplete_count += result.incomplete_count;
    aggregate.duplicate_email_count += result.duplicate_email_count;
    aggregate.remaining_in_plan = result.remaining_in_plan;
    aggregate.created_leads.push(
      ...result.created_leads.map((lead) => ({ ...lead, index: lead.index + i })),
    );
  }
  return aggregate;
}

export async function listLeads(body: {
  campaign_id?: string;
  lead_list_id?: string;
  search?: string;
  interest_status?: number;
  limit?: number;
  starting_after?: string;
}, requestOptions?: InstantlyRequestOptions) {
  // Instantly API v2 expects `list_id` and `campaign` — not `lead_list_id` /
  // `campaign_id`. Sending the wrong keys makes Instantly silently ignore the
  // filter and return leads from the entire workspace. We keep the caller-
  // facing field names for backwards compatibility (portal UI, scripts, worker)
  // but rename them on the wire.
  // See: tests/lib/instantly/clientListLeads.test.ts
  const { lead_list_id, campaign_id, ...rest } = body;
  const apiBody: Record<string, unknown> = { ...rest };
  if (lead_list_id !== undefined) apiBody.list_id = lead_list_id;
  if (campaign_id !== undefined) apiBody.campaign = campaign_id;
  return request<PaginatedResponse<Lead>>('/leads/list', { method: 'POST', body: apiBody }, requestOptions);
}

export async function listAllLeads(campaignId: string, requestOptions?: InstantlyRequestOptions): Promise<Lead[]> {
  const all: Lead[] = [];
  let after: string | undefined;
  do {
    const page = await listLeads({ campaign_id: campaignId, limit: 100, starting_after: after }, requestOptions);
    if (page.items?.length) all.push(...page.items);
    after = page.next_starting_after || undefined;
  } while (after);
  return all;
}

export async function getLead(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Lead>(`/leads/${id}`, {}, requestOptions);
}

export async function updateLead(id: string, payload: Partial<LeadCreatePayload>, requestOptions?: InstantlyRequestOptions) {
  return request<Lead>(`/leads/${id}`, { method: 'PATCH', body: payload }, requestOptions);
}

export async function updateLeadInterestStatus(body: { lead_email: string; campaign_id?: string; interest_status: number }, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/leads/update-interest-status', { method: 'POST', body }, requestOptions);
}

export async function moveLeads(body: { lead_ids: string[]; to_campaign_id?: string; to_lead_list_id?: string }, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>('/leads/move', { method: 'POST', body }, requestOptions);
}

export async function getLeadsByEmail(params: { email: string; campaign_id?: string }, requestOptions?: InstantlyRequestOptions) {
  const body: Record<string, unknown> = { search: params.email, limit: 10 };
  if (params.campaign_id) body.campaign = params.campaign_id;
  const res = await request<PaginatedResponse<Lead>>('/leads/list', { method: 'POST', body }, requestOptions);
  return res.items ?? [];
}

export async function deleteLeadsByCampaign(campaignId: string, requestOptions?: InstantlyRequestOptions): Promise<{ count: number }> {
  let totalDeleted = 0;
  const MAX_ROUNDS = 200;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await request<{ count: number }>(
      '/leads',
      { method: 'DELETE', body: { campaign_id: campaignId, limit: 10000 } },
      requestOptions,
    );
    totalDeleted += result.count;
    if (result.count === 0) break;
  }
  return { count: totalDeleted };
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

export async function listEmails(
  params?: PaginationParams & {
    campaign_id?: string;
    lead_id?: string;
    /**
     * Filter by lead EMAIL. Instantly's working lead filter on GET /emails is
     * `lead` (the address), NOT `lead_id` — passing an email as `lead_id` is
     * silently ignored and the API returns the WHOLE campaign's emails (verified
     * live 2026-06-19). Use this to fetch one lead's full conversation.
     */
    lead?: string;
    search?: string;
    /**
     * Per Instantly v2 docs (GET /api/v2/emails), the filter on direction is
     * `email_type` (string enum), NOT `ue_type` (which is a RESPONSE field
     * classifying the email, not a query filter). Passing an unknown param
     * like `ue_type` is silently ignored — Instantly returns ALL emails for
     * the campaign, including outbound ones. Use `email_type: 'received'`
     * when you want only inbound replies.
     */
    email_type?: 'received' | 'sent' | 'manual';
    /**
     * Unibox tab. Instantly defaults to `emode_focused` (Primary) when the
     * param is omitted — the "Others" tab (~97% of inbound: warmup, spam, but
     * also SOME real replies Instantly missorted) is reachable ONLY with
     * `mode: 'emode_others'`. NOT the response fields `is_focused`/`i_status`
     * (passing those as query params is silently ignored; verified live
     * 2026-07-15).
     */
    mode?: 'emode_focused' | 'emode_others' | 'emode_all';
  },
  requestOptions?: InstantlyRequestOptions,
) {
  return request<PaginatedResponse<Email>>('/emails', { params: params as Record<string, string | number> }, requestOptions);
}

export async function getEmail(id: string, requestOptions?: InstantlyRequestOptions) {
  return request<Email>(`/emails/${id}`, {}, requestOptions);
}

export async function replyToEmail(body: {
  reply_to_uuid: string;
  eaccount: string;
  subject: string;
  body: { html?: string; text?: string } | string;
  cc_address_email_list?: string;
  bcc_address_email_list?: string;
}, requestOptions?: InstantlyRequestOptions) {
  return request<Email>('/emails/reply', { method: 'POST', body }, requestOptions);
}

export async function forwardEmail(body: {
  reply_to_uuid: string;
  eaccount: string;
  to_address_email_list: string;
  subject: string;
  body: { html?: string; text?: string } | string;
  include_original_body: boolean;
}, requestOptions?: InstantlyRequestOptions) {
  return request<Email>('/emails/forward', { method: 'POST', body }, requestOptions);
}

/**
 * Тест-эндпоинт (POST /emails/test). Единственный в v2 способ отправить НОВОЕ
 * письмо (compose-эндпоинта нет): нужен для handoff по Others-письмам, которые
 * не принадлежат кампании — reply и forward на них отвечают 400 «not part of
 * an Instantly campaign» (проверено живьём 27.07). Минусы: без сущности в
 * Unibox и без cc (копию кладём в to_address_email_list). Лимит 10/мин/воркспейс.
 */
export async function sendTestEmail(body: {
  eaccount: string;
  to_address_email_list: string;
  subject: string;
  body: { html: string };
}, requestOptions?: InstantlyRequestOptions): Promise<{ status?: string; error?: string }> {
  // У тест-эндпоинта ошибки приходят HTTP 200 с телом {error: 'ACC_*'} — обычный
  // request() считает это успехом (бросает только !res.ok). Проверяем payload
  // сами, иначе webhook пометил бы передачу 'sent' при неотправленном письме
  // (MEDIUM-находка swarm-ревью 27.07).
  const res = await request<{ status?: string; error?: string }>(
    '/emails/test',
    { method: 'POST', body },
    requestOptions,
  );
  if (res && typeof res === 'object' && res.error) {
    throw new InstantlyApiError(`Instantly test email rejected: ${res.error}`, 400);
  }
  return res;
}

export async function getUnreadCount(requestOptions?: InstantlyRequestOptions) {
  return request<{ count: number }>('/emails/unread/count', {}, requestOptions);
}

export async function markThreadAsRead(threadId: string, requestOptions?: InstantlyRequestOptions) {
  return request<unknown>(`/emails/threads/${threadId}/mark-as-read`, { method: 'POST' }, requestOptions);
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
