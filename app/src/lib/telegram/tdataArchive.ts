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
