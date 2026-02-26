/**
 * Serper.dev API — поисковая выдача через Google Search API.
 * Используется когда задан SERPER_API_KEY; избавляет от парсинга HTML и блокировок.
 */

import type { SearchResultItem } from './searchScraper';

const SERPER_API_URL = 'https://google.serper.dev/search';

export interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
  sitelinks?: Array<{ title?: string; link?: string }>;
  attributes?: Record<string, unknown>;
}

export interface SerperSearchResponse {
  organic?: SerperOrganicItem[];
  knowledgeGraph?: unknown;
  answerBox?: unknown;
  [key: string]: unknown;
}

export interface SerperSearchDebug {
  request_url: string;
  status: number;
  organic_count: number;
  error?: string;
}

export async function serperSearchDetailed(
  query: string,
  opts?: { num?: number; gl?: string; hl?: string },
): Promise<{
  results: SearchResultItem[];
  debug: SerperSearchDebug;
}> {
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('SERPER_API_KEY is not set');
  }

  const num = Math.min(100, Math.max(10, opts?.num ?? 100));
  const body = {
    q: query,
    num,
    ...(opts?.gl ? { gl: opts.gl } : {}),
    ...(opts?.hl ? { hl: opts.hl } : {}),
  };

  const res = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const debug: SerperSearchDebug = {
    request_url: SERPER_API_URL,
    status: res.status,
    organic_count: 0,
  };

  if (!res.ok) {
    const text = await res.text();
    debug.error = `Serper API ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(debug.error);
  }

  const data = (await res.json()) as SerperSearchResponse;
  const organic = Array.isArray(data.organic) ? data.organic : [];
  debug.organic_count = organic.length;

  const results: SearchResultItem[] = organic
    .filter((item): item is SerperOrganicItem => item != null && typeof item === 'object' && typeof item.link === 'string')
    .map((item, index) => ({
      query,
      title: (String(item.title ?? '').trim() || item.link) ?? '',
      link: String(item.link).trim(),
      snippet: String(item.snippet ?? '').trim(),
      position: typeof item.position === 'number' && item.position > 0 ? item.position : index + 1,
    }));

  return { results, debug };
}
