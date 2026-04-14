import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';

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
 * Server-side: apply completed job results directly into `database_spreadsheet_states`
 * so the user sees them even if the browser was closed during processing.
 */
export async function applyBriefScoringResults(
  userId: string,
  jobId: string,
  tabId: string,
  scoreColIndex: number,
  reasonColIndex: number,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  try {
    const results = await fetchAllScoringResults(jobId);
    if (results.length === 0) return true;

    const state = await loadSpreadsheetState(userId);
    if (!state) return false;

    const tabIdx = state.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) {
      await logInfo('spreadsheet.apply.tab_not_found', 'Tab not found for scoring results', { userId, jobId, tabId });
      return false;
    }

    const tab = state.tabs[tabIdx];
    const header = tab.data[0];

    if (scoreColIndex >= header.length) {
      while (header.length <= reasonColIndex) header.push('');
      header[scoreColIndex] = 'ЦА Балл';
      header[reasonColIndex] = 'ЦА Причина';
    }

    let applied = 0;
    for (const r of results) {
      if (r.row_index > 0 && r.row_index < tab.data.length) {
        const row = tab.data[r.row_index];
        while (row.length <= reasonColIndex) row.push('');
        if (r.status === 'completed') {
          row[scoreColIndex] = r.score != null ? String(r.score) : '?';
          row[reasonColIndex] = r.reason ?? '';
        } else {
          row[scoreColIndex] = '\u26A0';
          row[reasonColIndex] = 'Ошибка AI';
        }
        applied++;
      }
    }

    state.tabs[tabIdx] = tab;
    state.savedAt = Date.now();

    await saveSpreadsheetState(userId, state);
    await logInfo('spreadsheet.apply.scoring_done', `Applied ${applied} scoring results to tab`, {
      userId, jobId, tabId, applied,
    });
    return true;
  } catch (err) {
    await logError('spreadsheet.apply.scoring_failed', err, { userId, jobId, tabId });
    return false;
  }
}

export async function applyEnrichmentResults(
  userId: string,
  jobId: string,
  tabId: string,
  resultColIndex: number,
  resultColHeader?: string,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  try {
    const results = await fetchAllEnrichmentResults(jobId);
    if (results.length === 0) return true;

    const state = await loadSpreadsheetState(userId);
    if (!state) return false;

    const tabIdx = state.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) {
      await logInfo('spreadsheet.apply.tab_not_found', 'Tab not found for enrichment results', { userId, jobId, tabId });
      return false;
    }

    const tab = state.tabs[tabIdx];
    const header = tab.data[0];

    if (resultColIndex >= header.length) {
      while (header.length <= resultColIndex) header.push('');
      header[resultColIndex] = resultColHeader ?? 'Обогащение';
    }

    let applied = 0;
    for (const r of results) {
      if (r.row_index > 0 && r.row_index < tab.data.length && r.result_text) {
        const row = tab.data[r.row_index];
        while (row.length <= resultColIndex) row.push('');
        row[resultColIndex] = r.result_text;
        applied++;
      }
    }

    state.tabs[tabIdx] = tab;
    state.savedAt = Date.now();

    await saveSpreadsheetState(userId, state);
    await logInfo('spreadsheet.apply.enrichment_done', `Applied ${applied} enrichment results to tab`, {
      userId, jobId, tabId, applied,
    });
    return true;
  } catch (err) {
    await logError('spreadsheet.apply.enrichment_failed', err, { userId, jobId, tabId });
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

async function fetchAllScoringResults(jobId: string) {
  if (!supabaseAdmin) return [];
  const all: { row_index: number; score: number | null; reason: string | null; status: string }[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabaseAdmin
      .from('brief_scoring_queue')
      .select('row_index, score, reason, status')
      .eq('job_id', jobId)
      .in('status', ['completed', 'failed'])
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...data);
    page++;
  }
  return all;
}

async function fetchAllEnrichmentResults(jobId: string) {
  if (!supabaseAdmin) return [];
  const all: { row_index: number; result_text: string | null; status: string }[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabaseAdmin
      .from('website_enrichment_queue')
      .select('row_index, result_text, status')
      .eq('job_id', jobId)
      .eq('status', 'completed')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...data);
    page++;
  }
  return all;
}
