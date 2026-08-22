'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, authFetchJson } from '@/lib/authFetch';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { detectInnColumn, extractInns } from '@/lib/innEnrich/extractInns';
import { pct, type EnrichmentStats } from '@/lib/innEnrich/fields';

type Phase = 'idle' | 'parsing' | 'ready' | 'enriching';

interface InnEnrichJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  file_name: string;
  total: number;
  processed: number;
  stats: EnrichmentStats | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

function statusLabel(status: InnEnrichJob['status']): string {
  switch (status) {
    case 'pending':
      return 'В очереди';
    case 'running':
      return 'Обогащаем';
    case 'completed':
      return 'Готово';
    case 'failed':
      return 'Ошибка';
  }
}

async function downloadJob(job: InnEnrichJob) {
  const res = await authFetch(`/api/tools/inn-enrich/jobs/${job.id}/download`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${job.file_name.replace(/\.[^.]+$/, '') || 'export'}_обогащённый.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function InnEnrichPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [columnIndex, setColumnIndex] = useState(-1);
  const [hasHeader, setHasHeader] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<InnEnrichJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fileRef = useRef<File | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(async () => {
    const data = await authFetchJson<{ jobs: InnEnrichJob[] }>('/api/tools/inn-enrich/jobs');
    setJobs(data.jobs);
    return data.jobs;
  }, []);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPoll = useCallback(
    (jobId: string) => {
      stopPoll();
      setActiveJobId(jobId);
      setPhase('enriching');
      const tick = async () => {
        try {
          const data = await authFetchJson<{ job: InnEnrichJob }>(
            `/api/tools/inn-enrich/jobs/${jobId}`,
          );
          setJobs((prev) => {
            const rest = prev.filter((j) => j.id !== data.job.id);
            return [data.job, ...rest];
          });
          if (data.job.status === 'completed' || data.job.status === 'failed') {
            stopPoll();
            setActiveJobId(null);
            setPhase('idle');
            if (data.job.status === 'failed') {
              setError(data.job.error_message ?? 'Обогащение не удалось');
            }
          }
        } catch {
          /* сеть моргнула — следующий тик подтянет */
        }
      };
      void tick();
      pollRef.current = setInterval(() => {
        void tick();
      }, 2000);
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        const list = await loadJobs();
        const active = list.find((j) => j.status === 'pending' || j.status === 'running');
        if (active) startPoll(active.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить историю');
      }
    })();
    return () => stopPoll();
  }, [loadJobs, startPoll]);

  const reset = () => {
    fileRef.current = null;
    setRows([]);
    setFileName('');
    setColumnIndex(-1);
    setError(null);
    setPhase('idle');
  };

  const handleFile = useCallback(async (file: File) => {
    reset();
    setPhase('parsing');
    setFileName(file.name);
    fileRef.current = file;
    try {
      const parsed = await readSpreadsheetFile(file);
      if (parsed.length === 0) throw new Error('Файл пустой');
      const d = detectInnColumn(parsed);
      setRows(parsed);
      setColumnIndex(d.columnIndex);
      setHasHeader(d.hasHeader);
      setPhase('ready');
      if (d.columnIndex === -1) {
        setError('Не нашёл колонку с ИНН автоматически — выберите её вручную ниже.');
      }
    } catch (e) {
      fileRef.current = null;
      setPhase('idle');
      setError(
        e instanceof Error
          ? `Не удалось прочитать файл: ${e.message}. Если файл защищён паролем — снимите защиту и загрузите снова.`
          : 'Не удалось прочитать файл',
      );
    }
  }, []);

  const handleEnrich = useCallback(async () => {
    const file = fileRef.current;
    if (!file || columnIndex < 0) return;
    setError(null);

    const { inns } = extractInns(rows, columnIndex, hasHeader);
    if (inns.length === 0) {
      setError('В выбранной колонке нет валидных ИНН (10 или 12 цифр).');
      return;
    }

    const form = new FormData();
    form.append('file', file);
    form.append('columnIndex', String(columnIndex));
    form.append('hasHeader', hasHeader ? 'true' : 'false');

    try {
      const data = await authFetchJson<{ job: InnEnrichJob }>('/api/tools/inn-enrich/jobs', {
        method: 'POST',
        body: form,
      });
      setJobs((prev) => [data.job, ...prev.filter((j) => j.id !== data.job.id)]);
      startPoll(data.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось запустить обогащение');
      try {
        const list = await loadJobs();
        const active = list.find((j) => j.status === 'pending' || j.status === 'running');
        if (active) startPoll(active.id);
      } catch {
        /* ignore */
      }
    }
  }, [rows, columnIndex, hasHeader, startPoll, loadJobs]);

  const uniquePreview = (() => {
    if (phase !== 'ready' || columnIndex < 0 || rows.length === 0) return null;
    const { inns, invalidCount } = extractInns(rows, columnIndex, hasHeader);
    return { unique: inns.length, invalid: invalidCount, total: rows.length - (hasHeader ? 1 : 0) };
  })();

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const activeJob = jobs.find((j) => j.id === activeJobId) ?? jobs.find((j) => j.status === 'pending' || j.status === 'running');
  const latestCompleted = jobs.find((j) => j.status === 'completed');

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Обогащение по ИНН</h1>
        <p className="text-sm text-gray-500 mt-1">
          Загрузите файл с колонкой ИНН — добавим контакты, адрес, ОКВЭД, выручку и ещё 24 поля
          из «Нашей базы баз». Прогон идёт на сервере: можно закрыть вкладку и скачать результат
          из истории. Файл не должен быть защищён паролем.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-base font-semibold text-gray-900">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">1</span>
          Файл
        </h2>

        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
          className="block rounded-xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 text-center cursor-pointer"
        >
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          {phase === 'parsing' ? (
            <span className="text-sm text-gray-600">Читаем файл…</span>
          ) : fileName ? (
            <span className="text-sm text-gray-900 font-medium">{fileName}</span>
          ) : (
            <span className="text-sm text-gray-600">
              Перетащите файл сюда или <span className="text-blue-600 underline">выберите</span>
            </span>
          )}
        </label>
      </div>

      {rows.length > 0 && phase === 'ready' && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <h2 className="text-base font-semibold text-gray-900">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">2</span>
            Колонка с ИНН
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Колонка</div>
              <select
                value={columnIndex}
                onChange={(e) => setColumnIndex(Number(e.target.value))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
              >
                <option value={-1}>— не выбрана —</option>
                {Array.from({ length: maxCols }, (_, c) => (
                  <option key={c} value={c}>
                    {hasHeader && rows[0]?.[c] ? `${rows[0][c]} (колонка ${c + 1})` : `Колонка ${c + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Первая строка</div>
              <select
                value={hasHeader ? 'header' : 'data'}
                onChange={(e) => setHasHeader(e.target.value === 'header')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
              >
                <option value="header">Заголовок</option>
                <option value="data">Данные</option>
              </select>
            </div>
          </div>

          {uniquePreview && (
            <div className="text-sm text-gray-600">
              Строк данных: <b>{uniquePreview.total.toLocaleString('ru-RU')}</b> · уникальных ИНН:{' '}
              <b>{uniquePreview.unique.toLocaleString('ru-RU')}</b>
              {uniquePreview.invalid > 0 && (
                <> · невалидных значений: <b>{uniquePreview.invalid.toLocaleString('ru-RU')}</b></>
              )}
            </div>
          )}
        </div>
      )}

      {phase === 'ready' && rows.length > 0 && (
        <div className="flex flex-col items-center gap-4 py-2">
          <button
            type="button"
            onClick={() => void handleEnrich()}
            disabled={columnIndex < 0 || !uniquePreview || uniquePreview.unique === 0}
            className="rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-16 py-4 text-lg font-semibold transition-colors shadow-md"
          >
            Обогатить
          </button>
        </div>
      )}

      {activeJob && (activeJob.status === 'pending' || activeJob.status === 'running') && (
        <div className="w-full">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>
              {activeJob.status === 'pending' ? 'В очереди воркера…' : 'Обогащаем на сервере…'} {activeJob.file_name}
            </span>
            <span>
              {activeJob.processed.toLocaleString('ru-RU')} / {activeJob.total.toLocaleString('ru-RU')}
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{
                width: `${activeJob.total > 0 ? (activeJob.processed / activeJob.total) * 100 : 8}%`,
              }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Можно закрыть вкладку — результат появится в истории, когда воркер закончит.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}
      {downloadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{downloadError}</div>
      )}

      {latestCompleted?.stats && activeJob?.id !== latestCompleted.id && phase !== 'ready' && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Последний результат</h2>
          <div className="text-sm text-gray-600">{latestCompleted.file_name}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {latestCompleted.stats.matchedRows.toLocaleString('ru-RU')}
              </div>
              <div className="text-xs text-gray-500">строк обогащено</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {pct(latestCompleted.stats.matchedUniqueInns, latestCompleted.stats.uniqueInns)}%
              </div>
              <div className="text-xs text-gray-500">уникальных ИНН найдено</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {latestCompleted.stats.withAnyContact.toLocaleString('ru-RU')}
              </div>
              <div className="text-xs text-gray-500">с контактом</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <div className="text-xl font-bold text-gray-900">
                {(latestCompleted.stats.uniqueInns - latestCompleted.stats.matchedUniqueInns).toLocaleString('ru-RU')}
              </div>
              <div className="text-xs text-gray-500">ИНН не в базе</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setDownloadError(null);
              void downloadJob(latestCompleted).catch((e) =>
                setDownloadError(e instanceof Error ? e.message : 'Не удалось скачать'),
              );
            }}
            className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 text-sm font-semibold transition-colors shadow-sm"
          >
            Скачать XLSX
          </button>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h2 className="text-base font-semibold text-gray-900">История прогонов</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-gray-500">Пока пусто — после обогащения файлы появятся здесь.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {jobs.map((job) => (
              <li key={job.id} className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{job.file_name}</div>
                  <div className="text-xs text-gray-500">
                    {statusLabel(job.status)}
                    {job.total > 0 && ` · ${job.processed.toLocaleString('ru-RU')} / ${job.total.toLocaleString('ru-RU')}`}
                    {' · '}
                    {new Date(job.created_at).toLocaleString('ru-RU')}
                    {job.error_message ? ` · ${job.error_message}` : ''}
                  </div>
                </div>
                {job.status === 'completed' && (
                  <button
                    type="button"
                    onClick={() => {
                      setDownloadError(null);
                      void downloadJob(job).catch((e) =>
                        setDownloadError(e instanceof Error ? e.message : 'Не удалось скачать'),
                      );
                    }}
                    className="shrink-0 text-sm text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Скачать
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
