import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringSession } from 'telegram/sessions';
import { readFirstRow } from '@/lib/telegram/sqliteReader';
import { buildGramJsSessionString, sqliteBufferToSessionString } from '@/lib/telegram/sessionUtils';

// sqlite3 здесь — не зависимость читаемого кода, а способ собрать эталонный
// файл: пакет остаётся в проекте ради образа воркера и вот таких фикстур.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite3 = require('sqlite3') as typeof import('sqlite3');

/** Собрать временную базу из набора SQL-команд и вернуть её содержимое. */
async function buildDatabase(statements: Array<[string, unknown[]?]>): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `sqlite-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = new sqlite3.Database(tmp);
  await new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      for (const [sql, params] of statements) {
        db.run(sql, params ?? [], (err: Error | null) => { if (err) reject(err); });
      }
      db.close((err) => (err ? reject(err) : resolve()));
    });
  });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

/** Схема Telethon дословно: dc_id объявлен как INTEGER PRIMARY KEY. */
const TELETHON_SCHEMA = `CREATE TABLE sessions (
  dc_id integer primary key,
  server_address text,
  port integer,
  auth_key blob,
  takeout_id integer,
  tmp_auth_key blob
)`;

describe('readFirstRow', () => {
  it('берёт dc_id из rowid, когда колонка объявлена INTEGER PRIMARY KEY', async () => {
    const authKey = Buffer.alloc(256, 7);
    const buf = await buildDatabase([
      [TELETHON_SCHEMA],
      ['INSERT INTO sessions (dc_id, server_address, port, auth_key) VALUES (?, ?, ?, ?)',
        [4, '149.154.167.91', 443, authKey]],
    ]);

    const row = readFirstRow(buf, 'sessions');
    // Значение такой колонки лежит в rowid, а в самой записи стоит NULL —
    // без подстановки из rowid номер DC приехал бы пустым.
    expect(row?.dc_id).toBe(4);
    expect(row?.server_address).toBe('149.154.167.91');
    expect(row?.port).toBe(443);
    expect(row?.auth_key).toEqual(authKey);
    expect(row?.takeout_id).toBeNull();

    const session = await sqliteBufferToSessionString(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );

    // Сверяем содержимое сессии, а не байты строки. GramJS при save() пишет
    // свой формат адреса (ASCII с длиной), тогда как buildGramJsSessionString
    // пакует IPv4 в четыре байта. Обе строки грузятся одинаково — это
    // проверено ниже, — но посимвольно не совпадают, и сравнение строк ловило
    // бы не ошибку чтения, а разницу кодировок.
    const loaded = new StringSession(session);
    await loaded.load();
    expect(loaded.dcId).toBe(4);
    expect(loaded.serverAddress).toBe('149.154.167.91');
    expect(loaded.port).toBe(443);
    expect(Buffer.from(loaded.authKey!.getKey()!)).toEqual(authKey);

    // И то же самое из прямого построителя — обе дороги дают одну сессию.
    const direct = new StringSession(buildGramJsSessionString(4, '149.154.167.91', 443, authKey));
    await direct.load();
    expect(direct.save()).toBe(session);
  });

  it('возвращает null для пустой таблицы', async () => {
    const buf = await buildDatabase([[TELETHON_SCHEMA]]);
    expect(readFirstRow(buf, 'sessions')).toBeNull();
  });

  it('обходит внутренние страницы b-дерева и отдаёт первую строку', async () => {
    // Строк заведомо больше, чем влезает на одну страницу в 4 КБ, поэтому
    // корень таблицы становится внутренней страницей со ссылками на листья.
    const rows: Array<[string, unknown[]?]> = [['CREATE TABLE many (id integer primary key, payload text)']];
    for (let i = 1; i <= 400; i++) {
      rows.push(['INSERT INTO many (id, payload) VALUES (?, ?)', [i, `значение-${i}`.repeat(4)]]);
    }
    const buf = await buildDatabase(rows);

    const row = readFirstRow(buf, 'many');
    expect(row?.id).toBe(1);
    expect(row?.payload).toBe('значение-1'.repeat(4));
  });

  it('не притворяется, что читает посторонний файл', () => {
    expect(() => readFirstRow(Buffer.alloc(4096, 0x41), 'sessions')).toThrow(/SQLite/);
  });

  it('сообщает, что таблицы нет, а не отдаёт пустую строку', async () => {
    const buf = await buildDatabase([[TELETHON_SCHEMA]]);
    expect(() => readFirstRow(buf, 'entities')).toThrow(/entities/);
  });
});
