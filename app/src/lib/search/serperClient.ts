import 'server-only';
import { beginProviderUsage, getProviderUsageScope, type ProviderUsageDetails } from '@/lib/providerUsage';

const SERPER_API_URL = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 8_000;

export interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

export function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

/**
 * Best-effort обёртка над Serper (Google search API):
 * нет ключа / non-2xx / timeout / сетевой сбой → []. Дефолт регион ru/ru.
 * Ошибка активного журнала расходов пробрасывается: учёт нельзя молча потерять.
 */
export async function serperSearch(
  query: string,
  opts?: { num?: number; gl?: string; hl?: string; signal?: AbortSignal; timeout?: number },
): Promise<SerperOrganicItem[]> {
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) return [];
  if (opts?.signal?.aborted) return [];
  const metered = getProviderUsageScope() !== undefined;
  const metering = await beginProviderUsage('serper');
  const usage: ProviderUsageDetails = { status: 'ambiguous' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeout ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort(opts?.signal?.reason);
  opts?.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts?.signal?.aborted) onAbort();

  try {
    controller.signal.throwIfAborted();
    const res = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: opts?.num ?? 10, gl: opts?.gl ?? 'ru', hl: opts?.hl ?? 'ru' }),
      signal: controller.signal,
    });
    usage.httpStatus = res.status;
    usage.providerRequestId = res.headers?.get('x-request-id') ?? undefined;
    if (!res.ok) {
      usage.status = 'http_error';
      if (metered) {
        try { usage.serperCredits = reportedCredits(await res.json()); } catch { /* Cost remains unknown. */ }
      }
      return [];
    }
    const data = (await res.json()) as { organic?: SerperOrganicItem[] };
    usage.serperCredits = reportedCredits(data);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      usage.status = 'success';
      const record = data as Record<string, unknown>;
      if (record.error || (typeof record.statusCode === 'number' && record.statusCode >= 400)) usage.status = 'http_error';
    }
    return (data.organic ?? []).filter(
      (it): it is SerperOrganicItem => it != null && typeof it === 'object' && typeof it.link === 'string',
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
    await metering.finish(usage);
  }
}

function reportedCredits(data: unknown): number | undefined {
  const credits = data && typeof data === 'object' ? (data as { credits?: unknown }).credits : undefined;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}
