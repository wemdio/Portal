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

/** Файлы папки как записи архива под произвольным префиксом. */
function tdataEntries(dir: string, prefix: string): Array<{ name: string; content: Buffer }> {
  return listFiles(dir).map((rel) => ({
    name: prefix ? `${prefix}/${rel}` : rel,
    content: fs.readFileSync(path.join(dir, rel)),
  }));
}

/**
 * Имя файла с данными аккаунта внутри tdata. Оно выводится из служебного имени
 * `data`, а не из ключей, поэтому одинаково у всех папок в этих тестах.
 */
const ACCOUNT_FILE = 'D877F783D5D3EF8Cs';

/** Байты, которые deflate реально жмёт: на испорченном потоке inflate падает. */
function compressible(): Buffer {
  return Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7 + (i % 13)) & 0xff));
}

/**
 * Испортить сжатый поток одной записи так, чтобы inflate по нему не прошёл.
 *
 * Смещение данных считаем от локального заголовка: длины имени и extra-поля
 * лежат на 26-м и 28-м байтах, сами данные идут сразу за ними.
 */
function breakEntry(zip: Buffer, entryPath: string): Buffer {
  const out = Buffer.from(zip);
  const header = out.indexOf(Buffer.from(entryPath)) - 30;
  const data = header + 30 + out.readUInt16LE(header + 26) + out.readUInt16LE(header + 28);
  out.fill(0xa5, data + 40, data + 64);
  return out;
}

/**
 * Пометить записи архива как зашифрованные.
 *
 * `archiver` не умеет ставить пароль, а нам нужен ровно тот бит, по которому
 * это видно снаружи: младший бит поля флагов в заголовке центрального каталога
 * (сигнатура `PK\x01\x02`, флаги на 8-м байте).
 */
