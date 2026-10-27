/**
 * Текст CSV/TXT из байтов файла — для тех мест, где файл любого формата читает SheetJS.
 *
 * SheetJS 0.20 читает CSV без BOM как Windows-1252: русский текст в UTF-8 превращается
 * в «Ð”Ð¾Ð±…». Поэтому текстовый файл декодируем сами и отдаём SheetJS строкой:
 * UTF-8 (с BOM или без), а если байты не UTF-8 — Windows-1251, в которой сохраняет CSV
 * русский Excel. Для xlsx (zip) и старого xls (OLE) возвращает null — их SheetJS
 * читает из байтов сам, кодировка у них внутри файла.
 */
export function decodeTextSpreadsheet(bytes: Uint8Array): string | null {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isZip || isOle) return null;

  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1251').decode(body);
  }
}
