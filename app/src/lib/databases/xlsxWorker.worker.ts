import * as XLSX from 'xlsx';

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const buffer = e.data;
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null | undefined)[]>(sheet, {
      header: 1,
      raw: false,
      blankrows: true,
    });
    const normalized = rows.map((row) =>
      row.map((cell) => `${cell ?? ''}`),
    );
    (self as unknown as Worker).postMessage({ ok: true, rows: normalized });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
