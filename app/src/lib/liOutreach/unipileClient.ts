import 'server-only';

/**
 * Unipile REST API client for LinkedIn automation.
 * Port of Python linkedin-ai-responder/app/services/unipile.py → TypeScript.
 *
 * Usage:
 *   const client = new UnipileClient(dsn, apiKey, accountId);
 *   const accounts = await client.listAccounts();
 */

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 90_000;
const SEARCH_TIMEOUT_MS = 180_000;

export class UnipileError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'UnipileError';
    this.status = status;
    this.body = body;
  }
}

export class UnipileClient {
  private baseUrl: string;
  private apiKey: string;
  private accountId: string | null;

  constructor(dsn: string, apiKey: string, accountId?: string | null) {
    // dsn like "api23.unipile.com:15321" → "https://api23.unipile.com:15321/api/v1"
    const cleanDsn = dsn.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.baseUrl = `https://${cleanDsn}/api/v1`;
    this.apiKey = apiKey;
    this.accountId = accountId ?? null;
  }

  // ---- Internal helpers ------------------------------------------------

  private get headers(): Record<string, string> {
    return {
      'X-API-KEY': this.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private async request<T = Record<string, unknown>>(
    method: string,
    endpoint: string,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeout?: number;
      retries?: number;
      addAccountId?: boolean;
    } = {},
  ): Promise<T> {
    const { params = {}, body, timeout = REQUEST_TIMEOUT_MS, retries = MAX_RETRIES, addAccountId = true } = options;
    const ep = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const url = new URL(`${this.baseUrl}/${ep}`);

    // Append query params
    if (addAccountId && this.accountId && !params.account_id) {
      params.account_id = this.accountId;
    }
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(url.toString(), {
          method,
          headers: this.headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new UnipileError(`Unipile ${res.status}: ${text.slice(0, 300)}`, res.status, text);
        }

        if (res.status === 204 || res.headers.get('content-length') === '0') {
          return {} as T;
        }
        return (await res.json()) as T;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Don't retry 4xx client errors (except 429)
        if (e instanceof UnipileError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          throw e;
        }
        const wait = (attempt + 1) * 2 * 1000;
        console.warn(`[unipile] ${method} ${ep} attempt ${attempt + 1}/${retries} failed: ${lastError.message}. Retrying in ${wait}ms…`);
        await new Promise((r) => setTimeout(r, wait));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`Unipile request failed after ${retries} retries`);
  }

  /** Send message via multipart/form-data (Unipile requires this for chat messages). */
  private async sendMultipart(endpoint: string, text: string): Promise<Record<string, unknown>> {
    const ep = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const url = new URL(`${this.baseUrl}/${ep}`);
    if (this.accountId) url.searchParams.set('account_id', this.accountId);

    const form = new FormData();
    form.append('text', text);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'X-API-KEY': this.apiKey, Accept: 'application/json' },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new UnipileError(`Unipile send_message ${res.status}: ${body.slice(0, 300)}`, res.status, body);
      }
      return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Accounts --------------------------------------------------------

