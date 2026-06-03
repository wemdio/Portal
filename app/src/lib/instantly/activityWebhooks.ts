import 'server-only';

import { listInstantlyAccounts, getInstantlyAccountApiKey } from './accounts';

/**
 * Idempotent registration of the activity webhooks (email_opened + reply_received)
 * in EVERY configured Instantly account, pointing at our receiver
 * `/api/instantly/webhook/<accountId>?token=<secret>`.
 *
 * Why a self-contained helper instead of the existing `createWebhook` in
 * client.ts: those helpers use the legacy payload shape (`url` / `event_types[]`)
 * and don't support per-account keys. The live V2 API wants `target_hook_url` +
 * a single `event_type`. We keep this isolated so we don't disturb the existing
 * (separate) webhook admin surface.
 *
 * Only Instantly API calls in the whole feature: 2 events × N accounts, run once
 * at setup (and safe to re-run). After that everything is push (zero polling).
 */

const BASE_URL = 'https://api.instantly.ai/api/v2';

// Verified against the V2 webhook event-type enum.
const ACTIVITY_EVENTS = ['email_opened', 'reply_received'] as const;
type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

interface RawWebhook {
  id: string;
  target_hook_url?: string;
  event_type?: string | null;
  name?: string | null;
}

export interface EnsureWebhookResult {
  account: string;
  event: ActivityEvent;
  action: 'created' | 'updated' | 'exists' | 'error';
  id?: string;
  error?: string;
}

async function instantlyFetch(
  apiKey: string,
  pathOrUrl: string | URL,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = typeof pathOrUrl === 'string' ? `${BASE_URL}${pathOrUrl}` : pathOrUrl.toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const reqInit: RequestInit = { method: init?.method ?? 'GET', headers };
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, reqInit);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Instantly ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function listAllWebhooks(apiKey: string): Promise<RawWebhook[]> {
  const out: RawWebhook[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${BASE_URL}/webhooks`);
    url.searchParams.set('limit', '100');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const res = (await instantlyFetch(apiKey, url)) as
      | { items?: RawWebhook[]; next_starting_after?: string | null }
      | null;
    const items = Array.isArray(res?.items) ? res!.items : [];
    out.push(...items);
    startingAfter = res?.next_starting_after || undefined;
    if (!startingAfter || items.length === 0) break;
  }
  return out;
}

/** Compares two webhook URLs by origin+pathname, ignoring the query (token). */
function samePath(candidate: string | undefined, desiredPath: string): boolean {
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    return `${u.origin}${u.pathname}` === desiredPath;
  } catch {
    return false;
  }
}

export async function ensureActivityWebhooks(): Promise<EnsureWebhookResult[]> {
  const secret = (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim();
  const site = (process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  if (!secret) throw new Error('INSTANTLY_WEBHOOK_SECRET is not set');
  if (!site) throw new Error('NEXT_PUBLIC_SITE_URL is not set');

  const results: EnsureWebhookResult[] = [];

  for (const account of listInstantlyAccounts()) {
    const apiKey = getInstantlyAccountApiKey(account.id);
    const desiredPath = `${site}/api/instantly/webhook/${account.id}`;
    const desiredUrl = `${desiredPath}?token=${encodeURIComponent(secret)}`;

    let existing: RawWebhook[] = [];
    try {
      existing = await listAllWebhooks(apiKey);
    } catch (e) {
      for (const event of ACTIVITY_EVENTS) {
        results.push({
          account: account.id,
          event,
          action: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    for (const event of ACTIVITY_EVENTS) {
      try {
        const match = existing.find(
          (w) => w.event_type === event && samePath(w.target_hook_url, desiredPath),
        );
        if (match) {
          if (match.target_hook_url !== desiredUrl) {
            // Path matches but token rotated → update in place (no duplicate).
            await instantlyFetch(apiKey, `/webhooks/${match.id}`, {
              method: 'PATCH',
              body: { target_hook_url: desiredUrl },
            });
            results.push({ account: account.id, event, action: 'updated', id: match.id });
          } else {
            results.push({ account: account.id, event, action: 'exists', id: match.id });
          }
          continue;
        }
        const created = (await instantlyFetch(apiKey, '/webhooks', {
          method: 'POST',
          body: {
            name: `Portal activity: ${event}`,
            target_hook_url: desiredUrl,
            event_type: event,
          },
        })) as { id?: string } | null;
        results.push({ account: account.id, event, action: 'created', id: created?.id });
      } catch (e) {
        results.push({
          account: account.id,
          event,
          action: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return results;
}
