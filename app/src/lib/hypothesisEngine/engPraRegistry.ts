import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngGleifRegisteredAs, readHeEngRegistryText } from './engRegistryHttp';
import { validLei } from './engRegistryIdentity';

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

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Firm { frn: string; name: string; detail: string; kind: ListFile['kind']; localRegistryId?: string }

function fail(code: string): never { throw new Error(code); }
function clean(raw: string | undefined, max = 500): string {
  return sliceWholeChars(stripUnstorableJsonChars(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max);
}

function readText(url: string, options: Options): Promise<string> {
  return readHeEngRegistryText(url, { ...options, accept: 'text/html,text/csv', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS });
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

// A heading row names a group of firms; a firm row with a missing FRN is not one.
const HEADING = /\b(?:incorporated|authorised|entitled|vehicles|list of)\b/i;

/** Firms under the file's UK heading: a row with only its first cell filled that reads like a heading. */
function ukFirms(text: string, list: ListFile): Firm[] {
  const firms: Firm[] = [];
  let section = '';
  for (const raw of parseCsv(text.replace(/^\uFEFF/, ''))) {
    const cells = raw.map(cell => clean(cell, 1500));
    if (!cells.some(Boolean)) continue;
    if (/^\d{6,7}$/.test(cells[1] ?? '')) {
      if (list.section.test(section) && cells[0]) firms.push({ frn: cells[1], name: clean(cells[0], 300), detail: cells[2] ?? '', kind: list.kind });
    } else if (cells[0] && cells.slice(1).every(cell => !cell) && HEADING.test(cells[0])) section = cells[0];
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
  // Banks and building societies come with their LEI; its GLEIF entry gives the
  // Companies House number their legal pages print («Registered in England No. …»).
  // Without GLEIF the list still works (FRN identity); it is not cached, so the next page asks again.
  const leis = sorted.filter(firm => firm.kind !== 'insurer' && validLei(firm.detail)).map(firm => firm.detail);
  let complete = true;
  if (leis.length) {
    try {
      const registered = await readHeEngGleifRegisteredAs(leis, { ...options, maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS });
      for (const firm of sorted) firm.localRegistryId = registered.get(firm.detail);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      complete = false;
    }
  }
  if (complete) cache.set(category, { at: now, firms: sorted });
  return sorted;
}

function candidate(firm: Firm): HeEngRegistryCandidate {
  const lei = firm.kind !== 'insurer' && validLei(firm.detail) ? `; LEI ${firm.detail}` : '';
  const classes = firm.kind === 'insurer' && firm.detail ? `; classes of business: ${firm.detail}` : '';
  return { provider: 'pra', recordId: firm.frn, company: firm.name, country: 'united kingdom',
    // The list states UK incorporation, not an address; see hasRegistryCountry.
    address: 'United Kingdom', addressKind: 'registered', category: `PRA-authorised ${firm.kind}`,
    ...(firm.localRegistryId ? { localRegistryId: firm.localRegistryId } : {}), website: '', emails: [],
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
