'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Play, Loader2, Download, FileSpreadsheet, Database, AlertCircle } from 'lucide-react';
import { saveAs } from 'file-saver';
import ExcelJS from 'exceljs';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

type HabrCompany = {
  vacancy_title?: string | null;
  vacancy_meta?: string | null;
  vacancy_skills?: string | null;
  vacancy_url?: string | null;
  company_name?: string | null;
  company_description?: string | null;
  company_addresses?: string | null;
  company_employees?: string | null;
  company_site?: string | null;
  company_emails?: string | null;
  company_contacts?: string | null;
  company_links?: string | null;
  company_url?: string | null;
};

const COLUMNS: (keyof HabrCompany)[] = [
  'company_name',
  'company_site',
  'company_emails',
  'company_contacts',
  'company_addresses',
  'company_description',
  'company_employees',
  'vacancy_title',
  'vacancy_meta',
  'vacancy_skills',
  'vacancy_url',
  'company_url',
  'company_links',
];

function cellValue(v: unknown): string {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export default function HabrCareerPage() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<HabrCompany[]>([]);

  const runScrape = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.startsWith('https://career.habr.com/vacancies')) {
      setError('Введите корректную ссылку на career.habr.com/vacancies');
      return;
    }

    setBusy(true);
    setError(null);
    setCompanies([]);

    try {
      const token = await getAccessToken();
      if (!token) {
        setError('Необходима авторизация');
        return;
      }

      const res = await fetch('/api/tools/habr-career/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: trimmed }),
      });

      const data = (await res.json()) as { status?: string; companies?: HabrCompany[]; error?: string };

      if (!res.ok) {
        setError(data?.error ?? `Ошибка: ${res.status}`);
        return;
      }

      if (data.status === 'error') {
        setError(data.error ?? 'Ошибка парсинга');
        return;
      }

      setCompanies(data.companies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    } finally {
      setBusy(false);
    }
  }, [url]);

  const exportCsv = useCallback(async () => {
    if (companies.length === 0) return;
    setExporting(true);
    try {
      const header = COLUMNS.join(',');
      const rows = companies.map((c) =>
        COLUMNS.map((col) => {
          const v = cellValue(c[col]);
          const needsQuotes = /[",\n\r]/.test(v);
          return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      saveAs(blob, 'habr-career.csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [companies]);

  const addToDatabase = useCallback(() => {
    if (companies.length === 0) return;
    const headerRow = COLUMNS.map((c) => c.replace(/_/g, ' '));
    const dataRows = companies.map((c) =>
      COLUMNS.map((col) => String(c[col] ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
    );
    const title = `Habr Career ${new Date().toISOString().slice(0, 10)}`;
    const { id } = writePendingDbImport({ title, rows: [headerRow, ...dataRows] });
    const url = buildDatabasesImportUrl(id);
    window.open(url, '_blank');
  }, [companies]);

  const exportExcel = useCallback(async () => {
    if (companies.length === 0) return;
    setExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Habr Career');
      ws.columns = COLUMNS.map((col) => ({ header: col, key: col, width: 20 }));
      companies.forEach((c) => ws.addRow(c as Record<string, unknown>));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'habr-career.xlsx');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [companies]);

  useEffect(() => {
    setError(null);
  }, [url]);

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Habr Career</h1>
        <p className="text-sm text-gray-500 mt-1">
          Парсинг вакансий и компаний с career.habr.com. Вставьте ссылку на поиск вакансий, чтобы получить
          список компаний с контактами и выгрузить в CSV или Excel.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <label htmlFor="habr-url" className="block text-sm font-medium text-gray-700 mb-2">
          URL поиска вакансий
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            id="habr-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://career.habr.com/vacancies?q=python"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            disabled={busy}
          />
          <button
            type="button"
            onClick={runScrape}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Парсинг...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Запустить
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {companies.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <div className="p-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              Найдено компаний: <span className="font-semibold text-gray-900">{companies.length}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addToDatabase}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Database className="h-4 w-4" />
                В базу
              </button>
              <button
                type="button"
                onClick={exportCsv}
                disabled={exporting}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
              <button
                type="button"
                onClick={exportExcel}
                disabled={exporting}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                    >
                      {col.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {companies.map((c, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {COLUMNS.map((col) => {
                      const val = c[col];
                      const isLink = col.includes('url') || col === 'company_site';
                      return (
                        <td key={col} className="px-4 py-3 text-gray-700 max-w-[200px] truncate">
                          {isLink && typeof val === 'string' && val.startsWith('http') ? (
                            <a
                              href={val}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline truncate block"
                            >
                              {val}
                            </a>
                          ) : (
                            cellValue(val)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!busy && companies.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-12 text-center">
          <p className="text-gray-500 text-sm">
            Вставьте ссылку на страницу поиска вакансий Habr Career и нажмите «Запустить». Парсинг может занять
            несколько минут.
          </p>
        </div>
      )}
    </div>
  );
}
