# TG Outreach: загрузка аккаунтов из tdata — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор загружает на вкладке «Аккаунты» кампании zip-архивы с папками `tdata` и получает готовые аккаунты — без ручной конвертации разработчиком.

**Architecture:** Архив читается в память (`unzipper`), из него берутся только служебные файлы `tdata`; `@mtcute/convert` расшифровывает их офлайн, без подключения к Telegram, и отдаёт `authKey` + `userId`; из этого собирается строка сессии в том же формате, что уже лежит у всех аккаунтов портала. Дубли отсекаются по `tg_user_id` по всей базе. Разбор живёт в `src/lib/telegram/`, склейка с базой — в `src/lib/tgOutreach/tdataImport.ts`, ручка только вызывает их.

**Tech Stack:** Next.js 16, TypeScript, Jest, Supabase, `@mtcute/convert` (новая зависимость), `unzipper` и `archiver` (уже есть).

**Спека:** [2026-08-10-tg-outreach-tdata-upload-design.md](../specs/2026-08-10-tg-outreach-tdata-upload-design.md)

---

## Структура файлов

**Создаём:**

| Файл | Ответственность |
|---|---|
| `app/src/lib/telegram/tdataCrypto.ts` | Крипто-провайдер для `@mtcute/convert` поверх `node:crypto` (без нативных зависимостей) |
| `app/src/lib/telegram/tdata.ts` | Одна папка `tdata` → список аккаунтов (`tg_user_id` + строка сессии) |
| `app/src/lib/telegram/tdataArchive.ts` | Zip → файловая система в памяти, поиск папок `tdata`, имена аккаунтов |
| `app/src/lib/tgOutreach/tdataImport.ts` | Список загруженных архивов → кандидаты на вставку + построчные ошибки |
| `app/tests/lib/telegram/tdataCrypto.test.ts` | AES-IGE и хеши |
| `app/tests/lib/telegram/tdata.test.ts` | Круговой прогон через синтетическую `tdata`, мультиаккаунт, пароль |
| `app/tests/lib/telegram/tdataArchive.test.ts` | Поиск `tdata` в архиве, имена, отсев мусора |
| `app/tests/lib/tgOutreach/tdataImport.test.ts` | Сборка кандидатов, суффиксы `_2`, дубли внутри загрузки, ошибки |

**Меняем:**

| Файл | Что |
|---|---|
| `app/package.json` | + `@mtcute/convert` |
| `app/src/lib/telegram/sessionUtils.ts` | Выносим сборку строки сессии в экспортируемую `buildGramJsSessionString` |
| `app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts` | Ветка для `.zip`, дедуп по базе, отчёт в ответе |
| `app/src/app/tools/tg-outreach/page.tsx` | Принимаем `.zip`, показываем отчёт о загрузке |
| `app/src/app/api/tools/tg-outreach/accounts/[id]/check/route.ts` | Сохраняем телефон из ответа Telegram |

**Миграции не нужны:** все поля (`tg_user_id`, `session_data`, `phone`) уже есть.

---

### Task 1: Зависимость и крипто-обёртка

`@mtcute/convert` по умолчанию берёт крипту из `@mtcute/node`, а тот тянет нативный `better-sqlite3`. В образ портала это не нужно: `Tdata.open` принимает свою реализацию. Нужный минимум — `sha1`, `sha256`, `pbkdf2`, `createHash('md5'|'sha512')` и AES-IGE. Режима IGE в Node нет, он собирается из `aes-256-ecb` двумя цепочками XOR.

**Files:**
- Modify: `app/package.json`
- Create: `app/src/lib/telegram/tdataCrypto.ts`
- Test: `app/tests/lib/telegram/tdataCrypto.test.ts`

- [ ] **Step 1: Поставить зависимость**

```bash
cd app && npm install @mtcute/convert@0.31.0 --save-exact
```

Ожидаемо: в `package.json` появляется `"@mtcute/convert": "0.31.0"`, ставится 9 пакетов, нативных сборок нет.

- [ ] **Step 2: Написать падающий тест**

Создать `app/tests/lib/telegram/tdataCrypto.test.ts`:

```ts
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
```

