/**
 * Минимальный читатель SQLite на чистом JS — ровно под одну задачу: достать
 * первую строку таблицы `sessions` из .session-файла Telethon.
 *
 * Зачем свой, когда есть пакет `sqlite3`: у него нативные биндинги, а образ
 * приложения ставит зависимости с `--ignore-scripts` (в нём нет ни Python, ни
 * компилятора — так задумано, см. комментарий в Dockerfile). Биндинги там
 * никогда не собирались, поэтому любое чтение .session из веб-контейнера
 * падало на `Could not locate the bindings file`, и аккаунты старого формата
 * (у которых пустая `session_data`) не подключались вовсе.
 *
 * Границы намеренные: только чтение, только таблицы (b-tree с rowid), только
 * записи, помещающиеся на одну страницу. Индексы, overflow-страницы, WAL и
 * запись не поддерживаются — файл Telethon занимает ~28 КБ и ничего из этого
 * не использует. Всё, что выходит за границы, здесь падает с внятной ошибкой,
 * а не разбирается наполовину: тихо вернуть мусор вместо ключа авторизации
 * гораздо хуже, чем не вернуть ничего.
 */

/** Значение колонки в том же виде, в каком его отдавал пакет `sqlite3`. */
export type SqliteValue = number | bigint | string | Buffer | null;

export type SqliteRow = Record<string, SqliteValue>;

const HEADER_MAGIC = 'SQLite format 3\u0000';
const FILE_HEADER_BYTES = 100;

/** Тип страницы b-дерева из первого байта её заголовка. */
const PAGE_INTERIOR_TABLE = 0x05;
const PAGE_LEAF_TABLE = 0x0d;

interface Database {
  buf: Buffer;
  pageSize: number;
  /** Полезная часть страницы: у Telethon резерва нет, но формат его допускает. */
  usableSize: number;
  encoding: 'utf8' | 'utf16le';
}

/**
 * Varint формата SQLite: до девяти байт, по семь бит в каждом, у последнего
 * (девятого) — все восемь. Считаем в BigInt, потому что rowid и целые колонки
 * законно бывают 64-битными; сузим до number уже на конкретном значении.
 */
function readVarint(buf: Buffer, offset: number): { value: bigint; length: number } {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = buf.readUInt8(offset + i);
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  return { value: (value << 8n) | BigInt(buf.readUInt8(offset + 8)), length: 9 };
}

/** Целое из файла отдаём как number, пока оно точно представимо. */
function narrowInt(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function openDatabase(buf: Buffer): Database {
  if (buf.length < FILE_HEADER_BYTES || buf.toString('latin1', 0, 16) !== HEADER_MAGIC) {
    throw new Error('файл не похож на базу SQLite (нет заголовка «SQLite format 3»)');
  }

  // Размер страницы 1 — это 65536: в два байта такое число не влезает.
  const rawPageSize = buf.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`недопустимый размер страницы: ${pageSize}`);
  }

  const usableSize = pageSize - buf.readUInt8(20);
  if (usableSize < 480) throw new Error(`недопустимый размер полезной части страницы: ${usableSize}`);

  // Версия чтения: 1 — обычный журнал, 2 — WAL. У WAL-базы свежие изменения
  // могут лежать в соседнем -wal, но SQLite сливает его в основной файл при
  // закрытии последнего соединения, а Telethon в принципе оставляет базу в
  // режиме журнала. Всё, что не 1 и не 2, — формат, которого мы не знаем.
  const readVersion = buf.readUInt8(19);
  if (readVersion !== 1 && readVersion !== 2) {
    throw new Error(`неизвестная версия формата чтения: ${readVersion}`);
  }

  const rawEncoding = buf.readUInt32BE(56);
  // 0 встречается в только что созданной базе и означает UTF-8.
  if (rawEncoding !== 0 && rawEncoding !== 1 && rawEncoding !== 2) {
    throw new Error(`кодировка текста ${rawEncoding} не поддерживается (нужна UTF-8 или UTF-16le)`);
  }

  return { buf, pageSize, usableSize, encoding: rawEncoding === 2 ? 'utf16le' : 'utf8' };
}

interface TableCell {
  rowid: bigint;
  payload: Buffer;
}

function readLeafCell(db: Database, offset: number): TableCell {
  const size = readVarint(db.buf, offset);
  const rowid = readVarint(db.buf, offset + size.length);
  const payloadLength = Number(size.value);
  const start = offset + size.length + rowid.length;

  // Порог, после которого SQLite уносит хвост записи на overflow-страницы.
  // Строка `sessions` — это ~300 байт при странице 4 КБ, до порога ей далеко.
  if (payloadLength > db.usableSize - 35) {
    throw new Error('запись не помещается на страницу; overflow-страницы не поддерживаются');
  }
  if (start + payloadLength > db.buf.length) {
    throw new Error('запись выходит за границы файла (файл обрезан?)');
  }

  return {
    rowid: BigInt.asIntN(64, rowid.value),
    payload: db.buf.subarray(start, start + payloadLength),
  };
}

