import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';

/**
 * The Bank of England's lists of PRA-authorised insurers, banks and building
 * societies: official, keyless CSV files refreshed monthly and linked from one
 * fixed page. Unlike a register searched by activity code, every firm on them
 * is licensed for the activity, so a name such as «AAA Underwriting» is a real
 * insurer, not an empty Lloyd's vehicle. Only firms incorporated in the UK are
 * read; branches of foreign firms belong to their own countries.
 *
 * A row is a name and the FCA firm reference number (FRN), no address, website
 * or headcount. The website is found and proven like any registry company:
 * UK-regulated firms state their FRN on their own site («Firm Reference Number
 * 202153»), which engRegistryCompanyEvidence.ts reads as the identity number.
 * The FCA register itself needs a personal API key and is not used here.
 */
const ORIGIN = 'https://www.bankofengland.co.uk';
const LISTING = `${ORIGIN}/prudential-regulation/authorisations/which-firms-does-the-pra-regulate`;
const LIST_PATH = '/-/media/boe/files/prudential-regulation/authorisations/which-firms-does-the-pra-regulate/';
interface ListFile { file: string; section: RegExp; kind: 'insurer' | 'bank' | 'building society' }
// The UK section heading of each file; other sections are branches of foreign firms.
const FILES: Readonly<Record<string, readonly ListFile[]>> = {
  insurers: [{ file: 'insurers-list', section: /^Insurers incorporated in the UK\b/i, kind: 'insurer' }],
  banks: [
    { file: 'banks-list', section: /^Banks incorporated in the UK\b/i, kind: 'bank' },
    { file: 'building-societies-list', section: /^Building Societies incorporated in the UK\b/i, kind: 'building society' },
  ],
};
const PAGE_SIZE = 25;
const MAX_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
// The files change once a month; one collection reads every page of a list.
const CACHE_MS = 6 * 60 * 60_000;
// A list this short means the file layout changed, not that the UK lost its banks.
const MIN_FIRMS = 10;
const HEADERS = { Accept: 'text/html,text/csv', 'User-Agent': 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)' };

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Firm { frn: string; name: string; detail: string; kind: ListFile['kind'] }

function fail(code: string): never { throw new Error(code); }
function clean(raw: string | undefined, max = 500): string {
  return sliceWholeChars(stripUnstorableJsonChars(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max);
}

/** Same rules as the JSON registries: fixed host, no redirects, bounded size and time. */
async function readText(url: string, options: Options): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) fail('registry_aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(url, { method: 'GET', headers: HEADERS, redirect: 'error', signal: controller.signal });
    if (!response.ok) fail(`registry_http_${response.status}`);
    if (!response.body) fail('registry_invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); fail('registry_response_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (options.signal?.aborted) return fail('registry_aborted');
    if (controller.signal.aborted) return fail('registry_timeout');
    if (error instanceof Error && /^registry_[a-z0-9_]+$/.test(error.message)) throw error;
    return fail('registry_network_error');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

/** The newest monthly file linked from the listing page («insurers-list-2610.csv» is October 2026). */
function latestFile(html: string, file: string): string {
  const folder = LIST_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let best: { path: string; month: string } | null = null;
  for (const match of html.matchAll(new RegExp(`href="(${folder}(\\d{4})/${file}-(\\d{4})\\.csv)"`, 'g'))) {
    const month = `${match[3]}${match[2]}`;
    if (!best || month > best.month) best = { path: match[1], month };
  }
  return best ? `${ORIGIN}${best.path}` : fail('registry_invalid_response');
}

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Firms under the file's UK heading; a heading is a row with only its first cell filled. */
function ukFirms(text: string, list: ListFile): Firm[] {
  const firms: Firm[] = [];
  let section = '';
  for (const raw of parseCsv(text.replace(/^﻿/, ''))) {
    const cells = raw.map(cell => clean(cell, 1500));
    if (!cells.some(Boolean)) continue;
    if (/^\d{6,7}$/.test(cells[1] ?? '')) {
      if (list.section.test(section) && cells[0]) firms.push({ frn: cells[1], name: clean(cells[0], 300), detail: cells[2] ?? '', kind: list.kind });
    } else if (cells[0] && cells.slice(1).every(cell => !cell)) section = cells[0];
  }
  return firms;
}

const cache = new Map<string, { at: number; firms: Firm[] }>();
async function categoryFirms(category: string, options: Options): Promise<Firm[]> {
  const lists = FILES[category];
  if (!lists) fail('registry_invalid_task');
  const now = (options.now ?? Date.now)();
  const cached = cache.get(category);
  if (cached && now - cached.at < CACHE_MS) return cached.firms;
  const listing = await readText(LISTING, options);
  const firms = new Map<string, Firm>();
  for (const list of lists) {
    for (const firm of ukFirms(await readText(latestFile(listing, list.file), options), list)) if (!firms.has(firm.frn)) firms.set(firm.frn, firm);
  }
  // FRN order keeps a page boundary stable while the month's file stays the same.
  const sorted = [...firms.values()].sort((a, b) => Number(a.frn) - Number(b.frn));
  if (sorted.length < MIN_FIRMS) fail('registry_invalid_response');
  cache.set(category, { at: now, firms: sorted });
  return sorted;
}

function candidate(firm: Firm): HeEngRegistryCandidate {
  const lei = firm.kind !== 'insurer' && /^[A-Z0-9]{18}\d{2}$/.test(firm.detail) ? `; LEI ${firm.detail}` : '';
  const classes = firm.kind === 'insurer' && firm.detail ? `; classes of business: ${firm.detail}` : '';
  return { provider: 'pra', recordId: firm.frn, company: firm.name, country: 'united kingdom',
    // The list states UK incorporation, not an address; see hasRegistryCountry.
    address: 'United Kingdom', addressKind: 'registered', category: `PRA-authorised ${firm.kind}`, website: '', emails: [],
    description: clean(`${firm.kind === 'insurer' ? 'An insurer' : `A ${firm.kind}`} incorporated in the UK and authorised by the Prudential Regulation Authority (firm reference number ${firm.frn})${classes}${lei}. From the Bank of England list of PRA-regulated firms; website, employee count and services require verification.`, 1500),
    sourceUrl: `https://register.fca.org.uk/s/search?q=${firm.frn}&type=Companies` };
}

/** One 25-firm page of a PRA list; the caller validates the task and the position. */
export async function readHeEngPraRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'pra' || task.country !== 'united kingdom') fail('registry_invalid_task');
  const firms = await categoryFirms(task.category, options);
  const page = firms.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= firms.length, excluded: {}, recordsRead: page.length };
}
