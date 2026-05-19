'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { authFetchJson } from '@/lib/authFetch';
import type {
  SalesChatAccountRow,
  SalesChatAccountStatus,
  SalesChatSyncRunRow,
} from '@/types';

const API = '/api/tools/sales-chat-analyzer';
const POLL_MS = 10_000;

type AccountListRow = Omit<SalesChatAccountRow, 'created_by'>;

interface DialogRow {
  id: string;
  account_id: string;
  tg_peer_id: number;
  peer_type: string;
  peer_title: string | null;
  peer_username: string | null;
  last_message_at: string | null;
  message_count: number;
}

interface MessageRow {
  id: string;
  dialog_id: string;
  tg_message_id: number;
  direction: 'in' | 'out';
  sender_tg_id: number | null;
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  sent_at: string;
}

function formatDate(value: string | null | undefined): string {
  const s = String(value ?? '').trim();
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function safeTxtFilename(title: string | null, tgPeerId: number): string {
  const base =
    (title?.trim() ? title.replace(/[/\\?%*:|"<>[\]\n\r\t]/g, '_').slice(0, 80) : '') ||
    `dialog_${tgPeerId}`;
  return `${base}.txt`;
}

function buildMessagesTxt(dialog: DialogRow, messages: MessageRow[]): string {
  const title = dialog.peer_title ?? `Диалог ${dialog.tg_peer_id}`;
  const lines = messages.map((m) => {
    const who = m.sender_name ?? (m.direction === 'out' ? 'Менеджер' : 'Собеседник');
    const when = formatDate(m.sent_at);
    const parts: string[] = [];
    if (m.text?.trim()) parts.push(m.text.trim());
    if (m.media_type) parts.push(`[${m.media_type}]`);
    const body = parts.length > 0 ? parts.join('\n') : '(пустое сообщение)';
    return `[${when}] ${who}\n${body}`;
  });
  return `${title}\n${'─'.repeat(48)}\n\n${lines.join('\n\n')}\n`;
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function statusBadge(s: SalesChatAccountStatus): { label: string; cls: string } {
  switch (s) {
    case 'active':
      return { label: 'Активен', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'auth_error':
      return { label: 'Сессия слетела', cls: 'bg-red-50 text-red-700 border-red-200' };
    case 'disabled':
      return { label: 'Выключен', cls: 'bg-gray-100 text-gray-600 border-gray-200' };
    default:
      return { label: String(s), cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  }
}

function accountSyncLabel(acc: AccountListRow): string {
  switch (acc.backfill_status) {
    case 'pending':
      return 'Ожидает синхронизации';
    case 'running':
      return `Синхронизация: ${acc.backfill_dialogs_done}${
        acc.backfill_dialogs_total != null ? ` / ${acc.backfill_dialogs_total}` : ''
      } диалогов`;
    case 'done':
      return acc.last_synced_at
        ? `Синхронизировано: ${formatDate(acc.last_synced_at)}`
        : 'Синхронизировано';
    case 'error':
      return 'Ошибка синхронизации';
    default:
      return String(acc.backfill_status);
  }
}

/** Текст статуса синхронизации по последним запускам. */
function syncStatusText(runs: SalesChatSyncRunRow[]): string {
  const latest = runs[0];
  if (latest && (latest.status === 'pending' || latest.status === 'running')) {
    return `Идёт синхронизация… ${latest.accounts_done}${
      latest.accounts_total != null ? ` / ${latest.accounts_total}` : ''
    } аккаунтов`;
  }
  const lastDone = runs.find((r) => r.status === 'done');
  if (lastDone) return `Последняя синхронизация: ${formatDate(lastDone.finished_at)}`;
  if (runs.some((r) => r.status === 'error')) return 'Последняя синхронизация завершилась ошибкой';
  return 'Синхронизаций ещё не было';
}

export function SalesChatAnalyzerView() {
  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [dialogs, setDialogs] = useState<DialogRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [syncRuns, setSyncRuns] = useState<SalesChatSyncRunRow[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedDialog, setSelectedDialog] = useState<DialogRow | null>(null);
  const [dialogQuery, setDialogQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Мастер подключения.
  const [connectOpen, setConnectOpen] = useState(false);
  const [authStep, setAuthStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [authId, setAuthId] = useState('');

  const initialLoaded = useRef(false);

  const loadAccounts = useCallback(async () => {
    const data = await authFetchJson<{ accounts: AccountListRow[] }>(`${API}/accounts`, { method: 'GET' });
    setAccounts(data.accounts ?? []);
  }, []);

  const loadDialogs = useCallback(async (accountId: string, q: string) => {
    const url = `${API}/accounts/${accountId}/dialogs${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    const data = await authFetchJson<{ dialogs: DialogRow[] }>(url, { method: 'GET' });
    setDialogs(data.dialogs ?? []);
  }, []);

  const loadMessages = useCallback(async (dialogId: string) => {
    const data = await authFetchJson<{ messages: MessageRow[] }>(
      `${API}/dialogs/${dialogId}/messages`,
      { method: 'GET' },
    );
    setMessages(data.messages ?? []);
  }, []);

  const loadSync = useCallback(async () => {
    const data = await authFetchJson<{ runs: SalesChatSyncRunRow[] }>(`${API}/sync`, { method: 'GET' });
    setSyncRuns(data.runs ?? []);
  }, []);

  const triggerSync = useCallback(async () => {
    if (
      !window.confirm(
        'Синхронизация и так выполняется автоматически каждую ночь в 01:00 МСК.\n\n' +
          'Запустить выгрузку прямо сейчас?',
      )
    ) {
      return;
    }
    setBusy('sync');
    setError(null);
    try {
      await authFetchJson(`${API}/sync`, { method: 'POST' });
      await loadSync();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadSync]);

  useEffect(() => {
    if (initialLoaded.current) return;
    initialLoaded.current = true;
    loadAccounts().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'));
    loadSync().catch(() => {});
  }, [loadAccounts, loadSync]);

  // Периодическое обновление: статусы аккаунтов, диалоги, сообщения открытого диалога.
  useEffect(() => {
    const timer = window.setInterval(() => {
      loadAccounts().catch(() => {});
      loadSync().catch(() => {});
      if (selectedAccount) loadDialogs(selectedAccount, dialogQuery).catch(() => {});
      if (selectedDialog) loadMessages(selectedDialog.id).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadAccounts, loadSync, loadDialogs, loadMessages, selectedAccount, selectedDialog, dialogQuery]);

  const selectAccount = useCallback(
    async (accountId: string) => {
      setSelectedAccount(accountId);
      setSelectedDialog(null);
      setMessages([]);
      setDialogQuery('');
      try {
        await loadDialogs(accountId, '');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      }
    },
    [loadDialogs],
  );

  const selectDialog = useCallback(
    async (dialog: DialogRow) => {
      setSelectedDialog(dialog);
      try {
        await loadMessages(dialog.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      }
    },
    [loadMessages],
  );

  const resetConnect = useCallback(() => {
    setConnectOpen(false);
    setAuthStep('phone');
    setPhone('');
    setLabel('');
    setCode('');
    setPassword('');
    setAuthId('');
  }, []);

  const sendCode = useCallback(async () => {
    if (!phone.trim()) {
      setError('Укажите номер телефона');
      return;
    }
    setBusy('auth');
    setError(null);
    try {
      const data = await authFetchJson<{ step: string; auth_id: string }>(`${API}/accounts/auth`, {
        method: 'POST',
        body: JSON.stringify({ step: 'send_code', phone: phone.trim(), label: label.trim() }),
      });
      setAuthId(data.auth_id);
      setAuthStep('code');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [phone, label]);

  const signIn = useCallback(async () => {
    if (!code.trim()) {
      setError('Введите код из Telegram');
      return;
    }
    setBusy('auth');
    setError(null);
    try {
      const data = await authFetchJson<{ step: string }>(`${API}/accounts/auth`, {
        method: 'POST',
        body: JSON.stringify({ step: 'sign_in', auth_id: authId, code: code.trim() }),
      });
      if (data.step === 'password_needed') {
        setAuthStep('password');
        return;
      }
      resetConnect();
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [code, authId, resetConnect, loadAccounts]);

  const checkPassword = useCallback(async () => {
    if (!password) {
      setError('Введите пароль 2FA');
      return;
    }
    setBusy('auth');
    setError(null);
    try {
      await authFetchJson<{ step: string }>(`${API}/accounts/auth`, {
        method: 'POST',
        body: JSON.stringify({ step: 'check_password', auth_id: authId, password }),
      });
      resetConnect();
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [password, authId, resetConnect, loadAccounts]);

  const toggleAccount = useCallback(
    async (acc: AccountListRow) => {
      const next = acc.status === 'disabled' ? 'active' : 'disabled';
      setBusy(acc.id);
      setError(null);
      try {
        await authFetchJson(`${API}/accounts/${acc.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        await loadAccounts();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [loadAccounts],
  );

  const deleteAccount = useCallback(
    async (acc: AccountListRow) => {
      if (
        !window.confirm(
          `Удалить аккаунт «${acc.label ?? acc.phone}»? ` +
            'Захват остановится, но уже выгруженные переписки останутся в базе.',
        )
      ) {
        return;
      }
      setBusy(acc.id);
      setError(null);
      try {
        await authFetchJson(`${API}/accounts/${acc.id}`, { method: 'DELETE' });
        if (selectedAccount === acc.id) {
          setSelectedAccount(null);
          setSelectedDialog(null);
          setDialogs([]);
          setMessages([]);
        }
        await loadAccounts();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [loadAccounts, selectedAccount],
  );

  const downloadChatTxt = useCallback(() => {
    if (!selectedDialog || messages.length === 0) return;
    const name = safeTxtFilename(selectedDialog.peer_title, selectedDialog.tg_peer_id);
    downloadTextFile(name, buildMessagesTxt(selectedDialog, messages));
  }, [selectedDialog, messages]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Анализатор сейлз-переписок</h1>
        <p className="text-sm text-gray-500 mt-1">
          Подключите Telegram-аккаунты сейлз-менеджеров — все диалоги выгружаются в базу.
          Синхронизация выполняется автоматически каждую ночь в 01:00 МСК.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
        <div className="text-sm text-gray-600">{syncStatusText(syncRuns)}</div>
        <button
          type="button"
          onClick={triggerSync}
          disabled={busy != null}
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy === 'sync' ? 'Запуск…' : 'Выгрузить сейчас'}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {connectOpen ? (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Подключение аккаунта</h2>
            <button
              type="button"
              onClick={resetConnect}
              className="text-sm text-gray-500 hover:text-gray-800"
            >
              Отмена
            </button>
          </div>

          {authStep === 'phone' ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <div className="text-xs font-medium text-gray-600 mb-1">Номер телефона</div>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+79991234567"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <div className="text-xs font-medium text-gray-600 mb-1">Название (необязательно)</div>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Например: Алексей — продажи"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={busy === 'auth'}
                  className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy === 'auth' ? 'Отправка…' : 'Отправить код'}
                </button>
              </div>
            </div>
          ) : null}

          {authStep === 'code' ? (
            <div className="mt-4">
              <p className="text-sm text-gray-600 mb-2">
                Код отправлен в приложение Telegram на номер {phone}. Введите его:
              </p>
              <div className="flex items-end gap-3">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="12345"
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={signIn}
                  disabled={busy === 'auth'}
                  className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy === 'auth' ? 'Вход…' : 'Войти'}
                </button>
              </div>
            </div>
          ) : null}

          {authStep === 'password' ? (
            <div className="mt-4">
              <p className="text-sm text-gray-600 mb-2">У аккаунта включена 2FA. Введите пароль (облачный пароль):</p>
              <div className="flex items-end gap-3">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={checkPassword}
                  disabled={busy === 'auth'}
                  className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy === 'auth' ? 'Проверка…' : 'Подтвердить'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Колонка 1: аккаунты */}
        <div className="lg:col-span-2 rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Аккаунты ({accounts.length})</h2>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              + Подключить аккаунт
            </button>
          </div>
          <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
            {accounts.length === 0 ? (
              <div className="text-sm text-gray-500">Нет подключённых аккаунтов.</div>
            ) : (
              accounts.map((acc) => {
                const badge = statusBadge(acc.status);
                return (
                  <div
                    key={acc.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectAccount(acc.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectAccount(acc.id);
                      }
                    }}
                    className={`cursor-pointer rounded-xl border p-3 text-sm transition ${
                      selectedAccount === acc.id
                        ? 'border-blue-300 bg-blue-50'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900 truncate">
                        {acc.label ?? acc.phone}
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">{acc.phone}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      {accountSyncLabel(acc)}
                    </div>
                    {acc.last_error ? (
                      <div className="mt-1 text-xs text-red-600 truncate">{acc.last_error}</div>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAccount(acc);
                        }}
                        disabled={busy === acc.id}
                        className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {acc.status === 'disabled' ? 'Включить' : 'Выключить'}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAccount(acc);
                        }}
                        disabled={busy === acc.id}
                        className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Колонка 2: диалоги */}
        <div className="lg:col-span-3 rounded-2xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Диалоги</h2>
          {!selectedAccount ? (
            <div className="text-sm text-gray-500">Выберите аккаунт слева.</div>
          ) : (
            <>
              <input
                value={dialogQuery}
                onChange={(e) => {
                  setDialogQuery(e.target.value);
                  loadDialogs(selectedAccount, e.target.value).catch(() => {});
                }}
                placeholder="Поиск по названию…"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3"
              />
              <div className="space-y-1 max-h-[520px] overflow-y-auto pr-1">
                {dialogs.length === 0 ? (
                  <div className="text-sm text-gray-500">Диалогов пока нет.</div>
                ) : (
                  dialogs.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => selectDialog(d)}
                      className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition ${
                        selectedDialog?.id === d.id
                          ? 'border-blue-300 bg-blue-50'
                          : 'border-gray-200 bg-white hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900 truncate">
                        {d.peer_title ?? `id${d.tg_peer_id}`}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between text-xs text-gray-500">
                        <span>{d.message_count} сообщ.</span>
                        <span>{formatDate(d.last_message_at)}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* Колонка 3: сообщения */}
        <div className="lg:col-span-7 rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-gray-900 min-w-0 flex-1">
              {selectedDialog ? selectedDialog.peer_title ?? `Диалог ${selectedDialog.tg_peer_id}` : 'Переписка'}
            </h2>
            <button
              type="button"
              onClick={downloadChatTxt}
              disabled={!selectedDialog || messages.length === 0}
              title="Скачать всю переписку в текстовый файл"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Скачать .txt
            </button>
          </div>
          {!selectedDialog ? (
            <div className="text-sm text-gray-500">Выберите диалог.</div>
          ) : messages.length === 0 ? (
            <div className="text-sm text-gray-500">В этом диалоге пока нет сообщений.</div>
          ) : (
            <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl border px-3 py-2 text-sm ${
                      m.direction === 'out'
                        ? 'border-blue-200 bg-blue-50 text-gray-900'
                        : 'border-gray-200 bg-gray-50 text-gray-900'
                    }`}
                  >
                    <div className="text-[11px] text-gray-500 mb-0.5">
                      {m.sender_name ?? (m.direction === 'out' ? 'Менеджер' : 'Собеседник')} ·{' '}
                      {formatDate(m.sent_at)}
                    </div>
                    {m.text ? (
                      <div className="whitespace-pre-wrap break-words">{m.text}</div>
                    ) : null}
                    {m.media_type ? (
                      <div className="mt-0.5 text-xs italic text-gray-500">[{m.media_type}]</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
