import { createHash } from 'node:crypto';
import { StringSession } from 'telegram/sessions';

/**
 * Собрать строку сессии GramJS из адреса DC и ключа авторизации.
 *
 * Расклад — «телетоновский»: dc_id, IP четырьмя байтами, порт, 256 байт ключа.
 * Установленный GramJS выбирает эту ветку разбора по длине строки (352 символа
 * после префикса версии), поэтому менять расклад нельзя: строка перестанет
 * читаться как IP-адрес.
 *
 * `authKey` обязан быть ровно 256 байт — это предусловие, а не удобство.
 * Более короткий или длинный ключ раньше молча обрезался и давал строку
 * другой длины: она уезжала в другую ветку разбора GramJS и собирала рабочую
 * на вид сессию с адресом из мусора вместо ошибки. Дешевле упасть здесь, чем
 * записать такую сессию в таблицу аккаунтов.
 */
export function buildGramJsSessionString(
  dcId: number,
  serverAddress: string,
  port: number,
  authKey: Uint8Array,
): string {
  if (authKey.length !== 256) {
    throw new Error(
      `buildGramJsSessionString: ключ авторизации должен быть 256 байт, получено ${authKey.length}`,
    );
  }

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

  // Длина уже проверена выше, поэтому здесь keyBuf ровно 256 байт — обрезка
  // subarray() больше не нужна, она маскировала бы ту самую ошибку, которую
  // теперь бросаем явно.
  const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf]);
  return '1' + result.toString('base64');
}

/** Ключ авторизации — последние 256 байт строки сессии (см. расклад выше). */
const AUTH_KEY_BYTES = 256;

/**
 * Самый короткий законный расклад: dc(1) + IPv4(4) + порт(2) + ключ(256).
 * У IPv6 адрес длиннее, поэтому проверяем «не короче», а ключ берём с конца.
 */
const MIN_SESSION_BYTES = 1 + 4 + 2 + AUTH_KEY_BYTES;

/**
 * Отпечаток ключа авторизации из строки сессии.
 *
 * Сравнивать строки целиком нельзя: адрес DC, записанный перед ключом, у
 * одного и того же аккаунта разный в зависимости от того, откуда сессия
 * приехала — из tdata он берётся из таблицы адресов mtcute, из .session — из
 * SQLite. Одинаковый хвост в 256 байт означает один и тот же вход в Telegram,
 * а два параллельных подключения одним ключом дают AUTH_KEY_DUPLICATED, после
 * которого Telegram отзывает сессию.
 *
 * На пустой или нечитаемой строке возвращает null и никогда не бросает: в
 * таблице лежат строки с `session_data = ''` — там, где конвертация упала, — и
 * они не должны совпасть ни друг с другом, ни с чем-либо ещё.
 */
export function authKeyFingerprint(sessionString: string | null | undefined): string | null {
  // Префикс версии GramJS. Другую версию расклада мы не знаем и гадать не
  // будем: лучше не дать отпечатка вовсе, чем дать несравнимый.
  if (!sessionString || sessionString[0] !== '1') return null;

  // Buffer.from(..., 'base64') на мусоре не бросает, а молча пропускает
  // недопустимые символы — поэтому проверяем длину результата, а не входа.
  const decoded = Buffer.from(sessionString.slice(1), 'base64');
  if (decoded.length < MIN_SESSION_BYTES) return null;

  return createHash('sha256')
    .update(decoded.subarray(decoded.length - AUTH_KEY_BYTES))
    .digest('hex');
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