- [ ] **Step 3: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/telegram/tdataCrypto.test.ts
```

Ожидаемо: `Cannot find module '@/lib/telegram/tdataCrypto'`.

- [ ] **Step 4: Написать реализацию**

Создать `app/src/lib/telegram/tdataCrypto.ts`:

```ts
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
      let prevCipher = Buffer.from(iv.subarray(0, 16));
      let prevPlain = Buffer.from(iv.subarray(16, 32));
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
      let prevCipher = Buffer.from(iv.subarray(0, 16));
      let prevPlain = Buffer.from(iv.subarray(16, 32));
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
```

- [ ] **Step 5: Запустить тест**

```bash
cd app && npx jest tests/lib/telegram/tdataCrypto.test.ts
```

Ожидаемо: PASS, 2 теста.

- [ ] **Step 6: Коммит**

```bash
git add app/package.json app/package-lock.json app/src/lib/telegram/tdataCrypto.ts app/tests/lib/telegram/tdataCrypto.test.ts
git commit -m "feat(tg-outreach): крипта для чтения tdata без нативных зависимостей"
```

---

### Task 2: Вынести сборку строки сессии

`readSqliteSession` уже собирает строку сессии из dc/ip/порта/ключа. Тот же байтовый расклад нужен и для tdata, поэтому выносим его в отдельную функцию — чтобы у аккаунтов из обоих форматов строка была одна и та же.

Расклад важен: установленный GramJS (`telegram@2.26`) разбирает строку длиной ровно 352 символа как «телетоновскую» (IP четырьмя байтами), а всё остальное — как строку с длиной впереди. Все аккаунты портала сейчас в первом варианте, его и сохраняем.

**Files:**
- Modify: `app/src/lib/telegram/sessionUtils.ts:7-43`
- Test: `app/tests/lib/telegram/sessionUtils.buildString.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/telegram/sessionUtils.buildString.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { StringSession } from 'telegram/sessions';
import { buildGramJsSessionString } from '@/lib/telegram/sessionUtils';

describe('buildGramJsSessionString', () => {
  it('строит строку, которую GramJS разбирает обратно', async () => {
    const authKey = Buffer.alloc(256, 42);
    const str = buildGramJsSessionString(2, '149.154.167.41', 443, authKey);

    // 352 символа после префикса версии — ветка «телетоновского» формата в GramJS
    expect(str.startsWith('1')).toBe(true);
    expect(str).toHaveLength(353);

    const session = new StringSession(str);
    await session.load();
    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe('149.154.167.41');
    expect(session.port).toBe(443);
  });

  it('принимает Uint8Array так же, как Buffer', () => {
    const fromBuffer = buildGramJsSessionString(2, '149.154.167.41', 443, Buffer.alloc(256, 1));
    const fromU8 = buildGramJsSessionString(2, '149.154.167.41', 443, new Uint8Array(256).fill(1));
    expect(fromU8).toBe(fromBuffer);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/telegram/sessionUtils.buildString.test.ts
```

Ожидаемо: FAIL — `buildGramJsSessionString is not a function`.

- [ ] **Step 3: Вынести функцию**

В `app/src/lib/telegram/sessionUtils.ts` добавить перед `readSqliteSession`:

```ts
/**
 * Собрать строку сессии GramJS из адреса DC и ключа авторизации.
 *
 * Расклад — «телетоновский»: dc_id, IP четырьмя байтами, порт, 256 байт ключа.
 * Установленный GramJS выбирает эту ветку разбора по длине строки (352 символа
 * после префикса версии), поэтому менять расклад нельзя: строка перестанет
 * читаться как IP-адрес.
 */
export function buildGramJsSessionString(
  dcId: number,
  serverAddress: string,
  port: number,
  authKey: Uint8Array,
): string {
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

  const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf.subarray(0, 256)]);
  return '1' + result.toString('base64');
}
```

И заменить тело колбэка в `readSqliteSession` (строки 22-38) на вызов новой функции:

```ts
          resolve(
            new StringSession(
              buildGramJsSessionString(row.dc_id, row.server_address, row.port, row.auth_key),
            ),
          );
```

- [ ] **Step 4: Запустить оба теста сессий**

```bash
cd app && npx jest tests/lib/telegram/sessionUtils.buildString.test.ts tests/lib/sessionUtils.test.ts
```

Ожидаемо: PASS, старый тест `sqliteBufferToSessionString` тоже зелёный — расклад не изменился.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/telegram/sessionUtils.ts app/tests/lib/telegram/sessionUtils.buildString.test.ts
git commit -m "refactor(telegram): вынести сборку строки сессии из readSqliteSession"
```

---

### Task 3: Чтение папки tdata

Модуль читает одну папку `tdata` и отдаёт аккаунты. Работает через переданную файловую систему (`INodeFsLike`), поэтому одинаково умеет и диск, и архив в памяти.

Telegram Desktop держит в одной папке до шести аккаунтов: их число и порядок лежат в `keyData`.

**Files:**
- Create: `app/src/lib/telegram/tdata.ts`
- Test: `app/tests/lib/telegram/tdata.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/telegram/tdata.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertToTdata } from '@mtcute/convert';
import { StringSession } from 'telegram/sessions';
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';
import { readTdataAccounts } from '@/lib/telegram/tdata';

const DC = { id: 2, ipAddress: '149.154.167.51', port: 443 };

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
    { path: dir, crypto: createTdataCrypto(), passcode },
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
    expect(session.serverAddress).toBe('149.154.167.51');
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/telegram/tdata.test.ts
```

Ожидаемо: `Cannot find module '@/lib/telegram/tdata'`.

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/telegram/tdata.ts`:

```ts
import { Tdata, convertFromTdata, type INodeFsLike } from '@mtcute/convert';
import { createTdataCrypto } from './tdataCrypto';
import { buildGramJsSessionString } from './sessionUtils';

export interface TdataAccount {
  /** Порядковый номер внутри папки: Telegram Desktop держит до шести аккаунтов. */
  index: number;
  tgUserId: number;
  sessionString: string;
}

/**
 * Перевести ошибку библиотеки в текст, по которому оператор поймёт, что делать.
 *
 * `Failed to decrypt` прилетает и на локальном пароле Telegram, и на битом
 * `key_data`, отличить их снаружи нельзя — называем обе причины.
 */
function describeTdataError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid password|failed to decrypt/i.test(msg)) {
    return 'папка под локальным паролем Telegram либо повреждена — снимите пароль в Telegram Desktop и переупакуйте';
  }
  if (/ENOENT|file not found/i.test(msg)) {
    return 'папка не похожа на tdata: не найден файл key_data';
  }
  if (/Unsupported version/i.test(msg)) {
    return `папка от более новой версии Telegram Desktop, чем понимает портал (${msg})`;
  }
  return msg;
}

