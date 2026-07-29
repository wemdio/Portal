import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { crc32 } from 'node:zlib';

import { SaxesParser, type SaxesTagPlain } from 'saxes';

// unzipper 0.10 has no bundled TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as {
  Parse(options: { forceStream: true }): NodeJS.ReadWriteStream & AsyncIterable<{
    path: string;
    type: string;
    vars: {
      crc32: number;
      compressedSize: number;
      uncompressedSize: number;
    };
    size?: number;
    autodrain(): void;
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  }>;
};

const EXPECTED_FORMAT_VERSION = '4.06';
const EXPECTED_INFORMATION_TYPE = 'РЕЕСТРМСП';
const OKVED_CODE_PATTERN =
  /^\d{2}(?:\.\d|\.\d{2}(?:\.\d{1,2})?)?$/;
const REGISTRY_DATE_PATTERN =
  /^(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.\d{4}$/;
const MAX_XML_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_XML_ENTRIES = 100_000;

export type FnsSmeTaxpayerType =
  | 'legal_entity'
  | 'individual_entrepreneur';

export interface FnsSmeExactOkvedRecord {
  inn: string;
  ogrn: string;
  taxpayerType: FnsSmeTaxpayerType;
  okvedCodeExact: string;
  okvedVersion: '2001' | '2014';
  documentId: string;
  registryDate: string;
  sourceEntryName: string;
  sourceFileId: string;
}

export interface FnsSmeInvalidExactOkvedRecord
  extends FnsSmeExactOkvedRecord {
  reason: 'invalid_source_ogrn';
  validationError: string;
}

export interface FnsSmeXmlMetadata {
  entryName: string;
  fileId: string;
  formatVersion: string;
  informationType: string;
  declaredDocumentCount: number;
  registryDate: string;
}

export interface FnsSmeXmlMetrics {
  documentCount: number;
  emittedRecordCount: number;
  skippedWithoutMainOkvedCount: number;
  skippedInvalidOgrnCount: number;
}

export interface FnsSmeXmlParseResult {
  metadata: FnsSmeXmlMetadata;
  metrics: FnsSmeXmlMetrics;
}

export interface FnsSmeZipParseResult {
  entries: Array<FnsSmeXmlMetadata & FnsSmeXmlMetrics>;
  metrics: FnsSmeXmlMetrics & {
    xmlEntryCount: number;
    compressedBytes: number;
    uncompressedBytes: number;
  };
}

export interface FnsSmeExpectedZipEntry {
  entryName: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}

interface CurrentDocument {
  documentId: string;
  registryDate: string;
  taxpayerType: FnsSmeTaxpayerType | null;
  inn: string | null;
  ogrn: string | null;
  ogrnValidationError: string | null;
  okvedCodeExact: string | null;
  okvedVersion: '2001' | '2014' | null;
}

type XmlInput = AsyncIterable<Buffer | Uint8Array | string>;

function attribute(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredAttribute(
  tag: SaxesTagPlain,
  name: string,
  label: string,
): string {
  const value = attribute(tag, name);
  if (!value) {
    throw new Error(`${label} (${name}) is missing`);
  }
  return value;
}

function parseDeclaredCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('КолДок (document count) must be a non-negative integer');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error('КолДок (document count) is outside the safe range');
  }
  return count;
}

export function validateFnsInn(
  inn: string,
  taxpayerType: FnsSmeTaxpayerType,
): void {
  const expectedLength = taxpayerType === 'legal_entity' ? 10 : 12;
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(inn)) {
    throw new Error(
      `ИНН (${taxpayerType}) must contain exactly ${expectedLength} digits`,
    );
  }
  const digits = [...inn].map(Number);
  if (taxpayerType === 'legal_entity') {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    const checksum = (
      weights.reduce((sum, weight, index) =>
        sum + weight * digits[index], 0
      ) % 11
    ) % 10;
    if (checksum !== digits[9]) {
      throw new Error(`ИНН ${inn} has an invalid checksum`);
    }
    return;
  }

  const firstWeights = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const secondWeights = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const firstChecksum = (
    firstWeights.reduce((sum, weight, index) =>
      sum + weight * digits[index], 0
    ) % 11
  ) % 10;
  const secondChecksum = (
    secondWeights.reduce((sum, weight, index) =>
      sum + weight * digits[index], 0
    ) % 11
  ) % 10;
  if (firstChecksum !== digits[10] || secondChecksum !== digits[11]) {
    throw new Error(`ИНН ${inn} has an invalid checksum`);
  }
}

