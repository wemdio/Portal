'use client';

/**
 * /client/manual-scoring — ручной batch-прогон доменов через Mailganer.
 *
 * Клиент загружает CSV (или вставляет text-list), система прогоняет каждый
 * домен, разбивает на 4 bucket'а, выдаёт ссылки для скачивания CSV.
 *
 * Принципы UI:
 *   - Простой single-screen UX: upload → live progress → download buttons
 *   - История прогонов внизу (auto-refresh каждые 5s пока есть processing)
 *   - Никаких модалок — всё inline
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface RunRow {
  id: string;
  source_filename: string | null;
  uploaded_count: number;
  unique_count: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  processed_count: number;
  bucket_storage_count: number | null;
  bucket_medium_count: number | null;
  bucket_high_count: number | null;
  bucket_top_count: number | null;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  expires_at: string;
}

const BUCKETS = [
  { id: 'storage', label: 'До 1 000 (не пишем)', countKey: 'bucket_storage_count' as const, accent: 'gray' },
  { id: 'medium',  label: '1 001 – 15 000',     countKey: 'bucket_medium_count' as const,  accent: 'blue' },
  { id: 'high',    label: '15 001 – 1 000 000', countKey: 'bucket_high_count' as const,    accent: 'indigo' },
  { id: 'top',     label: '1 000 001+',          countKey: 'bucket_top_count' as const,     accent: 'purple' },
];

export default function ManualScoringPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchRuns = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Не авторизован');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/client/manual-scoring/runs', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (!silent) setError(`Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { runs: RunRow[] };
      setRuns(data.runs);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Ошибка сети');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + auto-refresh while any run is processing/pending
  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'processing' || r.status === 'pending');
    if (!hasActive) return;
    const interval = setInterval(() => void fetchRuns(true), 5_000);
    return () => clearInterval(interval);
  }, [runs, fetchRuns]);

  async function submitUpload(file: File | null, text: string | null) {
    setError(null);
    setUploadBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Не авторизован');
        return;
      }

      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        res = await fetch('/api/client/manual-scoring/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      } else if (text && text.trim()) {
        res = await fetch('/api/client/manual-scoring/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ text }),
        });
      } else {
        setError('Загрузите файл или вставьте список доменов');
        return;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        try {
          const parsed = JSON.parse(body) as { error?: string };
          setError(parsed.error || body || `Ошибка ${res.status}`);
        } catch {
          setError(body || `Ошибка ${res.status}`);
        }
        return;
      }

      setTextInput('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сети');
    } finally {
      setUploadBusy(false);
    }
  }

  async function downloadBucket(runId: string, bucket: string, filename: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Не авторизован');
        return;
      }
      const res = await fetch(
        `/api/client/manual-scoring/runs/${runId}/download/${bucket}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        setError(`Скачивание не удалось: ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка скачивания');
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <header>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          Ручная обработка доменов
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Загрузите CSV-файл или вставьте список доменов — система прогонит их
          через Mailganer-скоринг, для активных (score &gt; 1000) обогатит email
          с сайтов и проверит валидность через SMTP. На выходе 4 готовых CSV-файла,
          разделённых по уровню скоринга. Лимит на файл — 50 000 доменов.
          История прогонов хранится 30 дней.
        </p>
      </header>

      {/* Upload */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-base font-semibold text-gray-900">Новый прогон</h2>

        {/* Drag-drop file area */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void submitUpload(file, null);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragOver
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void submitUpload(file, null);
            }}
            disabled={uploadBusy}
          />
          <p className="text-sm font-medium text-gray-700">
            Перетащите CSV сюда или нажмите для выбора
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Первая колонка — домен (без http://). Заголовок необязателен.
          </p>
        </div>

        <div className="text-center text-xs text-gray-500">или</div>

        {/* Text paste */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Вставьте домены (по одному на строку)
          </label>
          <textarea
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={uploadBusy}
            rows={4}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 font-mono"
            placeholder={'example.com\nstripe.com\nya.ru'}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void submitUpload(null, textInput)}
            disabled={uploadBusy || !textInput.trim()}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploadBusy ? '…загружается' : 'Запустить обработку'}
          </button>
          {error && (
            <div className="text-sm text-red-600 flex-1 text-right">{error}</div>
          )}
        </div>
      </section>

      {/* History */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-3">
          История прогонов
        </h2>

        {loading && runs.length === 0 && (
          <div className="text-sm text-gray-500">Загрузка…</div>
        )}

        {!loading && runs.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
            Здесь будут ваши прогоны
          </div>
        )}

        <div className="space-y-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} onDownload={downloadBucket} />
          ))}
        </div>
      </section>
    </div>
  );
}

function RunCard({
  run,
  onDownload,
}: {
  run: RunRow;
  onDownload: (runId: string, bucket: string, filename: string) => void;
}) {
  const isProcessing = run.status === 'processing' || run.status === 'pending';
  const isCompleted = run.status === 'completed';
  const isFailed = run.status === 'failed';
  const progressPct =
    run.unique_count > 0
      ? Math.min(100, Math.round((run.processed_count / run.unique_count) * 100))
      : 0;

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <header className="flex items-baseline justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 truncate">
            {run.source_filename || 'Прямой ввод'}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {new Date(run.started_at).toLocaleString('ru-RU')} ·{' '}
            {run.unique_count.toLocaleString('ru-RU')} уникальных доменов
            {run.uploaded_count > run.unique_count
              && ` (из ${run.uploaded_count.toLocaleString('ru-RU')})`}
          </p>
        </div>
        <StatusBadge status={run.status} />
      </header>

      {isProcessing && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-xs text-gray-600 mb-1">
            <span>Обработано {run.processed_count.toLocaleString('ru-RU')} / {run.unique_count.toLocaleString('ru-RU')}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {isFailed && run.error_message && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {run.error_message}
        </div>
      )}

      {isCompleted && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BUCKETS.map((b) => {
            const count = run[b.countKey] ?? 0;
            return (
              <button
                key={b.id}
                type="button"
                disabled={count === 0}
                onClick={() => onDownload(run.id, b.id, `${run.id}-${b.id}.csv`)}
                className="flex flex-col items-start rounded-lg border border-gray-200 px-3 py-2 text-left hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-gray-200 transition-colors"
              >
                <span className="text-[10px] uppercase tracking-wide text-gray-500">{b.label}</span>
                <span className="text-lg font-semibold text-gray-900 tabular-nums">
                  {count.toLocaleString('ru-RU')}
                </span>
                <span className="text-[10px] text-blue-700 mt-0.5">↓ Скачать CSV</span>
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

function StatusBadge({ status }: { status: RunRow['status'] }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    pending: { label: 'В очереди', cls: 'bg-gray-100 text-gray-700' },
    processing: { label: 'Обработка', cls: 'bg-blue-100 text-blue-700' },
    completed: { label: 'Готово', cls: 'bg-green-100 text-green-700' },
    failed: { label: 'Ошибка', cls: 'bg-red-100 text-red-700' },
    cancelled: { label: 'Отменён', cls: 'bg-gray-100 text-gray-500' },
  };
  const c = cfg[status] ?? cfg.pending;
  return (
    <span className={`shrink-0 inline-block text-[10px] font-medium px-2 py-0.5 rounded-full ${c.cls}`}>
      {c.label}
    </span>
  );
}