/**
 * Прочитать папку tdata и отдать лежащие в ней аккаунты.
 *
 * К Telegram не подключаемся: ключ авторизации берётся из папки как есть, как
 * это делает `UseCurrentSession` в opentele. Аккаунт не видит нового входа, в
 * его списке сеансов ничего не появляется.
 *
 * `fsLike` подменяет работу с диском: архив читается из памяти. Без него
 * библиотека возьмёт `node:fs/promises` и прочитает обычную папку.
 */
export async function readTdataAccounts(
  tdataDir: string,
  fsLike?: INodeFsLike,
): Promise<TdataAccount[]> {
  let tdata: Tdata;
  try {
    tdata = await Tdata.open({
      path: tdataDir,
      crypto: createTdataCrypto(),
      ...(fsLike ? { fs: fsLike } : {}),
    });
  } catch (err) {
    throw new Error(describeTdataError(err));
  }

  const order = tdata.keyData.order?.length ? tdata.keyData.order : [0];
  const accounts: TdataAccount[] = [];

  for (const index of order) {
    try {
      const session = await convertFromTdata(tdata, index);
      const dc = session.primaryDcs.main;
      accounts.push({
        index,
        tgUserId: Number(session.self?.userId ?? 0),
        sessionString: buildGramJsSessionString(dc.id, dc.ipAddress, dc.port, session.authKey),
      });
    } catch (err) {
      throw new Error(`аккаунт №${index + 1} в папке: ${describeTdataError(err)}`);
    }
  }

  return accounts;
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/lib/telegram/tdata.test.ts
```

Ожидаемо: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/telegram/tdata.ts app/tests/lib/telegram/tdata.test.ts
git commit -m "feat(tg-outreach): чтение аккаунтов из папки tdata"
```

---

### Task 4: Чтение архива

Архив читается в память, на диск ничего не пишется — поэтому подмена путей внутри архива (`zip slip`) невозможна по построению.

Из архива берутся только служебные файлы `tdata`: `key_data*`, `<16 hex>*` и `map*`. Они весят единицы килобайт, так что полная папка Telegram Desktop с кэшем и медиа не загрузит память.

Важная деталь: `stat` в этом слое **возвращает `undefined` для отсутствующего файла, а не бросает**. Библиотека так выбирает между «современным» файлом `key_datas` и старой парой `key_data0`/`key_data1` — если `stat` бросит, до второй ветки дело не дойдёт.

**Files:**
- Create: `app/src/lib/telegram/tdataArchive.ts`
- Test: `app/tests/lib/telegram/tdataArchive.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/telegram/tdataArchive.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { convertToTdata } from '@mtcute/convert';
import { createTdataCrypto } from '@/lib/telegram/tdataCrypto';
import { readTdataArchive } from '@/lib/telegram/tdataArchive';

const DC = { id: 2, ipAddress: '149.154.167.51', port: 443 };

async function makeTdataDir(userId: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdata-arch-'));
  await convertToTdata(
    [{
      version: 3,
      primaryDcs: { main: DC, media: DC },
      authKey: new Uint8Array(256).fill(userId % 250),
      self: { userId, isBot: false, isPremium: false, usernames: [] },
    }],
    { path: dir, crypto: createTdataCrypto() },
  );
  return dir;
}

/** Собрать zip в буфер: entries — пары «путь внутри архива» → «путь на диске или содержимое». */
function makeZip(entries: Array<{ name: string; dir?: string; content?: string }>): Promise<Buffer> {
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

  it('на архиве без tdata объясняет, чего не хватает', async () => {
    const zip = await makeZip([{ name: 'session.json', content: '{}' }]);

    await expect(readTdataArchive(zip, 'аккаунты.zip')).rejects.toThrow(
      /не найдена папка tdata/,
    );
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/telegram/tdataArchive.test.ts
```

Ожидаемо: `Cannot find module '@/lib/telegram/tdataArchive'`.

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/telegram/tdataArchive.ts`:

```ts
import type { INodeFsLike } from '@mtcute/convert';
import { readTdataAccounts, type TdataAccount } from './tdata';

// unzipper 0.10 не поставляет типы.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as {
  Open: {
    buffer(buffer: Buffer): Promise<{
      files: Array<{
        path: string;
        type: string;
        uncompressedSize: number;
        lastModifiedDateTime: Date;
        buffer(): Promise<Buffer>;
      }>;
    }>;
  };
};

