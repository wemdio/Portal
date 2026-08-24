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
  mutated: boolean;
};

function comparableUrl(value: unknown): string {
  return String(value ?? '').trim();
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
    return { tabs, applied: 0, skippedChangedUrl: 0, mutated: false };
  }

  const sourceTab = tabs[tabIndex];
  const nextData = sourceTab.data.slice();
  const sourceHeader = nextData[0] ?? [];
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
  for (const result of params.results) {
    if (!result.inn || result.status !== 'completed') continue;
    if (result.row_index <= 0 || result.row_index >= nextData.length) continue;

    const currentRow = nextData[result.row_index];
    if (comparableUrl(currentRow?.[params.urlColumn]) !== comparableUrl(result.url)) {
      skippedChangedUrl += 1;
      continue;
    }

    const nextRow = currentRow.slice();
    while (nextRow.length <= requiredColumn) nextRow.push('');
    nextRow[params.innColumn] = result.inn;
    if (result.company_name != null) nextRow[params.companyColumn] = result.company_name;
    nextData[result.row_index] = nextRow;
    applied += 1;
    mutated = true;
  }

  if (!mutated) {
    return { tabs, applied, skippedChangedUrl, mutated: false };
  }

  const nextTabs = tabs.slice();
  nextTabs[tabIndex] = { ...sourceTab, data: nextData };
  return { tabs: nextTabs, applied, skippedChangedUrl, mutated: true };
}
