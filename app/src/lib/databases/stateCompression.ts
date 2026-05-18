/**
 * Сжатие состояния инструмента «Работа с базами» перед отправкой в БД.
 *
 * Состояние всех вкладок — один JSON, у активных пользователей до 30 МБ.
 * Без сжатия он писался/читался десятками секунд, и большие базы
 * (~32k строк) терялись (см. миграцию 20260518_0001). gzip даёт ~8x:
 * 30 МБ JSON → ~3-4 МБ; base64 для транспорта в JSON-теле добавляет
 * ~33% → ~4-5 МБ. Итого в 6-8 раз меньше.
 *
 * CompressionStream / DecompressionStream — нативные Web API, доступны
 * во всех актуальных браузерах (и в Web Worker'е).
 */

// Чанк для base64: spread большого Uint8Array в String.fromCharCode
// переполняет стек, поэтому кодируем порциями.
const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** JSON-строка состояния → gzip → base64 (для колонки state_compressed). */
export async function compressStateToBase64(json: string): Promise<string> {
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

/** base64 из state_compressed → gunzip → исходная JSON-строка состояния. */
export async function decompressStateFromBase64(b64: string): Promise<string> {
  const bytes = base64ToBytes(b64);
  const stream = new Blob([bytes.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
