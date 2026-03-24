'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Download, FileSpreadsheet, CirclePause, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { supabase } from '@/lib/supabaseClient';

type ParsedCompany = {
  companyName: string;
  website: string;
};

type MatchRow = {
  companyName: string;
  website: string;
  paymentSystem: string;
};

type HistoryEntry = {
  id: string;
  fileName: string;
  startedAt: string;
  checkedCount: number;
  totalCount: number;
  matchCount: number;
  matches: MatchRow[];
  status: 'running' | 'completed' | 'stopped';
};

const STORAGE_KEY = 'crypto-payment-parser-history';
const MAX_HISTORY = 10;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    // quota exceeded — ignore
  }
}

const WEBSITE_HEADER_HINTS = [
  'website', 'web site', 'site', 'url', 'domain', 'web', 'company website', 'company url',
  'сайт', 'вебсайт', 'домен', 'ссылка',
];

const COMPANY_HEADER_HINTS = [
  'company', 'company name', 'organization', 'org', 'name', 'merchant', 'vendor',
  'компания', 'название компании', 'название', 'организация',
];

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeUrl(raw: string): string | null {
  const value = String(raw || '').trim();
  if (!value || /\s/.test(value)) return null;
  const prefixed = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(prefixed);
    if (!url.hostname || !url.hostname.includes('.')) return null;
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function scoreHeader(header: string, hints: string[]): number {
  if (!header) return 0;
  if (hints.some((hint) => header === hint)) return 4;
  if (hints.some((hint) => header.includes(hint))) return 2;
  return 0;
}

function detectBestColumn(rows: unknown[][], hints: string[]): number {
  if (rows.length === 0) return 0;
  const headerRow = rows[0] ?? [];
  const maxColumn = headerRow.length;
  let best = { index: 0, score: -1 };
  const sample = rows.slice(1, 121);

  for (let col = 0; col < maxColumn; col += 1) {
    const header = normalizeHeader(headerRow[col]);
    const headerScore = scoreHeader(header, hints);
    let nonEmpty = 0;
    let urlLike = 0;
    for (const row of sample) {
      const raw = String(row[col] ?? '').trim();
      if (!raw) continue;
      nonEmpty += 1;
      if (normalizeUrl(raw)) urlLike += 1;
    }
    const ratio = nonEmpty > 0 ? urlLike / nonEmpty : 0;
    const total = headerScore + ratio * 2;
    if (total > best.score) best = { index: col, score: total };
  }
  return best.index;
}

function parseWorkbook(file: File): Promise<ParsedCompany[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) throw new Error('Лист в файле не найден');
        const worksheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '' });
        if (rows.length < 2) throw new Error('В файле недостаточно строк');

        const websiteCol = detectBestColumn(rows, WEBSITE_HEADER_HINTS);
        const companyCol = detectBestColumn(rows, COMPANY_HEADER_HINTS);

        const result: ParsedCompany[] = [];
        for (let i = 1; i < rows.length; i += 1) {
          const row = rows[i];
          const website = normalizeUrl(String(row[websiteCol] ?? ''));
          if (!website) continue;
          const companyName = String(row[companyCol] ?? '').trim() || `row_${i + 1}`;
          result.push({ companyName, website });
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function chunkArray<T>(items: T[], size: number): Array<T[]> {
  const out: Array<T[]> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function CryptoPaymentParserView() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [checkedCount, setCheckedCount] = useState(0);
  const [totalToCheck, setTotalToCheck] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const progress = useMemo(() => {
    if (totalToCheck <= 0) return 0;
    return Math.round((checkedCount / totalToCheck) * 100);
  }, [checkedCount, totalToCheck]);

  const persistEntry = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.id !== entry.id);
      const next = [entry, ...filtered].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleRun = async () => {
    if (!file) {
      setError('Выберите .xlsx файл');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setError(null);
    setMatches([]);
    setCheckedCount(0);
    setTotalToCheck(0);

    const runId = crypto.randomUUID();
    setActiveHistoryId(runId);

    try {
      const parsed = await parseWorkbook(file);
      const uniqueBySite = new Map<string, ParsedCompany>();
      for (const row of parsed) {
        if (!uniqueBySite.has(row.website)) uniqueBySite.set(row.website, row);
      }
      const prepared = Array.from(uniqueBySite.values());
      setTotalToCheck(prepared.length);

      const entry: HistoryEntry = {
        id: runId,
        fileName: file.name,
        startedAt: new Date().toISOString(),
        checkedCount: 0,
        totalCount: prepared.length,
        matchCount: 0,
        matches: [],
        status: 'running',
      };
      persistEntry(entry);

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Требуется авторизация');

      const chunks = chunkArray(prepared, 10);
      const found: MatchRow[] = [];
      let checked = 0;

      for (const chunk of chunks) {
        if (controller.signal.aborted) break;

        const res = await fetch('/api/parsers/crypto-payments/scan', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ items: chunk }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `Ошибка проверки: ${res.status}`);
        }

        const data = (await res.json()) as { matches: MatchRow[]; checked: number };
        found.push(...(data.matches ?? []));
        checked += data.checked ?? chunk.length;

        setMatches([...found]);
        setCheckedCount(checked);

        persistEntry({
          ...entry,
          checkedCount: checked,
          matchCount: found.length,
          matches: [...found],
          status: 'running',
        });
      }

      const finalStatus = controller.signal.aborted ? 'stopped' : 'completed';
      persistEntry({
        ...entry,
        checkedCount: checked,
        matchCount: found.length,
        matches: [...found],
        status: finalStatus,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // stopped by user — already persisted
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось выполнить проверку');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const loadFromHistory = useCallback((entry: HistoryEntry) => {
    setActiveHistoryId(entry.id);
    setMatches(entry.matches);
    setCheckedCount(entry.checkedCount);
    setTotalToCheck(entry.totalCount);
    setError(null);
  }, []);

  const deleteFromHistory = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      saveHistory(next);
      return next;
    });
    if (activeHistoryId === id) {
      setActiveHistoryId(null);
      setMatches([]);
      setCheckedCount(0);
      setTotalToCheck(0);
    }
  }, [activeHistoryId]);

  const displayMatches = matches;

  const exportCsv = () => {
    if (displayMatches.length === 0) return;
    const header = ['Company', 'Website', 'Платёжная система'];
    const lines = [header.join(',')];
    for (const row of displayMatches) {
      const values = [row.companyName, row.website, row.paymentSystem]
        .map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`);
      lines.push(values.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, 'crypto-payment-matches.csv');
  };

  const exportXlsx = () => {
    if (displayMatches.length === 0) return;
    const sheetData = displayMatches.map((row) => ({
      Company: row.companyName,
      Website: row.website,
      'Платёжная система': row.paymentSystem,
    }));
    const worksheet = XLSX.utils.json_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, worksheet, 'CryptoPayments');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8',
    });
    saveAs(blob, 'crypto-payment-matches.xlsx');
  };

  return (
    <div className="space-y-6">
      {/* Upload & Controls */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Проверка сайтов на crypto-платежки</h3>
        <p className="text-sm text-gray-500">
          Загрузите Excel с компаниями. Проверяются все строки файла, колонка сайта определяется автоматически.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept=".xlsx,.xls"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-700 disabled:opacity-40 disabled:pointer-events-none file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 file:transition-colors hover:file:border-blue-300 hover:file:bg-blue-50 hover:file:text-blue-700"
          />
          <div className="flex items-center gap-2 shrink-0">
            {busy ? (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
              >
                <CirclePause className="h-4 w-4" />
                Остановить
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleRun()}
                disabled={!file}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                Запустить
              </button>
            )}
          </div>
        </div>

        {busy || totalToCheck > 0 ? (
          <div className="space-y-1">
            <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all ${busy ? 'bg-emerald-500' : 'bg-emerald-500'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-gray-500">
              Проверено: {checkedCount} / {totalToCheck} ({progress}%)
              {busy ? ' — идёт проверка…' : ''}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
        {/* History sidebar */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/50">
            <h3 className="text-sm font-semibold text-gray-900">История запусков</h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-[520px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Нет запусков</div>
            ) : (
              history.map((entry) => (
                <div
                  key={entry.id}
                  className={`group relative px-4 py-3 cursor-pointer transition-colors ${
                    activeHistoryId === entry.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => loadFromHistory(entry)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      entry.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700'
                        : entry.status === 'stopped'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}>
                      {entry.status === 'completed' ? 'Готово' : entry.status === 'stopped' ? 'Остановлен' : 'В процессе'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteFromHistory(entry.id); }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                      title="Удалить"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="text-xs font-medium text-gray-900 truncate" title={entry.fileName}>
                    {entry.fileName}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {formatDate(entry.startedAt)} · {entry.checkedCount}/{entry.totalCount} проверено · {entry.matchCount} найдено
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Results table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Компании с crypto-платежками</h3>
              <p className="text-sm text-gray-500">Найдено: {displayMatches.length}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportCsv}
                disabled={displayMatches.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
              <button
                type="button"
                onClick={exportXlsx}
                disabled={displayMatches.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Компания</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Сайт</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Платёжная система</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {displayMatches.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                      {busy ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Идёт проверка…
                        </span>
                      ) : 'Пока нет результатов'}
                    </td>
                  </tr>
                ) : (
                  displayMatches.map((row, idx) => (
                    <tr key={`${row.website}-${idx}`} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-center text-sm text-gray-900">{row.companyName || '—'}</td>
                      <td className="px-4 py-3 text-center text-sm text-blue-700">
                        <a href={row.website} target="_blank" rel="noreferrer" className="hover:underline">
                          {row.website}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-center text-sm text-gray-700">{row.paymentSystem || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