/**
 * Обход таблицы в порядке rowid: внутренние страницы — слева направо, в конце
 * правый указатель. Тот же порядок, в котором `SELECT ... LIMIT 1` без ORDER BY
 * отдаёт «первую» строку, поэтому результат совпадает с прежним поведением.
 */
function* iterateTable(db: Database, pageNumber: number, seen: Set<number>): Generator<TableCell> {
  // Циклов в исправном дереве нет; проверка защищает от бесконечного обхода
  // испорченного файла.
  if (seen.has(pageNumber)) throw new Error(`страница ${pageNumber} встретилась дважды: b-дерево испорчено`);
  seen.add(pageNumber);

  const pageStart = (pageNumber - 1) * db.pageSize;
  if (pageNumber < 1 || pageStart + db.pageSize > db.buf.length) {
    throw new Error(`страницы ${pageNumber} нет в файле`);
  }

  // Заголовок первой страницы сдвинут на 100 байт заголовком файла.
  const header = pageStart + (pageNumber === 1 ? FILE_HEADER_BYTES : 0);
  const pageType = db.buf.readUInt8(header);
  if (pageType !== PAGE_LEAF_TABLE && pageType !== PAGE_INTERIOR_TABLE) {
    throw new Error(`страница ${pageNumber}: тип ${pageType} — это не b-дерево таблицы`);
  }

  const cellCount = db.buf.readUInt16BE(header + 3);
  const cellPointers = header + (pageType === PAGE_INTERIOR_TABLE ? 12 : 8);

  for (let i = 0; i < cellCount; i++) {
    const cellOffset = pageStart + db.buf.readUInt16BE(cellPointers + i * 2);
    if (pageType === PAGE_LEAF_TABLE) {
      yield readLeafCell(db, cellOffset);
    } else {
      yield* iterateTable(db, db.buf.readUInt32BE(cellOffset), seen);
    }
  }

  if (pageType === PAGE_INTERIOR_TABLE) {
    yield* iterateTable(db, db.buf.readUInt32BE(header + 8), seen);
  }
}

/**
 * Разбор записи: сначала заголовок с типами колонок, следом их значения
 * подряд. Типы описаны в формате SQLite: 0 — NULL, 1..6 — целые разной
 * ширины, 7 — double, 8 и 9 — сами константы 0 и 1, дальше чётные — BLOB,
 * нечётные — текст.
 */
function decodeRecord(db: Database, payload: Buffer): SqliteValue[] {
  const head = readVarint(payload, 0);
  const headerEnd = Number(head.value);
  if (headerEnd > payload.length) throw new Error('заголовок записи длиннее самой записи');

  const serialTypes: bigint[] = [];
  for (let p = head.length; p < headerEnd; ) {
    const serial = readVarint(payload, p);
    serialTypes.push(serial.value);
    p += serial.length;
  }

  const values: SqliteValue[] = [];
  let body = headerEnd;
  for (const serial of serialTypes) {
    const { value, length } = readColumn(db, payload, body, serial);
    values.push(value);
    body += length;
  }
  return values;
}

function readColumn(
  db: Database,
  payload: Buffer,
  offset: number,
  serial: bigint,
): { value: SqliteValue; length: number } {
  switch (serial) {
    case 0n: return { value: null, length: 0 };
    case 1n: return { value: payload.readInt8(offset), length: 1 };
    case 2n: return { value: payload.readInt16BE(offset), length: 2 };
    case 3n: return { value: (payload.readInt8(offset) << 16) | payload.readUInt16BE(offset + 1), length: 3 };
    case 4n: return { value: payload.readInt32BE(offset), length: 4 };
    // Шесть байт: читаем как беззнаковое (влезает в number) и добираем знак.
    case 5n: return { value: narrowInt(BigInt.asIntN(48, BigInt(payload.readUIntBE(offset, 6)))), length: 6 };
    case 6n: return { value: narrowInt(payload.readBigInt64BE(offset)), length: 8 };
    case 7n: return { value: payload.readDoubleBE(offset), length: 8 };
    case 8n: return { value: 0, length: 0 };
    case 9n: return { value: 1, length: 0 };
    case 10n:
    case 11n:
      throw new Error(`служебный тип колонки ${serial} во внешнем файле не бывает`);
    default: {
      const length = Number((serial - (serial % 2n === 0n ? 12n : 13n)) / 2n);
      if (offset + length > payload.length) throw new Error('значение колонки выходит за границы записи');
      const slice = payload.subarray(offset, offset + length);
      // Копируем BLOB: subarray смотрит в буфер всего файла, а вызывающий
      // держит ключ авторизации дольше, чем живёт этот разбор.
      return {
        value: serial % 2n === 0n ? Buffer.from(slice) : slice.toString(db.encoding),
        length,
      };
    }
  }
}

