/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertToTdata } from '@mtcute/convert';
import { StringSession } from 'telegram/sessions';
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';
import { readTdataAccounts, nodeFsLike } from '@/lib/telegram/tdata';

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
  passcode?: string,
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-test-'));
  await convertToTdata(
    accounts.map((a) => ({
      version: 3,
      primaryDcs: { main: DC, media: DC },
      authKey: new Uint8Array(256).fill(a.keyFill),
      self: { userId: a.userId, isBot: false, isPremium: false, usernames: [] },
    })),
    // fs передаём явно по той же причине, что и рабочий код: динамический
    // import() внутри библиотеки в песочнице jest не работает.
    { path: dir, crypto: createTdataCrypto(), passcode, fs: nodeFsLike },
  );
  return dir;
}

describe('readTdataAccounts', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('читает аккаунт и отдаёт строку сессии, понятную GramJS', async () => {
    const dir = await makeTdata([{ userId: 111222333, keyFill: 7 }]);
    dirs.push(dir);

    const accounts = await readTdataAccounts(dir);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].index).toBe(0);
    expect(accounts[0].tgUserId).toBe(111222333);

    const session = new StringSession(accounts[0].sessionString);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe(DC.ipAddress);
  });

  it('забирает все аккаунты из мультиаккаунтной папки', async () => {
    const dir = await makeTdata([
      { userId: 111, keyFill: 1 },
      { userId: 222, keyFill: 2 },
    ]);
    dirs.push(dir);

    const accounts = await readTdataAccounts(dir);

    expect(accounts.map((a) => a.tgUserId)).toEqual([111, 222]);
    expect(accounts[0].sessionString).not.toBe(accounts[1].sessionString);
  });

  it('на папке под локальным паролем объясняет причину по-русски', async () => {
    const dir = await makeTdata([{ userId: 999, keyFill: 3 }], 'hunter2');
    dirs.push(dir);

    await expect(readTdataAccounts(dir)).rejects.toThrow(
      /локальным паролем/,
    );
  });

  it('на папке без tdata говорит, что файлов нет', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-empty-'));
    dirs.push(dir);

    await expect(readTdataAccounts(dir)).rejects.toThrow(/не похожа на tdata/);
  });
});
