import 'server-only';

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
 * Best-effort обёртка над Serper (Google search API). Никогда не throw'ит:
 * нет ключа / non-2xx / timeout / сетевой сбой → []. Дефолт регион ru/ru.
 */
export async function serperSearch(
  query: string,
  opts?: { num?: number; gl?: string; hl?: string; signal?: AbortSignal; timeout?: number },
): Promise<SerperOrganicItem[]> {
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeout ?? DEFAULT_TIMEOUT_MS);
  if (opts?.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: opts?.num ?? 10, gl: opts?.gl ?? 'ru', hl: opts?.hl ?? 'ru' }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { organic?: SerperOrganicItem[] };
    return (data.organic ?? []).filter(
      (it): it is SerperOrganicItem => it != null && typeof it === 'object' && typeof it.link === 'string',
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
