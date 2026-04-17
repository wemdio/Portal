import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';

export type SignalResultRow = {
  row_index: number;
  result_text: string | null;
  status: string;
  last_error?: string | null;
};

export interface ApplySignalsOptions {
  stackColIndex: number;
  profileColIndex: number;
  stackHeader?: string;
  profileHeader?: string;
  /**
   * If true, skip rows that already have non-empty values in either target column.
   * Useful for partial re-runs where the user keeps existing data.
   */
  applyOnlyEmpty?: boolean;
}

type SpreadsheetTab = {
  id: string;
  name: string;
  data: string[][];
};

type SpreadsheetState = {
  version?: number;
  tabs: SpreadsheetTab[];
  activeTabId?: string;
  tabCounter?: number;
  columnWidths?: Record<string, number[]>;
  savedAt?: number;
};

/**
 * Pure function — mutates `tabData` in place.
 *
 * Parses each result_text as JSON {stack, profile} and writes to the two columns.
 * - Failed rows: writes ⚠ + error message to make problems visible.
 * - Invalid JSON: writes empty strings (does not throw).
 * - row_index = 0 (header) and out-of-bounds rows are skipped.
 */
export function applySignalsToTabData(
  tabData: string[][],
  results: SignalResultRow[],
  options: ApplySignalsOptions,
): { applied: number; skipped: number } {
  const { stackColIndex, profileColIndex, stackHeader, profileHeader, applyOnlyEmpty } = options;

  if (tabData.length > 0) {
    const header = tabData[0];
    while (header.length <= profileColIndex) header.push('');
    if (stackHeader && !String(header[stackColIndex] ?? '').trim()) {
      header[stackColIndex] = stackHeader;
    }
    if (profileHeader && !String(header[profileColIndex] ?? '').trim()) {
      header[profileColIndex] = profileHeader;
    }
  }

  let applied = 0;
  let skipped = 0;

  for (const r of results) {
    if (r.row_index <= 0 || r.row_index >= tabData.length) {
      skipped += 1;
      continue;
    }

    const row = tabData[r.row_index];
    while (row.length <= profileColIndex) row.push('');

    if (applyOnlyEmpty) {
      const stackHas = String(row[stackColIndex] ?? '').trim().length > 0;
      const profileHas = String(row[profileColIndex] ?? '').trim().length > 0;
      if (stackHas || profileHas) {
        skipped += 1;
        continue;
      }
    }

    if (r.status === 'completed') {
      const parsed = parseSignalResult(r.result_text);
      row[stackColIndex] = parsed.stack;
      row[profileColIndex] = parsed.profile;
      applied += 1;
    } else {
      row[stackColIndex] = '⚠';
      row[profileColIndex] = r.last_error ?? 'Не удалось обработать сайт';
      applied += 1;
    }
  }

  return { applied, skipped };
}

function parseSignalResult(resultText: string | null): { stack: string; profile: string } {
  if (!resultText) return { stack: '', profile: '' };
  try {
    const parsed = JSON.parse(resultText) as { stack?: unknown; profile?: unknown };
    return {
      stack: typeof parsed.stack === 'string' ? parsed.stack : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
    };
  } catch {
    return { stack: '', profile: '' };
  }
}

/**
 * Server-side: fetch completed signal job results from the queue and apply them
 * to the user's spreadsheet state. Idempotent: re-running with applyOnlyEmpty=true
 * will not overwrite existing values.
 */
export async function applySignalJobResults(
  userId: string,
  jobId: string,
  tabId: string,
  options: ApplySignalsOptions,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  try {
    const results = await fetchAllSignalResults(jobId);
    if (results.length === 0) return true;

    const state = await loadSpreadsheetState(userId);
    if (!state) return false;

    const tabIdx = state.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) {
      await logInfo('spreadsheet.apply.tab_not_found', 'Tab not found for signal results', {
        userId, jobId, tabId,
      });
      return false;
    }

    const tab = state.tabs[tabIdx];
    const summary = applySignalsToTabData(tab.data, results, options);

    state.tabs[tabIdx] = tab;
    state.savedAt = Date.now();

    await saveSpreadsheetState(userId, state);
    await logInfo('spreadsheet.apply.signals_done', `Applied ${summary.applied} signal results`, {
      userId, jobId, tabId, applied: summary.applied, skipped: summary.skipped,
    });

    // Free up storage: delete completed/failed queue rows for this job
    // (results are now in the spreadsheet — keeping queue would duplicate data).
    await purgeSignalQueue(jobId);

    return true;
  } catch (err) {
    await logError('spreadsheet.apply.signals_failed', err, { userId, jobId, tabId });
    return false;
  }
}

async function loadSpreadsheetState(userId: string): Promise<SpreadsheetState | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('database_spreadsheet_states')
    .select('state')
    .eq('user_id', userId)
    .single();
  if (error || !data?.state) return null;
  return typeof data.state === 'string' ? JSON.parse(data.state) : data.state;
}

async function saveSpreadsheetState(userId: string, state: SpreadsheetState): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('database_spreadsheet_states')
    .upsert({
      user_id: userId,
      state,
      updated_at: new Date().toISOString(),
    });
}

async function fetchAllSignalResults(jobId: string): Promise<SignalResultRow[]> {
  if (!supabaseAdmin) return [];
  const all: SignalResultRow[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabaseAdmin
      .from('website_enrichment_queue')
      .select('row_index, result_text, status, last_error')
      .eq('job_id', jobId)
      .in('status', ['completed', 'failed'])
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...(data as SignalResultRow[]));
    page += 1;
  }
  return all;
}

async function purgeSignalQueue(jobId: string): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin
      .from('website_enrichment_queue')
      .delete()
      .eq('job_id', jobId);
  } catch (err) {
    await logError('spreadsheet.apply.signals_purge_failed', err, { jobId });
  }
}
