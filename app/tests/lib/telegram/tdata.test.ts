/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertToTdata } from '@mtcute/convert';
import { StringSession } from 'telegram/sessions';
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';
import { readTdataAccounts, describeTdataError, nodeFsLike } from '@/lib/telegram/tdata';

/**
 * Адрес DC в самой tdata не хранится — там лежит только номер DC. Обратно
 * библиотека достаёт адрес из своей таблицы, поэтому здесь должен стоять ровно
 * тот адрес, что записан у неё для второго DC: иначе тест проверял бы не код,
 * а совпадение двух констант.
 */
const DC = { id: 2, ipAddress: '149.154.167.41', port: 443 };

/**
 * Синтетическая tdata из выдуманных ключей. Живые ключи боевых аккаунтов в
 * репозиторий не попадают: библиотека умеет не только читать tdata, но и писать.
 */
async function makeTdata(
  accounts: Array<{ userId: number; keyFill: number }>,
  options: { passcode?: string; dc?: { id: number; ipAddress: string; port: number } } = {},
): Promise<string> {
  const dc = options.dc ?? DC;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-test-'));
  await convertToTdata(
    accounts.map((a) => ({
      version: 3,
      primaryDcs: { main: dc, media: dc },
      authKey: new Uint8Array(256).fill(a.keyFill),
      self: { userId: a.userId, isBot: false, isPremium: false, usernames: [] },
    })),
    // fs передаём явно по той же причине, что и рабочий код: динамический
    // import() внутри библиотеки в песочнице jest не работает.
    { path: dir, crypto: createTdataCrypto(), passcode: options.passcode, fs: nodeFsLike },
  );
  return dir;
}

/**
 * Хвост строки сессии — те самые 256 байт ключа авторизации. Проверять их
 * важнее, чем кажется: перепутанный между аккаунтами ключ выглядит как
 * исправная сессия, а на боевом подключении даёт AUTH_KEY_DUPLICATED.
 */
function authKeyOf(sessionString: string): string {
  return Buffer.from(sessionString.slice(1), 'base64').subarray(-256).toString('hex');
}

const keyFilledWith = (fill: number) => Buffer.alloc(256, fill).toString('hex');

/** Файл аккаунта внутри tdata: 16 hex-символов и суффикс современного формата. */
const accountFiles = (dir: string) => fs.readdirSync(dir).filter((f) => /^[0-9A-F]{16}s$/.test(f));

