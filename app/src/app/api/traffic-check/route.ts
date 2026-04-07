import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { startToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HYPESTAT_DELAY_MS = 2000;
const HYPESTAT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 1;
const MAX_DOMAINS = 500;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

type DomainEntry = { idx: number; url: string };
type RequestBody = { sites: DomainEntry[] };

type TrafficResult = {
  idx: number;
  domain: string;
  monthlyVisits: number | null;
  dailyVisitors: number | null;
  error: string | null;
};

function extractDomain(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s).hostname.replace(/^www\./, '');
  } catch {
    return s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '');
  }
}

async function fetchTraffic(domain: string, attempt = 0): Promise<Omit<TrafficResult, 'idx' | 'domain'>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HYPESTAT_TIMEOUT_MS);

  try {
    const res = await fetch(`https://hypestat.com/info/${domain}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: controller.signal,
    });

    if (res.status === 429 || res.status === 403) {
      if (attempt < MAX_RETRIES) {
        clearTimeout(timeout);
        await new Promise((r) => setTimeout(r, 10_000));
        return fetchTraffic(domain, attempt + 1);
      }
      return { monthlyVisits: null, dailyVisitors: null, error: `HTTP ${res.status} (rate limited)` };
    }

    if (!res.ok) {
      return { monthlyVisits: null, dailyVisitors: null, error: `HTTP ${res.status}` };
    }

    const html = await res.text();

    const monthlyMatch = html.match(/Monthly Visits:<\/dt><dd>([\d,]+)<\/dd>/);
    const dailyMatch = html.match(/Daily Unique Visitors:<\/dt><dd>([\d,]+)<\/dd>/);

    const monthlyVisits = monthlyMatch ? parseInt(monthlyMatch[1].replace(/,/g, ''), 10) : null;
    const dailyVisitors = dailyMatch ? parseInt(dailyMatch[1].replace(/,/g, ''), 10) : null;

    return { monthlyVisits, dailyVisitors, error: null };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      clearTimeout(timeout);
      await new Promise((r) => setTimeout(r, 5000));
      return fetchTraffic(domain, attempt + 1);
    }
    return { monthlyVisits: null, dailyVisitors: null, error: err instanceof Error ? err.message : 'Fetch error' };
  } finally {
    clearTimeout(timeout);
  }
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const sites = body.sites ?? [];
  if (!Array.isArray(sites) || sites.length === 0) {
    return jsonError('Missing required field: sites (non-empty array)', 400);
  }
  if (sites.length > MAX_DOMAINS) {
    return jsonError(`Too many domains in one request (max ${MAX_DOMAINS})`, 400);
  }

  const trace = await startToolTrace({
    request: req,
    operation: 'database.traffic_check',
    userId: user.id,
    input: { count: sites.length },
    message: `Проверка трафика ${sites.length} сайтов`,
  });

  // Deduplicate domains to avoid redundant HypeStat requests
  const domainMap = new Map<string, DomainEntry[]>();
  for (const site of sites) {
    const domain = extractDomain(String(site.url ?? ''));
    if (!domain) continue;
    const arr = domainMap.get(domain) ?? [];
    arr.push(site);
    domainMap.set(domain, arr);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      const uniqueDomains = Array.from(domainMap.keys());
      send({ type: 'start', total: sites.length, uniqueDomains: uniqueDomains.length });

      const cache = new Map<string, Omit<TrafficResult, 'idx' | 'domain'>>();
      let processed = 0;

      for (let i = 0; i < uniqueDomains.length; i++) {
        const domain = uniqueDomains[i];
        const entries = domainMap.get(domain)!;

        const data = await fetchTraffic(domain);
        cache.set(domain, data);

        const results: TrafficResult[] = entries.map((e) => ({
          idx: e.idx,
          domain,
          ...data,
        }));

        processed += entries.length;
        send({
          type: 'batch',
          results,
          processed,
          total: sites.length,
          progress: Math.round((processed / sites.length) * 100),
        });

        if (i < uniqueDomains.length - 1) {
          await new Promise((r) => setTimeout(r, HYPESTAT_DELAY_MS));
        }
      }

      const withData = Array.from(cache.values()).filter((v) => v.monthlyVisits !== null).length;
      send({ type: 'done', processed, withData, noData: uniqueDomains.length - withData });

      try {
        await trace.end({ count: sites.length, uniqueDomains: uniqueDomains.length, withData });
      } catch {}

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
