import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { SEARCH_CONFIG } from '@/lib/config';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeProxyUrl(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  return `http://${s}`;
}

function redactProxyUrl(raw: string): string {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return normalized.replace(/\/\/[^@/]+@/g, '//').replace(/\/$/, '');
  }
}

function parseProxyList(raw: string): string[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((v) => normalizeProxyUrl(String(v ?? ''))).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  return s
    .split(/[,\n;\t ]+/g)
    .map((v) => normalizeProxyUrl(String(v ?? '')))
    .filter(Boolean);
}

function getProxyConfig(): { source: 'PROXY_URLS' | 'SEARCH_PROXY_URL' | 'HH_PROXY_URL' | 'none'; proxies: string[] } {
  const listRaw = (process.env.PROXY_URLS ?? '').trim();
  const list = parseProxyList(listRaw);
  if (list.length) return { source: 'PROXY_URLS', proxies: list };

  const singleSearch = (process.env.SEARCH_PROXY_URL ?? '').trim();
  if (singleSearch) return { source: 'SEARCH_PROXY_URL', proxies: [normalizeProxyUrl(singleSearch)] };

  const hh = (process.env.HH_PROXY_URL ?? '').trim();
  if (hh) return { source: 'HH_PROXY_URL', proxies: [normalizeProxyUrl(hh)] };

  return { source: 'none', proxies: [] };
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const cfg = getProxyConfig();
  const redacted = cfg.proxies.map((p) => redactProxyUrl(p)).filter(Boolean);

  return NextResponse.json({
    playwright_enabled: Boolean(SEARCH_CONFIG.PLAYWRIGHT.ENABLED),
    proxy_source: cfg.source,
    proxy_count: redacted.length,
    proxies: redacted,
    note: 'Прокси применяется только на сервере (worker/API), не в браузере.',
  });
}