describe('readTdataAccounts', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  /** Папка, которую тест потом сломает или переименует. */
  async function tempTdata(
    accounts: Array<{ userId: number; keyFill: number }>,
    options?: { passcode?: string; dc?: { id: number; ipAddress: string; port: number } },
  ): Promise<string> {
    const dir = await makeTdata(accounts, options);
    dirs.push(dir);
    return dir;
  }

  it('читает аккаунт и отдаёт строку сессии, понятную GramJS', async () => {
    const dir = await tempTdata([{ userId: 111222333, keyFill: 7 }]);

    const accounts = await readTdataAccounts(dir);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].index).toBe(0);
    expect(accounts[0].tgUserId).toBe(111222333);

    const session = new StringSession(accounts[0].sessionString);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe(DC.ipAddress);
  });

  it('забирает все аккаунты из мультиаккаунтной папки, не путая ключи', async () => {
    const dir = await tempTdata([
      { userId: 111, keyFill: 1 },
      { userId: 222, keyFill: 2 },
    ]);

    const accounts = await readTdataAccounts(dir);

    expect(accounts.map((a) => a.tgUserId)).toEqual([111, 222]);
    expect(authKeyOf(accounts[0].sessionString)).toBe(keyFilledWith(1));
    expect(authKeyOf(accounts[1].sessionString)).toBe(keyFilledWith(2));
  });

  it('на папке под локальным паролем объясняет причину по-русски', async () => {
    const dir = await tempTdata([{ userId: 999, keyFill: 3 }], { passcode: 'hunter2' });

    await expect(readTdataAccounts(dir)).rejects.toThrow(
      /локальным паролем/,
    );
  });

  it('на папке без tdata говорит, что файлов нет', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-empty-'));
    dirs.push(dir);

    await expect(readTdataAccounts(dir)).rejects.toThrow(/не похожа на tdata/);
  });

  it('битую папку объясняет тем же текстом, что и папку под паролем', async () => {
    // Сломанная сигнатура TDF$ — библиотека отвечает "invalid magic".
    const noMagic = await tempTdata([{ userId: 555, keyFill: 4 }]);
    const noMagicFile = path.join(noMagic, 'key_datas');
    const noMagicBytes = fs.readFileSync(noMagicFile);
    noMagicBytes.write('XXXX', 0);
    fs.writeFileSync(noMagicFile, noMagicBytes);

    await expect(readTdataAccounts(noMagic)).rejects.toThrow(/повреждена/);

    // Сигнатура цела, побит байт данных — библиотека отвечает "md5 mismatch".
    const badMd5 = await tempTdata([{ userId: 556, keyFill: 5 }]);
    const badMd5File = path.join(badMd5, 'key_datas');
    const badMd5Bytes = fs.readFileSync(badMd5File);
    badMd5Bytes[20] ^= 0xff;
    fs.writeFileSync(badMd5File, badMd5Bytes);

    await expect(readTdataAccounts(badMd5)).rejects.toThrow(/повреждена/);
  });

  it('читает папку со старой парой key_data0/key_data1', async () => {
    const dir = await tempTdata([{ userId: 777, keyFill: 9 }]);
    // Старый формат: тот же файл под именем key_data0. Библиотека доберётся до
    // него, только если stat на отсутствующем key_datas вернёт undefined.
    fs.renameSync(path.join(dir, 'key_datas'), path.join(dir, 'key_data0'));

    const accounts = await readTdataAccounts(dir);

    expect(accounts.map((a) => a.tgUserId)).toEqual([777]);
  });

  it('не выдаёт аккаунт без идентификатора за аккаунт с номером 0', async () => {
    const dir = await tempTdata([{ userId: 0, keyFill: 6 }]);

    await expect(readTdataAccounts(dir)).rejects.toThrow(
      /аккаунт №1 в папке: не авторизован — Telegram Desktop не сохранил идентификатор/,
    );
  });

  it('на незнакомом дата-центре объясняет причину, а не падает TypeError', async () => {
    const dir = await tempTdata([{ userId: 888, keyFill: 8 }], {
      dc: { id: 9, ipAddress: '1.2.3.4', port: 443 },
    });

    await expect(readTdataAccounts(dir)).rejects.toThrow(/не знает дата-центр/);
  });

  it('пропавший файл аккаунта называет файлом аккаунта, а не key_data', async () => {
    const solo = await tempTdata([{ userId: 1, keyFill: 1 }]);
    const [slot0] = accountFiles(solo);

    const dir = await tempTdata([
      { userId: 111, keyFill: 1 },
      { userId: 222, keyFill: 2 },
    ]);
    // Имена файлов аккаунтов детерминированы, поэтому второй слот — тот, чьё
    // имя не совпало с единственным файлом односчётной папки.
    const slot1 = accountFiles(dir).find((f) => f !== slot0);
    fs.rmSync(path.join(dir, slot1!));

    await expect(readTdataAccounts(dir)).rejects.toThrow(
      /аккаунт №2 в папке: не найден файл с данными аккаунта/,
    );
  });
});

describe('nodeFsLike', () => {
  it('на отсутствующем файле отдаёт undefined, а не бросает', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-stat-'));
    try {
      await expect(nodeFsLike.stat(path.join(dir, 'нет-такого-файла'))).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('describeTdataError', () => {
  it('заворачивает незнакомую ошибку в русскую рамку, сохраняя оригинал', () => {
    expect(describeTdataError(new Error('something odd'))).toBe(
      'папку не удалось прочитать (something odd)',
    );
  });
});