/**
 * Служебные файлы tdata: сам ключ (`key_data*`), блок авторизации аккаунта
 * (`<16 hex>*`) и карта (`map*`). Суффикс `s` — «современный» вариант,
 * `0`/`1` — старая пара, из которой библиотека берёт свежую по дате.
 *
 * Всё остальное из архива не читаем вовсе: в полной папке Telegram Desktop
 * лежат гигабайты кэша и медиа, а нужные файлы весят единицы килобайт.
 */
const TDATA_FILE = /^(key_data|map|[0-9A-F]{16})(s|0|1)$/;

/** Потолок на служебный файл tdata: настоящие весят меньше килобайта. */
const MAX_TDATA_FILE_BYTES = 1024 * 1024;

export interface TdataArchiveItem {
  /** Имя, под которым аккаунты попадут в список кампании. */
  name: string;
  accounts: TdataAccount[];
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Файловая система только на чтение поверх распакованных в память файлов.
 *
 * `stat` возвращает `undefined` для отсутствующего файла, а не бросает: так
 * библиотека сможет перебрать варианты имени (`key_datas`, затем
 * `key_data0`/`key_data1`) вместо падения на первом же промахе.
 */
function memoryFs(files: Map<string, { data: Buffer; lastModified: number }>): INodeFsLike {
  const get = (p: string) => files.get(normalize(p));
  return {
    readFile: async (p) => {
      const file = get(p);
      if (!file) throw new Error(`ENOENT: ${normalize(p)}`);
      return new Uint8Array(file.data);
    },
    writeFile: async () => { throw new Error('архив открыт только на чтение'); },
    mkdir: async () => { throw new Error('архив открыт только на чтение'); },
    stat: (async (p: string) => {
      const file = get(p);
      if (!file) return undefined;
      return { size: file.data.length, lastModified: file.lastModified };
    }) as INodeFsLike['stat'],
  };
}

/** Имя аккаунта — папка, в которой лежит tdata; если tdata в корне — имя архива. */
function accountName(tdataDir: string, archiveName: string): string {
  const parent = tdataDir.includes('/') ? tdataDir.slice(0, tdataDir.lastIndexOf('/')) : '';
  const own = parent ? parent.slice(parent.lastIndexOf('/') + 1) : '';
  return own || archiveName.replace(/\.zip$/i, '') || 'tdata';
}

/**
 * Прочитать zip-архив и отдать все лежащие в нём аккаунты.
 *
 * Архив разбирается в памяти, на диск ничего не пишется — поэтому подменить
 * путём внутри архива чужой файл на диске (`zip slip`) невозможно.
 */
export async function readTdataArchive(
  buffer: Buffer,
  archiveName: string,
): Promise<TdataArchiveItem[]> {
  const directory = await unzipper.Open.buffer(buffer);

  const files = new Map<string, { data: Buffer; lastModified: number }>();
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const p = normalize(entry.path);
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!TDATA_FILE.test(base)) continue;
    if (entry.uncompressedSize > MAX_TDATA_FILE_BYTES) continue;
    files.set(p, {
      data: await entry.buffer(),
      lastModified: entry.lastModifiedDateTime?.getTime() ?? 0,
    });
  }

  const tdataDirs = [...files.keys()]
    .filter((p) => /(^|\/)key_data(s|0|1)$/.test(p))
    .map((p) => p.slice(0, p.lastIndexOf('/')))
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .sort();

  if (!tdataDirs.length) {
    throw new Error('в архиве не найдена папка tdata');
  }

  const fsLike = memoryFs(files);
  const items: TdataArchiveItem[] = [];
  for (const dir of tdataDirs) {
    items.push({
      name: accountName(dir, archiveName),
      accounts: await readTdataAccounts(dir, fsLike),
    });
  }
  return items;
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/lib/telegram/tdataArchive.test.ts
```

Ожидаемо: PASS, 5 тестов.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/telegram/tdataArchive.ts app/tests/lib/telegram/tdataArchive.test.ts
git commit -m "feat(tg-outreach): чтение tdata прямо из zip-архива"
```

---

### Task 5: Сборка кандидатов на вставку

Слой между «прочитали архивы» и «пишем в базу»: раскладывает аккаунты по именам, отсекает дубли внутри самой загрузки и собирает построчный отчёт об ошибках. Базы не касается, поэтому проверяется обычными тестами.

**Files:**
- Create: `app/src/lib/tgOutreach/tdataImport.ts`
- Test: `app/tests/lib/tgOutreach/tdataImport.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/tdataImport.test.ts`:

