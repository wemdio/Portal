/** Письмо без отступов от генерации/вставки; абзацы и пробелы внутри строк сохраняются. */
export function normalizeReplyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimStart()).join('\n').trim();
}
