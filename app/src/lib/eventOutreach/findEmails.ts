/**
 * Email resolution: scrape the company website when one exists, otherwise
 * fall back to the registry email. Registry coverage is far higher than
 * website coverage (~60% vs ~22%), so the fallback is what makes most of
 * the shortlist reachable at all.
 */

import { scrapeEmails } from '@/lib/enrich/emailScraper';
import type { EmailSource } from './types';

const SCRAPE_TIMEOUT = 12_000;
const SCRAPE_MAX_PAGES = 6;
const CONCURRENCY = 6;

const JUNK_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'postmaster', 'hostmaster', 'abuse', 'bounce', 'spam', 'webmaster',
];

const PLACEHOLDER = new Set([
  'your@email.com', 'name@example.com', 'email@domain.com', 'test@test.com',
  'user@example.com', 'example@example.com', 'mail@example.com',
]);

function isJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (PLACEHOLDER.has(lower)) return true;
  const local = lower.split('@')[0] ?? '';
  return JUNK_PREFIXES.some((p) => local === p || local.startsWith(`${p}+`));
}

/** Picks the first usable address from a comma/semicolon-separated registry field. */
function pickRegistryEmail(raw: string | null): string | null {
  if (!raw) return null;
  for (const part of raw.split(/[,;\s]+/)) {
    const candidate = part.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(candidate) && !isJunkEmail(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface EmailInput {
  id: string;
  website: string | null;
  registryEmail: string | null;
}

export interface EmailResult {
  id: string;
  email: string | null;
  source: EmailSource;
}

async function resolveOne(input: EmailInput): Promise<EmailResult> {
  if (input.website) {
    try {
      const result = await scrapeEmails(input.website, {
        timeout: SCRAPE_TIMEOUT,
        maxPages: SCRAPE_MAX_PAGES,
      });
      const usable = (result.emails ?? []).map((e) => e.toLowerCase()).filter((e) => !isJunkEmail(e));
      if (usable.length > 0) {
        return { id: input.id, email: usable[0], source: 'scraped' };
      }
    } catch {
      /* fall through to registry */
    }
  }

  const registry = pickRegistryEmail(input.registryEmail);
  if (registry) return { id: input.id, email: registry, source: 'registry' };

  return { id: input.id, email: null, source: 'none' };
}

/** Resolves an email for every company, scraping in bounded-concurrency batches. */
export async function resolveEmails(inputs: EmailInput[]): Promise<EmailResult[]> {
  const results: EmailResult[] = [];

  for (let i = 0; i < inputs.length; i += CONCURRENCY) {
    const batch = inputs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(resolveOne));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ id: batch[j].id, email: null, source: 'none' });
      }
    }
  }

  return results;
}
