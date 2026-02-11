import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { normalizeUrl } from '@/lib/enrich/websiteParser';

export const dynamic = 'force-dynamic';

const CHECK_TIMEOUT_MS = Number(process.env.SITE_AVAILABILITY_TIMEOUT_MS ?? '12000');
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

type SiteEntry = {
  idx: number;
  url: string;
};

type RequestBody = {
  sites: SiteEntry[];
};

type SiteCheckResult = {
  idx: number;
  status: 'Онлайн' | 'Онлайн (нестандартный код)' | 'Оффлайн/Ошибка';
  code: number;
  finalUrl: string;
  durationMs: number;
  error: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function checkSingleSite(rawUrl: string): Promise<Omit<SiteCheckResult, 'idx'>> {
  let normalizedUrl = rawUrl;
  try {
    normalizedUrl = normalizeUrl(rawUrl);
  } catch (err) {
    return {
      status: 'Оффлайн/Ошибка',
      code: 0,
      finalUrl: rawUrl,
      durationMs: 0,
      error: err instanceof Error ? err.message : 'Невалидный URL',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(normalizedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    return {
      status: response.status === 200 ? 'Онлайн' : 'Онлайн (нестандартный код)',
      code: response.status,
      finalUrl: response.url || normalizedUrl,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка запроса';
    return {
      status: 'Оффлайн/Ошибка',
      code: 0,
      finalUrl: normalizedUrl,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
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

  if (sites.length > 200) {
    return jsonError('Too many sites in one request (max 200)', 400);
  }

  const results: SiteCheckResult[] = await Promise.all(
    sites.map(async (site) => ({
      idx: site.idx,
      ...(await checkSingleSite(String(site.url ?? '').trim())),
    })),
  );

  return NextResponse.json({ results });
}
