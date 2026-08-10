import { StringSession } from 'telegram/sessions';

/**
 * Собрать строку сессии GramJS из адреса DC и ключа авторизации.
 *
 * Расклад — «телетоновский»: dc_id, IP четырьмя байтами, порт, 256 байт ключа.
 * Установленный GramJS выбирает эту ветку разбора по длине строки (352 символа
 * после префикса версии), поэтому менять расклад нельзя: строка перестанет
 * читаться как IP-адрес.
 */
export function buildGramJsSessionString(
  dcId: number,
  serverAddress: string,
  port: number,
  authKey: Uint8Array,
): string {
  const isIPv6 = serverAddress.includes(':');
  const addressBuf = isIPv6
    ? Buffer.from(
        serverAddress.split(':').flatMap((p) => {
          const n = parseInt(p, 16);
          return [(n >> 8) & 255, n & 255];
        }),
      )
    : Buffer.from(serverAddress.split('.').map((p) => parseInt(p, 10)));

  const dcBuf = Buffer.from([dcId]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeInt16BE(port, 0);
  const keyBuf = Buffer.from(authKey);

  const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf.subarray(0, 256)]);
  return '1' + result.toString('base64');
}

/**
 * Read a Telethon/GramJS .session SQLite file and return a StringSession.
 * Avoids gramjs-sqlitesession which is incompatible with newer GramJS versions.
 */
export function readSqliteSession(filePath: string): Promise<StringSession> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite3Module = require('sqlite3') as typeof import('sqlite3');

  return new Promise((resolve, reject) => {
    const db = new sqlite3Module.Database(filePath, sqlite3Module.OPEN_READONLY, (err) => {
      if (err) return reject(err);

      db.get(
        'SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1',
        (err2: Error | null, row?: { dc_id: number; server_address: string; port: number; auth_key: Buffer }) => {
          db.close();
          if (err2) return reject(err2);
          if (!row?.auth_key) return reject(new Error('Пустая сессия в SQLite файле'));

          resolve(
            new StringSession(
              buildGramJsSessionString(row.dc_id, row.server_address, row.port, row.auth_key),
            ),
          );
        },
      );
    });
  });
}

/**
 * Convert a .session SQLite buffer to a GramJS StringSession string.
 * Writes the buffer to a temp file, reads it with readSqliteSession, then cleans up.
 */
export async function sqliteBufferToSessionString(buffer: ArrayBuffer): Promise<string> {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpPath = path.join(os.tmpdir(), `tg-session-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
    const session = await readSqliteSession(tmpPath);
    await session.load();
    return session.save();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
