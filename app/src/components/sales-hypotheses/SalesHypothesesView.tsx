'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Lightbulb,
  Loader2,
  Sparkles,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  Globe,
  HelpCircle,
} from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { LeadSourceHypothesesView } from '@/components/projects/LeadSourceHypothesesView';
import type { SalesHypothesesRunDTO } from '@/lib/salesHypotheses/run';

const API_BASE = '/api/tools/sales-hypotheses/runs';

type BusyPhase = 'autofilling' | 'generating' | 'regenerating' | null;

interface RunResponse {
  run?: SalesHypothesesRunDTO;
  error?: string;
  skipped?: boolean;
}
interface RunsListResponse {
  runs?: SalesHypothesesRunDTO[];
  error?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await authFetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function prettyHost(run: SalesHypothesesRunDTO): string {
  const raw = run.resolvedUrl || run.website;
  return raw.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

/** Цветной индикатор статуса прогона в истории. */
function StatusDot({ status }: { status: SalesHypothesesRunDTO['status'] }) {
  const color =
    status === 'completed'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'generating'
          ? 'bg-amber-400 animate-pulse'
          : 'bg-gray-300';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

export function SalesHypothesesView() {
  const [website, setWebsite] = useState('');
  const [runs, setRuns] = useState<SalesHypothesesRunDTO[]>([]);
  const [current, setCurrent] = useState<SalesHypothesesRunDTO | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyPhase, setBusyPhase] = useState<BusyPhase>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const busy = busyPhase !== null;

  const upsertRun = useCallback((run: SalesHypothesesRunDTO) => {
    setRuns((prev) =>
      prev.some((r) => r.id === run.id)
        ? prev.map((r) => (r.id === run.id ? run : r))
        : [run, ...prev],
    );
  }, []);

  // Загрузка истории при монтировании.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await call<RunsListResponse>(API_BASE);
        if (!cancelled) setRuns(Array.isArray(data.runs) ? data.runs : []);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    const url = website.trim();
    if (!url || busy) return;
    setErrorMsg('');
    setCurrent(null);
    setSelectedId(null);
    setBusyPhase('autofilling');
    try {
      const create = await call<RunResponse>(API_BASE, {
        method: 'POST',
        body: JSON.stringify({ website: url }),
      });
      if (!create.ok || !create.data.run) {
        throw new Error(create.data.error || 'Не удалось проанализировать сайт');
      }
      const run = create.data.run;
      upsertRun(run);
      setCurrent(run);
      setSelectedId(run.id);

      setBusyPhase('generating');
      const gen = await call<RunResponse>(`${API_BASE}/${run.id}/generate`, { method: 'POST' });
      if (gen.data.run) {
        upsertRun(gen.data.run);
        setCurrent(gen.data.run);
      }
      if (!gen.ok || !gen.data.run?.hypotheses) {
        throw new Error(gen.data.error || 'Не удалось сгенерировать гипотезы');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setBusyPhase(null);
    }
  }, [website, busy, upsertRun]);

  const handleRegenerate = useCallback(async () => {
    if (!current || busy) return;
    setErrorMsg('');
    setBusyPhase('regenerating');
    try {
      const gen = await call<RunResponse>(`${API_BASE}/${current.id}/generate?regenerate=1`, {
        method: 'POST',
      });
      if (gen.data.run) {
        upsertRun(gen.data.run);
        setCurrent(gen.data.run);
      }
      if (!gen.ok || !gen.data.run?.hypotheses) {
        throw new Error(gen.data.error || 'Не удалось перегенерировать гипотезы');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setBusyPhase(null);
    }
  }, [current, busy, upsertRun]);

  const selectRun = useCallback(
    async (id: string) => {
      if (busy || selectedId === id) return;
      setErrorMsg('');
      try {
        const { ok, data } = await call<RunResponse>(`${API_BASE}/${id}`);
        if (!ok || !data.run) throw new Error(data.error || 'Не удалось загрузить прогон');
        setCurrent(data.run);
        setSelectedId(id);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
      }
    },
    [busy, selectedId],
  );

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const prev = runs;
      setRuns((rs) => rs.filter((r) => r.id !== id));
      if (selectedId === id) {
        setCurrent(null);
        setSelectedId(null);
      }
      const { ok } = await call(`${API_BASE}/${id}`, { method: 'DELETE' });
      if (!ok) {
        setRuns(prev);
        setErrorMsg('Не удалось удалить прогон');
      }
    },
    [runs, selectedId],
  );

