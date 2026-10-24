import { pipeline, type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import { SaxesParser } from 'saxes';

import { classifyLicenceActivities, type LicenceGroupCode } from './licences';
import { validateFnsInn, validateFnsRegistryDate, validateFnsSmeZipEntryName } from './fnsSmeXml';

// unzipper 0.10 has no bundled TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as {
  Parse(options: { forceStream: true }): NodeJS.ReadWriteStream & AsyncIterable<{
    path: string;
    type: string;
    autodrain(): void;
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  }>;
};

const EXPECTED_FORMAT_VERSION = '4.06';
const MAX_XML_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVITY_CHARS = 300;

/** Лицензии одного юрлица из реестра МСП (ИП пропускаются: это персональные данные). */
export interface FnsSmeLicenceRecord {
  inn: string;
  /** ДатаСост документа, ДД.ММ.ГГГГ. */
  registryDate: string;
  activities: string[];
  issuers: string[];
  groups: LicenceGroupCode[];
}

export interface FnsSmeLicenceScan {
  entries: number;
  documents: number;
  legalEntities: number;
  legalEntitiesWithLicence: number;
  /** Пропущено: неверная контрольная сумма ИНН или формат даты. */
  invalidRecords: number;
  registryDate: string | null;
}

interface Doc { kind: string; date: string; inn: string; activities: string[]; issuers: string[] }

/**
 * Страница набора «Единый реестр МСП»: на ней ссылка на текущий файл и все
 * прежние. meta.csv того же набора отстаёт — 24.10.2026 последним в нём был
 * файл от 10.09, хотя 10.10 уже вышел.
 */
export const FNS_SME_DATASET_PAGE = 'https://www.nalog.gov.ru/opendata/7707329152-rsmp/';
const FNS_SME_FILE_BASE = 'https://file.nalog.ru/opendata/7707329152-rsmp/';

export interface FnsSmeRelease {
  name: string;
  /** Дата реестра из имени файла, ГГГГ-ММ-ДД. */
  date: string;
  url: string;
}

/** Новейший файл реестра со страницы набора: data-ДДММГГГГ-structure-ДДММГГГГ.zip. */
export function latestFnsSmeRelease(html: string): FnsSmeRelease | null {
  let latest: FnsSmeRelease | null = null;
  for (const name of new Set(html.match(/data-\d{8}-structure-\d{8}\.zip/g) ?? [])) {
    const digits = name.slice(5, 13);
    const date = `${digits.slice(4)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
    if (!Number.isFinite(Date.parse(date))) continue;
    if (!latest || date > latest.date) latest = { name, date, url: FNS_SME_FILE_BASE + name };
  }
  return latest;
}

/**
 * Читает ZIP реестра МСП потоком и отдаёт юрлица, у которых есть хотя бы одна
 * лицензия. Структура файла проверяется по корню и версии формата; ИНН — по
 * контрольной сумме, запись с неверным ИНН или датой пропускается и считается.
 */
export async function parseFnsSmeLicencesZip(input: {
  input: Readable;
  onRecord(record: FnsSmeLicenceRecord): Promise<void> | void;
}): Promise<FnsSmeLicenceScan> {
  const zip = unzipper.Parse({ forceStream: true });
  // pipe() не передаёт ошибку источника дальше: обрыв скачивания падал бы
  // необработанным 'error', а цикл ниже ждал бы вечно. pipeline() закрывает оба
  // потока и при раннем выходе из цикла. Ошибку отдаём и записи, которую сейчас
  // читаем: unzipper сообщает её только самому Parse, и чтение записи зависло бы.
  // Пропускаемой записи (autodrain) её не отдаём — у неё нет слушателя 'error'.
  let reading: { destroy(error?: Error): void } | null = null;
  pipeline(input.input, zip, (error) => { if (error) reading?.destroy(error); });
  const scan: FnsSmeLicenceScan = { entries: 0, documents: 0, legalEntities: 0, legalEntitiesWithLicence: 0, invalidRecords: 0, registryDate: null };
  for await (const entry of zip) {
    if (entry.type !== 'File' || !entry.path.toLowerCase().endsWith('.xml')) { entry.autodrain(); continue; }
    reading = entry as unknown as { destroy(error?: Error): void };
    validateFnsSmeZipEntryName(entry.path);
    scan.entries += 1;
    const pending: FnsSmeLicenceRecord[] = [];
    const parser = new SaxesParser({ xmlns: false, fileName: entry.path });
    const stack: string[] = [];
    let doc: Doc | null = null;
    let activity: string | null = null;
    parser.on('opentag', (tag) => {
      const attr = (name: string) => (typeof tag.attributes[name] === 'string' ? tag.attributes[name] as string : '');
      if (stack.length === 0) {
        if (tag.name !== 'Файл') throw new Error(`Unexpected XML root: ${tag.name}`);
        if (attr('ВерсФорм') !== EXPECTED_FORMAT_VERSION) throw new Error(`Unexpected ВерсФорм (format version): ${attr('ВерсФорм')}`);
      } else if (tag.name === 'Документ' && stack.length === 1) {
        doc = { kind: attr('ВидСубМСП'), date: attr('ДатаСост'), inn: '', activities: [], issuers: [] };
      } else if (doc) {
        if (tag.name === 'ОргВклМСП') doc.inn = attr('ИННЮЛ');
        else if (tag.name === 'СвЛиценз' && attr('ОргВыдЛиценз')) doc.issuers.push(attr('ОргВыдЛиценз').trim());
        else if (tag.name === 'НаимЛицВД') activity = '';
      }
      stack.push(tag.name);
    });
    parser.on('text', (text) => { if (activity !== null) activity += text; });
    parser.on('closetag', (tag) => {
      stack.pop();
      const current = doc as Doc | null;
      if (tag.name === 'НаимЛицВД' && current && activity !== null) {
        const value = activity.replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY_CHARS);
        if (value && !current.activities.includes(value)) current.activities.push(value);
        activity = null;
      } else if (tag.name === 'Документ' && current) {
        scan.documents += 1;
        if (current.kind === '1' && current.inn) {
          scan.legalEntities += 1;
          if (current.activities.length || current.issuers.length) {
            try {
              validateFnsInn(current.inn, 'legal_entity');
              validateFnsRegistryDate(current.date);
              scan.legalEntitiesWithLicence += 1;
              scan.registryDate ??= current.date;
              pending.push({ inn: current.inn, registryDate: current.date, activities: current.activities,
                issuers: [...new Set(current.issuers)], groups: classifyLicenceActivities(current.activities) });
            } catch {
              scan.invalidRecords += 1;
            }
          }
        }
        doc = null;
      }
    });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    // «Битый XML» — только ошибки разбора. Ошибка чтения потока (обрыв скачивания)
    // уходит как есть: иначе сетевой сбой выглядел бы в алерте как новый формат реестра.
    const xml = (step: () => void) => {
      try {
        step();
      } catch (error) {
        throw new Error(`Malformed or invalid XML in ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let bytes = 0;
    for await (const chunk of entry) {
      bytes += chunk.length;
      xml(() => {
        if (bytes > MAX_XML_ENTRY_BYTES) throw new Error('entry exceeds size limit');
        parser.write(decoder.decode(chunk, { stream: true }));
      });
    }
    reading = null;
    xml(() => {
      parser.write(decoder.decode());
      parser.close();
    });
    for (const record of pending) await input.onRecord(record);
  }
  return scan;
}
