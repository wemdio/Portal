'use client';

import { useCallback, useRef, useState } from 'react';
import { authFetchJson } from '@/lib/authFetch';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { chunkArray, normalizeInn, UI_CHUNK_SIZE } from '@/lib/innEnrich/inn';
import { detectInnColumn, extractInns } from '@/lib/innEnrich/extractInns';
import {
  buildEnrichmentStats,
  ENRICH_FIELDS,
  enrichValues,
  pct,
  type EnrichRow,
  type EnrichmentStats,
} from '@/lib/innEnrich/fields';

type Phase = 'idle' | 'parsing' | 'ready' | 'enriching' | 'done';

interface MatchResponse {
  rows: EnrichRow[];
  requestedUnique: number;
  invalidCount: number;
}

export default function InnEnrichPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [columnIndex, setColumnIndex] = useState(-1);
  const [hasHeader, setHasHeader] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stats, setStats] = useState<EnrichmentStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Накопленные совпадения: ИНН → строка базы. В ref, чтобы не гонять
  // ре-рендер на каждый чанк (десятки тысяч записей).
  const matchesRef = useRef<Map<string, EnrichRow>>(new Map());
  const cancelRef = useRef(false);

  const reset = () => {
    setRows([]);
    setFileName('');
    setColumnIndex(-1);
    setStats(null);
    setProgress(null);
    setError(null);
    matchesRef.current = new Map();
    setPhase('idle');
  };

  const handleFile = useCallback(async (file: File) => {
    reset();
    setPhase('parsing');
    setFileName(file.name);
    try {
      const parsed = await readSpreadsheetFile(file);
      if (parsed.length === 0) throw new Error('Файл пустой');
      const d = detectInnColumn(parsed);
      setRows(parsed);
      setColumnIndex(d.columnIndex);
      setHasHeader(d.hasHeader);
      setPhase('ready');
      if (d.columnIndex === -1) {
        setError('Не нашёл колонку с ИНН автоматически — выберите её вручную ниже.');
      }
    } catch (e) {
      setPhase('idle');
      setError(
        e instanceof Error
          ? `Не удалось прочитать файл: ${e.message}. Если файл защищён паролем — снимите защиту и загрузите снова.`
          : 'Не удалось прочитать файл',
      );
    }
  }, []);

  const handleEnrich = useCallback(async () => {
    if (columnIndex < 0 || rows.length === 0) return;
    setError(null);
    setStats(null);

    const { inns, invalidCount } = extractInns(rows, columnIndex, hasHeader);
    if (inns.length === 0) {
      setError('В выбранной колонке нет валидных ИНН (10 или 12 цифр).');
      return;
    }

    setPhase('enriching');
    cancelRef.current = false;
    matchesRef.current = new Map();
    const chunks = chunkArray(inns, UI_CHUNK_SIZE);
    let done = 0;
    setProgress({ done, total: inns.length });

    try {
      for (const chunk of chunks) {
        if (cancelRef.current) throw new Error('Отменено пользователем');
        const res = await authFetchJson<MatchResponse>('/api/tools/inn-enrich/match', {
          method: 'POST',
          body: JSON.stringify({ inns: chunk }),
        });
        for (const row of res.rows) {
          const inn = typeof row.inn === 'string' ? row.inn : null;
          if (inn) matchesRef.current.set(inn, row);
        }
        done += chunk.length;
        setProgress({ done, total: inns.length });
      }
    } catch (e) {
      setPhase('ready');
      setProgress(null);
      setError(e instanceof Error ? e.message : 'Ошибка обогащения');
      return;
    }

    const dataRows = rows.length - (hasHeader ? 1 : 0);
    let matchedRows = 0;
    for (let r = hasHeader ? 1 : 0; r < rows.length; r += 1) {
      const inn = normalizeInn(rows[r]?.[columnIndex]);
      if (inn && matchesRef.current.has(inn)) matchedRows += 1;
    }

    setStats(
      buildEnrichmentStats({
        totalRows: dataRows,
        uniqueInns: inns.length,
        invalidValues: invalidCount,
        matchedRows,
        matched: Array.from(matchesRef.current.values()),
      }),
    );
    setPhase('done');
  }, [rows, columnIndex, hasHeader]);

  const handleDownload = useCallback(async () => {
    if (rows.length === 0 || columnIndex < 0) return;
    const XLSX = await import('xlsx');

    const headerRow = hasHeader
      ? rows[0]
      : Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => `Колонка ${i + 1}`);
    const outHeader = [...headerRow, 'Найдено', ...ENRICH_FIELDS.map((f) => f.label)];
    const aoa: Array<Array<string | number | null>> = [outHeader];

    for (let r = hasHeader ? 1 : 0; r < rows.length; r += 1) {
      const source = rows[r];
      const inn = normalizeInn(source?.[columnIndex]);
      const match = inn ? matchesRef.current.get(inn) : undefined;
      aoa.push([
        ...headerRow.map((_, c) => source?.[c] ?? ''),
        match ? 'да' : 'нет',
        ...(match ? enrichValues(match) : ENRICH_FIELDS.map(() => null)),
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = outHeader.map((h, c) => ({
      wch: Math.min(
        Math.max(h.length, ...aoa.slice(1, 1001).map((r) => String(r[c] ?? '').length)),
        60,
      ),
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Обогащение');

    if (stats) {
      const s = stats;
      const statRows: Array<Array<string | number>> = [
        ['Строк в файле', s.totalRows],
        ['Уникальных ИНН', s.uniqueInns],
        ['Невалидных значений', s.invalidValues],
        ['Обогащено строк', `${s.matchedRows} (${pct(s.matchedRows, s.totalRows)}%)`],
        ['Обогащено уникальных ИНН', `${s.matchedUniqueInns} (${pct(s.matchedUniqueInns, s.uniqueInns)}%)`],
        ['Не найдено уникальных ИНН', s.uniqueInns - s.matchedUniqueInns],
        ['Хотя бы один контакт (тел/email/сайт)', `${s.withAnyContact} (${pct(s.withAnyContact, s.matchedUniqueInns)}% от найденных)`],
        [],
        ['Заполненность полей (от найденных)', ''],
        ...s.fillRates.map((f) => [f.label, `${f.filled} (${f.pct}%)`]),
      ];
      const wsStats = XLSX.utils.aoa_to_sheet(statRows);
      wsStats['!cols'] = [{ wch: 42 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, wsStats, 'Статистика');
    }

    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'export'}_обогащённый.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, columnIndex, hasHeader, stats, fileName]);

  const uniquePreview = (() => {
    if (phase !== 'ready' && phase !== 'done') return null;
    if (columnIndex < 0 || rows.length === 0) return null;
    const { inns, invalidCount } = extractInns(rows, columnIndex, hasHeader);
    return { unique: inns.length, invalid: invalidCount, total: rows.length - (hasHeader ? 1 : 0) };
  })();

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Обогащение по ИНН</h1>
        <p className="text-sm text-gray-500 mt-1">
          Загрузите файл с колонкой ИНН — добавим к каждой строке данные из «Нашей базы баз»:
          название, контакты, адрес, ОКВЭД, выручку и ещё 24 поля. Поддерживаются XLSX, XLS, CSV.
          Файл не должен быть защищён паролем.
        </p>
      </div>

      {/* Шаг 1: файл */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-base font-semibold text-gray-900">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">1</span>
          Файл
        </h2>

        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
          className="block rounded-xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 text-center cursor-pointer"
        >
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          {phase === 'parsing' ? (
            <span className="text-sm text-gray-600">Читаем файл…</span>
          ) : fileName ? (
            <span className="text-sm text-gray-900 font-medium">{fileName}</span>
          ) : (
            <span className="text-sm text-gray-600">
              Перетащите файл сюда или <span className="text-blue-600 underline">выберите</span>
            </span>
          )}
        </label>
      </div>

      {/* Шаг 2: колонка ИНН */}
      {rows.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <h2 className="text-base font-semibold text-gray-900">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">2</span>
            Колонка с ИНН
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Колонка</div>
              <select
                value={columnIndex}
                onChange={(e) => setColumnIndex(Number(e.target.value))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
              >
                <option value={-1}>— не выбрана —</option>
                {Array.from({ length: maxCols }, (_, c) => (
                  <option key={c} value={c}>
                    {hasHeader && rows[0]?.[c] ? `${rows[0][c]} (колонка ${c + 1})` : `Колонка ${c + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Первая строка</div>
              <select
                value={hasHeader ? 'header' : 'data'}
                onChange={(e) => setHasHeader(e.target.value === 'header')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
              >
                <option value="header">Заголовок</option>
                <option value="data">Данные</option>
              </select>
            </div>
          </div>

          {uniquePreview && (
            <div className="text-sm text-gray-600">
              Строк данных: <b>{uniquePreview.total.toLocaleString('ru-RU')}</b> · уникальных ИНН:{' '}
              <b>{uniquePreview.unique.toLocaleString('ru-RU')}</b>
              {uniquePreview.invalid > 0 && (
                <> · невалидных значений: <b>{uniquePreview.invalid.toLocaleString('ru-RU')}</b></>
              )}
            </div>
          )}
        </div>
      )}

      {/* Шаг 3: запуск */}
      {rows.length > 0 && (
        <div className="flex flex-col items-center gap-4 py-2">
          {phase === 'enriching' ? (
            <>
              <div className="w-full max-w-md">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Обогащаем…</span>
                  <span>
                    {progress?.done.toLocaleString('ru-RU')} / {progress?.total.toLocaleString('ru-RU')}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Отменить
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void handleEnrich()}
              disabled={columnIndex < 0 || !uniquePreview || uniquePreview.unique === 0}
              className="rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-16 py-4 text-lg font-semibold transition-colors shadow-md"
            >
              Обогатить
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Результат */}
      {phase === 'done' && stats && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <h2 className="text-base font-semibold text-gray-900">Готово</h2>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">{stats.matchedRows.toLocaleString('ru-RU')}</div>
              <div className="text-xs text-gray-500">строк обогащено</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {pct(stats.matchedUniqueInns, stats.uniqueInns)}%
              </div>
              <div className="text-xs text-gray-500">уникальных ИНН найдено</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">{stats.withAnyContact.toLocaleString('ru-RU')}</div>
              <div className="text-xs text-gray-500">с контактом (тел/email/сайт)</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {(stats.uniqueInns - stats.matchedUniqueInns).toLocaleString('ru-RU')}
              </div>
              <div className="text-xs text-gray-500">ИНН не в базе</div>
            </div>
          </div>

          <div className="text-sm text-gray-600 space-y-1">
            {stats.fillRates.map((f) => (
              <div key={f.label}>
                {f.label} — {f.pct}%
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4 pt-2">
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 text-sm font-semibold transition-colors shadow-sm"
            >
              Скачать XLSX
            </button>
            <button type="button" onClick={reset} className="text-sm text-gray-500 hover:text-gray-700 underline">
              Новый файл
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
