import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteBufferToSessionString } from '@/lib/telegram/sessionUtils';

// sqlite3 is a transitive dependency (used by sessionUtils); not always in package.json types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite3 = require('sqlite3') as typeof import('sqlite3');

describe('sqliteBufferToSessionString', () => {
  it('returns non-empty GramJS string for Telethon SQLite session', async () => {
    const tmp = path.join(os.tmpdir(), `tg-session-test-${Date.now()}.session`);
    const db = new sqlite3.Database(tmp);
    const authKey = Buffer.alloc(256, 1);
    await new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run(
          `CREATE TABLE sessions (
            dc_id INTEGER,
            server_address TEXT,
            port INTEGER,
            auth_key BLOB,
            takeout_id INTEGER,
            tmp_auth_key BLOB
          )`,
          (err: Error | null) => {
            if (err) return reject(err);
            db.run(
              `INSERT INTO sessions (dc_id, server_address, port, auth_key) VALUES (?, ?, ?, ?)`,
              [2, '149.154.167.51', 443, authKey],
              (err2: Error | null) => {
                if (err2) return reject(err2);
                db.close((err3) => {
                  if (err3) return reject(err3);
                  resolve();
                });
              },
            );
          },
        );
      });
    });

    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);

    const s = await sqliteBufferToSessionString(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    expect(s.length).toBeGreaterThan(20);
    expect(s.startsWith('1')).toBe(true);
  });
});
