'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  FileSpreadsheet,
  History,
  KeyRound,
  Loader2,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';

import { authFetch } from '@/lib/authFetch';

// ── Types (mirror app/src/lib/tools/polzaReports/types.ts) ──────────────────

type Tab = 'coldy' | 'trigga';

interface CredentialsView {
  email_hint: string | null;
  url: string;
  updated_at: string;
}

type ColdyPhase = 'login' | 'campaigns_list' | 'analytics' | 'formatting';

interface ColdyProgress {
  phase: ColdyPhase;
  current?: number;
  total?: number;
  campaign_name?: string;
}

interface JobItem {
  id: string;
  source: 'coldy' | 'trigga';
  status: 'pending' | 'running' | 'completed' | 'failed';
  detailed: boolean;
  include_created: boolean;
  include_base_left: boolean;
  result_filename: string | null;
  campaigns_count: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const COLDY_DEFAULT_URL = 'https://app.coldy.ai';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PolzaReportsPage() {
  const [tab, setTab] = useState<Tab>('coldy');
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const refreshHistory = useCallback(() => {
    setHistoryRefreshKey((n) => n + 1);
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Отчёты по рассылкам</h1>
        <p className="mt-1 text-sm text-gray-600">
          Excel-отчёты по email-кампаниям из двух источников: Coldy (через автоматический заход
          в кабинет) и Trigga (через загрузку CSV).
        </p>
      </header>

      <div className="mb-6 inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === 'coldy'} onClick={() => setTab('coldy')}>
          Coldy
        </TabButton>
        <TabButton active={tab === 'trigga'} onClick={() => setTab('trigga')}>
          Trigga
        </TabButton>
      </div>

      <div className="space-y-6">
        {tab === 'coldy' ? (
          <ColdyTab onCompleted={refreshHistory} />
        ) : (
          <TriggaTab onCompleted={refreshHistory} />
        )}

        <ReportHistory refreshKey={historyRefreshKey} />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-indigo-600 text-white shadow'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      }`}
    >
      {children}
    </button>
  );
}

// ── Coldy tab ───────────────────────────────────────────────────────────────

function ColdyTab({ onCompleted }: { onCompleted: () => void }) {
  const [credentials, setCredentials] = useState<CredentialsView | null>(null);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(COLDY_DEFAULT_URL);
  const [savingCreds, setSavingCreds] = useState(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);

  const [detailed, setDetailed] = useState(true);
  const [reportError, setReportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ColdyProgress | null>(null);
  const [running, setRunning] = useState(false);

  const loadCredentials = useCallback(async () => {
    try {
      const res = await authFetch('/api/tools/polza-reports/credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { credentials: CredentialsView | null };
      setCredentials(data.credentials);
      setEditing(!data.credentials);
      if (data.credentials) {
        setUrl(data.credentials.url || COLDY_DEFAULT_URL);
      }
    } catch (err) {
      setCredentialsError(err instanceof Error ? err.message : 'Не удалось загрузить настройки');
    } finally {
      setCredentialsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  const saveCredentials = async () => {
    setCredentialsError(null);
    if (!email.trim() || !password) {
      setCredentialsError('Заполните email и пароль');
      return;
    }
    setSavingCreds(true);
    try {
      const res = await authFetch('/api/tools/polza-reports/credentials', {
        method: 'PUT',
        body: JSON.stringify({ email: email.trim(), password, url: url.trim() }),
      });
      const data = (await res.json()) as { credentials?: CredentialsView; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setCredentials(data.credentials ?? null);
      setEditing(false);
      setPassword('');
    } catch (err) {
      setCredentialsError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSavingCreds(false);
    }
  };

  const deleteCredentials = async () => {
    if (!confirm('Удалить сохранённые данные Coldy?')) return;
    setSavingCreds(true);
    try {
      const res = await authFetch('/api/tools/polza-reports/credentials', { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setCredentials(null);
      setEditing(true);
      setEmail('');
      setPassword('');
      setUrl(COLDY_DEFAULT_URL);
    } catch (err) {
      setCredentialsError(err instanceof Error ? err.message : 'Не удалось удалить');
    } finally {
      setSavingCreds(false);
    }
  };

  const runReport = async () => {
    setReportError(null);
    setProgress(null);
    setRunning(true);
    try {
      const res = await authFetch('/api/tools/polza-reports/coldy/stream', {
        method: 'POST',
        body: JSON.stringify({
          detailed,
          include_created: true,
          include_base_left: true,
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let downloadInfo: { downloadUrl: string; filename: string } | null = null;
      let errorMessage: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          const eventType = event.type as string | undefined;
          if (eventType === 'progress') {
            setProgress({
              phase: event.phase as ColdyPhase,
              current: typeof event.current === 'number' ? event.current : undefined,
              total: typeof event.total === 'number' ? event.total : undefined,
              campaign_name:
                typeof event.campaign_name === 'string' ? event.campaign_name : undefined,
            });
          } else if (eventType === 'result') {
            downloadInfo = {
              downloadUrl: String(event.downloadUrl),
              filename: String(event.filename),
            };
          } else if (eventType === 'error') {
            errorMessage = String(event.message ?? 'Неизвестная ошибка');
          }
        }
      }

      if (errorMessage) throw new Error(errorMessage);
      if (!downloadInfo) throw new Error('Не получили ссылку на отчёт');

      triggerDownload(downloadInfo.downloadUrl, downloadInfo.filename);
      onCompleted();
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'Не удалось сформировать отчёт');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <section className="space-y-6">
      <Card title="Учётные данные Coldy" icon={<KeyRound className="h-5 w-5 text-indigo-600" />}>
        {!credentialsLoaded ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загружаю настройки…
          </div>
        ) : credentials && !editing ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Данные сохранены</p>
                  <p className="mt-0.5 text-emerald-800">
                    Email: <span className="font-mono">{credentials.email_hint ?? '—'}</span>
                    {' · '}
                    URL: <span className="font-mono">{credentials.url}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-emerald-700">
                    Обновлено: {formatDate(credentials.updated_at)}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setEmail('');
                  setPassword('');
                  setUrl(credentials.url || COLDY_DEFAULT_URL);
                }}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Изменить
              </button>
              <button
                type="button"
                onClick={deleteCredentials}
                disabled={savingCreds}
                className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />
                Удалить
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Данные шифруются на сервере (AES-256-GCM) и не передаются в браузер ни в каком виде
              после сохранения.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email Coldy" icon={<Mail className="h-4 w-4 text-gray-400" />}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  placeholder="login@example.com"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </Field>
              <Field label="Пароль" icon={<KeyRound className="h-4 w-4 text-gray-400" />}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </Field>
              <Field label="URL Coldy" className="sm:col-span-2">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={COLDY_DEFAULT_URL}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </Field>
            </div>
            {credentialsError && <InlineError message={credentialsError} />}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveCredentials}
                disabled={savingCreds}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {savingCreds && <Loader2 className="h-4 w-4 animate-spin" />}
                Сохранить
              </button>
              {credentials && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setCredentialsError(null);
                  }}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Отмена
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Сформировать отчёт Coldy"
        icon={<FileSpreadsheet className="h-5 w-5 text-indigo-600" />}
      >
        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={detailed}
              onChange={(e) => setDetailed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              <span className="font-medium text-gray-900">Детальный отчёт</span>
              <span className="block text-xs text-gray-500">
                Заходит в каждую кампанию и собирает статистику по письмам. Дольше (~30–60 сек на
                всё), зато в xlsx появляется разбивка по шагам.
              </span>
            </span>
          </label>

          {progress && <ProgressBar progress={progress} />}
          {reportError && <InlineError message={reportError} />}

          <button
            type="button"
            onClick={runReport}
            disabled={running || !credentials}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-4 w-4" />
            )}
            {running ? 'Собираю…' : 'Сформировать отчёт'}
          </button>
          {!credentials && credentialsLoaded && (
            <p className="text-xs text-gray-500">
              Сначала сохраните учётные данные Coldy выше.
            </p>
          )}
        </div>
      </Card>
    </section>
  );
}

function ProgressBar({ progress }: { progress: ColdyProgress }) {
  const phaseText: Record<ColdyPhase, string> = {
    login: 'Захожу в Coldy…',
    campaigns_list: 'Получаю список кампаний…',
    analytics: 'Собираю аналитику по кампаниям…',
    formatting: 'Формирую Excel…',
  };

  const showDeterminate =
    progress.phase === 'analytics' &&
    typeof progress.current === 'number' &&
    typeof progress.total === 'number' &&
    progress.total > 0;

  const pct = showDeterminate
    ? Math.min(100, Math.round((progress.current! / progress.total!) * 100))
    : null;

  return (
    <div className="rounded-md border border-indigo-100 bg-indigo-50 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-indigo-900">{phaseText[progress.phase]}</span>
        {showDeterminate && (
          <span className="font-mono text-xs text-indigo-700">
            {progress.current}/{progress.total}
          </span>
        )}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-indigo-100">
        <div
          className={`h-full bg-indigo-600 transition-all ${
            showDeterminate ? '' : 'animate-pulse'
          }`}
          style={{ width: showDeterminate ? `${pct}%` : '100%' }}
        />
      </div>
      {progress.campaign_name && (
        <p className="mt-1 truncate text-xs text-indigo-700">→ {progress.campaign_name}</p>
      )}
    </div>
  );
}

// ── Trigga tab ──────────────────────────────────────────────────────────────

function TriggaTab({ onCompleted }: { onCompleted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [includeCreated, setIncludeCreated] = useState(false);
  const [includeBaseLeft, setIncludeBaseLeft] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped && dropped.name.toLowerCase().endsWith('.csv')) {
      setFile(dropped);
      setError(null);
    } else if (dropped) {
      setError('Поддерживается только CSV-файл');
    }
  };

  const runReport = async () => {
    if (!file) {
      setError('Выберите CSV-файл');
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('include_created', String(includeCreated));
      form.append('include_base_left', String(includeBaseLeft));

      const res = await authFetch('/api/tools/polza-reports/trigga', {
        method: 'POST',
        body: form,
      });
      const data = (await res.json()) as {
        downloadUrl?: string;
        filename?: string;
        error?: string;
      };
      if (!res.ok || !data.downloadUrl) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      triggerDownload(data.downloadUrl, data.filename ?? 'trigga_report.xlsx');
      setFile(null);
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сформировать отчёт');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card title="Отчёт Trigga из CSV" icon={<Upload className="h-5 w-5 text-indigo-600" />}>
      <div className="space-y-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver
              ? 'border-indigo-400 bg-indigo-50'
              : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
          }`}
        >
          <Upload className="h-8 w-8 text-gray-400" />
          <p className="mt-2 text-sm font-medium text-gray-700">
            {file ? file.name : 'Перетащите CSV-файл или нажмите для выбора'}
          </p>
          <p className="text-xs text-gray-500">
            CSV из Trigga со столбцами «Компания», «Цепочка», «Отправлено», «Открыто», «Ответы»…
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) {
                setFile(picked);
                setError(null);
              }
            }}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeCreated}
              onChange={(e) => setIncludeCreated(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Колонка «Создано»
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeBaseLeft}
              onChange={(e) => setIncludeBaseLeft(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Колонка «Остаток базы»
          </label>
        </div>

        {error && <InlineError message={error} />}

        <button
          type="button"
          onClick={runReport}
          disabled={running || !file}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileSpreadsheet className="h-4 w-4" />
          )}
          {running ? 'Формирую…' : 'Сформировать отчёт'}
        </button>
      </div>
    </Card>
  );
}

// ── History block ───────────────────────────────────────────────────────────

function ReportHistory({ refreshKey }: { refreshKey: number }) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/tools/polza-reports/jobs?limit=20');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: JobItem[] };
      setJobs(data.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const downloadJob = async (job: JobItem) => {
    setDownloadingId(job.id);
    try {
      const res = await authFetch(`/api/tools/polza-reports/jobs/${job.id}`);
      const data = (await res.json()) as {
        downloadUrl?: string;
        filename?: string;
        error?: string;
      };
      if (!res.ok || !data.downloadUrl) throw new Error(data.error || `HTTP ${res.status}`);
      triggerDownload(data.downloadUrl, data.filename ?? `report-${job.id}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось скачать отчёт');
    } finally {
      setDownloadingId(null);
    }
  };

  const visibleJobs = useMemo(() => jobs.slice(0, 20), [jobs]);

  return (
    <Card title="История отчётов" icon={<History className="h-5 w-5 text-indigo-600" />}
      headerExtra={
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      }
    >
      {error && <InlineError message={error} />}
      {loading && !jobs.length ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загружаю…
        </div>
      ) : visibleJobs.length === 0 ? (
        <p className="text-sm text-gray-500">Пока нет отчётов.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {visibleJobs.map((job) => (
            <li key={job.id} className="flex items-center gap-3 py-2">
              <StatusDot status={job.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">
                  {job.source === 'coldy' ? 'Coldy' : 'Trigga'}
                  {job.campaigns_count != null && (
                    <span className="ml-2 text-xs text-gray-500">
                      кампаний: {job.campaigns_count}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {formatDate(job.completed_at ?? job.created_at)}
                  {job.error_message ? ` · ${job.error_message}` : ''}
                </p>
              </div>
              {job.status === 'completed' && (
                <button
                  type="button"
                  onClick={() => downloadJob(job)}
                  disabled={downloadingId === job.id}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {downloadingId === job.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  Скачать
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StatusDot({ status }: { status: JobItem['status'] }) {
  const map: Record<JobItem['status'], { color: string; title: string }> = {
    pending: { color: 'bg-gray-300', title: 'Ожидает' },
    running: { color: 'bg-amber-400', title: 'Выполняется' },
    completed: { color: 'bg-emerald-500', title: 'Готово' },
    failed: { color: 'bg-red-500', title: 'Ошибка' },
  };
  const m = map[status];
  return <span className={`h-2 w-2 shrink-0 rounded-full ${m.color}`} title={m.title} />;
}

// ── Shared atoms ────────────────────────────────────────────────────────────

function Card({
  title,
  icon,
  children,
  headerExtra,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
          {icon}
          {title}
        </h2>
        {headerExtra}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-700">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