  async listAccounts(): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>('GET', 'accounts', {
      params: { limit: 100 },
      addAccountId: false,
    });
    return data.items ?? (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []);
  }

  // ---- Search & Profiles -----------------------------------------------

  async searchByUrl(
    searchUrl: string,
    opts: { limit?: number; cursor?: string; start?: number } = {},
  ): Promise<{ items: Array<Record<string, unknown>>; cursor?: string; paging?: Record<string, unknown> }> {
    const body: Record<string, unknown> = { url: searchUrl };
    if (opts.limit) body.limit = opts.limit;
    if (opts.cursor) body.cursor = opts.cursor;
    else if (opts.start !== undefined && opts.start > 0) body.start = opts.start;

    return this.request('POST', 'linkedin/search', {
      body,
      timeout: SEARCH_TIMEOUT_MS,
      retries: 5,
    });
  }

  async searchPeople(query: string, limit = 20, offset = 0): Promise<Record<string, unknown>> {
    return this.request('GET', 'users/search', { params: { q: query, limit, offset } });
  }

  async getProfile(identifier: string): Promise<Record<string, unknown>> {
    const clean = extractPublicIdentifier(identifier) ?? identifier;
    return this.request('GET', `users/${encodeURIComponent(clean)}`);
  }

  async getProviderId(profileUrl: string): Promise<string> {
    const data = await this.getProfile(profileUrl);
    const pid = String(data.provider_id ?? '');
    if (!pid) throw new Error(`No provider_id for ${profileUrl}`);
    return pid;
  }

  // ---- Post reactions ---------------------------------------------------

  async getPostReactions(
    postUrn: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: Array<Record<string, unknown>>; cursor?: string }> {
    return this.request('GET', `posts/${encodeURIComponent(postUrn)}/reactions`, {
      params: { limit: opts.limit ?? 100, cursor: opts.cursor },
    });
  }

  // ---- Invitations ------------------------------------------------------

  async sendInvite(
    providerId: string,
    message?: string | null,
    retryWithoutMessage = true,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      provider_id: providerId,
      account_id: this.accountId,
    };
    if (message) {
      payload.message = message.length > 300 ? `${message.slice(0, 297)}...` : message;
    }

    try {
      const result = await this.request<Record<string, unknown>>('POST', 'users/invite', { body: payload, addAccountId: false });
      return { ...result, had_message: !!message };
    } catch (e) {
      if (!(e instanceof UnipileError)) throw e;
      // Retry without message if personalized invite limit reached
      const body = e.body.toLowerCase();
      const isLimitError =
        message &&
        retryWithoutMessage &&
        (body.includes('limit') || body.includes('personalize') || body.includes('message') || body.includes('too many') || e.status === 429);

      if (isLimitError) {
        console.warn('[unipile] Personalized invite limit, retrying WITHOUT message');
        const fallback: Record<string, unknown> = { provider_id: providerId, account_id: this.accountId };
        const result = await this.request<Record<string, unknown>>('POST', 'users/invite', { body: fallback, addAccountId: false });
        return { ...result, had_message: false, message_stripped: true };
      }
      throw e;
    }
  }

  // ---- Messaging --------------------------------------------------------

  async getChats(limit = 50): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>('GET', 'chats', { params: { limit } });
    return data.items ?? [];
  }

  async getChatMessages(chatId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>('GET', `chats/${chatId}/messages`, { params: { limit } });
    return data.items ?? [];
  }

  async sendMessage(chatId: string, text: string): Promise<Record<string, unknown>> {
    return this.sendMultipart(`chats/${chatId}/messages`, text);
  }

  async startChat(providerId: string, message?: string | null): Promise<Record<string, unknown>> {
    if (!this.accountId) throw new Error('account_id required for startChat');
    const payload: Record<string, unknown> = {
      account_id: this.accountId,
      attendees_ids: [providerId],
    };
    if (message) payload.text = message;
    return this.request('POST', 'chats', { body: payload, addAccountId: false });
  }

  async markChatRead(chatId: string): Promise<void> {
    await this.request('PATCH', `chats/${chatId}`, { body: { action: 'setReadStatus', value: true } });
  }

  // ---- Webhooks ---------------------------------------------------------

  async listWebhooks(): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<{ items?: Array<Record<string, unknown>> }>('GET', 'webhooks', { addAccountId: false });
    return data.items ?? (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []);
  }

  async createWebhook(webhookUrl: string, events?: string[]): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { url: webhookUrl };
    if (events?.length) payload.events = events;
    return this.request('POST', 'webhooks', { body: payload, addAccountId: false });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request('DELETE', `webhooks/${webhookId}`, { addAccountId: false });
  }

  /**
   * Patch an account's proxy settings in Unipile.
   * proxyStr format: "ip:port:user:pass" (HTTP proxy).
   * Pass null/empty to remove proxy (revert to Unipile default pool).
   */
  async patchAccountProxy(
    unipileAccountId: string,
    proxyStr: string | null,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (proxyStr) {
      const parts = proxyStr.split(':');
      if (parts.length === 4) {
        body.proxy = {
          host: parts[0],
          port: Number(parts[1]),
          username: parts[2],
          password: parts[3],
          protocol: 'http',
        };
      } else if (parts.length === 2) {
        body.proxy = {
          host: parts[0],
          port: Number(parts[1]),
          protocol: 'http',
        };
      } else {
        throw new Error(`Invalid proxy format: expected ip:port or ip:port:user:pass, got "${proxyStr}"`);
      }
    } else {
      body.proxy = null;
    }
    return this.request('PATCH', `accounts/${unipileAccountId}`, {
      body,
      addAccountId: false,
    });
  }
}

// ---- Static helpers ---------------------------------------------------

export function extractPublicIdentifier(profileUrl: string): string | null {
  try {
    const clean = profileUrl.split('?')[0]?.replace(/\/+$/, '') ?? '';
    if (clean.includes('/in/')) return clean.split('/in/').pop() ?? null;
    return null;
  } catch {
    return null;
  }
}

export function extractActivityUrn(postUrl: string): string | null {
  if (postUrl.startsWith('urn:li:activity:')) return postUrl;
  const match = postUrl.match(/activity[:-](\d{19})/);
  return match ? `urn:li:activity:${match[1]}` : null;
}
