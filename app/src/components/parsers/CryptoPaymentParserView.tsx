'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Download, FileSpreadsheet, CirclePause, Trash2, Play, Info } from 'lucide-react';

import { saveAs } from 'file-saver';
import { supabase } from '@/lib/supabaseClient';
import { readApiError } from '@/lib/apiError';

type ParsedCompany = {
  companyName: string;
  website: string;
};

type MatchRow = {
  companyName: string;
  website: string;
  paymentSystem: string;
};

type JobEntry = {
  id: string;
  file_name: string;
  status: 'pending' | 'running' | 'completed' | 'stopped' | 'error';
  checked_count: number;
  total_count: number;
  matches: MatchRow[];
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

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

async function parseWorkbook(file: File): Promise<ParsedCompany[]> {
  const XLSX = await import('xlsx');
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

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'В очереди', cls: 'bg-gray-100 text-gray-700' },
  running: { label: 'В процессе', cls: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Готово', cls: 'bg-emerald-100 text-emerald-700' },
  stopped: { label: 'Остановлен', cls: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', cls: 'bg-red-100 text-red-700' },
};

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  let token = session?.access_token ?? null;
  if (!token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    token = refreshed.session?.access_token ?? null;
  }
  if (!token) throw new Error('Требуется авторизация');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export function CryptoPaymentParserView() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);
  const displayMatches = activeJob?.matches ?? [];
  const checkedCount = activeJob?.checked_count ?? 0;
  const totalToCheck = activeJob?.total_count ?? 0;
  const progress = totalToCheck > 0 ? Math.round((checkedCount / totalToCheck) * 100) : 0;
  const isActive = activeJob?.status === 'running' || activeJob?.status === 'pending';

  // Load jobs on mount
  const loadJobs = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/parsers/crypto-payments/jobs', { headers });
      if (res.ok) {
        const data = (await res.json()) as JobEntry[];
        setJobs(data);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Poll active job
  useEffect(() => {
    if (!activeJobId) return;
    const active = jobs.find((j) => j.id === activeJobId);
    if (!active || (active.status !== 'running' && active.status !== 'pending')) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/parsers/crypto-payments/jobs/${activeJobId}`, { headers });
        if (res.ok) {
          const fresh = (await res.json()) as JobEntry;
          setJobs((prev) => prev.map((j) => (j.id === fresh.id ? fresh : j)));
        }
      } catch {
        // silent
      }
    };

    pollRef.current = setInterval(() => void poll(), 60_000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJobId, jobs]);

  const handleRun = async () => {
    if (!file) {
      setError('Выберите .xlsx файл');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const parsed = await parseWorkbook(file);
      const uniqueBySite = new Map<string, ParsedCompany>();
      for (const row of parsed) {
        if (!uniqueBySite.has(row.website)) uniqueBySite.set(row.website, row);
      }
      const prepared = Array.from(uniqueBySite.values());

      const headers = await getAuthHeaders();
      const res = await fetch('/api/parsers/crypto-payments/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ fileName: file.name, items: prepared }),
      });

      if (!res.ok) {
        throw new Error(await readApiError(res));
      }

      const job = (await res.json()) as JobEntry;
      setJobs((prev) => [{ ...job, matches: [], error_message: null, file_name: file.name, updated_at: job.created_at }, ...prev]);
      setActiveJobId(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать задачу');
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (!activeJobId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(`/api/parsers/crypto-payments/jobs/${activeJobId}/stop`, {
        method: 'POST',
        headers,
      });
      setJobs((prev) => prev.map((j) => (j.id === activeJobId ? { ...j, status: 'stopped' as const } : j)));
    } catch {
      // silent
    }
  };

  const handleResume = async (jobId: string) => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/parsers/crypto-payments/jobs/${jobId}/resume`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'pending' as const, error_message: null } : j)));
      setActiveJobId(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось возобновить задачу');
    }
  };

  const handleDelete = async (jobId: string) => {
    try {
      const headers = await getAuthHeaders();
      await fetch(`/api/parsers/crypto-payments/jobs/${jobId}`, { method: 'DELETE', headers });
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      if (activeJobId === jobId) {
        setActiveJobId(null);
      }
    } catch {
      // silent
    }
  };

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

  const exportXlsx = async () => {
    if (displayMatches.length === 0) return;
    const XLSX = await import('xlsx');
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
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Проверка сайтов на crypto-платежки</h3>
            <p className="text-sm text-gray-500">
              Загрузите Excel с компаниями. Проверяются все строки файла, колонка сайта определяется автоматически.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowHowItWorks(true)}
            className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1"
          >
            <Info className="h-3.5 w-3.5 mr-1" />
            <span>Как работает парсер</span>
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-700 disabled:opacity-40 disabled:pointer-events-none file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 file:transition-colors hover:file:border-blue-300 hover:file:bg-blue-50 hover:file:text-blue-700"
          />
          <div className="flex items-center gap-2 shrink-0">
            {isActive ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
              >
                <CirclePause className="h-4 w-4" />
                Остановить
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleRun()}
                disabled={!file || busy}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Запустить
              </button>
            )}
          </div>
        </div>

        {activeJob && (isActive || totalToCheck > 0) ? (
          <div className="space-y-1">
            <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full transition-all ${isActive ? 'bg-emerald-500' : 'bg-emerald-500'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-gray-500">
              Проверено: {checkedCount} / {totalToCheck} ({progress}%)
              {isActive ? ' — идёт проверка…' : ''}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        {activeJob?.error_message ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {/^\s*</.test(activeJob.error_message)
              ? 'Произошла внутренняя ошибка. Попробуйте возобновить задачу.'
              : activeJob.error_message.length > 500
                ? `${activeJob.error_message.slice(0, 500)}…`
                : activeJob.error_message}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
        {/* History sidebar */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50/50">
            <h3 className="text-sm font-semibold text-gray-900">История запусков</h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-[520px] overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Нет запусков</div>
            ) : (
              jobs.map((entry) => {
                const canResume = (entry.status === 'stopped' || entry.status === 'error') && entry.checked_count < entry.total_count;
                const st = STATUS_LABELS[entry.status] ?? STATUS_LABELS.pending;
                return (
                  <div
                    key={entry.id}
                    className={`group relative px-4 py-3 cursor-pointer transition-colors ${
                      activeJobId === entry.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                    onClick={() => setActiveJobId(entry.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${st.cls}`}>
                        {st.label}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {canResume ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleResume(entry.id); }}
                            className="p-1 rounded hover:bg-emerald-50 text-gray-400 hover:text-emerald-600"
                            title="Продолжить"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void handleDelete(entry.id); }}
                          className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                          title="Удалить"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="text-xs font-medium text-gray-900 truncate" title={entry.file_name}>
                      {entry.file_name}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {formatDate(entry.created_at)} · {entry.checked_count}/{entry.total_count} проверено · {(entry.matches ?? []).length} найдено
                    </div>
                  </div>
                );
              })
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
                onClick={() => void exportXlsx()}
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
                      {isActive ? (
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

      {showHowItWorks && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает crypto payment парсер</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Инструмент берёт <span className="font-semibold">список компаний с сайтами</span> из загруженного Excel
                и для каждого сайта проверяет, используются ли на нём крипто-платёжки (Onramper, NOWPayments и др.).
              </p>
              <p>
                Колонка с сайтом определяется <span className="font-semibold">автоматически</span> по заголовкам и формату
                ссылок, поэтому достаточно, чтобы в файле была хотя бы одна колонка с URL.
              </p>
              <p>
                Для каждой компании, где найдена crypto-платёжка, в результат пишется:
                название компании, домен и название платёжной системы.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">корректный результат</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>проверьте, что в файле нет лишних строк-заголовков внутри таблицы;</li>
                <li>старайтесь использовать «чистые» домены без мусорных символов (пробелы, текст вокруг ссылки);</li>
                <li>если сайт дублируется в нескольких строках, инструмент автоматически сведёт их в один домен.</li>
              </ul>
              <p className="text-xs text-gray-500 pt-1">
                Большие файлы обрабатываются дольше. Если нужно проверить десятки тысяч сайтов — делите файл на несколько
                запусков, чтобы проще было контролировать прогресс и перезапуски.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowHowItWorks(false)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
