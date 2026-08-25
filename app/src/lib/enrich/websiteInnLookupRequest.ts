export const WEBSITE_INN_LOOKUP_MAX_ITEMS = 50_000;
export const WEBSITE_INN_LOOKUP_MAX_COLUMN_INDEX = 10_000;
export const WEBSITE_INN_LOOKUP_MAX_URL_LENGTH = 4_096;

export type WebsiteInnLookupCreateItem = { rowIndex?: number; url?: string };
export type WebsiteInnLookupCreateBody = {
  tabId?: string;
  urlColumn?: number;
  innColumn?: number;
  companyColumn?: number;
  items?: WebsiteInnLookupCreateItem[];
};

export type ValidWebsiteInnLookupCreateBody = {
  tabId: string;
  urlColumn: number;
  innColumn: number;
  companyColumn: number;
  items: Array<{ row_index: number; url: string }>;
};

export type WebsiteInnLookupValidationResult =
  | { ok: true; value: ValidWebsiteInnLookupCreateBody }
  | { ok: false; error: string };

export function validateWebsiteInnLookupCreateBody(
  body: WebsiteInnLookupCreateBody,
): WebsiteInnLookupValidationResult {
  const tabId = typeof body.tabId === 'string' ? body.tabId.trim() : '';
  const columns = [body.urlColumn, body.innColumn, body.companyColumn];
  if (
    !tabId
    || tabId.length > 500
    || columns.some((value) => (
      !Number.isInteger(value)
      || Number(value) < 0
      || Number(value) > WEBSITE_INN_LOOKUP_MAX_COLUMN_INDEX
    ))
    || new Set(columns).size !== columns.length
  ) {
    return { ok: false, error: 'Некорректная вкладка или колонки' };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, error: 'Нет сайтов для обработки' };
  }
  if (body.items.length > WEBSITE_INN_LOOKUP_MAX_ITEMS) {
    return {
      ok: false,
      error: `Максимум ${WEBSITE_INN_LOOKUP_MAX_ITEMS} сайтов за один запуск`,
    };
  }

  const seenRows = new Set<number>();
  const items: Array<{ row_index: number; url: string }> = [];
  for (const raw of body.items) {
    const rowIndex = Number(raw.rowIndex);
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (
      !Number.isInteger(rowIndex)
      || rowIndex <= 0
      || rowIndex > 2_147_483_647
      || !url
      || url.length > WEBSITE_INN_LOOKUP_MAX_URL_LENGTH
      || seenRows.has(rowIndex)
    ) {
      return { ok: false, error: 'Некорректный список сайтов' };
    }
    seenRows.add(rowIndex);
    items.push({ row_index: rowIndex, url });
  }

  return {
    ok: true,
    value: {
      tabId,
      urlColumn: Number(body.urlColumn),
      innColumn: Number(body.innColumn),
      companyColumn: Number(body.companyColumn),
      items,
    },
  };
}
