/**
 * Сборка итоговой книги обогащения. Вынесено из страницы, чтобы воркер
 * писал тот же xlsx, что раньше собирал браузер: исходные колонки +
 * «Найдено» + 24 поля + лист «Статистика».
 *
 * Ширина области выгрузки — max по всем строкам (рваный CSV), без
 * spread в Math.max (90k строк иначе роняют стек).
 */

import {
  ENRICH_FIELDS,
  enrichValues,
  pct,
  type EnrichRow,
  type EnrichmentStats,
} from './fields';
import { normalizeInn } from './inn';

export function sourceColumnCount(rows: string[][]): number {
  return rows.reduce((max, r) => Math.max(max, r.length), 0);
}

export function sourceHeaders(rows: string[][], hasHeader: boolean, maxCols: number): string[] {
  return Array.from({ length: maxCols }, (_, c) =>
    hasHeader && rows[0]?.[c] ? rows[0][c] : `Колонка ${c + 1}`,
  );
}

export function buildEnrichmentAoa(args: {
  rows: string[][];
  columnIndex: number;
  hasHeader: boolean;
  matches: Map<string, EnrichRow>;
}): Array<Array<string | number | null>> {
  const { rows, columnIndex, hasHeader, matches } = args;
  const maxCols = sourceColumnCount(rows);
  const headerRow = sourceHeaders(rows, hasHeader, maxCols);
  const aoa: Array<Array<string | number | null>> = [
    [...headerRow, 'Найдено', ...ENRICH_FIELDS.map((f) => f.label)],
  ];

  for (let r = hasHeader ? 1 : 0; r < rows.length; r += 1) {
    const source = rows[r];
    const inn = normalizeInn(source?.[columnIndex]);
    const match = inn ? matches.get(inn) : undefined;
    aoa.push([
      ...headerRow.map((_, c) => source?.[c] ?? ''),
      match ? 'да' : 'нет',
      ...(match ? enrichValues(match) : ENRICH_FIELDS.map(() => null)),
    ]);
  }
  return aoa;
}

export function buildStatsAoa(stats: EnrichmentStats): Array<Array<string | number>> {
  return [
    ['Строк в файле', stats.totalRows],
    ['Уникальных ИНН', stats.uniqueInns],
    ['Невалидных значений', stats.invalidValues],
    ['Обогащено строк', `${stats.matchedRows} (${pct(stats.matchedRows, stats.totalRows)}%)`],
    [
      'Обогащено уникальных ИНН',
      `${stats.matchedUniqueInns} (${pct(stats.matchedUniqueInns, stats.uniqueInns)}%)`,
    ],
    ['Не найдено уникальных ИНН', stats.uniqueInns - stats.matchedUniqueInns],
    [
      'Хотя бы один контакт (тел/email/сайт)',
      `${stats.withAnyContact} (${pct(stats.withAnyContact, stats.matchedUniqueInns)}% от найденных)`,
    ],
    [],
    ['Заполненность полей (от найденных)', ''],
    ...stats.fillRates.map((f) => [f.label, `${f.filled} (${f.pct}%)`]),
  ];
}

export async function buildEnrichedXlsxBuffer(args: {
  rows: string[][];
  columnIndex: number;
  hasHeader: boolean;
  matches: Map<string, EnrichRow>;
  stats: EnrichmentStats;
}): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const aoa = buildEnrichmentAoa(args);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((h, c) => ({
    wch: Math.min(
      Math.max(String(h ?? '').length, ...aoa.slice(1, 1001).map((r) => String(r[c] ?? '').length)),
      60,
    ),
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Обогащение');
  const wsStats = XLSX.utils.aoa_to_sheet(buildStatsAoa(args.stats));
  wsStats['!cols'] = [{ wch: 42 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsStats, 'Статистика');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}
