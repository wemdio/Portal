'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  AudioLines,
  Loader2,
  FileAudio2,
  UploadCloud,
  Copy,
  Check,
  AlertTriangle,
  Download,
} from 'lucide-react';

interface TranscribeResponse {
  text: string;
  filename: string;
  length: number;
  job_id?: string;
  error?: string;
}

interface TranscribeProgressResponse {
  found: boolean;
  jobId: string;
  stage?: 'queued' | 'converting' | 'transcribing' | 'done' | 'cancelled' | 'error';
  progressPercent?: number;
  processedSeconds?: number | null;
  audioDurationSeconds?: number | null;
  error?: string | null;
}

interface HistoryItem {
  id: string;
  created_at: string;
  filename: string;
  length: number;
  text: string;
}

async function getToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function uploadForTranscription(
  file: File,
  jobId: string,
  signal?: AbortSignal
): Promise<TranscribeResponse> {
  const token = await getToken();
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/tools/audio-transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Transcribe-Job-Id': jobId,
    },
    body: formData,
    signal,
  });

  const raw = await res.text();
  const json = (() => {
    try {
      return JSON.parse(raw) as TranscribeResponse;
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error('Файл слишком большой для загрузки на сервер.');
    }
    throw new Error(
      json?.error ||
      `Ошибка при расшифровке аудио (HTTP ${res.status})`,
    );
  }
  if (!json) {
    throw new Error('Сервер вернул неверный формат ответа');
  }
  return json;
}

async function fetchTranscriptionProgress(jobId: string): Promise<TranscribeProgressResponse> {
  const token = await getToken();
  const res = await fetch(`/api/tools/audio-transcribe/progress?jobId=${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Не удалось получить прогресс (HTTP ${res.status})`);
  }
  return (await res.json()) as TranscribeProgressResponse;
}

async function cancelTranscription(jobId: string): Promise<void> {
  const token = await getToken();
  const res = await fetch('/api/tools/audio-transcribe/cancel', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok) {
    throw new Error(`Не удалось остановить расшифровку (HTTP ${res.status})`);
  }
}

const MAX_FILE_SIZE_BYTES = 600 * 1024 * 1024;
const ACCEPT_EXT = '.mp3,.wav,.mp4,.avi';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return '';
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  if (bytes === 0) return '0 Б';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

