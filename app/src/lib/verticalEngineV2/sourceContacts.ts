import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractEmails } from '@/lib/tools/dfybUtils';
import { normalizeVeCompanyInn } from './collectionIdentity';
import { fetchVeRelevanceEvidence, veOfficialWebsiteCandidates } from './relevanceEvidence';
import { VeRelevanceCheckpointError } from './relevanceCheckpoint';

type SourceRow = { company: string; website: string; email: string; inn: string; address: string; source_detail: string };
const MAX_SITE_LOOKUPS = 10_000;
const resultSchema = z.object({ website: z.string().max(1000), reason: z.string().max(400) });
const checkpointSchema = z.object({ version: z.literal(1), checked: z.record(z.string(), resultSchema) });
export type VeSourceContactCheckpoint = z.infer<typeof checkpointSchema>;
const keyFor = (row: SourceRow) => createHash('sha256')
  .update(JSON.stringify([row.company, row.website, row.inn, row.address])).digest('hex');

/** Keep the original source auditable. A misplaced email never becomes a URL,
 * and its domain is never assumed to be this company's official website. */
export function normalizeVeSourceContacts<T extends SourceRow>(row: T): T {
  const misplaced = row.website.split(/[\s,;|]+/).flatMap((value) => {
    const candidate = value.replace(/^(?:https?:\/\/|mailto:)/i, '').replace(/\/$/, '').toLowerCase();
    // An address in a URL's query/path may be an unrelated tracking value.
    return extractEmails(candidate).filter((email) => email.toLowerCase() === candidate);
  });
  const email = [...new Set([...extractEmails(row.email), ...misplaced].map((v) => v.toLowerCase()))].join(', ');
  const website = veOfficialWebsiteCandidates(row.website).map((url) => url.href).join(', ');
  return { ...row, email, website, source_detail: row.website && website !== row.website
    ? `${row.source_detail}\nСайт в источнике: ${row.website}` : row.source_detail };
}

function readState(value?: unknown): VeSourceContactCheckpoint {
  if (value === undefined) return { version: 1, checked: {} };
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success) throw new VeRelevanceCheckpointError('Source contact discovery checkpoint is invalid');
  return parsed.data;
}
function eligible(row: SourceRow): boolean {
  return !veOfficialWebsiteCandidates(row.website).length
    && Boolean(normalizeVeCompanyInn(row.inn) || (row.company.trim() && row.address.trim()));
}
export function hasPendingVeSourceContacts(rows: SourceRow[], value?: unknown): boolean {
  return pendingVeSourceContacts(rows, value).length > 0;
}
export function pendingVeSourceContacts<T extends SourceRow>(rows: T[], value?: unknown): T[] {
  const state = readState(value);
  const remaining = Math.max(0, MAX_SITE_LOOKUPS - Object.keys(state.checked).length);
  return remaining ? rows.filter((row) => eligible(row) && !state.checked[keyFor(row)]).slice(0, remaining) : [];
}

export function applyVeSourceContacts<T extends SourceRow>(rows: T[], value?: unknown): T[] {
  const state = readState(value);
  return rows.map((row) => {
    const found = state.checked[keyFor(row)]?.website;
    return normalizeVeSourceContacts(found ? { ...row, website: found,
      source_detail: `${row.source_detail}\nОфициальный сайт подтверждён по данным компании: ${found}` } : row);
  });
}

/** One bounded discovery pass, eight sites at a time. Completed searches are
 * saved before yielding; a missing site is an outcome, never an endless retry.
 * Found websites still pass the constructor's email + relevance gates. */
export async function recoverVeSourceContacts<T extends SourceRow>(input: {
  rows: T[]; state?: unknown; signal?: AbortSignal;
  fetchEvidence?: typeof fetchVeRelevanceEvidence;
  save: (state: VeSourceContactCheckpoint) => Promise<void>;
}): Promise<{ rows: T[]; state: VeSourceContactCheckpoint; waiting: boolean }> {
  const state = readState(input.state);
  const pending = [...new Map(pendingVeSourceContacts(input.rows, state)
    .map((row) => [keyFor(row), row])).values()];
  for (let start = 0; start < Math.min(16, pending.length); start += 8) {
    input.signal?.throwIfAborted();
    // Finish this bounded wave before throwing: paid successful siblings must
    // survive a provider error in another search.
    const results = await Promise.allSettled(pending.slice(start, start + 8).map(async (row) => {
      const evidence = await (input.fetchEvidence ?? fetchVeRelevanceEvidence)('', {
        signal: input.signal, companyInn: row.inn, companyName: row.company, companyAddress: row.address,
      });
      if (evidence.provider_error) throw new Error(evidence.provider_error.message);
      state.checked[keyFor(row)] = { website: evidence.status === 'ok' ? evidence.url : '', reason: evidence.reason.slice(0, 400) };
    }));
    input.signal?.throwIfAborted();
    await input.save(state);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return { state, waiting: hasPendingVeSourceContacts(input.rows, state), rows: applyVeSourceContacts(input.rows, state) };
}
