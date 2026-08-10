import fsp from 'fs/promises';
import { Tdata, convertFromTdata, type INodeFsLike } from '@mtcute/convert';
import { createTdataCrypto } from './tdataCrypto';
import { buildGramJsSessionString } from './sessionUtils';

/**
 * Обычная папка на диске в виде интерфейса, которым библиотека ходит за файлами.
 *
 * Библиотека умеет взять `node:fs/promises` сама, но делает это динамическим
 * `import()` уже внутри `Tdata.open`. В песочнице jest такой импорт запрещён
 * (нужен флаг `--experimental-vm-modules`, которого нет ни в `npm test`, ни в
 * CI), поэтому передаём файловую систему явно. Заодно диск и архив из Task 4
 * идут одной дорогой: библиотека всегда работает через переданный интерфейс.
 */
export const nodeFsLike: INodeFsLike = {
  readFile: (path) => fsp.readFile(path),
  writeFile: (path, data) => fsp.writeFile(path, data),
  mkdir: async (path, options) => {
    await fsp.mkdir(path, options);
  },
  /**
   * `stat` на несуществующем файле бросает ENOENT — на это опирается разбор
   * ошибок ниже. `mtimeMs` отдаём под именем `lastModified`: по нему библиотека
   * выбирает более свежий файл из пары key_data0/key_data1, которую Telegram
   * Desktop держит на случай обрыва записи.
   */
  stat: async (path) => {
    const stats = await fsp.stat(path);
    return { size: stats.size, lastModified: stats.mtimeMs };
  },
};

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
 * читаем обычную папку через `nodeFsLike`.
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
      fs: fsLike ?? nodeFsLike,
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