```ts
/**
 * @jest-environment node
 */
import {
  collectTdataCandidates,
  TDESKTOP_API_ID,
  TDESKTOP_API_HASH,
  type TdataArchiveReader,
} from '@/lib/tgOutreach/tdataImport';

const reader: TdataArchiveReader = async (_buffer, archiveName) => {
  if (archiveName === 'битый.zip') throw new Error('в архиве не найдена папка tdata');
  if (archiveName === 'мульти.zip') {
    return [{
      name: 'multi',
      accounts: [
        { index: 0, tgUserId: 11, sessionString: 'sess-11' },
        { index: 1, tgUserId: 22, sessionString: 'sess-22' },
      ],
    }];
  }
  return [{
    name: archiveName.replace(/\.zip$/, ''),
    accounts: [{ index: 0, tgUserId: 777, sessionString: 'sess-777' }],
  }];
};

const file = (name: string) => ({ name, buffer: Buffer.alloc(0) });

describe('collectTdataCandidates', () => {
  it('собирает кандидата с телеграмовскими api_id и api_hash', async () => {
    const result = await collectTdataCandidates([file('246630983.zip')], reader);

    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([{
      name: '246630983',
      tgUserId: 777,
      sessionString: 'sess-777',
      apiId: TDESKTOP_API_ID,
      apiHash: TDESKTOP_API_HASH,
    }]);
  });

  it('нумерует аккаунты внутри мультиаккаунтной папки', async () => {
    const result = await collectTdataCandidates([file('мульти.zip')], reader);

    expect(result.candidates.map((c) => c.name)).toEqual(['multi', 'multi_2']);
  });

  it('отсекает один и тот же аккаунт, залитый двумя архивами', async () => {
    const result = await collectTdataCandidates(
      [file('копия1.zip'), file('копия2.zip')],
      reader,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.skipped).toEqual([
      { name: 'копия2', reason: 'этот же аккаунт уже есть в загрузке (копия1)' },
    ]);
  });

  it('битый архив не отменяет остальные', async () => {
    const result = await collectTdataCandidates(
      [file('битый.zip'), file('живой.zip')],
      reader,
    );

    expect(result.candidates.map((c) => c.name)).toEqual(['живой']);
    expect(result.errors).toEqual([
      { name: 'битый.zip', error: 'в архиве не найдена папка tdata' },
    ]);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/tgOutreach/tdataImport.test.ts
```

Ожидаемо: `Cannot find module '@/lib/tgOutreach/tdataImport'`.

- [ ] **Step 3: Написать реализацию**

Создать `app/src/lib/tgOutreach/tdataImport.ts`:

```ts
import { readTdataArchive, type TdataArchiveItem } from '@/lib/telegram/tdataArchive';

/**
 * Официальные ключи Telegram Desktop.
 *
 * Ключ авторизации в tdata выписан именно этим клиентом. Подставить сюда чужой
 * api_id — значит показать Telegram, что живой сессией десктопа вдруг начал
 * пользоваться посторонний софт; это ровно тот признак, по которому аккаунты
 * получают флаг.
 */
export const TDESKTOP_API_ID = 2040;
export const TDESKTOP_API_HASH = 'b18441a1ff607e10a989891a5462e627';

export interface TdataUpload {
  name: string;
  buffer: Buffer;
}

export interface TdataCandidate {
  name: string;
  tgUserId: number;
  sessionString: string;
  apiId: number;
  apiHash: string;
}

export interface TdataSkip {
  name: string;
  reason: string;
}

export interface TdataError {
  name: string;
  error: string;
}

export interface TdataCollectResult {
  candidates: TdataCandidate[];
  skipped: TdataSkip[];
  errors: TdataError[];
}

export type TdataArchiveReader = (
  buffer: Buffer,
  archiveName: string,
) => Promise<TdataArchiveItem[]>;

/**
 * Разобрать загруженные архивы в кандидатов на вставку.
 *
 * Дубли внутри самой загрузки отсекаются здесь; сверка с базой — на уровне
 * ручки, ей нужен доступ к Supabase. Ошибка одного архива не отменяет
 * остальные: оператор грузит партию целиком и должен увидеть, что именно
 * не прочиталось.
 */
export async function collectTdataCandidates(
  uploads: TdataUpload[],
  read: TdataArchiveReader = readTdataArchive,
): Promise<TdataCollectResult> {
  const candidates: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];
  const errors: TdataError[] = [];
  const seen = new Map<number, string>();

  for (const upload of uploads) {
    let items: TdataArchiveItem[];
    try {
      items = await read(upload.buffer, upload.name);
    } catch (err) {
      errors.push({ name: upload.name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const item of items) {
      for (let i = 0; i < item.accounts.length; i++) {
        const account = item.accounts[i];
        const name = i === 0 ? item.name : `${item.name}_${i + 1}`;

        const already = seen.get(account.tgUserId);
        if (already) {
          skipped.push({ name, reason: `этот же аккаунт уже есть в загрузке (${already})` });
          continue;
        }
        seen.set(account.tgUserId, name);

        candidates.push({
          name,
          tgUserId: account.tgUserId,
          sessionString: account.sessionString,
          apiId: TDESKTOP_API_ID,
          apiHash: TDESKTOP_API_HASH,
        });
      }
    }
  }

  return { candidates, skipped, errors };
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/lib/tgOutreach/tdataImport.test.ts
```