  const copyHypotheses = useCallback(() => {
    if (!current?.hypotheses || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(current.hypotheses).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [current]);

  const shownError = busy ? '' : errorMsg || (current?.status === 'failed' ? current.error ?? '' : '');

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 text-left">
      {/* Заголовок */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <Lightbulb className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Гипотезы по сайту</h1>
          <p className="text-sm text-gray-500">
            Вставьте сайт компании или опишите запрос — AI соберёт бриф и предложит 5–10 гипотез по сбору базы.
          </p>
        </div>
      </div>

      {/* Ввод сайта */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <label htmlFor="sh-website" className="block text-sm font-medium text-gray-700">
          Сайт или запрос
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
            <input
              id="sh-website"
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleGenerate();
              }}
              placeholder="acme.com или запрос: «кому продавать франшизу кофеен?»"
              disabled={busy}
              className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={busy || !website.trim()}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
            Сгенерировать гипотезы
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Можно вставить сайт компании или коротко описать задачу («кому продавать …?»). Бриф собирается автоматически и не показывается — на выходе только готовые гипотезы. Занимает 1–2 минуты.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* История */}
        <aside className="order-2 lg:order-1">
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-gray-400">История</h2>
          {listLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg border border-gray-200 bg-gray-50" aria-hidden />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <p className="px-1 text-xs text-gray-400">Пока нет прогонов.</p>
          ) : (
            <ul className="space-y-1.5">
              {runs.map((run) => {
                const active = run.id === selectedId;
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => void selectRun(run.id)}
                      className={`group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition ${
                        active
                          ? 'border-blue-300 bg-blue-50/60'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <StatusDot status={run.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-800">{prettyHost(run)}</span>
                        <span className="block text-[11px] text-gray-400">{formatDate(run.createdAt)}</span>
                      </span>
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label="Удалить прогон"
                        onClick={(e) => void handleDelete(run.id, e)}
                        className="shrink-0 rounded p-1 text-gray-300 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Результат */}
        <section className="order-1 min-w-0 lg:order-2">
          {busyPhase === 'autofilling' && (
            <StatusBox icon="spin" tone="info">
              Готовим бриф — обычно 30–60 секунд…
            </StatusBox>
          )}
          {(busyPhase === 'generating' || busyPhase === 'regenerating') && (
            <StatusBox icon="spin" tone="info">
              {current?.resolvedUrl ? `${prettyHost(current)}: ` : ''}
              бриф готов, генерируем гипотезы — ещё 30–60 секунд…
            </StatusBox>
          )}

          {!busy && shownError && (
            <div className="space-y-3">
              <StatusBox icon="error" tone="error">
                {shownError}
              </StatusBox>
              {current && (
                // У упавшего прогона бриф уже собран — повторяем ТОЛЬКО генерацию
                // гипотез (без повторного autofill-вызова и без новой строки).
                <button
                  type="button"
                  onClick={() => void handleRegenerate()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  Повторить генерацию
                </button>
              )}
            </div>
          )}

          {!busy && !shownError && current?.hypotheses && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  {current.resolvedUrl ? (
                    <a
                      href={current.resolvedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900 hover:text-blue-700"
                    >
                      <Globe className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
                      {prettyHost(current)}
                    </a>
                  ) : (
                    // Прогон по свободному запросу — нет URL, показываем сам запрос.
                    <span className="flex items-start gap-1.5 text-sm font-semibold text-gray-900">
                      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
                      <span className="line-clamp-2">{current.website}</span>
                    </span>
                  )}
                  {current.hypothesesGeneratedAt && (
                    <p className="text-[11px] text-gray-400">Сгенерировано: {formatDate(current.hypothesesGeneratedAt)}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyHypotheses}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                    {copied ? 'Скопировано' : 'Копировать'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerate()}
                    disabled={busy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    Перегенерировать
                  </button>
                </div>
              </div>

              {current.questions.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
                    Стоит уточнить у клиента:
                  </p>
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-amber-900 marker:text-amber-500">
                    {current.questions.map((q, i) => (
                      <li key={`${i}-${q}`}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}

              <LeadSourceHypothesesView markdown={current.hypotheses} />
            </div>
          )}

          {!busy && !shownError && !current?.hypotheses && (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
              <Lightbulb className="mb-3 h-8 w-8 text-gray-300" aria-hidden />
              <p className="text-sm font-medium text-gray-500">Вставьте сайт или запрос выше</p>
              <p className="mt-1 text-xs text-gray-400">
                AI соберёт бриф и предложит готовые гипотезы по сбору базы.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Статусная плашка (загрузка / ошибка). */
function StatusBox({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode;
  icon: 'spin' | 'error';
  tone: 'info' | 'error';
}) {
  const toneClass = tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-600';
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${toneClass}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon === 'spin' ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-gray-400" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <span className="flex-1">{children}</span>
    </div>
  );
}