export default function AudioTranscribeToolPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStage, setProgressStage] = useState<'queued' | 'converting' | 'transcribing' | 'done' | 'cancelled' | 'error' | null>(null);
  const [progressHint, setProgressHint] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

  const fetchHistory = useCallback(async (): Promise<HistoryItem[]> => {
    setHistoryLoading(true);
    try {
      const token = await getToken();
      if (!token) {
        setHistory([]);
        return [];
      }
      const res = await fetch('/api/tools/audio-transcribe', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        setHistory([]);
        return [];
      }
      const json = (await res.json()) as { items?: HistoryItem[] };
      const items = Array.isArray(json.items) ? json.items : [];
      setHistory(items);
      return items;
    } catch {
      setHistory([]);
      return [];
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const validateFile = (f: File): string | null => {
    if (!f) return 'Файл не выбран';
    if (f.size > MAX_FILE_SIZE_BYTES) {
      return 'Файл превышает лимит 600 МБ.';
    }
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp3', 'wav', 'mp4', 'avi'].includes(ext)) {
      return 'Поддерживаются только файлы MP3, WAV, MP4, AVI.';
    }
    return null;
  };

  const handleFiles = useCallback((filesList: FileList | null) => {
    if (!filesList || filesList.length === 0) return;
    const f = filesList[0];
    const err = validateFile(f);
    if (err) {
      setError(err);
      setFile(null);
      return;
    }
    setError(null);
    setFile(f);
  }, []);

  const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  };

  const onDragOver: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };

  const onDragLeave: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    handleFiles(e.target.files);
  };

  const onSubmit = async () => {
    if (!file || loading) return;
    const err = validateFile(file);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setLoading(true);
    setCopied(false);
    setProgressPercent(0);
    setProgressStage('queued');
    setProgressHint('Подготовка файла...');

    const jobId = crypto.randomUUID();
    setActiveJobId(jobId);
    cancelRequestedRef.current = false;
    const uploadAbort = new AbortController();
    uploadAbortControllerRef.current = uploadAbort;
    let pollingStopped = false;
    const stopPolling = () => {
      pollingStopped = true;
    };

    let lastKnownStage: TranscribeProgressResponse['stage'] = 'queued';
    const pollProgress = async () => {
      while (!pollingStopped) {
        try {
          const progress = await fetchTranscriptionProgress(jobId);
          if (!progress.found) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            continue;
          }
          const nextPercent = Math.max(0, Math.min(100, Number(progress.progressPercent ?? 0)));
          const stage = progress.stage ?? 'queued';
          lastKnownStage = stage;
          setProgressPercent(nextPercent);
          setProgressStage(stage);

          if (stage === 'converting') {
            setProgressHint('Конвертация аудио...');
          } else if (stage === 'transcribing') {
            if (
              typeof progress.processedSeconds === 'number'
              && typeof progress.audioDurationSeconds === 'number'
              && progress.audioDurationSeconds > 0
            ) {
              setProgressHint(
                `Расшифровка: ${Math.floor(progress.processedSeconds)}с / ${Math.floor(progress.audioDurationSeconds)}с`,
              );
            } else {
              setProgressHint('Расшифровка аудио...');
            }
          } else if (stage === 'done') {
            setProgressHint('Готово');
            setProgressPercent(100);
            stopPolling();
            return;
          } else if (stage === 'cancelled') {
            setProgressHint(progress.error ?? 'Расшифровка остановлена');
            setProgressStage('cancelled');
            stopPolling();
            return;
          } else if (stage === 'error') {
            setProgressHint(progress.error ?? 'Ошибка обработки');
            stopPolling();
            return;
          }
        } catch {
          // ignore transient polling errors
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    };

    const pollingPromise = pollProgress();
    let shouldAwaitByProgress = false;
    try {
      const resp = await uploadForTranscription(file, jobId, uploadAbort.signal);
      setResult(resp);
      setProgressPercent(100);
      setProgressStage('done');
      setProgressHint('Готово');
      void fetchHistory();
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      const networkFailed = err instanceof TypeError && /fetch failed/i.test(err.message);
      const message = aborted
        ? 'Расшифровка остановлена. Для продолжения запустите её заново с нуля.'
        : (err instanceof Error ? err.message : 'Неизвестная ошибка');
      if (aborted || cancelRequestedRef.current) {
        setProgressStage('cancelled');
        setProgressHint('Расшифровка остановлена');
      } else if (networkFailed) {
        shouldAwaitByProgress = true;
        setProgressHint('Соединение потеряно, ожидаем завершение по прогрессу...');
      } else {
        setProgressStage('error');
        setProgressHint(message);
      }
      if (!networkFailed) {
        setError(message);
        setResult(null);
      }
    } finally {
      if (shouldAwaitByProgress) {
        const timeoutMs = 20 * 60 * 1000;
        const timedOut = await Promise.race([
          pollingPromise.then(() => false).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
        ]);
        if (timedOut) {
          stopPolling();
          await pollingPromise.catch(() => {});
          setError('Связь с сервером потеряна, и ожидание прогресса превысило лимит. Попробуйте открыть историю расшифровок.');
        } else if (String(lastKnownStage) === 'done') {
          const items = await fetchHistory();
          const matched = items.find((item) => item.filename === file.name) ?? items[0];
          if (matched) {
            setResult({
              text: matched.text,
              filename: matched.filename,
              length: matched.length,
            });
            setError(null);
          }
        } else if (String(lastKnownStage) === 'error') {
          setError('Ошибка расшифровки. Проверьте логи сервера и попробуйте снова.');
        } else if (String(lastKnownStage) === 'cancelled') {
          setError('Расшифровка остановлена.');
        }
      } else {
        stopPolling();
        await pollingPromise.catch(() => {});
      }
      uploadAbortControllerRef.current = null;
      cancelRequestedRef.current = false;
      setActiveJobId(null);
      setLoading(false);
    }
  };

  const onCancel = async () => {
    if (!loading || !activeJobId) return;
    const ok = window.confirm(
      'Остановить текущую расшифровку?\n\nПосле остановки продолжить нельзя — нужно будет запускать расшифровку заново с нуля.'
    );
    if (!ok) return;

    cancelRequestedRef.current = true;
    uploadAbortControllerRef.current?.abort();
    setProgressStage('cancelled');
    setProgressHint('Останавливаем расшифровку...');
    try {
      await cancelTranscription(activeJobId);
    } catch {
      // ignore cancel errors; local abort already triggered
    }
  };

  const onCopy = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const onDownloadTxt = () => {
    if (!result?.text) return;
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (result.filename || 'transcript').replace(/\.[^.]+$/, '') + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 max-w-7xl space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
              <AudioLines className="h-3.5 w-3.5" />
              Инструмент расшифровки аудио
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Расшифровка видео и аудио</h1>
            <p className="max-w-2xl text-sm text-gray-500">
              Загрузите запись в формате MP3, WAV, MP4 или AVI. Мы расшифруем
              аудио через AI и вернём чистый текст.
            </p>
            <p className="text-xs text-gray-400">
              Максимальный размер файла — до 600&nbsp;МБ. Обработка крупных записей может занять
              несколько минут.
            </p>
          </div>
        </header>

        <section className="grid gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.8fr)_minmax(0,1.1fr)] items-start">
        <div className="space-y-4">
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            className={[
              'relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 transition-colors cursor-pointer min-h-[180px]',
              dragActive
                ? 'border-indigo-400 bg-indigo-50/60'
                : 'border-gray-200 bg-gray-50/80 hover:border-indigo-300 hover:bg-indigo-50/40',
            ].join(' ')}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept={ACCEPT_EXT}
              onChange={onFileChange}
            />
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-sm mb-3">
              <UploadCloud className="h-6 w-6 text-indigo-500" />
            </div>
            <p className="text-sm font-medium text-gray-900">
              Перетащите файл сюда или нажмите, чтобы выбрать
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Поддерживаемые форматы: MP3, WAV, MP4, AVI. До 600&nbsp;МБ.
            </p>
            {file && (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-white/80 px-3 py-2 text-xs text-gray-700 shadow-sm">
                <FileAudio2 className="h-4 w-4 text-indigo-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{file.name}</p>
                  <p className="text-[11px] text-gray-500">{formatBytes(file.size)}</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-500">
              Файл не отправляется, пока вы не нажмёте кнопку ниже. Для новой записи просто
              выберите другой файл.
            </div>
            <div className="flex items-center gap-2">
              {loading && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="inline-flex items-center gap-2 rounded-full bg-rose-100 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-200"
                >
                  Остановить
                </button>
              )}
              <button
                type="button"
                onClick={onSubmit}
                disabled={!file || loading}
                className={[
                  'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-sm transition',
                  !file || loading
                    ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700',
                ].join(' ')}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {progressPercent > 0 ? `Обработка... ${progressPercent}%` : 'Обработка...'}
                  </>
                ) : (
                  <>
                    <AudioLines className="h-4 w-4" />
                    Отправить на расшифровку
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}
          {loading && (
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                  style={{ width: `${Math.max(4, Math.min(100, progressPercent))}%` }}
                />
              </div>
              <p className="text-[11px] text-gray-500">
                {progressHint ?? 'Идёт обработка...'}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-sm min-h-[220px]">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Результат расшифровки
              </p>
              <p className="text-sm text-gray-700">
                {result?.filename
                  ? `Файл: ${result.filename}`
                  : 'Здесь появится текст после обработки файла.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!result?.text}
                onClick={onCopy}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                  result?.text
                    ? 'border-gray-200 bg-gray-50 text-gray-700 hover:border-indigo-300 hover:bg-indigo-50'
                    : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed',
                ].join(' ')}
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Копировать
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={!result?.text}
                onClick={onDownloadTxt}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                  result?.text
                    ? 'border-gray-200 bg-gray-50 text-gray-700 hover:border-indigo-300 hover:bg-indigo-50'
                    : 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed',
                ].join(' ')}
              >
                <Download className="h-3.5 w-3.5" />
                TXT
              </button>
            </div>
          </div>

          <div className="relative">
            <div className="max-h-72 min-h-[160px] overflow-auto rounded-xl bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-800">
              {loading && (
                <div className="flex h-full items-center justify-center text-gray-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Идёт расшифровка аудио...
                </div>
              )}
              {!loading && result?.text && (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                  {result.text}
                </pre>
              )}
              {!loading && !result?.text && (
                <div className="flex h-full items-center justify-center text-gray-400 text-xs">
                  Загрузите аудио и запустите расшифровку, чтобы увидеть текст здесь.
                </div>
              )}
            </div>
          </div>

          {result?.length != null && result.length > 0 && (
            <div className="flex items-center justify-between text-[11px] text-gray-500">
              <span>
                Символов в расшифровке:&nbsp;
                <span className="font-medium text-gray-700">
                  {result.length.toLocaleString('ru-RU')}
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-sm min-h-[220px]">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              История (последние 10)
            </p>
            {historyLoading && (
              <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Обновление...
              </span>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-[11px] text-gray-400">
              Пока нет сохранённых расшифровок. После обработки файлов они появятся здесь.
            </p>
          ) : (
            <ul className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setResult({
                        text: item.text,
                        filename: item.filename,
                        length: item.length,
                      })
                    }
                    className="w-full rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-gray-700">
                        {item.filename}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {new Date(item.created_at).toLocaleString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[10px] text-gray-500">{item.text}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        </section>
      </div>
    </div>
  );
}

