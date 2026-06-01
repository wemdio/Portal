'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Package } from 'lucide-react';
import { authFetch, authFetchJson } from '@/lib/authFetch';
import type {
  SalesChatAccountRow,
  SalesChatAccountStatus,
  SalesChatSyncRunRow,
} from '@/types';

/** Состояние задания на сборку ZIP-архива всех диалогов аккаунта. */
interface ArchiveJobRow {
  id: string;
  account_id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  dialogs_total: number | null;
  dialogs_done: number;
  file_size_bytes: number | null;
  s3_key: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  attachments?: AttachmentRow[];
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  tg_message_id: number;
  media_type: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  status: 'uploaded' | 'skipped' | 'error';
  error_message: string | null;
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

function formatBytes(value: number | null | undefined): string {
  if (!value || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function filenameFromDisposition(value: string | null, fallback: string): string {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return fallback;
    }
  }
  const plain = value?.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || fallback;
}

function downloadBlob(filename: string, blob: Blob): void {
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

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-gray-500">
      <svg className="h-4 w-4 text-blue-600" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3">
          <animateTransform
            attributeName="transform"
            dur="0.8s"
            from="0 12 12"
            repeatCount="indefinite"
            to="360 12 12"
            type="rotate"
          />
        </path>
      </svg>
      <span>{label}</span>
    </div>
  );
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
  const [dialogsLoading, setDialogsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [archiveJob, setArchiveJob] = useState<ArchiveJobRow | null>(null);

  // Мастер подключения.
  const [connectOpen, setConnectOpen] = useState(false);
  const [authStep, setAuthStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [authId, setAuthId] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [sentType, setSentType] = useState<string | null>(null);

  const initialLoaded = useRef(false);

  const loadAccounts = useCallback(async () => {
    const data = await authFetchJson<{ accounts: AccountListRow[] }>(`${API}/accounts`, { method: 'GET' });
    setAccounts(data.accounts ?? []);
  }, []);

  const loadDialogs = useCallback(async (accountId: string, q: string, silent = false) => {
    if (!silent) setDialogsLoading(true);
    try {
      const url = `${API}/accounts/${accountId}/dialogs${q ? `?q=${encodeURIComponent(q)}` : ''}`;
      const data = await authFetchJson<{ dialogs: DialogRow[] }>(url, { method: 'GET' });
      setDialogs(data.dialogs ?? []);
    } finally {
      if (!silent) setDialogsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (dialogId: string, silent = false) => {
    if (!silent) setMessagesLoading(true);
    try {
      const data = await authFetchJson<{ messages: MessageRow[] }>(
        `${API}/dialogs/${dialogId}/messages`,
        { method: 'GET' },
      );
      setMessages(data.messages ?? []);
    } finally {
      if (!silent) setMessagesLoading(false);
    }
  }, []);

  const loadSync = useCallback(async () => {
    const data = await authFetchJson<{ runs: SalesChatSyncRunRow[] }>(`${API}/sync`, { method: 'GET' });
    setSyncRuns(data.runs ?? []);
  }, []);

  const loadArchiveJob = useCallback(async (accountId: string) => {
    const data = await authFetchJson<{ job: ArchiveJobRow | null }>(
      `${API}/accounts/${accountId}/archive`,
      { method: 'GET' },
    );
    setArchiveJob(data.job ?? null);
  }, []);

  const startArchive = useCallback(async () => {
    if (!selectedAccount) return;
    setBusy('archive-start');
    setError(null);
    try {
      const data = await authFetchJson<{ job: ArchiveJobRow }>(
        `${API}/accounts/${selectedAccount}/archive`,
        { method: 'POST' },
      );
      setArchiveJob(data.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [selectedAccount]);

  const downloadArchive = useCallback(async (jobId: string) => {
    setBusy('archive-download');
    setError(null);
    try {
      const data = await authFetchJson<{ url: string; filename: string }>(
        `${API}/archives/${jobId}/download`,
        { method: 'GET' },
      );
      // Триггерим скачивание через клик по ссылке — браузер сам обработает
      // 7-дневный presigned URL и скачает файл (для больших ZIP это сильно
      // лучше, чем грузить blob в RAM вкладки).
      const a = document.createElement('a');
      a.href = data.url;
      a.download = data.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
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

  // Периодическое обновление: статусы аккаунтов, диалоги, сообщения открытого
  // диалога, прогресс архива (если он собирается прямо сейчас).
  const archiveActive = archiveJob?.status === 'pending' || archiveJob?.status === 'running';
  useEffect(() => {
    const timer = window.setInterval(() => {
      loadAccounts().catch(() => {});
      loadSync().catch(() => {});
      if (selectedAccount) loadDialogs(selectedAccount, dialogQuery, true).catch(() => {});
      if (selectedDialog) loadMessages(selectedDialog.id, true).catch(() => {});
      if (selectedAccount && archiveActive) loadArchiveJob(selectedAccount).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [
    loadAccounts, loadSync, loadDialogs, loadMessages, loadArchiveJob,
    selectedAccount, selectedDialog, dialogQuery, archiveActive,
  ]);

  const selectAccount = useCallback(
    async (accountId: string) => {
      setSelectedAccount(accountId);
      setSelectedDialog(null);
      setDialogs([]);
      setMessages([]);
      setDialogQuery('');
      setArchiveJob(null);
      try {
        await Promise.all([
          loadDialogs(accountId, ''),
          // Подтягиваем последний архив для аккаунта: если уже собирался —
          // покажем готовую ссылку или прогресс прямо в шапке колонки.
          loadArchiveJob(accountId).catch(() => {}),
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      }
    },
    [loadDialogs, loadArchiveJob],
  );

  const selectDialog = useCallback(
    async (dialog: DialogRow) => {
      setSelectedDialog(dialog);
      setMessages([]);
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
    setAuthToken('');
    setSentType(null);
  }, []);

  const sendCode = useCallback(async () => {
    if (!phone.trim()) {
      setError('Укажите номер телефона');
      return;
    }
    setBusy('auth');
    setError(null);
    try {
      const data = await authFetchJson<{
        step: string;
        auth_id: string;
        auth_token: string;
        sent_type: string;
        next_type: string;
        timeout: number | null;
      }>(`${API}/accounts/auth`, {
        method: 'POST',
        body: JSON.stringify({ step: 'send_code', phone: phone.trim(), label: label.trim() }),
      });
      setAuthId(data.auth_id);
      setAuthToken(data.auth_token);
      setSentType(data.sent_type);
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
      const data = await authFetchJson<{ step: string; auth_id?: string; auth_token?: string }>(`${API}/accounts/auth`, {
        method: 'POST',
        body: JSON.stringify({ step: 'sign_in', auth_id: authId, auth_token: authToken, code: code.trim() }),
      });
      if (data.step === 'password_needed') {
        if (data.auth_id) setAuthId(data.auth_id);
        if (data.auth_token) setAuthToken(data.auth_token);
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
  }, [code, authId, authToken, resetConnect, loadAccounts]);

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
        body: JSON.stringify({ step: 'check_password', auth_id: authId, auth_token: authToken, password }),
      });
      resetConnect();
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [password, authId, authToken, resetConnect, loadAccounts]);


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

  const downloadChatDocx = useCallback(async () => {
    if (!selectedDialog || messages.length === 0) return;
    setBusy('export-docx');
    setError(null);
    try {
      const res = await authFetch(`${API}/dialogs/${selectedDialog.id}/export?format=docx`, { method: 'GET' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Error ${res.status}`);
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(
        res.headers.get('content-disposition'),
        `${selectedDialog.peer_title ?? `dialog_${selectedDialog.tg_peer_id}`}.docx`,
      );
      downloadBlob(filename, blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'РћС€РёР±РєР°');
    } finally {
      setBusy(null);
    }
  }, [selectedDialog, messages.length]);

  const downloadAttachment = useCallback(async (attachment: AttachmentRow) => {
    setBusy(attachment.id);
    setError(null);
    try {
      const res = await authFetch(`${API}/attachments/${attachment.id}/download`, { method: 'GET' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Error ${res.status}`);
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(
        res.headers.get('content-disposition'),
        attachment.file_name ?? `telegram-document-${attachment.tg_message_id}`,
      );
      downloadBlob(filename, blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка скачивания файла');
    } finally {
      setBusy(null);
    }
  }, []);

  const selectedAccountRow = accounts.find((acc) => acc.id === selectedAccount) ?? null;

  /** Архив считаем «свежим» (можно качать) если done и моложе 7 дней. */
  const isArchiveDownloadable = (() => {
    if (!archiveJob || archiveJob.status !== 'done' || !archiveJob.finished_at) return false;
    return Date.now() - new Date(archiveJob.finished_at).getTime() <= ARCHIVE_TTL_MS;
  })();

  /** Рисует управление архивом справа от заголовка «Диалоги». */
  const renderArchiveControl = () => {
    const isPending = archiveJob?.status === 'pending';
    const isRunning = archiveJob?.status === 'running';

    if (isPending || isRunning) {
      const total = archiveJob?.dialogs_total ?? 0;
      const done = archiveJob?.dialogs_done ?? 0;
      const label = isPending && total === 0
        ? 'Ставим в очередь…'
        : `Собираем архив: ${done}${total ? ` / ${total}` : ''}`;
      return (
        <div className="flex items-center gap-1.5 text-xs text-gray-600 min-w-0">
          <Loader2 className="h-3.5 w-3.5 text-blue-600 animate-spin shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </div>
      );
    }

    if (isArchiveDownloadable && archiveJob) {
      const sizeLabel = archiveJob.file_size_bytes ? ` · ${formatBytes(archiveJob.file_size_bytes)}` : '';
      return (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void downloadArchive(archiveJob.id)}
            disabled={busy === 'archive-download'}
            title="Скачать готовый ZIP-архив"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {busy === 'archive-download' ? 'Готовим…' : `Скачать .zip${sizeLabel}`}
          </button>
          <button
            type="button"
            onClick={() => void startArchive()}
            disabled={busy != null}
            title="Пересобрать архив с актуальными данными"
            className="text-xs text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline disabled:opacity-50"
          >
            пересобрать
          </button>
        </div>
      );
    }

    // Дефолт: архив не собран / истёк / упал — кнопка запуска (+ текст ошибки).
    return (
      <div className="flex flex-col items-end gap-0.5 min-w-0">
        <button
          type="button"
          onClick={() => void startArchive()}
          disabled={busy != null || dialogs.length === 0}
          title="Собрать ZIP со всеми диалогами этого аккаунта (1 диалог = 1 DOCX)"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Package className="h-3.5 w-3.5" aria-hidden />
          {busy === 'archive-start' ? 'Создаём…' : 'Скачать архив'}
        </button>
        {archiveJob?.status === 'error' ? (
          <span
            className="text-[10px] text-red-600 max-w-[180px] truncate"
            title={archiveJob.error_message ?? 'unknown error'}
          >
            Ошибка: {archiveJob.error_message ?? 'unknown'}
          </span>
        ) : null}
      </div>
    );
  };

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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-gray-500">Запускает выгрузку по всем активным аккаунтам</span>
          <button
            type="button"
            onClick={triggerSync}
            disabled={busy != null}
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'sync' ? 'Запуск…' : 'Выгрузить сейчас'}
          </button>
        </div>
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
                {sentType === 'sms'
                  ? `Код отправлен по SMS на номер ${phone}. Введите его:`
                  : sentType === 'call' || sentType === 'flash_call' || sentType === 'missed_call'
                    ? `Telegram позвонит на номер ${phone}. Введите код из звонка:`
                    : `Код отправлен в приложение Telegram на номер ${phone}. Введите его:`}
              </p>
              <div className="flex items-center gap-3">
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
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={busy === 'auth'}
                  className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                >
                  Отправить повторно
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
          <div className="flex items-start justify-between gap-2 mb-3 min-h-[2rem]">
            <h2 className="text-sm font-semibold text-gray-900 shrink-0 pt-1">Диалоги</h2>
            {selectedAccount ? renderArchiveControl() : null}
          </div>
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
                {dialogsLoading ? (
                  <LoadingState label="Загружаем диалоги..." />
                ) : dialogs.length === 0 ? (
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
              onClick={downloadChatDocx}
              disabled={!selectedDialog || messages.length === 0 || busy === 'export-docx'}
              title="Скачать всю переписку в DOCX с ссылками на файлы из S3"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {busy === 'export-docx' ? 'Готовим...' : 'Скачать .docx'}
            </button>
          </div>
          {!selectedDialog ? (
            <div className="text-sm text-gray-500">Выберите диалог.</div>
          ) : messagesLoading ? (
            <LoadingState label="Загружаем переписку..." />
          ) : messages.length === 0 ? (
            <div className="text-sm text-gray-500">В этом диалоге пока нет сообщений.</div>
          ) : (
            <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1">
              {messages.map((m) => {
                const isOwn =
                  m.direction === 'out' ||
                  (selectedAccountRow?.tg_user_id != null && m.sender_tg_id === selectedAccountRow.tg_user_id);
                return (
                <div
                  key={m.id}
                  className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl border px-3 py-2 text-sm ${
                      isOwn
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
                    {m.attachments?.length ? (
                      <div className="mt-1 space-y-0.5 text-xs text-gray-600">
                        {m.attachments.map((a) => (
                          a.status === 'uploaded' ? (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => void downloadAttachment(a)}
                              disabled={busy === a.id}
                              className="inline-flex max-w-full items-center gap-1 text-left font-medium text-blue-700 hover:text-blue-800 hover:underline disabled:opacity-50"
                              title="Скачать файл"
                            >
                              <Download className="h-3 w-3 shrink-0" aria-hidden />
                              <span className="truncate">{a.file_name ?? `telegram-document-${a.tg_message_id}`}</span>
                              {a.file_size_bytes ? <span className="shrink-0 text-gray-500">· {formatBytes(a.file_size_bytes)}</span> : null}
                            </button>
                          ) : (
                            <div key={a.id}>
                              {a.file_name ?? `telegram-document-${a.tg_message_id}`}
                              {a.file_size_bytes ? ` · ${formatBytes(a.file_size_bytes)}` : ''}
                              {a.error_message ? ` · ${a.error_message}` : ''}
                            </div>
                          )
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
