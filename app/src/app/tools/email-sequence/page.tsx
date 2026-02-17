'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type {
  EmailSequenceBrief,
  EmailSequenceLetterRow,
  EmailSequenceRunRow,
  EmailSequenceSegmentRow,
} from '@/types';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function authedFetch(path: string, init?: RequestInit) {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error ?? `Request failed: ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

async function authedFetchWithTimeout(path: string, init?: RequestInit, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await authedFetch(path, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Операция заняла слишком много времени. Попробуйте ещё раз.');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function cleanSegmentText(value: unknown): string {
  const s = String(value ?? '');
  // Remove leading marker used in prompts, e.g. "► Сегмент: ..."
  return s.replace(/^\s*►\s*/u, '');
}

function formatRunStatus(value: string | null | undefined): string {
  const raw = String(value ?? '');
  const v = raw.toLowerCase();
  if (!v) return '—';
  if (v === 'running') return 'в процессе';
  if (v === 'completed' || v === 'done' || v === 'success') return 'готово';
  if (v === 'failed' || v === 'error') return 'ошибка';
  if (v === 'cancelled' || v === 'canceled') return 'отменено';
  if (v === 'pending' || v === 'queued') return 'в очереди';
  return raw;
}

function getRunStatusBadgeClasses(value: string | null | undefined): string {
  const v = String(value ?? '').toLowerCase();
  if (v === 'running') return 'bg-blue-50 text-blue-700 border-blue-200';
  if (v === 'completed' || v === 'done' || v === 'success') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (v === 'failed' || v === 'error') return 'bg-red-50 text-red-700 border-red-200';
  if (v === 'cancelled' || v === 'canceled') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (v === 'pending' || v === 'queued') return 'bg-gray-50 text-gray-600 border-gray-200';
  return 'bg-gray-50 text-gray-600 border-gray-200';
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-gray-700 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-gray-700 mb-1">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
      />
    </label>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text)}
      className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
    >
      Копировать
    </button>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className ?? 'h-4 w-4'}
      aria-hidden="true"
    >
      <path
        d="M10.3 3.7c.7-1.2 2.7-1.2 3.4 0l8.3 14.4c.7 1.2-.2 2.7-1.7 2.7H3.7c-1.4 0-2.3-1.5-1.7-2.7L10.3 3.7Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M12 9v4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 17.2h.01" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

function SegmentModal({
  open,
  title,
  text,
  status,
  notice,
  canAnalyzeNow,
  isBlockedByOtherBusy,
  isAnalyzingThis,
  onClose,
  onCopy,
  onAnalyze,
  onQueueInfo,
}: {
  open: boolean;
  title: string;
  text: string;
  status: { label: string; classes: string };
  notice: string | null;
  canAnalyzeNow: boolean;
  isBlockedByOtherBusy: boolean;
  isAnalyzingThis: boolean;
  onClose: () => void;
  onCopy: () => void;
  onAnalyze: () => void;
  onQueueInfo: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-0 flex items-end justify-center p-4 sm:items-center">
        <div className="w-full max-w-3xl rounded-2xl border border-gray-200 bg-white shadow-xl">
          <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 truncate">{title}</h3>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.classes}`}>
                  {status.label}
                </span>
              </div>
              <p className="mt-1 text-xs sm:text-sm text-gray-500">
                Анализ и письма отображаются в основном окне после выбора сегмента.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {notice ? (
            <div className="px-5 pt-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {notice}
              </div>
            </div>
          ) : null}

          <div className="p-5">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 max-h-[45vh] overflow-auto">
              <pre className="whitespace-pre-wrap text-sm text-gray-800">{text || '—'}</pre>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onCopy}
                  className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
                >
                  Копировать
                </button>
              </div>

              <div className="flex items-center gap-2">
                {isBlockedByOtherBusy ? (
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-500 cursor-not-allowed"
                    title="Подождите завершения текущей операции"
                  >
                    Занято
                  </button>
                ) : !canAnalyzeNow ? (
                  <button
                    type="button"
                    onClick={onQueueInfo}
                    className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                    title="Сейчас идёт анализ другого сегмента этого запуска"
                  >
                    <WarningIcon className="h-4 w-4 text-amber-700" />
                    В очередь
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onAnalyze}
                    disabled={isAnalyzingThis}
                    className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isAnalyzingThis ? 'Анализ…' : 'Анализ'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function EmailSequencePage() {
  const [runs, setRuns] = useState<EmailSequenceRunRow[]>([]);
  const [run, setRun] = useState<EmailSequenceRunRow | null>(null);
  const [segments, setSegments] = useState<EmailSequenceSegmentRow[]>([]);
  const [letters, setLetters] = useState<EmailSequenceLetterRow[]>([]);
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [activeLetterIndex, setActiveLetterIndex] = useState<1 | 2 | 3 | 4>(1);
  const [segmentModalId, setSegmentModalId] = useState<string | null>(null);
  const [segmentModalNotice, setSegmentModalNotice] = useState<string | null>(null);
  const [analyzeQueueByRun, setAnalyzeQueueByRun] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const coreLoaded = useRef<boolean | null>(null);

  const [brief, setBrief] = useState<EmailSequenceBrief>({
    site: '',
    Company: '',
    Product: '',
    Service: '',
    Segments: '',
    ca: '',
    FIGURES: '',
    sender_name: '',
    language: 'ru',
    notes: '',
  });

  const refresh = useCallback(async (runId?: string) => {
    const data = await authedFetch('/api/tools/email-sequence/runs', { method: 'GET' });
    setRuns((data.runs ?? []) as EmailSequenceRunRow[]);
    if (runId) {
      const runData = await authedFetch(`/api/tools/email-sequence/runs/${runId}`, { method: 'GET' });
      setRun(runData.run as EmailSequenceRunRow);
      setSegments((runData.segments ?? []) as EmailSequenceSegmentRow[]);
      setLetters((runData.letters ?? []) as EmailSequenceLetterRow[]);
      setBrief((runData.run?.brief ?? {}) as EmailSequenceBrief);
    }
  }, []);

  if (coreLoaded.current == null) {
    coreLoaded.current = true;
    refresh().catch(() => {});
  }

  const selected = useMemo(
    () => (selectedSegment == null ? null : segments.find((s) => s.segment_index === selectedSegment) ?? null),
    [segments, selectedSegment],
  );

  const selectedLetters = useMemo(() => {
    if (selectedSegment == null) return [];
    return letters.filter((l) => l.segment_index === selectedSegment).sort((a, b) => a.letter_index - b.letter_index);
  }, [letters, selectedSegment]);

  const activeAnalyzeIndex = useMemo(() => {
    const m = busy?.match(/^analyze:(\d+)$/);
    return m ? Number(m[1]) : null;
  }, [busy]);

  const analyzeQueue = useMemo(() => {
    if (!run?.id) return [];
    return analyzeQueueByRun[run.id] ?? [];
  }, [analyzeQueueByRun, run?.id]);

  const activeLetter = useMemo(() => {
    if (!selectedLetters.length) return null;
    return selectedLetters.find((l) => l.letter_index === activeLetterIndex) ?? selectedLetters[0] ?? null;
  }, [selectedLetters, activeLetterIndex]);

  useEffect(() => {
    setActiveLetterIndex(1);
  }, [selectedSegment]);

  useEffect(() => {
    // Auto-run queued analyses when system is idle.
    if (!run?.id) return;
    if (busy != null) return;
    const q = analyzeQueueByRun[run.id] ?? [];
    if (q.length === 0) return;
    const nextIdx = q[0];
    setAnalyzeQueueByRun((prev) => {
      const cur = prev[run.id] ?? [];
      if (cur.length === 0) return prev;
      return { ...prev, [run.id]: cur.slice(1) };
    });
    // Start next analysis on next tick to let state settle.
    window.setTimeout(() => {
      void (async () => {
        if (!run?.id) return;
        setError(null);
        setBusy(`analyze:${nextIdx}`);
        try {
          await authedFetchWithTimeout(
            `/api/tools/email-sequence/runs/${run.id}/segments/${nextIdx}/analyze`,
            { method: 'POST' },
          );
          await refresh(run.id);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Ошибка');
        } finally {
          setBusy(null);
        }
      })();
    }, 0);
  }, [analyzeQueueByRun, busy, refresh, run?.id]);

  const createRun = useCallback(async () => {
    setError(null);
    setBusy('create');
    try {
      const data = await authedFetch('/api/tools/email-sequence/runs', {
        method: 'POST',
        body: JSON.stringify({ brief }),
      });
      const created = data.run as EmailSequenceRunRow;
      setRun(created);
      setSelectedSegment(null);
      await refresh(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [brief, refresh]);

  const generateSegments = useCallback(async () => {
    if (!run?.id) return;
    setError(null);
    setBusy('segments');
    try {
      await authedFetchWithTimeout(`/api/tools/email-sequence/runs/${run.id}/generate-segments`, { method: 'POST' });
      await refresh(run.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [run?.id, refresh]);

  const runAnalyzeNow = useCallback(
    async (idx: number) => {
      if (!run?.id) return;
      setError(null);
      setBusy(`analyze:${idx}`);
      try {
        await authedFetchWithTimeout(
          `/api/tools/email-sequence/runs/${run.id}/segments/${idx}/analyze`,
          { method: 'POST' },
          360_000,
        );
        await refresh(run.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [run?.id, refresh],
  );

  const requestAnalyze = useCallback(
    (idx: number) => {
      if (!run?.id) return;
      // Only mutex within this run: allow queueing when another segment is currently analyzing.
      if (activeAnalyzeIndex != null && activeAnalyzeIndex !== idx) {
        setAnalyzeQueueByRun((prev) => {
          const cur = prev[run.id] ?? [];
          if (cur.includes(idx) || activeAnalyzeIndex === idx) return prev;
          return { ...prev, [run.id]: [...cur, idx] };
        });
        setSegmentModalNotice(
          `Сейчас идёт анализ сегмента ${activeAnalyzeIndex + 1} этого запуска. Сегмент ${idx + 1} добавлен в очередь и стартует автоматически после завершения.`,
        );
        return;
      }
      if (busy != null) return; // avoid collisions with other operations
      void runAnalyzeNow(idx);
    },
    [activeAnalyzeIndex, busy, run?.id, runAnalyzeNow],
  );

  const generateChain = useCallback(
    async (idx: number) => {
      if (!run?.id) return;
      setError(null);
      setBusy(`chain:${idx}`);
      try {
        await authedFetchWithTimeout(`/api/tools/email-sequence/runs/${run.id}/segments/${idx}/generate-chain`, { method: 'POST' });
        setSelectedSegment(idx);
        await refresh(run.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [run?.id, refresh],
  );

  const modalSegment = useMemo(() => {
    if (!segmentModalId) return null;
    return segments.find((s) => s.id === segmentModalId) ?? null;
  }, [segmentModalId, segments]);

  const modalStatus = useMemo(() => {
    if (!modalSegment) return { label: '—', classes: 'bg-gray-50 text-gray-600 border-gray-200' };
    const isAnalyzing = activeAnalyzeIndex === modalSegment.segment_index;
    const isQueued = analyzeQueue.includes(modalSegment.segment_index);
    const hasAnalysis = Boolean(modalSegment.pains_and_solutions);
    if (isAnalyzing) return { label: 'анализ…', classes: 'bg-blue-50 text-blue-700 border-blue-200' };
    if (isQueued) return { label: 'в очереди', classes: 'bg-amber-50 text-amber-800 border-amber-200' };
    if (hasAnalysis) return { label: 'готово', classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    return { label: 'не запускали', classes: 'bg-gray-50 text-gray-600 border-gray-200' };
  }, [activeAnalyzeIndex, analyzeQueue, modalSegment]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Цепочки писем</h1>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* Top row: Brief + Runs (same height) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3 items-stretch">
        <div className="xl:col-span-2 h-full">
          <div className="rounded-2xl border border-gray-200 bg-white p-6 h-full">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Бриф</h2>
                <p className="text-sm text-gray-500 mt-1">Заполните данные компании и автора писем.</p>
              </div>
              <button
                type="button"
                onClick={createRun}
                disabled={busy != null}
                className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {run ? 'Сохранить бриф' : 'Создать запуск'}
              </button>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextField label="Сайт" value={brief.site ?? ''} onChange={(v) => setBrief((b) => ({ ...b, site: v }))} />
              <TextField
                label="Компания*"
                value={brief.Company ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, Company: v }))}
              />
              <TextAreaField
                label="Продукт"
                value={brief.Product ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, Product: v }))}
                rows={3}
              />
              <TextAreaField
                label="Услуга / сервис"
                value={brief.Service ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, Service: v }))}
                rows={3}
              />
              <TextAreaField
                label="Сегменты (опыт / текущие клиенты)"
                value={brief.Segments ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, Segments: v }))}
                rows={3}
              />
              <TextAreaField
                label="ЦА (целевая аудитория)"
                value={brief.ca ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, ca: v }))}
                rows={3}
              />
              <TextAreaField
                label="Цифры / достижения"
                value={brief.FIGURES ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, FIGURES: v }))}
                rows={3}
              />
              <TextField
                label="Имя отправителя (подпись)*"
                value={brief.sender_name ?? ''}
                onChange={(v) => setBrief((b) => ({ ...b, sender_name: v }))}
                placeholder="Имя для подписи"
              />
            </div>
          </div>
        </div>

        <div className="xl:col-span-1 h-full">
          <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col h-full">
            <h2 className="text-lg font-semibold text-gray-900">Запуски</h2>
            <p className="text-sm text-gray-500 mt-1">Последние 20 запусков.</p>
            <div className="mt-4 space-y-2 flex-1 overflow-y-auto pr-1">
              {runs.length ? (
                runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => refresh(r.id)}
                    className={`w-full text-left rounded-xl border px-3 py-2 text-sm transition ${
                      run?.id === r.id ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-gray-900 truncate">{r.brief?.Company ?? r.id}</div>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${getRunStatusBadgeClasses(r.status)}`}
                      >
                        {formatRunStatus(r.status)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 truncate">{r.id}</div>
                  </button>
                ))
              ) : (
                <div className="text-sm text-gray-500">Пока пусто.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Full-width: Segments */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Сегменты</h2>
            <p className="text-sm text-gray-500 mt-1">
              Генерируем 5 сегментов и ЛПР (Perplexity sonar-pro).
            </p>
            {busy === 'segments' && (
              <p className="mt-2 text-xs text-gray-500">
                Генерация сегментов… Это может занять 1–2 минуты.
              </p>
            )}
            {activeAnalyzeIndex != null ? (
              <p className="mt-2 text-xs text-gray-500">
                Анализ сегмента {activeAnalyzeIndex + 1}… Это может занять 2–4 минуты.
                {analyzeQueue.length ? ` В очереди: ${analyzeQueue.length}.` : ''}
              </p>
            ) : analyzeQueue.length ? (
              <p className="mt-2 text-xs text-gray-500">
                В очереди анализа: {analyzeQueue.length}. Запустится автоматически, когда система будет свободна.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={generateSegments}
            disabled={!run?.id || busy != null}
            className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
          >
            Сгенерировать сегменты
          </button>
        </div>

        {segments.length ? (
          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {segments.map((s) => {
              const preview = String(s.segment_text ?? '').replace(/\s+/g, ' ').trim();
              const previewClean = cleanSegmentText(preview);
              const isAnalyzing = activeAnalyzeIndex === s.segment_index;
              const isQueued = analyzeQueue.includes(s.segment_index);
              const hasAnalysis = Boolean(s.pains_and_solutions);
              const status = isAnalyzing
                ? { label: 'анализ…', classes: 'bg-blue-50 text-blue-700 border-blue-200' }
                : isQueued
                  ? { label: 'в очереди', classes: 'bg-amber-50 text-amber-800 border-amber-200' }
                  : hasAnalysis
                    ? { label: 'готово', classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                    : { label: 'не запускали', classes: 'bg-gray-50 text-gray-600 border-gray-200' };
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSegmentModalNotice(null);
                    setSegmentModalId(s.id);
                  }}
                  className="group relative w-full text-left rounded-2xl border border-gray-200 bg-white p-4 transition hover:bg-gray-50 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-300 flex flex-col md:aspect-square"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-xs font-semibold text-gray-500">Сегмент {s.segment_index + 1}</div>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status.classes}`}>
                          {status.label}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-gray-900 overflow-hidden text-ellipsis [display:-webkit-box] [-webkit-line-clamp:5] [-webkit-box-orient:vertical]">
                        {previewClean}
                      </div>
                    </div>

                    {isAnalyzing ? (
                      <div className="shrink-0 mt-1">
                        <svg className="h-5 w-5 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" opacity="0.9" />
                        </svg>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-auto pt-4 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      Нажмите, чтобы открыть
                    </div>
                    <div className="text-xs font-semibold text-gray-700 group-hover:text-gray-900">→</div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 text-sm text-gray-500">
            Пока нет сегментов. Создайте запуск и нажмите «Сгенерировать сегменты».
          </div>
        )}
      </div>

      {/* Full-width: Analyze & chain */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Анализ и цепочка</h2>
            <p className="text-sm text-gray-500 mt-1">Выберите сегмент и сгенерируйте 4 письма.</p>
            {busy?.startsWith('chain:') && (
              <p className="mt-2 text-xs text-gray-500">
                Генерируем цепочку… Это может занять 2–4 минуты.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => (selectedSegment != null ? generateChain(selectedSegment) : null)}
            disabled={selectedSegment == null || busy != null}
            className="inline-flex items-center rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {busy?.startsWith('chain:') ? (
              <>
                <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" opacity="0.9" />
                </svg>
                Генерация…
              </>
            ) : (
              'Сгенерировать цепочку'
            )}
          </button>
        </div>

        {selected ? (
          <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-5">
            <div className="xl:col-span-3">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Segment_Analysis</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-gray-700">
                    {selected.segment_research ?? '—'}
                  </pre>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Pains_And_Solutions</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-gray-700">
                    {selected.pains_and_solutions ?? '—'}
                  </pre>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Tasks_And_Solutions</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-gray-700">
                    {selected.tasks_and_solutions ?? '—'}
                  </pre>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Social_Proof</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-gray-700">
                    {selected.social_proof ?? '—'}
                  </pre>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 lg:col-span-2">
                  <div className="text-sm font-semibold text-gray-900">Cases_LPR</div>
                  <pre className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-gray-700">
                    {selected.cases_lpr ?? '—'}
                  </pre>
                </div>
              </div>
            </div>

            <div className="xl:col-span-2">
              <div className="rounded-2xl border border-gray-200 bg-gradient-to-b from-white to-gray-50 p-4 xl:sticky xl:top-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-gray-900">Письма</div>
                    <div className="mt-0.5 text-xs text-gray-500">Сегмент {selected.segment_index + 1}</div>
                  </div>
                  {activeLetter?.content ? <CopyButton text={activeLetter.content} /> : null}
                </div>

                <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-white p-1 border border-gray-200">
                  {[1, 2, 3, 4].map((idx) => {
                    const exists = selectedLetters.some((l) => l.letter_index === idx);
                    const active = activeLetterIndex === idx;
                    return (
                      <button
                        key={idx}
                        type="button"
                        disabled={!exists}
                        onClick={() => setActiveLetterIndex(idx as 1 | 2 | 3 | 4)}
                        className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
                          active
                            ? 'bg-gray-900 text-white'
                            : exists
                              ? 'text-gray-700 hover:bg-gray-50'
                              : 'text-gray-400 cursor-not-allowed'
                        }`}
                        title={exists ? `Письмо ${idx}` : `Письмо ${idx} ещё не готово`}
                      >
                        {idx}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3 max-h-[520px] overflow-auto">
                  {activeLetter ? (
                    <>
                      <div className="text-xs font-semibold text-gray-500">Письмо {activeLetter.letter_index}</div>
                      <pre className="mt-2 whitespace-pre-wrap text-sm text-gray-900">{activeLetter.content}</pre>
                    </>
                  ) : (
                    <div className="text-sm text-gray-500">
                      Цепочка ещё не сгенерирована. Нажмите «Сгенерировать цепочку» сверху.
                    </div>
                  )}
                </div>

                <div className="mt-2 text-[11px] text-gray-500">
                  {selectedLetters.length ? `Готово писем: ${selectedLetters.length}/4` : 'Готово писем: 0/4'}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-5 text-sm text-gray-500">Выберите сегмент выше.</div>
        )}
      </div>

      <SegmentModal
        open={Boolean(modalSegment)}
        title={modalSegment ? `Сегмент ${modalSegment.segment_index + 1}` : 'Сегмент'}
        text={cleanSegmentText(modalSegment?.segment_text ?? '')}
        status={modalStatus}
        notice={segmentModalNotice}
        canAnalyzeNow={
          modalSegment != null &&
          ((activeAnalyzeIndex == null && busy == null) || activeAnalyzeIndex === modalSegment.segment_index)
        }
        isBlockedByOtherBusy={busy != null && !busy.startsWith('analyze:')}
        isAnalyzingThis={modalSegment != null && activeAnalyzeIndex === modalSegment.segment_index}
        onClose={() => setSegmentModalId(null)}
        onCopy={() => {
          if (!modalSegment?.segment_text) return;
          void navigator.clipboard.writeText(cleanSegmentText(modalSegment.segment_text));
        }}
        onAnalyze={() => {
          if (!modalSegment) return;
          requestAnalyze(modalSegment.segment_index);
        }}
        onQueueInfo={() => {
          if (!modalSegment) return;
          // Queue when another analysis is in-flight for this run.
          if (activeAnalyzeIndex != null && activeAnalyzeIndex !== modalSegment.segment_index) {
            setAnalyzeQueueByRun((prev) => {
              if (!run?.id) return prev;
              const cur = prev[run.id] ?? [];
              const idx = modalSegment.segment_index;
              if (cur.includes(idx) || activeAnalyzeIndex === idx) return prev;
              return { ...prev, [run.id]: [...cur, idx] };
            });
            setSegmentModalNotice(
              `Сейчас идёт анализ сегмента ${activeAnalyzeIndex + 1} этого запуска. Сегмент ${modalSegment.segment_index + 1} добавлен в очередь и начнётся позже.`,
            );
          }
        }}
      />
    </div>
  );
}

