'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Play,
  Loader2,
  Download,
  FileSpreadsheet,
  AlertCircle,
  Database,
  Plus,
  Trash2,
  User,
} from 'lucide-react';
import { saveAs } from 'file-saver';
import ExcelJS from 'exceljs';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

type LinkedInCompany = {
  name?: string | null;
  site?: string | null;
  phone?: string | null;
};

const COLUMNS: (keyof LinkedInCompany)[] = ['name', 'site', 'phone'];

function cellValue(v: unknown): string {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

const LINKEDIN_COMPANIES_TEMPLATE =
  'https://www.linkedin.com/search/results/companies';

const DEFAULT_LIMIT = 600;

type LinkedInAccount = {
  id: string;
  name: string;
  login: string;
  is_active: boolean;
  created_at: string;
};

const API_ACCOUNTS = '/api/tools/linkedin-bot/accounts';

export default function LinkedInBotPage() {
  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT));
  const [accountId, setAccountId] = useState<string>('');
  const [accounts, setAccounts] = useState<LinkedInAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [addName, setAddName] = useState('');
  const [addLogin, setAddLogin] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<LinkedInCompany[]>([]);

  const loadAccounts = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setAccountsLoading(false);
      return;
    }
    try {
      const res = await fetch(API_ACCOUNTS, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const { items } = (await res.json()) as { items: LinkedInAccount[] };
        setAccounts(items ?? []);
      }
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const addAccount = useCallback(async () => {
    const login = addLogin.trim();
    const password = addPassword.trim();
    if (!login || !password) {
      setError('Укажите логин и пароль');
      return;
    }
    setAddBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError('Необходима авторизация');
        return;
      }
      const res = await fetch(API_ACCOUNTS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: addName.trim() || login,
          login,
          password,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data?.error ?? `Ошибка: ${res.status}`);
        return;
      }
      setAddName('');
      setAddLogin('');
      setAddPassword('');
      setShowAddAccount(false);
      void loadAccounts();
    } finally {
      setAddBusy(false);
    }
  }, [addName, addLogin, addPassword, loadAccounts]);

  const deleteAccount = useCallback(
    async (id: string) => {
      if (!confirm('Удалить аккаунт?')) return;
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch(`${API_ACCOUNTS}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        if (accountId === id) setAccountId('');
        void loadAccounts();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data?.error ?? 'Ошибка удаления');
      }
    },
    [accountId, loadAccounts]
  );

  const runScrape = useCallback(async () => {
    const trimmed = url.trim();
    if (
      !trimmed ||
      !trimmed.startsWith(LINKEDIN_COMPANIES_TEMPLATE)
    ) {
      setError(
        'Введите корректную ссылку на linkedin.com/search/results/companies'
      );
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

      const limitNum = Math.min(2000, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
      const body: { url: string; limit: number; account_id?: string } = {
        url: trimmed,
        limit: limitNum,
      };
      if (accountId.trim()) body.account_id = accountId.trim();
      const res = await fetch('/api/tools/linkedin-bot/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as {
        status?: string;
        companies?: LinkedInCompany[];
        error?: string;
      };

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
  }, [url, limit, accountId]);

  const addToDatabase = useCallback(() => {
    if (companies.length === 0) return;
    const headerRow = COLUMNS.map((c) => c);
    const dataRows = companies.map((c) =>
      COLUMNS.map((col) => cellValue(c[col]))
    );
    const title = `LinkedIn Companies ${new Date().toISOString().slice(0, 10)}`;
    const { id } = writePendingDbImport({ title, rows: [headerRow, ...dataRows] });
    const importUrl = buildDatabasesImportUrl(id);
    window.open(importUrl, '_blank');
  }, [companies]);

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
      const blob = new Blob(['\ufeff' + csv], {
        type: 'text/csv;charset=utf-8',
      });
      saveAs(blob, 'linkedin-companies.csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [companies]);

  const exportExcel = useCallback(async () => {
    if (companies.length === 0) return;
    setExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('LinkedIn Companies');
      ws.columns = COLUMNS.map((col) => ({
        header: col,
        key: col,
        width: 30,
      }));
      companies.forEach((c) => ws.addRow(c as Record<string, unknown>));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'linkedin-companies.xlsx');
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
        <h1 className="text-2xl font-bold text-gray-900">LinkedIn Companies</h1>
        <p className="text-sm text-gray-500 mt-1">
          Парсинг компаний по поисковому URL LinkedIn. Вставьте ссылку на
          страницу поиска компаний, чтобы получить список (название, сайт, телефон)
          и выгрузить в базу, CSV или Excel.
        </p>
      </div>

      {/* Аккаунты LinkedIn */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <User className="h-4 w-4" />
            Аккаунты LinkedIn ({accounts.length})
          </h2>
          <button
            type="button"
            onClick={() => setShowAddAccount((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Plus className="h-4 w-4" />
            Добавить
          </button>
        </div>
        {showAddAccount && (
          <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50/50 p-4 space-y-3">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Название (опционально)"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <input
              value={addLogin}
              onChange={(e) => setAddLogin(e.target.value)}
              placeholder="Email или телефон LinkedIn"
              type="text"
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <input
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
              placeholder="Пароль"
              type="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addAccount}
                disabled={addBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Сохранить
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddAccount(false);
                  setAddName('');
                  setAddLogin('');
                  setAddPassword('');
                }}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
        {accountsLoading ? (
          <p className="text-sm text-gray-500 py-2">Загрузка аккаунтов...</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-gray-500 py-2">
            Нет аккаунтов. Добавьте аккаунт LinkedIn для парсинга (или используйте env-переменные LINKEDIN_LOGIN / LINKEDIN_PASSWORD).
          </p>
        ) : (
          <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 mb-4">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="flex items-center gap-3 px-4 py-2.5 text-sm"
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${acc.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`}
                  title={acc.is_active ? 'Активен' : 'Отключен'}
                />
                <span className="font-medium text-gray-800 truncate flex-1">
                  {acc.name || acc.login}
                </span>
                <span className="text-gray-500 truncate max-w-[160px] text-xs">
                  {acc.login}
                </span>
                <button
                  type="button"
                  onClick={() => deleteAccount(acc.id)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                  title="Удалить"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <label
          htmlFor="linkedin-url"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          URL поиска компаний
        </label>
        <div className="flex flex-col gap-3">
          {accounts.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="linkedin-account" className="text-sm text-gray-600 whitespace-nowrap">
                Аккаунт:
              </label>
              <select
                id="linkedin-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 min-w-[200px]"
                disabled={busy}
              >
                <option value="">Сервер (env)</option>
                {accounts.filter((a) => a.is_active).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.login}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-500">или env LINKEDIN_LOGIN/LINKEDIN_PASSWORD</span>
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="linkedin-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.linkedin.com/search/results/companies/?keywords=..."
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
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
          <div className="flex items-center gap-2">
            <label htmlFor="linkedin-limit" className="text-sm text-gray-600 whitespace-nowrap">
              Макс. компаний:
            </label>
            <input
              id="linkedin-limit"
              type="number"
              min={1}
              max={2000}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              disabled={busy}
            />
            <span className="text-xs text-gray-500">по умолчанию {DEFAULT_LIMIT}, макс. 2000</span>
          </div>
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
              Найдено компаний:{' '}
              <span className="font-semibold text-gray-900">{companies.length}</span>
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
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {companies.map((c, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {COLUMNS.map((col) => {
                      const val = c[col];
                      const isLink =
                        col === 'site' &&
                        typeof val === 'string' &&
                        val.startsWith('http');
                      return (
                        <td
                          key={col}
                          className="px-4 py-3 text-gray-700 max-w-[280px] truncate"
                        >
                          {isLink ? (
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
            Вставьте ссылку на страницу поиска компаний LinkedIn
            (linkedin.com/search/results/companies) и нажмите «Запустить».
            Парсинг может занять несколько минут. Затем используйте «В базу» или скачайте CSV/Excel.
          </p>
        </div>
      )}
    </div>
  );
}
