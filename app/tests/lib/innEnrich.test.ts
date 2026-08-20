/**
 * Pure helpers behind the /tools/inn-enrich tool: INN normalization and
 * validation, order-preserving dedupe, chunking for RPC batches, and the
 * spreadsheet column auto-detection used after readSpreadsheetFile().
 *
 * Locked behaviours:
 *  - normalizeInn strips anything non-digit and accepts ONLY 10- or 12-digit
 *    results (юрлицо / ИП). Everything else → null (phones, ОГРН, КПП, dates
 *    must not leak into the RPC payload).
 *  - dedupeInns keeps the FIRST occurrence order (progress display maps
 *    chunks back to row numbers).
 *  - detectInnColumn picks the column where ≥80% of non-empty data cells are
 *    valid INNs, tolerates a text header row, and prefers header cells named
 *    «ИНН» on ties. A column of 10-digit OKPO values is a known false-positive
 *    risk — the UI offers a manual override, detection only needs to be a
 *    sensible default.
 */

import {
  normalizeInn,
  dedupeInns,
  chunkArray,
  MAX_INNS_PER_REQUEST,
  RPC_BATCH_SIZE,
} from '@/lib/innEnrich/inn';
import { detectInnColumn, extractInns } from '@/lib/innEnrich/extractInns';

describe('normalizeInn', () => {
  it('accepts a clean 10-digit юрлицо INN', () => {
    expect(normalizeInn('7707083893')).toBe('7707083893');
  });

  it('accepts a clean 12-digit ИП INN', () => {
    expect(normalizeInn('771234567890')).toBe('771234567890');
  });

  it('strips spaces, dashes and quotes around the digits', () => {
    expect(normalizeInn(' 7707 083 893 ')).toBe('7707083893');
    expect(normalizeInn('"7707083893"')).toBe('7707083893');
    expect(normalizeInn('7707-08-38-93')).toBe('7707083893');
  });

  it('accepts numeric cell values (xlsx may parse INN as number)', () => {
    expect(normalizeInn(7707083893)).toBe('7707083893');
  });

  it('keeps leading zeros (string form) — ИНН может начинаться с 0', () => {
    expect(normalizeInn('0123456789')).toBe('0123456789');
  });

  it.each([
    ['too short', '12345'],
    ['too long (13 — ОГРН)', '1027700132195'],
    ['9 digits (КПП)', '770701001'],
    ['11 digits (phone)', '79161234567'],
    ['empty', ''],
    ['text', 'не инн'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(normalizeInn(value)).toBeNull();
  });
});

describe('dedupeInns', () => {
  it('removes duplicates keeping first-occurrence order', () => {
    expect(dedupeInns(['7707083893', '771234567890', '7707083893', '7702000000']))
      .toEqual(['7707083893', '771234567890', '7702000000']);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeInns([])).toEqual([]);
  });
});

describe('chunkArray', () => {
  it('splits into fixed-size batches, last one partial', () => {
    const input = Array.from({ length: 1200 }, (_, i) => `inn-${i}`);
    const chunks = chunkArray(input, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(chunks.flat()).toEqual(input);
  });

  it('returns [] for [] (no empty trailing chunk)', () => {
    expect(chunkArray([], 500)).toEqual([]);
  });

  it('exposes sane batch limits for the match route', () => {
    expect(MAX_INNS_PER_REQUEST).toBe(2000);
    expect(RPC_BATCH_SIZE).toBe(500);
  });
});

/* ── column detection ──────────────────────────────────────────────────── */

const HEADER = ['Компания', 'ИНН', 'Телефон'];

function makeRows(innColumn: string[], opts: { header?: string[] } = {}) {
  const header = opts.header === undefined ? HEADER : opts.header;
  return [
    header,
    ...innColumn.map((inn, i) => [`ООО Ромашка ${i}`, inn, `+7916${String(i).padStart(7, '0')}`]),
  ];
}

describe('detectInnColumn', () => {
  it('finds the INN column despite a text header row', () => {
    const rows = makeRows(['7707083893', '771234567890', '7702000000']);
    const d = detectInnColumn(rows);
    expect(d.columnIndex).toBe(1);
    expect(d.hasHeader).toBe(true);
    expect(d.validCount).toBe(3);
    expect(d.totalDataRows).toBe(3);
  });

  it('works without a header row', () => {
    const rows = [
      ['7707083893', 'ООО А'],
      ['771234567890', 'ООО Б'],
    ];
    const d = detectInnColumn(rows);
    expect(d.columnIndex).toBe(0);
    expect(d.hasHeader).toBe(false);
    expect(d.validCount).toBe(2);
  });

  it('tolerates up to 20% garbage in the INN column', () => {
    const rows = makeRows(['7707083893', '771234567890', '7702000000', '7703000000', 'мусор']);
    const d = detectInnColumn(rows);
    expect(d.columnIndex).toBe(1);
    expect(d.validCount).toBe(4);
  });

  it('rejects a column with >20% garbage', () => {
    const rows = makeRows(['7707083893', 'мусор', '7702000000']);
    // 2/3 valid = 66% < 80% → no column qualifies
    const d = detectInnColumn(rows);
    expect(d.columnIndex).toBe(-1);
  });

  it('ignores phone and name columns', () => {
    const rows = makeRows(['7707083893', '771234567890']);
    const d = detectInnColumn(rows);
    expect(d.columnIndex).not.toBe(0); // names
    expect(d.columnIndex).not.toBe(2); // phones (11 digits)
  });

  it('prefers the column whose header says «ИНН» on ties', () => {
    const rows = [
      ['ОГРН', 'ИНН'],
      ['7707083893', '771234567890'],
      ['7702000000', '7703000000'],
    ];
    const d = detectInnColumn(rows);
    expect(d.columnIndex).toBe(1);
  });

  it('returns -1 for an empty sheet', () => {
    const d = detectInnColumn([]);
    expect(d.columnIndex).toBe(-1);
    expect(d.validCount).toBe(0);
  });
});

describe('extractInns', () => {
  it('returns unique valid INNs in row order, skipping the header', () => {
    const rows = makeRows(['7707083893', '771234567890', '7707083893', 'junk', '']);
    const { inns, invalidCount } = extractInns(rows, 1, true);
    expect(inns).toEqual(['7707083893', '771234567890']);
    expect(invalidCount).toBe(1); // 'junk'; empty cells are not counted
  });

  it('reads from row 0 when there is no header', () => {
    const rows = [
      ['7707083893'],
      ['771234567890'],
    ];
    const { inns, invalidCount } = extractInns(rows, 0, false);
    expect(inns).toEqual(['7707083893', '771234567890']);
    expect(invalidCount).toBe(0);
  });
});
