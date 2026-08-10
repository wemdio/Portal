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
        flags: number;
        compressedSize: number;
        uncompressedSize: number;
        lastModifiedDateTime: Date;
        buffer(): Promise<Buffer>;
      }>;
    }>;
  };
};

/**
 * Служебные файлы tdata: сам ключ (`key_data*`) и блок авторизации аккаунта
 * (`<16 hex>*`). Суффикс `s` — «современный» вариант, `0`/`1` — старая пара,
 * из которой библиотека берёт свежую по дате.
 *
 * Всё остальное из архива не читаем вовсе: в полной папке Telegram Desktop
 * лежат гигабайты кэша и медиа, а нужные файлы весят единицы килобайт.
 * `map` в этот список не входит намеренно: его пишет `convertToTdata`, но
 * обратно не читает никто (`Tdata.open` берёт `key_data*`, `convertFromTdata` —
 * `<16 hex>*`), а `<16 hex>/map*` — это карта медиафайлов, единственная
 * по-настоящему тяжёлая запись настоящей tdata.
 */
const TDATA_FILE = /^(key_data|[0-9A-F]{16})(s|0|1)$/;

/**
 * Пределы на распаковку. Значения по умолчанию взяты с огромным запасом:
 * настоящий служебный файл весит меньше килобайта, а вся папка — около 740
 * байт, так что даже партия в тысячи аккаунтов не подходит к границе.
 *
 * Границы нужны потому, что архивы приходят от продавцов, то есть это
 * недоверенный ввод: 2000 записей по мегабайту нулей укладываются в 9 МБ zip и
 * заявляют 2 ГБ распаковки. Потолок на файл такую запись пропускает — она
 * ровно в мегабайт и влезает, — а ловит её именно предел раздутия. Один этот
 * сервер уже ложился от исчерпания ресурсов, см. post-mortem 23.07 в CLAUDE.md.
 */
export interface TdataArchiveLimits {
  /** Потолок на один служебный файл. */
  maxFileBytes?: number;
  /** Потолок на все служебные файлы архива вместе — единственная жёсткая граница памяти. */
  maxTotalBytes?: number;
  /** Во сколько раз записи позволено раздуться при распаковке. */
  maxCompressionRatio?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 200;

/** Пароль оператор снимает сам, поэтому у этого случая свой текст. */
const PASSWORD_MESSAGE = 'архив под паролем — распакуйте и переупакуйте без пароля';

/**
 * Ошибку zip-библиотеки перевести в текст для оператора.
 *
 * Наружу голые английские коды вроде `FILE_ENDED` не выпускаем: отчёт о
 * загрузке читает не разработчик. Оригинал оставляем в скобках — по нему
 * разбираются, если дойдёт до разбора.
 */
function describeArchiveError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/MISSING_PASSWORD|BAD_PASSWORD/i.test(msg)) return PASSWORD_MESSAGE;
  return `не удалось открыть архив: файл повреждён или это не zip (${msg})`;
}

export interface TdataArchiveItem {
  /** Имя, под которым аккаунты попадут в список кампании. */
  name: string;
  accounts: TdataAccount[];
  /**
   * Заполнено, если прочитать удалось не эту папку: `accounts` тогда пуст.
   * Соседние папки архива при этом загружаются — оператор грузит партию
   * целиком, и одна битая папка не должна отменять остальные.
   */
  error?: string;
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

/**
 * Папка, в которой лежит файл. Для файла в корне архива — пустая строка:
 * `lastIndexOf` вернул бы -1, и `slice(0, -1)` откусил бы последний символ,
 * превратив `key_datas` в несуществующую папку `key_data`.
 */
function dirname(p: string): string {
  const cut = p.lastIndexOf('/');
  return cut === -1 ? '' : p.slice(0, cut);
}

/**
 * Имя аккаунта — та папка пути, которая его называет.
 *
 * Обычно это владелец папки `tdata`, но часть продавцов кладёт служебные файлы
 * прямо в папку аккаунта. Слепо брать родителя нельзя: тогда `246630983/` и
 * `246210089/` из одного архива оба назвались бы именем архива и стали в списке
 * неразличимы. У tdata-строки пустой `phone`, а имя пользователя неизвестно до
 * «Проверить», так что имя — единственная зацепка оператора.
 */
function accountName(tdataDir: string, archiveName: string): string {
  const parts = tdataDir.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const own = last === 'tdata' ? parts[parts.length - 2] ?? '' : last;
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
  limits: TdataArchiveLimits = {},
): Promise<TdataArchiveItem[]> {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxRatio = limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO;

  let directory: Awaited<ReturnType<typeof unzipper.Open.buffer>>;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch (err) {
    throw new Error(describeArchiveError(err));
  }

  const files = new Map<string, { data: Buffer; lastModified: number }>();
  let totalBytes = 0;
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const p = normalize(entry.path);
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!TDATA_FILE.test(base)) continue;

    // Про пароль говорим до того, как записи отсеются: иначе зашифрованный
    // архив выглядел бы как «без tdata», и оператор не понял бы, что чинить.
    if (entry.flags & 0x1) throw new Error(PASSWORD_MESSAGE);

    if (entry.uncompressedSize > maxFileBytes) continue;
    // Запись, раздувающаяся сверх меры, — это zip-бомба: её просто не читаем,
    // так что в память она не попадает вовсе.
    if (entry.compressedSize >= 1 && entry.uncompressedSize / entry.compressedSize > maxRatio) {
      continue;
    }

    let data: Buffer;
    try {
      data = await entry.buffer();
    } catch {
      // Нераспаковываемая запись выпадает так же, как слишком большая:
      // папка, которой она нужна, ниже сама скажет, чего ей не хватило.
      continue;
    }

    // Заголовок zip — это заявление, а не факт: unzipper не обрезает поток
    // распаковки по `uncompressedSize`, поэтому меряем то, что реально пришло.
    if (data.length > maxFileBytes) continue;
    totalBytes += data.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(
        `в архиве слишком много служебных файлов tdata: распаковка вышла за ${maxTotalBytes} байт`,
      );
    }

    files.set(p, {
      data,
      lastModified: entry.lastModifiedDateTime?.getTime() ?? 0,
    });
  }

  const tdataDirs = [...files.keys()]
    .filter((p) => /(^|\/)key_data(s|0|1)$/.test(p))
    .map(dirname)
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .sort();

  if (!tdataDirs.length) {
    throw new Error('в архиве не найдена папка tdata');
  }

  const fsLike = memoryFs(files);
  const items: TdataArchiveItem[] = [];
  for (const dir of tdataDirs) {
    const name = accountName(dir, archiveName);
    try {
      items.push({ name, accounts: await readTdataAccounts(dir, fsLike) });
    } catch (err) {
      // Битая папка не отменяет соседние: в партии из двадцати аккаунтов
      // отказ седьмого не должен стоить оператору остальных девятнадцати.
      items.push({ name, accounts: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return items;
}