function fnsOgrnRules(taxpayerType: FnsSmeTaxpayerType): {
  isLegalEntity: boolean;
  expectedLength: 13 | 15;
  label: 'ОГРН' | 'ОГРНИП';
} {
  const isLegalEntity = taxpayerType === 'legal_entity';
  return {
    isLegalEntity,
    expectedLength: isLegalEntity ? 13 : 15,
    label: isLegalEntity ? 'ОГРН' : 'ОГРНИП',
  };
}

export function validateFnsOgrnStructure(
  ogrn: string,
  taxpayerType: FnsSmeTaxpayerType,
): void {
  const { expectedLength, label } = fnsOgrnRules(taxpayerType);
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(ogrn)) {
    throw new Error(
      `${label} (${taxpayerType}) must contain exactly `
      + `${expectedLength} digits`,
    );
  }
}

export function validateFnsOgrn(
  ogrn: string,
  taxpayerType: FnsSmeTaxpayerType,
): void {
  validateFnsOgrnStructure(ogrn, taxpayerType);
  const { isLegalEntity, label } = fnsOgrnRules(taxpayerType);
  const checkDivisor = isLegalEntity ? BigInt(11) : BigInt(13);
  const payload = BigInt(ogrn.slice(0, -1));
  const expectedChecksum = Number((payload % checkDivisor) % BigInt(10));
  const actualChecksum = Number(ogrn.at(-1));
  if (expectedChecksum !== actualChecksum) {
    throw new Error(`${label} ${ogrn} has an invalid checksum`);
  }
}

export function validateFnsOkvedCode(value: string): void {
  if (!OKVED_CODE_PATTERN.test(value)) {
    throw new Error(`ОКВЭД code has an invalid XSD format: ${value}`);
  }
}

export function validateFnsRegistryDate(value: string): void {
  if (!REGISTRY_DATE_PATTERN.test(value)) {
    throw new Error(`ДатаСост (registry date) has an invalid format: ${value}`);
  }
}

export function validateFnsSmeZipEntryName(entryName: string): string {
  if (
    !entryName
    || entryName.includes('\\')
    || entryName.startsWith('/')
    || /^[a-z]:/i.test(entryName)
    || entryName.split('/').some((segment) =>
      segment === '' || segment === '.' || segment === '..'
    )
    || basename(entryName) !== entryName
  ) {
    throw new Error(`Unsafe or nested ZIP entry path: ${entryName}`);
  }
  if (!/\.xml$/i.test(entryName)) {
    throw new Error(`Unexpected non-XML ZIP entry: ${entryName}`);
  }
  return entryName.slice(0, -4);
}

