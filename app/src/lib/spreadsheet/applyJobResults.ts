import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo } from '@/lib/loggerServer';
import {
  loadCompressedState,
  saveCompressedStateWithCas,
  type SpreadsheetState,
} from './serverState';
import {
  applyWebsiteInnLookupResultsToTabs,
  isWebsiteInnLookupApplyComplete,
  type ApplyWebsiteInnLookupResult,
  type WebsiteInnLookupResult,
} from '@/lib/enrich/websiteInnLookupShared';

/**
 * Server-side apply for completed/in-progress job results.
 *
 * Идемпотентность: каждый apply делает full load → modify → save (CAS).
 * Повторный вызов с тем же набором results перезатрёт ячейки теми же
 * значениями — это OK, никакого drift'а.
 *
 * Race-protection: `saveCompressedStateWithCas` атомарно проверяет что
 * `updated_at` строки не изменился с момента load'а. Если юзер параллельно
 * успел писнуть через frontend backgroundSave — наш save no-op'ится,
 * apply возвращает true (для caller это не ошибка, frontend сам сохранит
 * результаты через свой polling). На следующем периодическом тике worker
 * попробует ещё раз с новыми данными.
 *
 * До правки 27 мая обе функции читали колонку `state` (несжатую), которая
 * у юзеров после миграции state_compressed (20260518_0001) всегда NULL.
 * Это значило что серверный apply молчаливо не делал ничего — никто
 * не замечал, потому что frontend polling в active-сценарии успешно
 * подтягивал данные. Поломалось когда polling Оли завис → не было safety
 * net'а на сервере. Сейчас фикс state_compressed восстанавливает оба пути.
 */

/** Сколько раз retry'ить apply при CAS-conflict (frontend параллельно писал). */
const MAX_CAS_RETRIES = 2;

export async function applyBriefScoringResults(
  userId: string,
  jobId: string,
  tabId: string,
  scoreColIndex: number,
  reasonColIndex: number,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  return runApplyWithCasRetry('scoring', userId, jobId, tabId, async (state) => {
    const results = await fetchAllScoringResults(jobId);
    if (results.length === 0) return { applied: 0, mutated: false };

    const tabIdx = state.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) {
      await logInfo('spreadsheet.apply.tab_not_found', 'Tab not found for scoring results', { userId, jobId, tabId });
      return { applied: 0, mutated: false };
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
          row[scoreColIndex] = '⚠';
          row[reasonColIndex] = 'Ошибка AI';
        }
        applied++;
      }
    }
    state.tabs[tabIdx] = tab;
    return { applied, mutated: applied > 0 };
  });
}

export async function applyEnrichmentResults(
  userId: string,
  jobId: string,
  tabId: string,
  resultColIndex: number,
  resultColHeader?: string,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  return runApplyWithCasRetry('enrichment', userId, jobId, tabId, async (state) => {
    const results = await fetchAllEnrichmentResults(jobId);
    if (results.length === 0) return { applied: 0, mutated: false };

    const tabIdx = state.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) {
      await logInfo('spreadsheet.apply.tab_not_found', 'Tab not found for enrichment results', { userId, jobId, tabId });
      return { applied: 0, mutated: false };
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
        // Idempotent: повторный apply того же result_text перезапишет тем же
        // значением. НЕ перезаписываем непустые ячейки если result_text пуст —
        // защита от затирания юзеровских правок (если он ввёл вручную email).
        row[resultColIndex] = r.result_text;
        applied++;
      }
    }
    state.tabs[tabIdx] = tab;
    return { applied, mutated: applied > 0 };
  });
}

export async function applyWebsiteInnLookupResults(
  userId: string,
  jobId: string,
  tabId: string,
  urlColumn: number,
  innColumn: number,
  companyColumn: number,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  let latestApply: ApplyWebsiteInnLookupResult | null = null;
  const saved = await runApplyWithCasRetry('website_inn_lookup', userId, jobId, tabId, async (state) => {
    const results = await fetchAllWebsiteInnLookupResults(jobId);
    const applied = applyWebsiteInnLookupResultsToTabs(state.tabs, {
      tabId,
      urlColumn,
      innColumn,
      companyColumn,
      results,
    });
    latestApply = applied;
    if (applied.mutated) state.tabs = applied.tabs;
    return {
      applied: applied.applied,
      mutated: applied.mutated,
    };
  });
  // runApplyWithCasRetry считает корректный no-op успехом. Для website lookup
  // это безопасно только когда вкладка/строки присутствуют и целевые колонки
  // не были переставлены. Иначе results_applied_at должен остаться пустым,
  // чтобы браузер или следующий reconciliation смог повторить применение.
  return saved && latestApply !== null && isWebsiteInnLookupApplyComplete(latestApply);
}

/**
 * Generic wrapper: load → mutate → save with CAS retry.
 *
 * Если CAS conflict — frontend параллельно писнул, нашу мутацию отбрасываем,
 * читаем свежий state и пробуем заново. Retry'имся до MAX_CAS_RETRIES раз,
 * после чего сдаёмся (на следующем периодическом тике попробуем ещё).
 */
export async function runApplyWithCasRetry(
  label: string,
  userId: string,
  jobId: string,
  tabId: string,
  mutator: (state: SpreadsheetState) => Promise<{ applied: number; mutated: boolean }>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_CAS_RETRIES + 1; attempt += 1) {
    try {
      const loaded = await loadCompressedState(userId);
      if (!loaded) {
        if (attempt === 1) {
          await logInfo(`spreadsheet.apply.${label}.no_state`, 'No spreadsheet state for user', {
            userId, jobId, tabId,
          });
        }
        return false;
      }
      const { state, loadedUpdatedAt } = loaded;
      const mutation = await mutator(state);
      if (!mutation.mutated) {
        // Нечего сохранять — apply прошёл вхолостую, это OK.
        return true;
      }
      state.savedAt = Date.now();
      const result = await saveCompressedStateWithCas(userId, state, loadedUpdatedAt);
      if (result.ok) {
        await logInfo(`spreadsheet.apply.${label}.done`, `Applied ${mutation.applied} results to tab`, {
          userId, jobId, tabId, applied: mutation.applied, attempt,
        });
        return true;
      }
      if (result.reason === 'conflict' && attempt <= MAX_CAS_RETRIES) {
        // Frontend параллельно писнул — load freshest state и retry.
        await logInfo(`spreadsheet.apply.${label}.cas_retry`, 'CAS conflict, retrying', {
          userId, jobId, tabId, attempt,
        });
        continue;
      }
      // not_found / persistent conflict / error.
      await logInfo(`spreadsheet.apply.${label}.skipped`, `Skipped after attempt ${attempt}`, {
        userId, jobId, tabId, reason: result.reason, details: result.details,
      });
      return false;
    } catch (err) {
      await logError(`spreadsheet.apply.${label}.failed`, err, { userId, jobId, tabId, attempt });
      return false;
    }
  }
  return false;
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

async function fetchAllWebsiteInnLookupResults(jobId: string): Promise<WebsiteInnLookupResult[]> {
  if (!supabaseAdmin) return [];
  const all: WebsiteInnLookupResult[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabaseAdmin
      .from('website_inn_lookup_items')
      .select('id, row_index, url, status, inn, company_name, error_message')
      .eq('job_id', jobId)
      .in('status', ['completed', 'failed'])
      .order('row_index', { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...(data as WebsiteInnLookupResult[]));
    page += 1;
  }
  return all;
}
