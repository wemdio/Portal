import { readXlsxRows } from '@/lib/spreadsheet/parseCSV';

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const buffer = e.data;
    void readXlsxRows(buffer).then((rows) => {
      (self as unknown as Worker).postMessage({ ok: true, rows });
    }).catch((err) => {
      (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
    });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
