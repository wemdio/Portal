import 'server-only';
import { serperSearch, hasSerperKey } from '@/lib/search/serperClient';
import { filterSocialUrls } from '@/lib/enrich/extractors/socialMediaExtractor';
import { domainRoot } from '@/lib/enrich/extractors/deriveCompanyName';

const MAX_QUERIES = 4;
const VERIFY_TIMEOUT_MS = 6_000;

/**
 * Найти официальные каналы компании (Telegram/VK) через Google/Serper, когда
 * на сайте соцсетей нет. Возвращает только релевантные (имя/домен встречаются
 * в выдаче), прошедшие общий фильтр (боты/личные/потолки) и достижимые (HEAD).
 * Best-effort: нет ключа / сбой → []. Никогда не throw'ит.
 */
export async function findCompanySocials(
  companyName: string,
  domain: string,
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  if (!hasSerperKey()) return [];
  const name = (companyName ?? '').trim();
  const root = domainRoot(domain ?? '');
  if (!name && !root) return [];

  const queries = buildQueries(name, root).slice(0, MAX_QUERIES);
  const candidates: string[] = [];
  for (const q of queries) {
    if (opts?.signal?.aborted) break;
    const items = await serperSearch(q, { num: 10, signal: opts?.signal });
    for (const it of items) {
      const link = (it.link ?? '').trim();
      if (link && matchesCompany(it, name, root)) candidates.push(link);
    }
  }

  const filtered = filterSocialUrls(candidates);
  const verified: string[] = [];
  for (const url of filtered) {
    if (opts?.signal?.aborted) break;
    if (await verifyReachable(url, opts?.signal)) verified.push(url);
  }
  return verified;
}

function buildQueries(name: string, root: string): string[] {
  const q: string[] = [];
  if (name) { q.push(`site:t.me ${name}`); q.push(`site:vk.com ${name}`); }
  if (root) { q.push(`site:t.me ${root}`); q.push(`site:vk.com ${root}`); }
  return Array.from(new Set(q));
}

function matchesCompany(
  it: { title?: string; snippet?: string; link?: string },
  name: string,
  root: string,
): boolean {
  const text = `${it.title ?? ''} ${it.snippet ?? ''} ${it.link ?? ''}`.toLowerCase();
  if (root.length >= 3 && text.includes(root.toLowerCase())) return true;
  const tokens = name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  return tokens.some((t) => text.includes(t));
}

async function verifyReachable(url: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
