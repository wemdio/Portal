import type { SpreadsheetTab } from '@/lib/spreadsheet/serverState';

export const WEBSITE_INN_LOOKUP_INN_HEADER = 'ИНН (найден)';
export const WEBSITE_INN_LOOKUP_COMPANY_HEADER = 'Компания (найдена)';

export type WebsiteInnLookupResult = {
  id: string;
  row_index: number;
  url: string;
  status: 'completed' | 'failed';
  inn: string | null;
  company_name: string | null;
  error_message: string | null;
};

export type ApplyWebsiteInnLookupParams = {
  tabId: string;
  urlColumn: number;
  innColumn: number;
  companyColumn: number;
  results: WebsiteInnLookupResult[];
};

export type ApplyWebsiteInnLookupResult = {
  tabs: SpreadsheetTab[];
  applied: number;
  skippedChangedUrl: number;
  skippedMissingRows: number;
  tabFound: boolean;
  unsafeTargetColumns: boolean;
  mutated: boolean;
};

export type WebsiteInnLookupResumeJob = {
  id: string;
  status: string;
  completed_at?: string | null;
  results_applied_at?: string | null;
};

function comparableUrl(value: unknown): string {
  return String(value ?? '').trim();
}

function isSafeResultHeader(current: unknown, expected: string): boolean {
  const value = String(current ?? '').trim();
  return value.length === 0 || value === expected;
}

function emptyApplyResult(
  tabs: SpreadsheetTab[],
  overrides?: Partial<ApplyWebsiteInnLookupResult>,
): ApplyWebsiteInnLookupResult {
  return {
    tabs,
    applied: 0,
    skippedChangedUrl: 0,
    skippedMissingRows: 0,
    tabFound: false,
    unsafeTargetColumns: false,
    mutated: false,
    ...overrides,
  };
}

/**
 * Запуск server job разрешён только после успешной записи актуального
 * spreadsheet snapshot. Иначе пользователь может закрыть вкладку сразу
 * после клика, а worker попытается применить результаты к старой версии.
 */
export async function startWebsiteInnLookupAfterStateSaved<T>(
  saveState: () => Promise<boolean>,
  createJob: () => Promise<T>,
): Promise<T> {
  if (!(await saveState())) {
    throw new Error('Не удалось сохранить базу перед запуском фонового поиска ИНН');
  }
  return createJob();
}

/**
 * Сервер может отметить results_applied_at только если целевая вкладка и
 * строки реально присутствовали, а result-колонки не были переставлены.
 * Изменившийся URL — осознанный пользовательский edit, его пропуск завершён.
 */
export function isWebsiteInnLookupApplyComplete(
  result: ApplyWebsiteInnLookupResult,
): boolean {
  return result.tabFound
    && !result.unsafeTargetColumns
    && result.skippedMissingRows === 0;
}

/**
 * Если job завершился уже после начала hydration текущей страницы, локальный
 * snapshot мог загрузиться за мгновение до финального server apply. Один
 * replay terminal results закрывает эту гонку; старые применённые jobs не
 * трогаем, чтобы не перезаписать более поздние ручные правки.
 */
export function selectWebsiteInnLookupResumeJob<T extends WebsiteInnLookupResumeJob>(params: {
  activeJob: T | null;
  unappliedJob: T | null;
  latestTerminalJob: T | null;
  pageOpenedAt: number;
}): T | null {
  if (params.activeJob) return params.activeJob;
  if (params.unappliedJob) return params.unappliedJob;
  const completedAt = Date.parse(params.latestTerminalJob?.completed_at ?? '');
  return params.latestTerminalJob && Number.isFinite(completedAt) && completedAt >= params.pageOpenedAt
    ? params.latestTerminalJob
    : null;
}

/**
 * Идемпотентно применяет серверные результаты к spreadsheet snapshot.
 *
 * row_index сам по себе недостаточен: пока job работал, пользователь мог
 * заменить или удалить URL в этой строке. Поэтому запись разрешена только
 * когда текущий URL дословно совпадает со snapshot URL из queue item.
 */
export function applyWebsiteInnLookupResultsToTabs(
  tabs: SpreadsheetTab[],
  params: ApplyWebsiteInnLookupParams,
): ApplyWebsiteInnLookupResult {
  const tabIndex = tabs.findIndex((tab) => tab.id === params.tabId);
  if (tabIndex < 0) {
    return emptyApplyResult(tabs);
  }

  const sourceTab = tabs[tabIndex];
  const nextData = sourceTab.data.slice();
  const sourceHeader = nextData[0] ?? [];
  const distinctColumns = new Set([
    params.urlColumn,
    params.innColumn,
    params.companyColumn,
  ]).size === 3;
  const validColumns = [params.urlColumn, params.innColumn, params.companyColumn]
    .every((value) => Number.isInteger(value) && value >= 0);
  const safeTargetColumns = distinctColumns
    && validColumns
    && isSafeResultHeader(sourceHeader[params.innColumn], WEBSITE_INN_LOOKUP_INN_HEADER)
    && isSafeResultHeader(sourceHeader[params.companyColumn], WEBSITE_INN_LOOKUP_COMPANY_HEADER);
  if (!safeTargetColumns) {
    return emptyApplyResult(tabs, { tabFound: true, unsafeTargetColumns: true });
  }

  const nextHeader = sourceHeader.slice();
  const requiredColumn = Math.max(params.innColumn, params.companyColumn);
  while (nextHeader.length <= requiredColumn) nextHeader.push('');

  let mutated = false;
  if (nextHeader[params.innColumn] !== WEBSITE_INN_LOOKUP_INN_HEADER) {
    nextHeader[params.innColumn] = WEBSITE_INN_LOOKUP_INN_HEADER;
    mutated = true;
  }
  if (nextHeader[params.companyColumn] !== WEBSITE_INN_LOOKUP_COMPANY_HEADER) {
    nextHeader[params.companyColumn] = WEBSITE_INN_LOOKUP_COMPANY_HEADER;
    mutated = true;
  }
  if (mutated || nextHeader.length !== sourceHeader.length) nextData[0] = nextHeader;

  let applied = 0;
  let skippedChangedUrl = 0;
  let skippedMissingRows = 0;
  for (const result of params.results) {
    if (!result.inn || result.status !== 'completed') continue;
    if (result.row_index <= 0 || result.row_index >= nextData.length) {
      skippedMissingRows += 1;
      continue;
    }

    const currentRow = nextData[result.row_index];
    if (comparableUrl(currentRow?.[params.urlColumn]) !== comparableUrl(result.url)) {
      skippedChangedUrl += 1;
      continue;
    }

    const nextRow = currentRow.slice();
    while (nextRow.length <= requiredColumn) nextRow.push('');
    const nextCompany = result.company_name ?? '';
    if (
      nextRow[params.innColumn] !== result.inn
      || nextRow[params.companyColumn] !== nextCompany
    ) {
      nextRow[params.innColumn] = result.inn;
      nextRow[params.companyColumn] = nextCompany;
      nextData[result.row_index] = nextRow;
      mutated = true;
    }
    applied += 1;
  }

  if (!mutated) {
    return {
      tabs,
      applied,
      skippedChangedUrl,
      skippedMissingRows,
      tabFound: true,
      unsafeTargetColumns: false,
      mutated: false,
    };
  }

  const nextTabs = tabs.slice();
  nextTabs[tabIndex] = { ...sourceTab, data: nextData };
  return {
    tabs: nextTabs,
    applied,
    skippedChangedUrl,
    skippedMissingRows,
    tabFound: true,
    unsafeTargetColumns: false,
    mutated: true,
  };
}