Ожидаемо: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add app/src/lib/tgOutreach/tdataImport.ts app/tests/lib/tgOutreach/tdataImport.test.ts
git commit -m "feat(tg-outreach): сборка аккаунтов из tdata-архивов в кандидатов"
```

---

### Task 6: Ветка `.zip` в ручке загрузки

Ручка `bulk-files` сейчас одной функцией разбирает файлы, парсит JSON, вставляет строки и грузит `.session` в хранилище. Третью ветку внутрь не добавляем: файлы сначала делятся по расширению, `.zip` уходит в новый путь, остальное — в существующий.

Сверка дублей идёт по всей таблице `tg_outreach_accounts`, а не только по текущей кампании: один и тот же ключ авторизации в двух кампаниях — это два параллельных подключения и гарантированный `AUTH_KEY_DUPLICATED`.

**Files:**
- Modify: `app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts`
- Test: `app/tests/lib/tgOutreach/tdataDedupe.test.ts`

- [ ] **Step 1: Написать падающий тест на сверку дублей**

Создать `app/tests/lib/tgOutreach/tdataDedupe.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { splitExistingAccounts } from '@/lib/tgOutreach/tdataImport';
import type { TdataCandidate } from '@/lib/tgOutreach/tdataImport';

const candidate = (name: string, tgUserId: number): TdataCandidate => ({
  name,
  tgUserId,
  sessionString: `sess-${tgUserId}`,
  apiId: 2040,
  apiHash: 'hash',
});

