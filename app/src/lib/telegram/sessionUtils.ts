import { StringSession } from 'telegram/sessions';

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

          const isIPv6 = row.server_address.includes(':');
          const addressBuf = isIPv6
            ? Buffer.from(
                row.server_address.split(':').flatMap((p) => {
                  const n = parseInt(p, 16);
                  return [(n >> 8) & 255, n & 255];
                }),
              )
            : Buffer.from(row.server_address.split('.').map((p) => parseInt(p, 10)));

          const dcBuf = Buffer.from([row.dc_id]);
          const portBuf = Buffer.alloc(2);
          portBuf.writeInt16BE(row.port, 0);
          const keyBuf = Buffer.isBuffer(row.auth_key) ? row.auth_key : Buffer.from(row.auth_key);

          const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf.subarray(0, 256)]);
          resolve(new StringSession('1' + result.toString('base64')));
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
    return session.save();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
