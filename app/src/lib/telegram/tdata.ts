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
   * Отсутствующий файл — это `undefined`, а не исключение: библиотека проверяет
   * результат `stat` на истинность, чтобы выбрать между современным `key_datas`
   * и старой парой `key_data0`/`key_data1`. Если бросать, перебор обрывается на
   * первом же промахе и папка старого формата выглядит как «не tdata». Тот же
   * контракт у файловой системы поверх архива (Task 4) — оба пути ведут себя
   * одинаково именно там, где решается, читается папка или нет.
   *
   * Ошибку прав доступа при этом пропускаем наружу: она не должна выглядеть
   * как отсутствующий файл.
   *
   * `mtimeMs` отдаём под именем `lastModified`: по нему библиотека выбирает
   * более свежий файл из пары, которую Telegram Desktop держит на случай
   * обрыва записи.
   */
  stat: (async (path: string) => {
    try {
      const stats = await fsp.stat(path);
      return { size: stats.size, lastModified: stats.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }) as INodeFsLike['stat'],
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
 * `key_data`, отличить их снаружи нельзя — называем обе причины. Туда же
 * относим порчу на уровне файла (`invalid magic`, `md5 mismatch`): для
 * оператора это тот же случай «папка испорчена», а у кривого архива от
 * продавца он даже вероятнее, чем сбой расшифровки.
 *
 * Наружу английский текст библиотеки не выпускаем: отчёт о загрузке читает не
 * разработчик. Непонятную ошибку заворачиваем в русскую рамку, оригинал
 * оставляем в скобках — по нему разбираются, если дойдёт до разбора.
 */
export function describeTdataError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid password|failed to decrypt|invalid magic|md5 mismatch/i.test(msg)) {
    return 'папка под локальным паролем Telegram либо повреждена — снимите пароль в Telegram Desktop и переупакуйте';
  }
  if (/ENOENT|file not found/i.test(msg)) {
    return 'папка не похожа на tdata: не найден файл key_data';
  }
  if (/Unsupported version/i.test(msg)) {
    return `папка от более новой версии Telegram Desktop, чем понимает портал (${msg})`;
  }
  return `папку не удалось прочитать (${msg})`;
}

/**
 * То же, но для ошибки на конкретном аккаунте внутри папки.
 *
 * `key_data` тут уже прочитан, поэтому пропавший файл — это файл самого
 * аккаунта, и общий текст про `key_data` указывал бы не на тот файл.
 */
function describeAccountError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|file not found/i.test(msg)) {
    return 'не найден файл с данными аккаунта';
  }
  return describeTdataError(err);
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
    const where = `аккаунт №${index + 1} в папке`;

    // Оборачиваем только вызов библиотеки: у проверок ниже уже свой русский
    // текст, и заворачивать его ещё раз как «непонятную ошибку» незачем.
    const session = await convertFromTdata(tdata, index).catch((err: unknown) => {
      throw new Error(`${where}: ${describeAccountError(err)}`);
    });

    /**
     * Аккаунт без идентификатора не берём. Дальше по цепочке аккаунты
     * сравниваются между собой именно по `tgUserId`, и подставленный ноль
     * склеил бы два разных аккаунта в «дубль»: один молча потерялся бы, а
     * записанный в базу ноль отбивал бы все следующие такие загрузки.
     */
    const tgUserId = session.self?.userId;
    if (!tgUserId) {
      throw new Error(`${where}: не авторизован — Telegram Desktop не сохранил идентификатор пользователя`);
    }

    /**
     * Таблица дата-центров в библиотеке покрывает номера 1-5 и объявлена как
     * всегда заполненная, поэтому на незнакомом номере `primaryDcs` молча
     * приходит `undefined` — без этой проверки была бы не ошибка, а TypeError.
     */
    const dc = session.primaryDcs?.main;
    if (!dc) {
      throw new Error(`${where}: портал не знает дата-центр Telegram, на который ссылается аккаунт`);
    }

    accounts.push({
      index,
      tgUserId,
      sessionString: buildGramJsSessionString(dc.id, dc.ipAddress, dc.port, session.authKey),
    });
  }

  return accounts;
}
