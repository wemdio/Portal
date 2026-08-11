import { createHash } from 'node:crypto';
import { StringSession } from 'telegram/sessions';
import { readFirstRow } from './sqliteReader';

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
 * Собрать строку сессии из содержимого .session-файла Telethon.
 *
 * Разбираем файл своим читателем SQLite (`sqliteReader`), а не пакетом
 * `sqlite3`: у пакета нативные биндинги, которых в образе приложения нет и не
 * будет — зависимости там ставятся с `--ignore-scripts`. Раньше эта ветка
 * падала на `Could not locate the bindings file` для каждого аккаунта, у
 * которого пустая `session_data`.
 */
function sessionStringFromSqliteBuffer(fileBuffer: Buffer): string {
  const row = readFirstRow(fileBuffer, 'sessions');
  // `auth_key` пустой у сессии, которую Telethon завёл, но не авторизовал.
  if (!row?.auth_key || !(row.auth_key instanceof Buffer) || row.auth_key.length === 0) {
    throw new Error('Пустая сессия в SQLite файле');
  }

  return buildGramJsSessionString(
    Number(row.dc_id),
    String(row.server_address),
    Number(row.port),
    row.auth_key,
  );
}

/**
 * Read a Telethon/GramJS .session SQLite file and return a StringSession.
 * Avoids gramjs-sqlitesession which is incompatible with newer GramJS versions.
 */
export async function readSqliteSession(filePath: string): Promise<StringSession> {
  const fs = await import('fs');
  try {
    return new StringSession(sessionStringFromSqliteBuffer(fs.readFileSync(filePath)));
  } catch (err) {
    // Имя функции в тексте ошибки — не украшение: по нему цикл кампании
    // отличает порчу файла сессии от точно так же звучащих ошибок разбора
    // сетевых пакетов GramJS (campaignLoop.ts, ветка «offset out of range»).
    throw new Error(`readSqliteSession(${filePath}): ${(err as Error).message}`);
  }
}

/**
 * Convert a .session SQLite buffer to a GramJS StringSession string.
 */
export async function sqliteBufferToSessionString(buffer: ArrayBuffer): Promise<string> {
  const session = new StringSession(sessionStringFromSqliteBuffer(Buffer.from(buffer)));
  await session.load();
  return session.save();
}