describe('splitExistingAccounts', () => {
  it('пропускает уже загруженный аккаунт и называет кампанию', () => {
    const result = splitExistingAccounts(
      [candidate('a', 111), candidate('b', 222)],
      [{ tg_user_id: 111, campaign_name: 'ATOL' }],
    );

    expect(result.fresh.map((c) => c.name)).toEqual(['b']);
    expect(result.skipped).toEqual([
      { name: 'a', reason: 'уже загружен в кампанию «ATOL»' },
    ]);
  });

  it('без названия кампании всё равно не пускает дубль', () => {
    const result = splitExistingAccounts(
      [candidate('a', 111)],
      [{ tg_user_id: 111, campaign_name: null }],
    );

    expect(result.fresh).toEqual([]);
    expect(result.skipped[0].reason).toBe('уже загружен в другую кампанию');
  });

  it('на пустой базе пропускает всех вперёд', () => {
    const result = splitExistingAccounts([candidate('a', 111)], []);

    expect(result.fresh).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
cd app && npx jest tests/lib/tgOutreach/tdataDedupe.test.ts
```

Ожидаемо: FAIL — `splitExistingAccounts is not a function`.

- [ ] **Step 3: Добавить сверку в `tdataImport.ts`**

В конец `app/src/lib/tgOutreach/tdataImport.ts`:

```ts
export interface ExistingAccountRow {
  tg_user_id: number;
  campaign_name: string | null;
}

/**
 * Развести кандидатов на новых и уже загруженных.
 *
 * Сверка идёт по всей базе, а не по текущей кампании: один ключ авторизации в
 * двух кампаниях — это два параллельных подключения и `AUTH_KEY_DUPLICATED`,
 * после которого Telegram рвёт сессию.
 */
export function splitExistingAccounts(
  candidates: TdataCandidate[],
  existing: ExistingAccountRow[],
): { fresh: TdataCandidate[]; skipped: TdataSkip[] } {
  const byUserId = new Map(existing.map((row) => [row.tg_user_id, row.campaign_name]));
  const fresh: TdataCandidate[] = [];
  const skipped: TdataSkip[] = [];

  for (const candidate of candidates) {
    if (!byUserId.has(candidate.tgUserId)) {
      fresh.push(candidate);
      continue;
    }
    const campaignName = byUserId.get(candidate.tgUserId);
    skipped.push({
      name: candidate.name,
      reason: campaignName
        ? `уже загружен в кампанию «${campaignName}»`
        : 'уже загружен в другую кампанию',
    });
  }

  return { fresh, skipped };
}
```

- [ ] **Step 4: Запустить тест**

```bash
cd app && npx jest tests/lib/tgOutreach/tdataDedupe.test.ts
```

Ожидаемо: PASS, 3 теста.

- [ ] **Step 5: Подключить ветку `.zip` в ручке**

В `app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts` добавить импорты:

```ts
import {
  collectTdataCandidates,
  splitExistingAccounts,
  type TdataSkip,
  type TdataError,
} from '@/lib/tgOutreach/tdataImport';
```

Сразу после проверки `if (!files?.length) …` (строка 55) вставить разделение по расширению:

```ts
      const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
      const plainFiles = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));
```

Ниже, в цикле раскладки файлов (строка 58), заменить `for (const file of files)` на `for (const file of plainFiles)`.

Проверку `if (ordered.length === 0)` (строка 88) заменить на:

```ts
      if (ordered.length === 0 && zipFiles.length === 0) {
        return jsonError('Нет валидных JSON-файлов с аккаунтами', 400);
      }
```

- [ ] **Step 6: Добавить обработку архивов перед вставкой**

В том же файле, сразу после проверки кампании (`if (campaignError || !campaign) …`, строка 97), вставить:

```ts
      // Клиент для записи объявляем один раз здесь: ниже он же используется
      // при вставке и при загрузке .session в хранилище.
      const db = supabaseAdmin ?? auth.supabase;

      // Аккаунты из tdata: архив читается в память, к Telegram не подключаемся.
      const tdataSkipped: TdataSkip[] = [];
      const tdataErrors: TdataError[] = [];
      let tdataRows: Array<Record<string, unknown>> = [];

      if (zipFiles.length) {
        const uploads = await Promise.all(
          zipFiles.map(async (file) => ({
            name: file.name,
            buffer: Buffer.from(await file.arrayBuffer()),
          })),
        );
        const collected = await collectTdataCandidates(uploads);
        tdataSkipped.push(...collected.skipped);
        tdataErrors.push(...collected.errors);

        const { data: existing } = await db
          .from('tg_outreach_accounts')
          .select('tg_user_id, tg_outreach_campaigns(name)')
          .in('tg_user_id', collected.candidates.map((c) => c.tgUserId));

        const existingRows = (existing ?? []).map((row) => {
          const campaign = (row as { tg_outreach_campaigns?: { name?: string } | null })
            .tg_outreach_campaigns;
          return {
            tg_user_id: Number((row as { tg_user_id: number }).tg_user_id),
            campaign_name: campaign?.name ?? null,
          };
        });

        const { fresh, skipped } = splitExistingAccounts(collected.candidates, existingRows);
        tdataSkipped.push(...skipped);

        tdataRows = fresh.map((candidate) => ({
          campaign_id: campaignId,
          session_name: candidate.name,
          api_id: candidate.apiId,
          api_hash: candidate.apiHash,
          phone: '',
          proxy_id: null,
          session_data: candidate.sessionString,
          tg_user_id: candidate.tgUserId,
          is_active: true,
        }));
      }
```

Затем в существующей вставке заменить строки 99-116 так, чтобы вставлялись обе пачки:

```ts
      const insertRows = [
        ...ordered.map(({ acc }) => ({
          campaign_id: campaignId,
          session_name: acc.session_name,
          api_id: acc.api_id,
          api_hash: acc.api_hash,
          phone: acc.phone ?? '',
          proxy_id: null,
          session_data: '',
          is_active: true,
        })),
        ...tdataRows,
      ];

      let inserted: Array<{ id: string; session_name: string }> = [];
      if (insertRows.length) {
        const { data, error: insertError } = await db
          .from('tg_outreach_accounts')
          .insert(insertRows)
          .select('id, session_name');
        if (insertError) return jsonError(insertError.message, 500);
        inserted = data ?? [];
      }
```

Дальше цикл загрузки `.session` в хранилище работает по `ordered`, а `ids[i]` берёт первые `ordered.length` строк — порядок сохранён, потому что `tdataRows` добавлены в конец. В ответ добавить отчёт:

```ts
      return NextResponse.json(
        {
          items: inserted,
          count: inserted.length,
          ...(tdataSkipped.length ? { skipped: tdataSkipped } : {}),
          ...(tdataErrors.length ? { errors: tdataErrors } : {}),
          ...(sessionConvertErrors.length
            ? { session_convert_errors: sessionConvertErrors }
            : {}),
        },
        { status: 201 },
      );
```

- [ ] **Step 7: Проверить типы и линт**

```bash
cd app && npx tsc --noEmit && npx eslint src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts src/lib/tgOutreach/tdataImport.ts src/lib/telegram
```

Ожидаемо: обе команды без ошибок.

- [ ] **Step 8: Коммит**

```bash
git add app/src/app/api/tools/tg-outreach/accounts/bulk-files/route.ts app/src/lib/tgOutreach/tdataImport.ts app/tests/lib/tgOutreach/tdataDedupe.test.ts
git commit -m "feat(tg-outreach): принимать zip с tdata в загрузке аккаунтов кампании"
```

---

### Task 7: Кнопка и отчёт в интерфейсе

**Files:**
- Modify: `app/src/app/tools/tg-outreach/page.tsx:1604-1652`

- [ ] **Step 1: Принимать `.zip`**

В `app/src/app/tools/tg-outreach/page.tsx` в поле загрузки (строка 1651) заменить `accept`:

```tsx
            <input type="file" multiple accept=".json,.session,.zip" className="hidden" onChange={e => { void handleFiles(e); }} />
```

Подпись «Загрузить файлы» оставить как есть, а во внешний `<label>` (строка 1648) дописать подсказку при наведении:

```tsx
            title="tdata — zip-архивами (можно сразу несколько), старый формат — парами .session и .json"
```

- [ ] **Step 2: Показать отчёт о загрузке**

Рядом с объявлением `uploadError` в `CampaignAccountsTab` добавить состояние:

```tsx
  const [uploadSummary, setUploadSummary] = useState<string | null>(null);
```

Заменить тело `handleFiles` (строки 1604-1627) на:

```tsx
  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    setUploadSummary(null);
    try {
      const token = await getAccessToken();
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));
      const res = await fetch(`${API_BASE}/accounts/bulk-files?campaign_id=${campaignId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const body = await res.json() as {
        error?: string;
        count?: number;
        skipped?: Array<{ name: string; reason: string }>;
        errors?: Array<{ name: string; error: string }>;
      };
      if (!res.ok) {
        setUploadError(body.error ?? 'Ошибка загрузки');
      } else {
        const parts = [`Добавлено аккаунтов: ${body.count ?? 0}`];
        if (body.skipped?.length) {
          parts.push(
            `Пропущено ${body.skipped.length}: ` +
            body.skipped.map(s => `${s.name} — ${s.reason}`).join('; '),
          );
        }
        if (body.errors?.length) {
          parts.push(
            `Не прочиталось ${body.errors.length}: ` +
            body.errors.map(x => `${x.name} — ${x.error}`).join('; '),
          );
        }
        setUploadSummary(parts.join('. '));
      }
    } finally {
      setUploading(false);
      void load();
    }
    e.target.value = '';
  };
```

- [ ] **Step 3: Вывести отчёт на экран**

Сразу после блока с `uploadError` (строки 1659-1661) добавить:

```tsx
      {uploadSummary && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <span>{uploadSummary}</span>
          <button type="button" onClick={() => setUploadSummary(null)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
```

- [ ] **Step 4: Проверить сборку и линт**

```bash
cd app && npx tsc --noEmit && npx eslint src/app/tools/tg-outreach/page.tsx
```

Ожидаемо: без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): загрузка tdata-архивов и отчёт о загрузке в интерфейсе"
```

---

### Task 8: Сохранять телефон при проверке аккаунта

`accountCheck.ts` уже забирает телефон из ответа Telegram, но ручка проверки сохраняет только `tg_user_id` и `tg_username`. У аккаунтов из `tdata` телефона нет физически, поэтому без этой правки колонка останется пустой навсегда.

**Files:**
- Modify: `app/src/app/api/tools/tg-outreach/accounts/[id]/check/route.ts:51-69`

- [ ] **Step 1: Расширить тип и сохранение**

В `save` добавить телефон в тип аргумента и в обновление:

```ts
      const save = async (result: {
        status: string;
        detail: string;
        other_sessions?: unknown[];
        tg_user_id?: number | null;
        tg_username?: string | null;
        phone?: string | null;
      }) => {
        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            check_status: result.status,
            check_detail: result.detail.slice(0, 500),
            checked_at: new Date().toISOString(),
            other_sessions: result.other_sessions ?? [],
            ...(result.tg_user_id != null ? { tg_user_id: result.tg_user_id } : {}),
            ...(result.tg_username != null ? { tg_username: result.tg_username } : {}),
            // Телефона в tdata нет — он приходит только от Telegram, и это
            // единственное место, где портал его узнаёт.
            ...(result.phone ? { phone: result.phone } : {}),
          })
          .eq('id', id);
      };
