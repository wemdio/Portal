/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { convertToTdata } from '@mtcute/convert';
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';
import { nodeFsLike } from '@/lib/telegram/tdata';
import { readTdataArchive } from '@/lib/telegram/tdataArchive';

// Адрес не хранится в tdata: библиотека восстанавливает его по номеру DC из
// своей таблицы, поэтому здесь он должен совпадать с DC_MAPPING_PROD.
const DC = { id: 2, ipAddress: '149.154.167.41', port: 443 };

async function makeTdataDir(userId: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-arch-'));
  await convertToTdata(
    [{
      version: 3,
      primaryDcs: { main: DC, media: DC },
      authKey: new Uint8Array(256).fill(userId % 250),
      self: { userId, isBot: false, isPremium: false, usernames: [] },
    }],
    // fs передаём явно: без него библиотека делает динамический import,
    // на котором падает Jest (см. Task 3).
    { path: dir, crypto: createTdataCrypto(), fs: nodeFsLike },
  );
  return dir;
}

/** Пути всех файлов внутри папки — относительно неё, через `/`. */
function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
      : [`${prefix}${e.name}`]);
}

/** Собрать zip в буфер: entries — пары «путь внутри архива» → «путь на диске или содержимое». */
function makeZip(
  entries: Array<{ name: string; dir?: string; content?: string | Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      if (entry.dir) archive.directory(entry.dir, entry.name);
      else archive.append(entry.content ?? '', { name: entry.name });
    }
    void archive.finalize();
  });
}

describe('readTdataArchive', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('находит tdata во вложенной папке и берёт имя от папки-владельца', async () => {
    const dir = await makeTdataDir(8841769957);
    dirs.push(dir);
    const zip = await makeZip([{ name: '246630983/tdata', dir }]);

    const found = await readTdataArchive(zip, '246630983.zip');

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('246630983');
    expect(found[0].accounts[0].tgUserId).toBe(8841769957);
  });

  it('берёт имя от архива, если tdata лежит в корне', async () => {
    const dir = await makeTdataDir(555);
    dirs.push(dir);
    const zip = await makeZip([{ name: 'tdata', dir }]);

    const found = await readTdataArchive(zip, '246210089.zip');

    expect(found[0].name).toBe('246210089');
  });

  it('разбирает архив сразу с несколькими аккаунтами', async () => {
    const first = await makeTdataDir(101);
    const second = await makeTdataDir(202);
    dirs.push(first, second);
    const zip = await makeZip([
      { name: 'acc_a/tdata', dir: first },
      { name: 'acc_b/tdata', dir: second },
    ]);

    const found = await readTdataArchive(zip, 'партия.zip');

    expect(found.map((f) => f.name).sort()).toEqual(['acc_a', 'acc_b']);
  });

  it('не спотыкается о посторонние файлы рядом с tdata', async () => {
    const dir = await makeTdataDir(303);
    dirs.push(dir);
    const zip = await makeZip([
      { name: '246630983/tdata', dir },
      { name: '246630983/tdata.rar', content: 'мусор от продавца' },
      { name: '246630983/readme.txt', content: 'пароль от почты' },
    ]);

    const found = await readTdataArchive(zip, '246630983.zip');

    expect(found).toHaveLength(1);
    expect(found[0].accounts[0].tgUserId).toBe(303);
  });

  it('читает старую пару key_data0/key_data1, которую с диска не открыть', async () => {
    const dir = await makeTdataDir(404);
    dirs.push(dir);
    // Telegram Desktop писал служебные файлы парами `<имя>0`/`<имя>1` до того,
    // как перешёл на одиночный `<имя>s`. Библиотека доходит до старой пары,
    // только если `stat` на промахе вернёт undefined, а не бросит: на диске
    // (nodeFsLike) он бросает ENOENT, поэтому такую папку читает лишь этот слой.
    const zip = await makeZip(
      listFiles(dir).map((rel) => ({
        name: `acc/tdata/${rel.replace(/s$/, '0')}`,
        content: fs.readFileSync(path.join(dir, rel)),
      })),
    );

    const found = await readTdataArchive(zip, 'старый.zip');

    expect(found[0].accounts[0].tgUserId).toBe(404);
  });

  it('на архиве без tdata объясняет, чего не хватает', async () => {
    const zip = await makeZip([{ name: 'session.json', content: '{}' }]);

    await expect(readTdataArchive(zip, 'аккаунты.zip')).rejects.toThrow(
      /не найдена папка tdata/,
    );
  });
});
