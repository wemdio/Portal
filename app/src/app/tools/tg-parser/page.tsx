'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Play,
  Loader2,
  Download,
  FileSpreadsheet,
  AlertCircle,
  Plus,
  Trash2,
  User,
  ChevronDown,
  ChevronUp,
  KeyRound,
  CheckCircle2,
  Upload,
  Zap,
} from 'lucide-react';
import { saveAs } from 'file-saver';
import ExcelJS from 'exceljs';
import type { ParsedUser } from '@/lib/tgParser/types';

const COLUMNS: (keyof ParsedUser)[] = [
  'ID/Username',
  'ID',
  'Username',
  'Имя',
  'Фамилия',
  'Полное имя',
  'Пол',
  'Биография',
  'Личный канал',
  'Статус онлайн',
  'Последний раз в сети',
  'Сообщения',
  'Количество сообщений',
  'Тип источника',
  'Ссылка на источник',
  'Название источника',
];

function cellValue(v: unknown): string {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

type TgAccount = {
  id: string;
  name: string;
  api_id: number;
  api_hash: string;
  phone: string;
  proxy_url: string;
  session_data: string;
  is_active: boolean;
  daily_limit: number;
  sent_today: number;
  created_at: string;
};

const API_ACCOUNTS = '/api/tools/tg-parser/accounts';

export default function TgParserPage() {
  const [links, setLinks] = useState('');
  const [accountId, setAccountId] = useState('');
  const [parseMessages, setParseMessages] = useState(true);
  const [parseMembers, setParseMembers] = useState(true);
  const [parseComments, setParseComments] = useState(true);
  const [messageLimit, setMessageLimit] = useState(100);
  const [filterOnline, setFilterOnline] = useState(false);
  const [filterRecently, setFilterRecently] = useState(false);
  const [maxOfflineDays, setMaxOfflineDays] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<ParsedUser[]>([]);

  // --- Accounts state ---
  const [accounts, setAccounts] = useState<TgAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addName, setAddName] = useState('');
  const [addApiId, setAddApiId] = useState('');
  const [addApiHash, setAddApiHash] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [accountsExpanded, setAccountsExpanded] = useState(true);
  const [uploading, setUploading] = useState(false);

  // Auth wizard state
  type AuthStep = 'form' | 'code_needed' | 'password_needed' | 'done';
  const [authStep, setAuthStep] = useState<AuthStep>('form');
  const [authId, setAuthId] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authPassword, setAuthPassword] = useState('');

  const loadAccounts = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) { setAccountsLoading(false); return; }
    try {
      const res = await fetch(API_ACCOUNTS, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const { items } = (await res.json()) as { items: TgAccount[] };
        setAccounts(items ?? []);
      }
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const resetAddForm = () => {
    setAddName(''); setAddApiId(''); setAddApiHash('');
    setAddPhone('');
    setAuthStep('form'); setAuthId(''); setAuthCode(''); setAuthPassword('');
  };

  const AUTH_API = '/api/tools/tg-parser/accounts/auth';

  const startAuth = useCallback(async () => {
    const apiId = parseInt(addApiId.trim(), 10);
    const apiHash = addApiHash.trim();
    const phone = addPhone.trim();
    if (!apiId || !apiHash) { setError('API ID и API Hash обязательны'); return; }
    if (!phone) { setError('Телефон обязателен (в формате +7...)'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }
      const res = await fetch(AUTH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          step: 'send_code',
          api_id: apiId,
          api_hash: apiHash,
          phone,
          name: addName.trim(),
        }),
      });
      const data = (await res.json()) as { step?: string; auth_id?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'code_needed' && data.auth_id) {
        setAuthId(data.auth_id);
        setAuthStep('code_needed');
      }
    } finally {
      setAddBusy(false);
    }
  }, [addName, addApiId, addApiHash, addPhone]);

  const submitCode = useCallback(async () => {
    const code = authCode.trim();
    if (!code) { setError('Введите код из Telegram'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }
      const res = await fetch(AUTH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ step: 'sign_in', auth_id: authId, code }),
      });
      const data = (await res.json()) as { step?: string; auth_id?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'password_needed') {
        setAuthStep('password_needed');
      } else if (data.step === 'done') {
        setAuthStep('done');
        void loadAccounts();
      }
    } finally {
      setAddBusy(false);
    }
  }, [authId, authCode, loadAccounts]);

  const submitPassword = useCallback(async () => {
    const password = authPassword;
    if (!password) { setError('Введите пароль 2FA'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }
      const res = await fetch(AUTH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ step: 'check_password', auth_id: authId, password }),
      });
      const data = (await res.json()) as { step?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'done') {
        setAuthStep('done');
        void loadAccounts();
      }
    } finally {
      setAddBusy(false);
    }
  }, [authId, authPassword, loadAccounts]);

  const deleteAccount = useCallback(async (id: string) => {
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
  }, [accountId, loadAccounts]);

  const updateDailyLimit = useCallback(async (id: string, newLimit: number) => {
    const token = await getAccessToken();
    if (!token) return;
    const res = await fetch(`${API_ACCOUNTS}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ daily_limit: Math.max(0, newLimit) }),
    });
    if (res.ok) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, daily_limit: Math.max(0, newLimit) } : a)),
      );
    } else {
      const data = (await res.json()) as { error?: string };
      setError(data?.error ?? 'Ошибка обновления лимита');
    }
  }, []);

  const handleFilesUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (!files.length) return;

    setUploading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      const res = await fetch(`${API_ACCOUNTS}/bulk-files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.warnings?.length) {
        setError(`Загружено ${data.count} аккаунтов. Предупреждения: ${data.warnings.join('; ')}`);
      }
      void loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки файлов');
    } finally {
      setUploading(false);
    }
  }, [loadAccounts]);

  // --- Parse ---
  const runParse = useCallback(async () => {
    const linkList = links.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (linkList.length === 0) {
      setError('Введите хотя бы одну ссылку на чат или канал (t.me/… или https://t.me/…)');
      return;
    }

    setBusy(true);
    setError(null);
    setUsers([]);

    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }

      const body: Record<string, unknown> = {
        links: linkList,
        parse_chat_messages: parseMessages,
        parse_chat_members: parseMembers,
        parse_post_comments: parseComments,
        message_limit: messageLimit,
        filter_online: filterOnline,
        filter_recently: filterRecently,
        max_offline_days: maxOfflineDays ? Number(maxOfflineDays) : null,
      };
      if (accountId.trim()) body.account_id = accountId.trim();

      const res = await fetch('/api/tools/tg-parser/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as { status?: string; users?: ParsedUser[]; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.status === 'error') { setError(data.error ?? 'Ошибка парсинга'); return; }
      setUsers(data.users ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    } finally {
      setBusy(false);
    }
  }, [links, accountId, parseMessages, parseMembers, parseComments, messageLimit, filterOnline, filterRecently, maxOfflineDays]);

  const exportCsv = useCallback(async () => {
    if (users.length === 0) return;
    setExporting(true);
    try {
      const header = COLUMNS.join(',');
      const rows = users.map((u) =>
        COLUMNS.map((col) => {
          const v = cellValue(u[col]);
          const needsQuotes = /[",\n\r]/.test(v);
          return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      saveAs(blob, 'tg-parser.csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [users]);

  const exportExcel = useCallback(async () => {
    if (users.length === 0) return;
    setExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('TG Parser');
      ws.columns = COLUMNS.map((col) => ({ header: col, key: col, width: 20 }));
      users.forEach((u) => ws.addRow(u as unknown as Record<string, unknown>));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'tg-parser.xlsx');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  }, [users]);

  useEffect(() => { setError(null); }, [links]);

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">TG User Parser</h1>
        <p className="text-sm text-gray-500 mt-1">
          Парсинг пользователей из Telegram: сообщения в чатах, участники, комментарии к постам. Экспорт в CSV или Excel.
        </p>
      </div>

      {/* Accounts section */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAccountsExpanded((v) => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-800"
          >
            <User className="h-4 w-4" />
            Аккаунты Telegram ({accounts.length})
            {accountsExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <div className="flex items-center gap-2">
            <label className={`inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Загрузить файлы
              <input
                type="file"
                multiple
                accept=".json,.session"
                className="hidden"
                onChange={handleFilesUpload}
                disabled={uploading}
              />
            </label>
            <button
              type="button"
              onClick={() => { setShowAddAccount((v) => !v); setAccountsExpanded(true); }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Добавить
            </button>
          </div>
        </div>

        {accountsExpanded && (
          <div className="mt-4 space-y-4">
            {showAddAccount && (
              <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4 space-y-3">
                {/* Step 1: credentials + phone */}
                {authStep === 'form' && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        placeholder="Название (опционально)"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addPhone}
                        onChange={(e) => setAddPhone(e.target.value)}
                        placeholder="Телефон (+7...)"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addApiId}
                        onChange={(e) => setAddApiId(e.target.value)}
                        placeholder="API ID"
                        type="number"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addApiHash}
                        onChange={(e) => setAddApiHash(e.target.value)}
                        placeholder="API Hash"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      API ID и API Hash можно получить на{' '}
                      <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">my.telegram.org</a>.
                      После нажатия «Авторизовать» на указанный телефон придёт код подтверждения в Telegram.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={startAuth}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Авторизовать
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 2: enter code from Telegram */}
                {authStep === 'code_needed' && (
                  <>
                    <p className="text-sm text-gray-700">
                      Код отправлен на <span className="font-semibold">{addPhone}</span> в Telegram. Введите его ниже:
                    </p>
                    <input
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      placeholder="Код из Telegram"
                      autoFocus
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono tracking-widest text-center text-lg"
                      onKeyDown={(e) => { if (e.key === 'Enter') void submitCode(); }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={submitCode}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Подтвердить код
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 3: 2FA password */}
                {authStep === 'password_needed' && (
                  <>
                    <p className="text-sm text-gray-700">
                      У этого аккаунта включена двухфакторная авторизация. Введите пароль 2FA:
                    </p>
                    <input
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="Пароль 2FA"
                      type="password"
                      autoFocus
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      onKeyDown={(e) => { if (e.key === 'Enter') void submitPassword(); }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={submitPassword}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Подтвердить
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 4: done */}
                {authStep === 'done' && (
                  <div className="flex items-center gap-3 py-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    <p className="text-sm text-gray-700">Аккаунт успешно добавлен!</p>
                    <button
                      type="button"
                      onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                      className="ml-auto rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Закрыть
                    </button>
                  </div>
                )}
              </div>
            )}

            {accountsLoading ? (
              <p className="text-sm text-gray-500 py-2">Загрузка аккаунтов...</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-gray-500 py-2">
                Нет аккаунтов. Добавьте Telegram-аккаунт для парсинга.
              </p>
            ) : (
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {accounts.map((acc) => {
                  const pct = acc.daily_limit > 0
                    ? Math.min(100, Math.round((acc.sent_today / acc.daily_limit) * 100))
                    : 100;
                  const limitReached = acc.sent_today >= acc.daily_limit;
                  const barColor = limitReached
                    ? 'bg-rose-500'
                    : pct > 75
                      ? 'bg-amber-500'
                      : 'bg-emerald-500';

                  return (
                    <div key={acc.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span
                        className={`h-2 w-2 rounded-full shrink-0 ${acc.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`}
                        title={acc.is_active ? 'Активен' : 'Отключен'}
                      />
                      <span className="font-medium text-gray-800 truncate min-w-0 flex-1">
                        {acc.name || `Account ${acc.api_id}`}
                      </span>
                      <span className="text-gray-500 text-xs truncate max-w-[120px]">
                        {acc.phone || `ID: ${acc.api_id}`}
                      </span>
                      {acc.session_data ? (
                        <span className="text-xs text-emerald-600">session ok</span>
                      ) : (
                        <span className="text-xs text-amber-600">no session</span>
                      )}

                      {/* Daily capacity */}
                      <div className="flex items-center gap-2 min-w-[180px]" title="Мощность: отправлено / лимит в день">
                        <Zap className={`h-3.5 w-3.5 shrink-0 ${limitReached ? 'text-rose-500' : 'text-amber-500'}`} />
                        <div className="flex items-center gap-1.5 flex-1">
                          <div className="h-1.5 flex-1 rounded-full bg-gray-200 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${barColor}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={`text-xs tabular-nums whitespace-nowrap ${limitReached ? 'text-rose-600 font-medium' : 'text-gray-500'}`}>
                            {acc.sent_today}/{acc.daily_limit}
                          </span>
                        </div>
                        <input
                          type="number"
                          min={0}
                          defaultValue={acc.daily_limit}
                          key={`${acc.id}-${acc.daily_limit}`}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v) && v >= 0) void updateDailyLimit(acc.id, v);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                          className="w-14 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-center text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          title="Лимит рассылок в день"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => deleteAccount(acc.id)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                        title="Удалить"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Parse form */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        {accounts.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="tg-account" className="text-sm text-gray-600 whitespace-nowrap">
              Аккаунт:
            </label>
            <select
              id="tg-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 min-w-[200px]"
              disabled={busy}
            >
              <option value="">Выберите аккаунт</option>
              {accounts.filter((a) => a.is_active && a.session_data).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || `Account ${a.api_id}`}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-500">выберите аккаунт для парсинга</span>
          </div>
        )}

        <div>
          <label htmlFor="tg-links" className="block text-sm font-medium text-gray-700 mb-2">
            Ссылки на чаты/каналы (по одной на строку)
          </label>
          <textarea
            id="tg-links"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            placeholder={'https://t.me/chatname\nhttps://t.me/channel'}
            rows={4}
            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            disabled={busy}
          />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Парсить:</p>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-messages"
                checked={parseMessages}
                onChange={(e) => setParseMessages(e.target.checked)}
                disabled={busy}
              />
              <label htmlFor="parse-messages" className="text-sm text-gray-700">Сообщения в чатах</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-members"
                checked={parseMembers}
                onChange={(e) => setParseMembers(e.target.checked)}
                disabled={busy}
              />
              <label htmlFor="parse-members" className="text-sm text-gray-700">Участники</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-comments"
                checked={parseComments}
                onChange={(e) => setParseComments(e.target.checked)}
                disabled={busy}
              />
              <label htmlFor="parse-comments" className="text-sm text-gray-700">Комментарии под постами</label>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Сообщения — собирает авторов сообщений из чатов. Участники — список членов группы/канала. Комментарии — авторы комментариев под постами каналов.
          </p>
        </div>

        <div className="flex flex-wrap gap-6 items-end">
          <div>
            <label htmlFor="message-limit" className="block text-sm font-medium text-gray-700 mb-1">Лимит сообщений/участников</label>
            <input
              id="message-limit"
              type="number"
              min={10}
              max={5000}
              value={messageLimit}
              onChange={(e) => setMessageLimit(Math.min(5000, Math.max(10, Number(e.target.value) || 100)))}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-gray-900"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="max-offline" className="block text-sm font-medium text-gray-700 mb-1">Макс. дней оффлайн</label>
            <input
              id="max-offline"
              type="number"
              min={0}
              placeholder="—"
              value={maxOfflineDays}
              onChange={(e) => setMaxOfflineDays(e.target.value)}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-gray-900"
              disabled={busy}
            />
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Фильтр по активности</p>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="filter-online"
                checked={filterOnline}
                onChange={(e) => setFilterOnline(e.target.checked)}
                disabled={busy}
              />
              <label htmlFor="filter-online" className="text-sm text-gray-700">Только онлайн</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="filter-recently"
                checked={filterRecently}
                onChange={(e) => setFilterRecently(e.target.checked)}
                disabled={busy}
              />
              <label htmlFor="filter-recently" className="text-sm text-gray-700">Недавно в сети</label>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            «Только онлайн» — в результатах останутся лишь те, кто сейчас в сети.
            «Недавно в сети» — онлайн + те, кого Telegram помечает как «был недавно».
            «Макс. дней оффлайн» — отсечь тех, кто не заходил дольше N дней (например, 7 = был в сети за последнюю неделю).
            Если ничего не выбрано — возвращаются все пользователи без фильтрации.
          </p>
        </div>

        <button
          type="button"
          onClick={runParse}
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
              Запустить парсинг
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {users.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <div className="p-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              Найдено пользователей: <span className="font-semibold text-gray-900">{users.length}</span>
            </p>
            <div className="flex items-center gap-2">
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
                {users.map((u, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {COLUMNS.map((col) => {
                      const val = u[col];
                      const isLink = col === 'Ссылка на источник' || col === 'Личный канал';
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

      {!busy && users.length === 0 && !error && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-12 text-center">
          <p className="text-gray-500 text-sm">
            Введите ссылки на чаты или каналы (t.me/…), выберите режимы парсинга и нажмите «Запустить парсинг».
            Парсинг может занять несколько минут.
          </p>
        </div>
      )}
    </div>
  );
}