export async function parseFnsSmeXmlStream(input: {
  input: XmlInput;
  entryName: string;
  onRecord(record: FnsSmeExactOkvedRecord): Promise<void> | void;
  onInvalidIdentity(
    record: FnsSmeInvalidExactOkvedRecord,
  ): Promise<void> | void;
}): Promise<FnsSmeXmlParseResult> {
  const expectedFileId = validateFnsSmeZipEntryName(input.entryName);
  const parser = new SaxesParser({ xmlns: false, fileName: input.entryName });
  const stack: string[] = [];
  const pendingRecords: FnsSmeExactOkvedRecord[] = [];
  const pendingInvalidRecords: FnsSmeInvalidExactOkvedRecord[] = [];
  let currentDocument: CurrentDocument | null = null;
  let fileId: string | null = null;
  let formatVersion: string | null = null;
  let informationType: string | null = null;
  let declaredDocumentCount: number | null = null;
  let registryDate: string | null = null;
  let documentCount = 0;
  let skippedWithoutMainOkvedCount = 0;
  let skippedInvalidOgrnCount = 0;
  let parserError: Error | null = null;

  parser.on('error', (error) => {
    parserError = error;
    throw error;
  });

  parser.on('opentag', (tag) => {
    if (stack.length === 0) {
      if (tag.name !== 'Файл') {
        throw new Error(`Unexpected XML root: ${tag.name}`);
      }
      fileId = requiredAttribute(tag, 'ИдФайл', 'File id');
      if (fileId !== expectedFileId) {
        throw new Error(
          `ИдФайл does not match ZIP entry name: ${fileId} != ${expectedFileId}`,
        );
      }
      formatVersion = requiredAttribute(tag, 'ВерсФорм', 'Format version');
      if (formatVersion !== EXPECTED_FORMAT_VERSION) {
        throw new Error(
          `Unexpected ВерсФорм (format version): ${formatVersion}`,
        );
      }
      informationType = requiredAttribute(
        tag,
        'ТипИнф',
        'Information type',
      );
      if (informationType !== EXPECTED_INFORMATION_TYPE) {
        throw new Error(
          `Unexpected ТипИнф (information type): ${informationType}`,
        );
      }
      declaredDocumentCount = parseDeclaredCount(
        requiredAttribute(tag, 'КолДок', 'Document count'),
      );
    } else if (
      tag.name === 'Документ'
      && stack.length === 1
      && stack[0] === 'Файл'
    ) {
      if (currentDocument !== null) {
        throw new Error('Nested Документ elements are not allowed');
      }
      const documentRegistryDate = requiredAttribute(
        tag,
        'ДатаСост',
        'Registry date',
      );
      validateFnsRegistryDate(documentRegistryDate);
      if (
        registryDate !== null
        && registryDate !== documentRegistryDate
      ) {
        throw new Error(
          `Different ДатаСост (registry date) values in ${input.entryName}`,
        );
      }
      registryDate = documentRegistryDate;
      currentDocument = {
        documentId: requiredAttribute(tag, 'ИдДок', 'Document id'),
        registryDate: documentRegistryDate,
        taxpayerType: null,
        inn: null,
        ogrn: null,
        ogrnValidationError: null,
        okvedCodeExact: null,
        okvedVersion: null,
      };
    } else if (
      currentDocument !== null
      && stack.length === 2
      && stack[0] === 'Файл'
      && stack[1] === 'Документ'
      && (tag.name === 'ОргВклМСП' || tag.name === 'ИПВклМСП')
    ) {
      if (currentDocument.taxpayerType !== null) {
        throw new Error(
          `Document ${currentDocument.documentId} has multiple taxpayer identities`,
        );
      }
      const taxpayerType: FnsSmeTaxpayerType =
        tag.name === 'ОргВклМСП'
          ? 'legal_entity'
          : 'individual_entrepreneur';
      const inn = requiredAttribute(
        tag,
        taxpayerType === 'legal_entity' ? 'ИННЮЛ' : 'ИННФЛ',
        'ИНН',
      );
      const ogrn = requiredAttribute(
        tag,
        taxpayerType === 'legal_entity' ? 'ОГРН' : 'ОГРНИП',
        taxpayerType === 'legal_entity' ? 'ОГРН' : 'ОГРНИП',
      );
      validateFnsInn(inn, taxpayerType);
      validateFnsOgrnStructure(ogrn, taxpayerType);
      let ogrnValidationError: string | null = null;
      try {
        validateFnsOgrn(ogrn, taxpayerType);
      } catch (error) {
        ogrnValidationError = error instanceof Error
          ? error.message
          : String(error);
      }
      currentDocument.taxpayerType = taxpayerType;
      currentDocument.inn = inn;
      currentDocument.ogrn = ogrn;
      currentDocument.ogrnValidationError = ogrnValidationError;
    } else if (
      currentDocument !== null
      && tag.name === 'СвОКВЭДОсн'
      && stack.length === 3
      && stack[0] === 'Файл'
      && stack[1] === 'Документ'
      && stack[2] === 'СвОКВЭД'
    ) {
      if (currentDocument.okvedCodeExact !== null) {
        throw new Error(
          `Document ${currentDocument.documentId} has multiple main ОКВЭД values`,
        );
      }
      const code = requiredAttribute(tag, 'КодОКВЭД', 'ОКВЭД code');
      validateFnsOkvedCode(code);
      const version = requiredAttribute(tag, 'ВерсОКВЭД', 'ОКВЭД version');
      if (version !== '2001' && version !== '2014') {
        throw new Error(`Unexpected ВерсОКВЭД: ${version}`);
      }
      currentDocument.okvedCodeExact = code;
      currentDocument.okvedVersion = version;
    }
    stack.push(tag.name);
  });

  parser.on('closetag', (tag) => {
    const opened = stack.pop();
    if (opened !== tag.name) {
      throw new Error(
        `Malformed XML: expected closing ${String(opened)}, got ${tag.name}`,
      );
    }
    if (
      tag.name !== 'Документ'
      || stack.length !== 1
      || stack[0] !== 'Файл'
    ) {
      return;
    }
    if (currentDocument === null) {
      throw new Error('Closing Документ without an active document');
    }
    documentCount += 1;
    if (
      currentDocument.taxpayerType === null
      || currentDocument.inn === null
      || currentDocument.ogrn === null
    ) {
      throw new Error(
        `Document ${currentDocument.documentId} has no valid ИНН/ОГРН identity`,
      );
    }
    if (currentDocument.okvedCodeExact === null) {
      skippedWithoutMainOkvedCount += 1;
    } else {
      if (currentDocument.okvedVersion === null) {
        throw new Error(
          `Document ${currentDocument.documentId} has no ВерсОКВЭД`,
        );
      }
      const record: FnsSmeExactOkvedRecord = {
        inn: currentDocument.inn,
        ogrn: currentDocument.ogrn,
        taxpayerType: currentDocument.taxpayerType,
        okvedCodeExact: currentDocument.okvedCodeExact,
        okvedVersion: currentDocument.okvedVersion,
        documentId: currentDocument.documentId,
        registryDate: currentDocument.registryDate,
        sourceEntryName: input.entryName,
        sourceFileId: fileId as string,
      };
      if (currentDocument.ogrnValidationError === null) {
        pendingRecords.push(record);
      } else {
        skippedInvalidOgrnCount += 1;
        pendingInvalidRecords.push({
          ...record,
          reason: 'invalid_source_ogrn',
          validationError: currentDocument.ogrnValidationError,
        });
      }
    }
    currentDocument = null;
  });

  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of input.input) {
      if (parserError !== null) throw parserError;
      if (typeof chunk === 'string') {
        parser.write(chunk);
      } else {
        parser.write(decoder.decode(chunk, { stream: true }));
      }
    }
    parser.write(decoder.decode());
    parser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed or invalid XML in ${input.entryName}: ${message}`);
  }

  if (
    fileId === null
    || formatVersion === null
    || informationType === null
    || declaredDocumentCount === null
  ) {
    throw new Error(`XML metadata is incomplete in ${input.entryName}`);
  }
  if (documentCount !== declaredDocumentCount) {
    throw new Error(
      `КолДок (document count) mismatch in ${input.entryName}: `
      + `declared ${declaredDocumentCount}, parsed ${documentCount}`,
    );
  }
  if (documentCount > 0 && registryDate === null) {
    throw new Error(`ДатаСост (registry date) is missing in ${input.entryName}`);
  }

  for (const record of pendingRecords) {
    await input.onRecord(record);
  }
  for (const record of pendingInvalidRecords) {
    await input.onInvalidIdentity(record);
  }

  return {
    metadata: {
      entryName: input.entryName,
      fileId,
      formatVersion,
      informationType,
      declaredDocumentCount,
      registryDate: registryDate ?? '',
    },
    metrics: {
      documentCount,
      emittedRecordCount: pendingRecords.length,
      skippedWithoutMainOkvedCount,
      skippedInvalidOgrnCount,
    },
  };
}

function toUnsignedCrc(value: number): number {
  return value >>> 0;
}

export async function parseFnsSmeZipStream(input: {
  input: Readable;
  onRecord(record: FnsSmeExactOkvedRecord): Promise<void> | void;
  onInvalidIdentity(
    record: FnsSmeInvalidExactOkvedRecord,
  ): Promise<void> | void;
  expectedEntries?: ReadonlyMap<string, FnsSmeExpectedZipEntry>;
}): Promise<FnsSmeZipParseResult> {
  const zipParser = unzipper.Parse({ forceStream: true });
  input.input.pipe(zipParser);

  const entries: Array<FnsSmeXmlMetadata & FnsSmeXmlMetrics> = [];
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let documentCount = 0;
  let emittedRecordCount = 0;
  let skippedWithoutMainOkvedCount = 0;
  let skippedInvalidOgrnCount = 0;
  const seenEntryNames = new Set<string>();

  for await (const entry of zipParser) {
    if (entries.length >= MAX_XML_ENTRIES) {
      throw new Error(`ZIP contains more than ${MAX_XML_ENTRIES} XML entries`);
    }
    validateFnsSmeZipEntryName(entry.path);
    if (seenEntryNames.has(entry.path)) {
      throw new Error(`Duplicate ZIP entry name: ${entry.path}`);
    }
    seenEntryNames.add(entry.path);
    const expectedEntry = input.expectedEntries?.get(entry.path);
    if (input.expectedEntries && !expectedEntry) {
      throw new Error(`Unexpected ZIP entry not present in inspection: ${entry.path}`);
    }
    if (entry.type !== 'File') {
      entry.autodrain();
      throw new Error(`Unexpected non-file ZIP entry: ${entry.path}`);
    }
    const declaredUncompressedSize = (
      expectedEntry?.uncompressedSize
      ?? entry.vars.uncompressedSize
    );
    if (declaredUncompressedSize > MAX_XML_ENTRY_BYTES) {
      entry.autodrain();
      throw new Error(`ZIP entry is too large: ${entry.path}`);
    }

    let actualBytes = 0;
    let actualCrc = 0;
    const meteredInput = (async function* (): AsyncGenerator<Buffer> {
      for await (const chunk of entry) {
        actualBytes += chunk.length;
        if (actualBytes > MAX_XML_ENTRY_BYTES) {
          throw new Error(`ZIP entry exceeds size limit: ${entry.path}`);
        }
        actualCrc = crc32(chunk, actualCrc);
        yield chunk;
      }
    })();

    const result = await parseFnsSmeXmlStream({
      input: meteredInput,
      entryName: entry.path,
      onRecord: input.onRecord,
      onInvalidIdentity: input.onInvalidIdentity,
    });
    const expectedSize = Number(
      expectedEntry?.uncompressedSize
      ?? entry.vars.uncompressedSize
      ?? entry.size
      ?? 0,
    );
    const expectedCrc = toUnsignedCrc(Number(
      expectedEntry?.crc32 ?? entry.vars.crc32,
    ));
    if (expectedSize > 0 && actualBytes !== expectedSize) {
      throw new Error(
        `ZIP entry size mismatch for ${entry.path}: `
        + `expected ${expectedSize}, got ${actualBytes}`,
      );
    }
    // Streaming ZIPs may place CRC/size only in a trailing data descriptor.
    // unzipper exposes its final size but not the descriptor CRC. File-based
    // production imports additionally pin CRCs from the central directory.
    if (
      (expectedEntry !== undefined || expectedCrc !== 0)
      && toUnsignedCrc(actualCrc) !== expectedCrc
    ) {
      throw new Error(`ZIP CRC mismatch for ${entry.path}`);
    }

    compressedBytes += Number(
      expectedEntry?.compressedSize ?? entry.vars.compressedSize,
    );
    uncompressedBytes += actualBytes;
    documentCount += result.metrics.documentCount;
    emittedRecordCount += result.metrics.emittedRecordCount;
    skippedWithoutMainOkvedCount +=
      result.metrics.skippedWithoutMainOkvedCount;
    skippedInvalidOgrnCount += result.metrics.skippedInvalidOgrnCount;
    entries.push({
      ...result.metadata,
      ...result.metrics,
    });
  }

  if (entries.length === 0) {
    throw new Error('ZIP archive contains no XML entries');
  }
  if (
    input.expectedEntries
    && seenEntryNames.size !== input.expectedEntries.size
  ) {
    throw new Error(
      `ZIP entry count changed after inspection: `
      + `expected ${input.expectedEntries.size}, parsed ${seenEntryNames.size}`,
    );
  }
  const registryDates = new Set(entries.map((entry) => entry.registryDate));
  if (registryDates.size !== 1) {
    throw new Error('ZIP XML entries contain different registry dates');
  }

  return {
    entries,
    metrics: {
      xmlEntryCount: entries.length,
      compressedBytes,
      uncompressedBytes,
      documentCount,
      emittedRecordCount,
      skippedWithoutMainOkvedCount,
      skippedInvalidOgrnCount,
    },
  };
}

export function mergeFnsSmeExactOkvedRecord(
  index: Map<string, FnsSmeExactOkvedRecord>,
  incoming: FnsSmeExactOkvedRecord,
):
  | {
    status: 'added';
    record: FnsSmeExactOkvedRecord;
  }
  | {
    status: 'duplicate_same';
    record: FnsSmeExactOkvedRecord;
    duplicate: FnsSmeExactOkvedRecord;
  } {
  const existing = index.get(incoming.ogrn);
  if (!existing) {
    index.set(incoming.ogrn, incoming);
    return {
      status: 'added',
      record: incoming,
    };
  }
  if (
    existing.inn !== incoming.inn
    || existing.taxpayerType !== incoming.taxpayerType
    || existing.okvedCodeExact !== incoming.okvedCodeExact
    || existing.okvedVersion !== incoming.okvedVersion
  ) {
    throw new Error(
      `Conflicting FNS identity or main ОКВЭД values for OGRN `
      + `${incoming.ogrn}: `
      + `${existing.inn}/${existing.okvedCodeExact}/${existing.okvedVersion} `
      + `vs ${incoming.inn}/${incoming.okvedCodeExact}/`
      + `${incoming.okvedVersion}`,
    );
  }
  return {
    status: 'duplicate_same',
    record: existing,
    duplicate: incoming,
  };
}