function markEncrypted(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i + 10 <= out.length; i++) {
    if (out.readUInt32LE(i) === 0x02014b50) {
      out.writeUInt16LE(out.readUInt16LE(i + 8) | 0x1, i + 8);
    }
  }
  return out;
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

  it('читает старую пару key_data0/key_data1', async () => {
    const dir = await makeTdataDir(404);
    dirs.push(dir);
    // Telegram Desktop писал служебные файлы парами `<имя>0`/`<имя>1` до того,
    // как перешёл на одиночный `<имя>s`. Библиотека доходит до старой пары,
    // только если `stat` на промахе вернёт undefined, а не бросит: иначе перебор
    // обрывается на первом же промахе и папка выглядит как «не tdata».
    const zip = await makeZip(
      listFiles(dir).map((rel) => ({
        name: `acc/tdata/${rel.replace(/s$/, '0')}`,
        content: fs.readFileSync(path.join(dir, rel)),
      })),
    );

    const found = await readTdataArchive(zip, 'старый.zip');

    expect(found[0].accounts[0].tgUserId).toBe(404);
  });

  it('читает архив, в котором служебные файлы лежат в корне без папки', async () => {
    const dir = await makeTdataDir(909);
    dirs.push(dir);
    // Оператор запаковал не саму папку tdata, а её содержимое: папки-владельца
    // нет, поэтому имя берётся от архива.
    const zip = await makeZip(
      listFiles(dir).map((rel) => ({
        name: rel,
        content: fs.readFileSync(path.join(dir, rel)),
      })),
    );

    const found = await readTdataArchive(zip, '246630983.zip');

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('246630983');
    expect(found[0].accounts[0].tgUserId).toBe(909);
  });

  it('битая папка не отменяет соседнюю: обе в ответе, но с разной судьбой', async () => {
    const good = await makeTdataDir(707);
    const bad = await makeTdataDir(808);
    dirs.push(good, bad);
    // Портим ключ второй папки: библиотека не узнает свой формат и откажется
    // открывать её целиком. Оператор грузит партию, и отказ одной папки не
    // должен стоить ему остальных — поэтому это элемент с `error`, а не отказ
    // всего архива.
    const zip = await makeZip([
      { name: 'acc_good/tdata', dir: good },
      ...listFiles(bad).map((rel) => ({
        name: `acc_bad/tdata/${rel}`,
        content: rel === 'key_datas'
          ? Buffer.from('не tdata, а мусор')
          : fs.readFileSync(path.join(bad, rel)),
      })),
    ]);

    const found = await readTdataArchive(zip, 'партия.zip');

    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(byName.acc_good.accounts[0].tgUserId).toBe(707);
    expect(byName.acc_good.error).toBeUndefined();
    expect(byName.acc_bad.accounts).toEqual([]);
    expect(byName.acc_bad.error).toMatch(/повреждена/);
  });

  it('различает папки, в которых служебные файлы лежат без вложенной tdata', async () => {
    const first = await makeTdataDir(1111);
    const second = await makeTdataDir(2222);
    dirs.push(first, second);
    // Часть продавцов кладёт содержимое tdata прямо в папку аккаунта. Если
    // всегда брать родителя, обе такие папки получат имя архива и станут в
    // списке неразличимы — а `phone` у tdata-строки пуст, имя тут единственная
    // зацепка.
    const zip = await makeZip([
      ...tdataEntries(first, '246630983'),
      ...tdataEntries(second, '246210089'),
    ]);

    const found = await readTdataArchive(zip, 'партия.zip');

    expect(found.map((f) => f.name).sort()).toEqual(['246210089', '246630983']);
  });

  it('на архиве без tdata объясняет, чего не хватает', async () => {
    const zip = await makeZip([{ name: 'session.json', content: '{}' }]);

    await expect(readTdataArchive(zip, 'аккаунты.zip')).rejects.toThrow(
      /не найдена папка tdata/,
    );
  });

  it('на файле, который вовсе не zip, объясняется по-русски', async () => {
    const notZip = Buffer.from('это не архив, а просто текст');

    await expect(readTdataArchive(notZip, 'мусор.zip')).rejects.toThrow(
      /не удалось открыть архив/,
    );
  });

  it('на архиве под паролем отдельно говорит про пароль', async () => {
    const dir = await makeTdataDir(1212);
    dirs.push(dir);
    const zip = markEncrypted(await makeZip(tdataEntries(dir, 'acc/tdata')));

    // Пароль оператор снимает сам, поэтому это не общее «архив не открылся».
    await expect(readTdataArchive(zip, 'под-паролем.zip')).rejects.toThrow(
      /под паролем/,
    );
  });

  it('отбивает архив, служебные файлы которого не влезают в лимит памяти', async () => {
    const dir = await makeTdataDir(1313);
    dirs.push(dir);
    const zip = await makeZip(tdataEntries(dir, 'acc/tdata'));

    // Настоящая папка весит меньше килобайта, так что лимит ниже неё отбивает
    // архив на втором же файле — не дожидаясь, пока в памяти окажется всё.
    await expect(readTdataArchive(zip, 'жирный.zip', { maxTotalBytes: 512 }))
      .rejects.toThrow(/слишком много|512/);
  });

  it('не разворачивает zip-бомбу: раздутые записи не читаются вовсе', async () => {
    // Записи названы как файл аккаунта и по заголовку весят ровно по мегабайту,
    // то есть в потолок на файл укладываются — ловит их только предел раздутия.
    const oneMb = Buffer.alloc(1024 * 1024, 0);
    const zip = await makeZip(
      Array.from({ length: 200 }, (_, i) => ({
        name: `f${i}/tdata/AAAAAAAAAAAAAAAA0`,
        content: oneMb,
      })),
    );
    expect(zip.length).toBeLessThan(4 * 1024 * 1024);

    // 200 МБ по заголовкам — но ни одна запись не распаковывается, поэтому
    // архив просто оказывается «без tdata», а не съедает память.
    await expect(readTdataArchive(zip, 'бомба.zip')).rejects.toThrow(/не найдена папка tdata/);
  });

  it('нераспаковываемая запись не роняет архив, а валит только свою папку', async () => {
    const good = await makeTdataDir(1414);
    const bad = await makeTdataDir(1515);
    dirs.push(good, bad);
    // У битой папки ключ цел (папка опознаётся как tdata), а файл самого
    // аккаунта не распакуется. Настоящий файл аккаунта зашифрован и правку
    // байтов переживает молча, поэтому кладём под его именем сжимаемый
    // мусор — на нём inflate спотыкается по-настоящему.
    const zip = await makeZip([
      ...tdataEntries(good, 'acc_good/tdata'),
      { name: `acc_bad/tdata/${ACCOUNT_FILE}`, content: compressible() },
      {
        name: 'acc_bad/tdata/key_datas',
        content: fs.readFileSync(path.join(bad, 'key_datas')),
      },
    ]);

    const found = await readTdataArchive(breakEntry(zip, `acc_bad/tdata/${ACCOUNT_FILE}`), 'партия.zip');

    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(byName.acc_good.accounts[0].tgUserId).toBe(1414);
    expect(byName.acc_bad.error).toMatch(/не найден файл с данными аккаунта/);
  });
});
