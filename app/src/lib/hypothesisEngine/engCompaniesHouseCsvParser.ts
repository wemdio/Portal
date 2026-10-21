/**
 * Free Company Data Product, not the officers/PSC datasets.
 * https://resources.companieshouse.gov.uk/toolsToHelp/pdf/freeDataProductDataset.pdf
 * The published CSV has whitespace around some header names. Keep company
 * numbers as text and do not infer a country or convert legacy four-digit SIC.
 */
export const HE_ENG_COMPANIES_HOUSE_CSV_HEADERS = [
  'CompanyName', 'CompanyNumber', 'RegAddress.AddressLine1', 'RegAddress.AddressLine2',
  'RegAddress.PostTown', 'RegAddress.Country', 'RegAddress.PostCode', 'CompanyStatus',
  'SICCode.SicText_1', 'SICCode.SicText_2', 'SICCode.SicText_3', 'SICCode.SicText_4',
] as const;

export const HE_ENG_COMPANIES_HOUSE_CSV_LIMITS = Object.freeze({
  fieldChars: 16_384,
  recordChars: 131_072,
  columns: 128,
  decodeBytes: 65_536,
});

export interface HeEngCompaniesHouseCsvRow {
  company_number: string;
  company_name: string;
  company_status: 'active';
  sic_codes: string[];
  registered_office_address: {
    address_line_1: string;
    address_line_2: string;
    locality: string;
    postal_code: string;
    country: string;
  };
}

type CsvFailure = 'invalid_utf8' | 'invalid_chunk' | 'malformed_csv' | 'field_limit' |
  'record_limit' | 'column_limit' | 'missing_header' | 'duplicate_header' | 'row_width';

/** Diagnostic metadata never includes a name, address, field value or raw row. */
export class HeEngCompaniesHouseCsvError extends Error {
  constructor(readonly reason: CsvFailure, readonly recordNumber: number) {
    super(`ENG Companies House CSV: ${reason} at record ${recordNumber}`);
    this.name = 'HeEngCompaniesHouseCsvError';
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Normalize a decoded record. Inactive or unidentified companies are omitted. */
export function mapHeEngCompaniesHouseCsvRow(raw: Readonly<Record<string, string>>): HeEngCompaniesHouseCsvRow | null {
  const companyNumber = clean(raw.CompanyNumber);
  const companyName = clean(raw.CompanyName);
  if (!/^[A-Z0-9]{8}$/.test(companyNumber) || !companyName || clean(raw.CompanyStatus).toLowerCase() !== 'active') return null;
  const sicCodes = [...new Set([1, 2, 3, 4].flatMap(index => {
    const match = /^(\d{5})(?=$|[\s-])/.exec(clean(raw[`SICCode.SicText_${index}`]));
    return match ? [match[1]] : [];
  }))];
  return {
    company_number: companyNumber,
    company_name: companyName,
    company_status: 'active',
    sic_codes: sicCodes,
    registered_office_address: {
      address_line_1: clean(raw['RegAddress.AddressLine1']),
      address_line_2: clean(raw['RegAddress.AddressLine2']),
      locality: clean(raw['RegAddress.PostTown']),
      postal_code: clean(raw['RegAddress.PostCode']),
      country: clean(raw['RegAddress.Country']),
    },
  };
}

/**
 * Accepts Node Readable byte streams or any asynchronous byte iterable. Memory
 * is bounded by one record and a small decoding window, not the archive size.
 * Bad CSV aborts the import: silently skipping it could shift legal identities.
 */
export async function* parseHeEngCompaniesHouseCsv(
  input: AsyncIterable<Uint8Array>,
  options: { signal?: AbortSignal; onActivity?: () => void } = {},
): AsyncGenerator<HeEngCompaniesHouseCsvRow> {
  const limits = HE_ENG_COMPANIES_HOUSE_CSV_LIMITS;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let headers: string[] | null = null;
  let fieldIndexes: number[] = [];
  let recordNumber = 1;
  let recordChars = 0;
  let field = '';
  let fields: string[] = [];
  let mode: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let skipLf = false;
  let touched = false;
  const fail = (reason: CsvFailure): never => { throw new HeEngCompaniesHouseCsvError(reason, recordNumber); };
  const append = (char: string) => {
    if (field.length + char.length > limits.fieldChars) fail('field_limit');
    field += char;
  };
  const endField = () => {
    if (fields.length >= limits.columns) fail('column_limit');
    fields.push(field);
    field = '';
    mode = 'start';
  };
  const endRecord = (): HeEngCompaniesHouseCsvRow | null => {
    endField();
    const row = fields;
    fields = [];
    recordChars = 0;
    touched = false;
    if (row.length === 1 && !row[0].trim()) { recordNumber++; return null; }
    let mapped: HeEngCompaniesHouseCsvRow | null = null;
    if (!headers) {
      const names = row.map(value => value.trim());
      if (names.some(value => !value) || new Set(names).size !== names.length) fail('duplicate_header');
      if (HE_ENG_COMPANIES_HOUSE_CSV_HEADERS.some(name => !names.includes(name))) fail('missing_header');
      headers = names;
      fieldIndexes = HE_ENG_COMPANIES_HOUSE_CSV_HEADERS.map(name => names.indexOf(name));
    } else {
      if (row.length !== headers.length) fail('row_width');
      const raw = Object.create(null) as Record<string, string>;
      // Only retain required company fields, never officers/previous names or
      // unrelated extra columns from a future revision of the bulk dataset.
      for (let index = 0; index < fieldIndexes.length; index++) raw[HE_ENG_COMPANIES_HOUSE_CSV_HEADERS[index]] = row[fieldIndexes[index]];
      mapped = mapHeEngCompaniesHouseCsvRow(raw);
    }
    recordNumber++;
    return mapped;
  };
  function* consume(chunk: string): Generator<HeEngCompaniesHouseCsvRow> {
    for (const char of chunk) {
      if (skipLf) { skipLf = false; if (char === '\n') continue; }
      if (++recordChars > limits.recordChars) fail('record_limit');
      if (char === '\0') fail('malformed_csv');
      if (mode === 'quoted') {
        touched = true;
        if (char === '"') mode = 'closed';
        else append(char);
        continue;
      }
      if (char === '\r' || char === '\n') {
        skipLf = char === '\r';
        const row = endRecord();
        if (row) { options.signal?.throwIfAborted(); yield row; }
        continue;
      }
      touched = true;
      if (mode === 'closed') {
        if (char === '"') { append('"'); mode = 'quoted'; }
        else if (char === ',') endField();
        else fail('malformed_csv');
      } else if (char === ',') endField();
      else if (char === '"') {
        if (mode !== 'start') fail('malformed_csv');
        mode = 'quoted';
      } else { append(char); mode = 'plain'; }
    }
  }
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try { return decoder.decode(bytes, { stream }); }
    catch { return fail('invalid_utf8'); }
  };
  const endInput = (): HeEngCompaniesHouseCsvRow | null => {
    if (mode === 'quoted') fail('malformed_csv');
    return touched || fields.length || field.length ? endRecord() : null;
  };
  options.signal?.throwIfAborted();
  for await (const bytes of input) {
    options.signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array)) fail('invalid_chunk');
    for (let offset = 0; offset < bytes.length; offset += limits.decodeBytes) {
      options.signal?.throwIfAborted();
      yield* consume(decode(bytes.subarray(offset, offset + limits.decodeBytes), true));
      options.onActivity?.();
    }
  }
  options.signal?.throwIfAborted();
  yield* consume(decode());
  const row = endInput();
  if (row) yield row;
  if (!headers) fail('missing_header');
}
