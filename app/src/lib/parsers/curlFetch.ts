// Shared curl-based HTTP helpers for parser runners (worker-only).
// Some upstreams (Clearbit autocomplete, the Adzuna API) hang or 403 node/undici
// by TLS fingerprint / large-body handling, but respond fine to curl — which is
// installed in the worker image. These helpers shell out to curl.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a URL via curl and JSON-parse the body. Throws on curl error / bad JSON. */
export async function curlJson(
  url: string,
  opts: { timeoutMs?: number; headers?: string[] } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const headers = opts.headers ?? ['Accept: application/json'];
  const args = ['-sS', '--max-time', String(Math.ceil(timeoutMs / 1000))];
  for (const h of headers) args.push('-H', h);
  args.push(url);
  const { stdout } = await execFileP('curl', args, {
    timeout: timeoutMs + 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';

function normName(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Resolve a company domain via Clearbit autocomplete (free, no key). '' if unresolved. */
export async function clearbitDomain(name: string): Promise<string> {
  const url = `${CLEARBIT_SUGGEST}?query=${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const suggestions = (await curlJson(url, { timeoutMs: 15_000 })) as Array<{
        name?: string;
        domain?: string;
      }>;
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        const key = normName(name);
        const exact = suggestions.find((s) => normName(s?.name) === key);
        const domain = String((exact ?? suggestions[0])?.domain ?? '').trim();
        if (domain) return domain;
      }
    } catch {
      /* transient curl/parse failure — retry once */
    }
    if (attempt === 0) await sleep(400);
  }
  return '';
}
