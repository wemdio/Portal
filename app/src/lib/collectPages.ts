export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function collectPages<T>(
  loadPage: (from: number, to: number) => Promise<PageResult<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const page = await loadPage(from, from + pageSize - 1);
    if (page.error) throw new Error(page.error.message);
    const pageRows = page.data ?? [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
    from += pageSize;
  }
}
