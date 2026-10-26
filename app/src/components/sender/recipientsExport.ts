import { fetchRecipientsExportChunk } from './api';

/** Всю базу кампании таблицей (заголовок + строки), кусками — с прогрессом. */
export async function loadCampaignTable(
  campaignId: string,
  onProgress: (done: number, total: number) => void,
): Promise<string[][]> {
  const all: { email: string; name: string; vars: Record<string, string> }[] = [];
  let total = 0;
  for (;;) {
    const chunk = await fetchRecipientsExportChunk(campaignId, all.length);
    total = chunk.total;
    all.push(...chunk.rows);
    onProgress(all.length, total);
    if (chunk.rows.length === 0 || all.length >= total) break;
  }
  const hasName = all.some((row) => row.name);
  const keys: string[] = [];
  const seen = new Set<string>(['email']);
  for (const row of all) {
    for (const key of Object.keys(row.vars)) {
      if (!seen.has(key.toLowerCase())) {
        seen.add(key.toLowerCase());
        keys.push(key);
      }
    }
  }
  const header = ['email', ...(hasName ? ['name'] : []), ...keys];
  const body = all.map((row) => [
    row.email,
    ...(hasName ? [row.name] : []),
    ...keys.map((key) => String(row.vars[key] ?? '')),
  ]);
  return [header, ...body];
}

function csvCell(value: string): string {
  return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV с BOM — Excel открывает кириллицу без танцев. */
export function tableToCsv(table: string[][]): string {
  return `﻿${table.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function downloadCsv(table: string[][], fileName: string): void {
  const url = URL.createObjectURL(new Blob([tableToCsv(table)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
