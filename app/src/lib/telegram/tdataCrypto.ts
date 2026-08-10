import nodeCrypto from 'crypto';
import type { Tdata } from '@mtcute/convert';

/**
 * Крипто-провайдер для чтения tdata.
 *
 * `@mtcute/convert` по умолчанию берёт реализацию из `@mtcute/node`, а тот
 * тянет нативный `better-sqlite3` — в образ портала это незачем. Здесь
 * закрыт ровно тот минимум, который вызывает чтение tdata.
 */
export type TdataCrypto = NonNullable<Parameters<typeof Tdata.open>[0]['crypto']>;

function xorBlock(a: Uint8Array, b: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * AES-IGE поверх `aes-*-ecb`: режима IGE в Node нет, но он выражается через
 * ECB двумя цепочками XOR — по шифротексту и по открытому тексту.
 * iv здесь 32 байта: первая половина продолжает цепочку шифротекста,
 * вторая — цепочку открытого текста.
 */
function createAesIge(key: Uint8Array, iv: Uint8Array) {
  const algo = key.length === 32 ? 'aes-256-ecb' : 'aes-128-ecb';
  const keyBuf = Buffer.from(key);

  const ecb = (block: Buffer, encrypt: boolean): Buffer => {
    const cipher = encrypt
      ? nodeCrypto.createCipheriv(algo, keyBuf, null)
      : nodeCrypto.createDecipheriv(algo, keyBuf, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
  };

  return {
    encrypt(data: Uint8Array): Uint8Array {
      // Явно широкий тип Buffer (= Buffer<ArrayBufferLike>): без аннотации TS
      // сужает его по Buffer.from() до Buffer<ArrayBuffer>, а xorBlock() ниже
      // возвращает Buffer<ArrayBufferLike> — переменная цикла должна принимать оба.
      let prevCipher: Buffer = Buffer.from(iv.subarray(0, 16));
      let prevPlain: Buffer = Buffer.from(iv.subarray(16, 32));
      const out = Buffer.allocUnsafe(data.length);
      for (let i = 0; i < data.length; i += 16) {
        const block = Buffer.from(data.subarray(i, i + 16));
        const cipher = xorBlock(ecb(xorBlock(block, prevCipher), true), prevPlain);
        cipher.copy(out, i);
        prevCipher = cipher;
        prevPlain = block;
      }
      return new Uint8Array(out);
    },
    decrypt(data: Uint8Array): Uint8Array {
      let prevCipher: Buffer = Buffer.from(iv.subarray(0, 16));
      let prevPlain: Buffer = Buffer.from(iv.subarray(16, 32));
      const out = Buffer.allocUnsafe(data.length);
      for (let i = 0; i < data.length; i += 16) {
        const block = Buffer.from(data.subarray(i, i + 16));
        const plain = xorBlock(ecb(xorBlock(block, prevPlain), false), prevCipher);
        plain.copy(out, i);
        prevCipher = block;
        prevPlain = plain;
      }
      return new Uint8Array(out);
    },
  };
}

const notNeeded = (name: string) => (): never => {
  throw new Error(`${name} при чтении tdata не используется`);
};

/**
 * Реализуем не весь интерфейс библиотеки, а только то, что вызывает чтение
 * tdata: остальное бросает понятную ошибку, если однажды понадобится. Отсюда
 * приведение типа — объект намеренно уже интерфейса.
 */
export function createTdataCrypto(): TdataCrypto {
  return {
    initialize: (): void => {},
    sha1: (d: Uint8Array) => new Uint8Array(nodeCrypto.createHash('sha1').update(d).digest()),
    sha256: (d: Uint8Array) => new Uint8Array(nodeCrypto.createHash('sha256').update(d).digest()),
    pbkdf2: (
      password: Uint8Array,
      salt: Uint8Array,
      iterations: number,
      keylen = 64,
      algo = 'sha512',
    ) =>
      new Promise<Uint8Array>((resolve, reject) => {
        nodeCrypto.pbkdf2(password, salt, iterations, keylen, algo, (err, buf) =>
          err ? reject(err) : resolve(new Uint8Array(buf)),
        );
      }),
    hmacSha256: (d: Uint8Array, k: Uint8Array) =>
      new Uint8Array(nodeCrypto.createHmac('sha256', k).update(d).digest()),
    createAesIge,
    createAesCtr: notNeeded('createAesCtr'),
    factorizePQ: notNeeded('factorizePQ'),
    gzip: notNeeded('gzip'),
    gunzip: notNeeded('gunzip'),
    randomFill: (buf: Uint8Array): void => { nodeCrypto.randomFillSync(buf); },
    randomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
    createHash: (algorithm: 'md5' | 'sha512') => {
      const hash = nodeCrypto.createHash(algorithm);
      return {
        update: (d: Uint8Array): void => { hash.update(d); },
        digest: () => new Uint8Array(hash.digest()),
      };
    },
  } as unknown as TdataCrypto;
}