interface TableColumns {
  names: string[];
  /** Колонка, объявленная как INTEGER PRIMARY KEY: её значение лежит в rowid. */
  rowidAlias: string | null;
}

/** Снять кавычки любого из четырёх видов, которые допускает SQLite. */
function unquote(identifier: string): string {
  const trimmed = identifier.trim();
  if (/^".*"$/s.test(trimmed)) return trimmed.slice(1, -1).replace(/""/g, '"');
  if (/^`.*`$/s.test(trimmed)) return trimmed.slice(1, -1).replace(/``/g, '`');
  if (/^\[.*\]$/s.test(trimmed)) return trimmed.slice(1, -1);
  if (/^'.*'$/s.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

/** Разрезать тело CREATE TABLE по запятым верхнего уровня. */
function splitDefinitions(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Имена колонок и alias для rowid из текста CREATE TABLE.
 *
 * Alias важен: в схеме Telethon `dc_id integer primary key`, а такая колонка
 * в записи всегда хранится как NULL — настоящее значение лежит в rowid строки.
 * Без этого номер DC приезжал бы пустым, и строка сессии собиралась бы с
 * мусорным адресом.
 */
export function parseCreateTableColumns(sql: string): TableColumns {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('не удалось разобрать CREATE TABLE');

  const names: string[] = [];
  const declaredTypes = new Map<string, string>();
  let rowidAlias: string | null = null;
  let tablePrimaryKey: string | null = null;

  for (const definition of splitDefinitions(sql.slice(open + 1, close))) {
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(definition)) {
      const single = definition.match(/^primary\s+key\s*\(\s*([^),]+?)\s*\)/i);
      if (single) tablePrimaryKey = unquote(single[1]);
      continue;
    }

    const nameMatch = definition.match(/^("[^"]*(?:""[^"]*)*"|`[^`]*`|\[[^\]]*\]|[^\s(,]+)/);
    if (!nameMatch) continue;
    const name = unquote(nameMatch[0]);
    const rest = definition.slice(nameMatch[0].length).trim();
    names.push(name);
    declaredTypes.set(name, (rest.match(/^[a-z0-9_ ]+/i)?.[0] ?? '').trim().toLowerCase());

    // DESC отменяет alias: такая колонка хранится обычным индексом.
    if (/^integer\s+primary\s+key\b/i.test(rest) && !/^integer\s+primary\s+key\s+desc\b/i.test(rest)) {
      rowidAlias = name;
    }
  }

  // WITHOUT ROWID — таблица без rowid, alias'а там не бывает по определению.
  if (!rowidAlias && tablePrimaryKey && !/\bwithout\s+rowid\b/i.test(sql.slice(close))) {
    if (declaredTypes.get(tablePrimaryKey) === 'integer') rowidAlias = tablePrimaryKey;
  }

  return { names, rowidAlias };
}

/** Колонки служебной таблицы sqlite_schema — они зафиксированы форматом. */
const SCHEMA_COLUMNS = ['type', 'name', 'tbl_name', 'rootpage', 'sql'] as const;

/**
 * Первая строка таблицы по имени — эквивалент `SELECT * FROM <table> LIMIT 1`.
 * Возвращает null, если таблица есть, но пуста.
 */
export function readFirstRow(fileBuffer: Buffer, tableName: string): SqliteRow | null {
  const db = openDatabase(fileBuffer);

  let rootPage: number | null = null;
  let createSql: string | null = null;
  // Схема лежит в таблице на первой странице — обходим её так же, как любую другую.
  for (const cell of iterateTable(db, 1, new Set())) {
    const values = decodeRecord(db, cell.payload);
    const entry = Object.fromEntries(SCHEMA_COLUMNS.map((name, i) => [name, values[i] ?? null]));
    if (entry.type === 'table' && entry.name === tableName) {
      rootPage = Number(entry.rootpage);
      createSql = typeof entry.sql === 'string' ? entry.sql : null;
      break;
    }
  }

  if (rootPage === null || !createSql) throw new Error(`таблицы «${tableName}» нет в базе`);

  const { names, rowidAlias } = parseCreateTableColumns(createSql);
  for (const cell of iterateTable(db, rootPage, new Set())) {
    const values = decodeRecord(db, cell.payload);
    const row: SqliteRow = {};
    names.forEach((name, i) => {
      // Колонок в записи бывает меньше, чем в схеме, если таблицу расширяли
      // через ALTER TABLE после того, как строку записали.
      row[name] = name === rowidAlias ? narrowInt(cell.rowid) : (values[i] ?? null);
    });
    return row;
  }

  return null;
}
