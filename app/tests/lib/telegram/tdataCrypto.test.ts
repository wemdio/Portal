/**
 * @jest-environment node
 */
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';

describe('createTdataCrypto', () => {
  it('AES-IGE расшифровывает то, что сам зашифровал', () => {
    const crypto = createTdataCrypto();
    const key = Buffer.alloc(32, 3);
    const iv = Buffer.alloc(32, 5);
    const plain = Buffer.alloc(64, 7);

    const ige = crypto.createAesIge(key, iv);
    const encrypted = ige.encrypt(plain);
    expect(Buffer.from(encrypted).equals(plain)).toBe(false);

    // IGE держит состояние цепочки, поэтому для расшифровки берём свежий объект
    const decrypted = crypto.createAesIge(key, iv).decrypt(encrypted);
    expect(Buffer.from(decrypted).equals(plain)).toBe(true);
  });

  it('AES-IGE бросает ошибку на данных не кратных 16 байтам', () => {
    const crypto = createTdataCrypto();
    const key = Buffer.alloc(32, 3);
    const iv = Buffer.alloc(32, 5);
    const ige = crypto.createAesIge(key, iv);

    // Task 4 пропускает через этот код байты из архива, который загрузил
    // оператор: битый .zip должен упасть с понятной ошибкой, а не тихо
    // отдать мусор.
    expect(() => ige.encrypt(Buffer.alloc(15))).toThrow('15');
    expect(() => ige.decrypt(Buffer.alloc(17))).toThrow('17');
  });

  it('считает sha1, sha256 и md5 как node:crypto', async () => {
    const crypto = createTdataCrypto();
    const data = Buffer.from('portal');

    expect(Buffer.from(crypto.sha1(data)).toString('hex')).toBe(
      '23f3fd77a464cbe250150f60d785f08978d07e40',
    );
    expect(Buffer.from(crypto.sha256(data)).toString('hex')).toBe(
      'd0960501f8971be812f2e5494426e08cdbb2cbc3b3190ba60075f14b8da7178a',
    );

    const md5 = await crypto.createHash('md5');
    await md5.update(data);
    expect(Buffer.from(await md5.digest()).toString('hex')).toBe(
      '7ee9c4f86007ba41bc79bbfab1cd8a68',
    );
  });
});
