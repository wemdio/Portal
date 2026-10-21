import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { deriveDomain } from './hhAutoParser';

const PAGE_SIZE = 500;
type HistoryRow = { id: string | number; domain?: string | null };
type PageResult = { data: unknown; error: { message: string } | null };

/** Keyset pagination also works when PostgREST returns less than our requested page size. */
async function readHistoryPages<T extends HistoryRow>(
  label: string,
  loadPage: (cursor: string | null) => PromiseLike<PageResult>,
  consume: (row: T) => void,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const { data, error } = await loadPage(cursor);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`Invalid ${label} page`);
    if (data.length === 0) return;
    const rows = data as T[];
    const lastId = rows[rows.length - 1]?.id;
    if (lastId === null || lastId === undefined || String(lastId) === cursor) {
      throw new Error(`Non-advancing ${label} cursor`);
    }
    for (const row of rows) consume(row);
    cursor = String(lastId);
  }
}

export async function loadSeenEmployerIds(clientUserId: string): Promise<Set<string>> {
  const db = supabaseAdmin;
  if (!db) throw new Error('supabaseAdmin not initialized');
  const seen = new Set<string>();
  await readHistoryPages<HistoryRow & { hh_employer_id: string }>('seen employer ids', (cursor) => {
    const query = db.from('client_auto_pipeline_seen_employers')
      .select('id, hh_employer_id').eq('client_user_id', clientUserId)
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    return cursor === null ? query : query.gt('id', cursor);
  }, (row) => { if (row.hh_employer_id) seen.add(row.hh_employer_id); });
  return seen;
}

/**
 * Enrichment history, not just the mutable seen table. Score-only cache/large-file
 * results remain eligible: they have not yet had their emails discovered/validated.
 * A failed history read aborts selection instead of silently returning a partial set.
 */
export async function loadSeenDomains(
  clientUserId: string,
  seenBobEmployerIds?: Set<string>,
): Promise<Set<string>> {
  const db = supabaseAdmin;
  if (!db) throw new Error('supabaseAdmin not initialized');
  const seen = new Set<string>();
  const addDomain = (row: HistoryRow) => {
    const domain = deriveDomain(row.domain ?? null);
    if (domain) seen.add(domain);
  };

  await readHistoryPages<HistoryRow & { hh_employer_id: string }>('seen domains', (cursor) => {
    const query = db.from('client_auto_pipeline_seen_employers')
      .select('id, domain, hh_employer_id').eq('client_user_id', clientUserId)
      // Preserve the existing rule: dry-run domains do not consume the reserve.
      .neq('status', 'dry_run')
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    return cursor === null ? query : query.gt('id', cursor);
  }, (row) => {
    addDomain(row);
    if (row.hh_employer_id?.startsWith('bob:')) seenBobEmployerIds?.add(row.hh_employer_id);
  });

  // Include pending rows as well: an independently queued manual run owns them.
  await readHistoryPages('manual enrichment domains', (cursor) => {
    const query = db.from('client_manual_score_rows')
      .select('id, domain, client_manual_score_runs!inner(client_user_id)')
      .eq('client_manual_score_runs.client_user_id', clientUserId)
      .not('domain', 'is', null).order('id', { ascending: true }).limit(PAGE_SIZE);
    return cursor === null ? query : query.gt('id', cursor);
  }, addDomain);

  const dryRunIds = new Set<string>();
  await readHistoryPages('dry-run identities', (cursor) => {
    const query = db.from('client_auto_pipeline_runs')
      .select('id').eq('client_user_id', clientUserId).eq('was_dry_run', true)
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    return cursor === null ? query : query.gt('id', cursor);
  }, (row) => { dryRunIds.add(String(row.id)); });

  await readHistoryPages<HistoryRow & {
    source_kind: string; source_run_id: string | null; source_row_id: string | null;
  }>(
    'durable enrichment domains',
    (cursor) => {
      const query = db.from('client_pipeline_domain_snapshots')
        .select('id, domain, source_kind, source_run_id, source_row_id').eq('client_user_id', clientUserId)
        .in('source_kind', ['auto_pipeline', 'manual_scoring'])
        .order('id', { ascending: true }).limit(PAGE_SIZE);
      return cursor === null ? query : query.gt('id', cursor);
    },
    (row) => {
      if (row.source_kind === 'auto_pipeline' && row.source_run_id && dryRunIds.has(row.source_run_id)) return;
      addDomain(row);
      if (row.source_kind === 'auto_pipeline' && row.source_row_id?.startsWith('bob:')) {
        seenBobEmployerIds?.add(row.source_row_id);
      }
    },
  );

  // Retain provider-independent contact history even after source-row retention.
  await readHistoryPages('campaign contact domains', (cursor) => {
    const query = db.from('client_campaign_contact_ledger')
      .select('id, domain').eq('client_user_id', clientUserId).not('domain', 'is', null)
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    return cursor === null ? query : query.gt('id', cursor);
  }, addDomain);
  return seen;
}