```

- [ ] **Step 2: Проверить типы**

```bash
cd app && npx tsc --noEmit
```

Ожидаемо: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add "app/src/app/api/tools/tg-outreach/accounts/[id]/check/route.ts"
git commit -m "fix(tg-outreach): сохранять телефон аккаунта, полученный при проверке"
```

---

### Task 9: Прогон на боевой партии и полные тесты

- [ ] **Step 1: Прогнать весь набор тестов**

```bash
cd app && npx jest tests/lib/telegram tests/lib/tgOutreach tests/lib/sessionUtils.test.ts
```

Ожидаемо: все тесты зелёные.

- [ ] **Step 2: Прогнать проект целиком**

```bash
cd app && npm test
```

Ожидаемо: падений, которых не было до начала работы, нет.

- [ ] **Step 3: Проверить на настоящих архивах**

Запустить портал (`npm run dev:next`), открыть кампанию → вкладка «Аккаунты» → «Загрузить файлы», выбрать все архивы из `G:\atol_акки\*.zip`.

Ожидаемо:
- в списке появляются аккаунты с именами вида `246630983`;
- повторная загрузка тех же архивов добавляет ноль аккаунтов и показывает «Пропущено 20: … уже загружен в кампанию …»;
- в базе у новых строк `api_id = 2040`, `session_data` длиной 353 символа, `tg_user_id` заполнен.

Проверка в базе:

```sql
select session_name, api_id, tg_user_id, length(session_data) as sess_len, phone
from tg_outreach_accounts
where campaign_id = '<id кампании>'
order by created_at desc
limit 25;
```

- [ ] **Step 4: Коммит, если что-то поправилось по итогам прогона**

Добавлять только свои файлы поимённо. В рабочей копии параллельно идут чужие
правки (`app/src/lib/leadsReport/`), `git add -A` утащил бы их в этот коммит.

```bash
git add app/src/lib/telegram app/src/lib/tgOutreach/tdataImport.ts app/tests/lib/telegram app/tests/lib/tgOutreach
git commit -m "fix(tg-outreach): правки по итогам прогона загрузки tdata"
```
