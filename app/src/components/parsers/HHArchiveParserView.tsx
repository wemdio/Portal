'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { RegionPicker } from './RegionPicker';
import { findRegionById } from '@/lib/parsers/hhArchive/regions';

/**
 * HH Archive Parser UI — отдельная вкладка для архивных (закрытых) вакансий
 * через api.hh.ru. Главные отличия от обычного HH-парсера:
 *  - Дата ОБЯЗАТЕЛЬНА (без неё архив бесконечный).
 *  - Перед запуском — кнопка «Узнать количество» (preview): дёргает HH с
 *    per_page=1, показывает found. Защита от «упс, выбрал всю РФ за 5 лет».
 *  - Один активный job на пользователя (DB-constraint). Запуск нового
 *    пока текущий не завершён → 409.
 *  - max_results cap (50 000 default). Поднимается через env админом.
 */

interface ArchiveJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  search_queries: string[];
  area: string;
  date_from: string;
  date_to: string;
  archived: boolean;
  chunk_strategy: 'single' | 'monthly' | 'weekly' | 'daily';
  max_results: number;
  estimated_total: number | null;
  found_total: number | null;
  saved_total: number;
  processed_chunks: number;
  total_chunks: number;
  errors_count: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface PreviewResponse {
  total_estimated: number;
  per_query: { query: string; found: number; error: string | null }[];
  note: string;
  /** ISO date самой старой записи в локальном hh_vacancies — для UI-плашки. */
  oldest_available?: string | null;
}

/** '2026-02-04T...' → 'февраля 2026'. Плашка «данные с ...». */
function formatOldestForBanner(iso: string | null | undefined): string {
  if (!iso) return 'февраля 2026';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'февраля 2026';
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const DEFAULT_QUERIES = `PR-менеджер
пресс-секретарь
руководитель PR`;

// Локальный архив `hh_vacancies` копится с 04.02.2026 (первая запись
// обычного HH-парсера спецов). До этой даты HH API не даёт ничего:
// удерживает вакансии только ~2 месяца, историю мы собираем сами. Ставим
// жёсткую нижнюю границу на date-инпуты — чтобы юзеры не запускали job
// на 2023-2025 и не получали 0 результатов с непонятной причиной.
// Env-override HH_ARCHIVE_MIN_DATE может понадобиться, если однажды
// подключим более старые источники (mailganer/outreachos сумели скопить
// глубже) — тогда просто снизим границу.
const ARCHIVE_MIN_DATE =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_HH_ARCHIVE_MIN_DATE) ||
  '2026-01-01';

function clampToArchiveMin(date: string): string {
  return date < ARCHIVE_MIN_DATE ? ARCHIVE_MIN_DATE : date;
}

const CHUNK_HELP: Record<ArchiveJob['chunk_strategy'], string> = {
  single: 'Один большой запрос. Риск: если за период >2000 вакансий, всё что свыше потеряется.',
  monthly: 'Период режется по месяцам. Подходит для большинства задач (PR, узкие ниши).',
  weekly: 'Период режется по неделям. Для широких ниш (IT, продажи).',
  daily: 'Период режется по дням. Очень широкие ниши + длинный период.',
};

export function HHArchiveParserView() {
  const [queriesRaw, setQueriesRaw] = useState(DEFAULT_QUERIES);
  // areas — массив выбранных area id. Пусто = вся РФ (113, дефолт на сервере).
  const [areas, setAreas] = useState<string[]>(['113']);
  // Дефолт: год назад, но не раньше ARCHIVE_MIN_DATE — иначе с ходу
  // получаем 0 результатов, юзер думает «парсер сломан».
  const [dateFrom, setDateFrom] = useState(() =>
    clampToArchiveMin(`${new Date().getFullYear() - 1}-01-01`),
  );
  const [dateTo, setDateTo] = useState(() =>
    clampToArchiveMin(`${new Date().getFullYear() - 1}-12-31`),
  );
  const [chunkStrategy, setChunkStrategy] = useState<ArchiveJob['chunk_strategy']>('monthly');
  const [maxResults, setMaxResults] = useState(50000);

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<ArchiveJob[]>([]);
  const [activeJob, setActiveJob] = useState<ArchiveJob | null>(null);

  const queries = queriesRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const loadJobs = useCallback(async () => {
    try {
      const res = await authFetch('/api/parsers/hh-archive');
      if (!res.ok) return;
      const { jobs: items } = (await res.json()) as { jobs: ArchiveJob[] };
      setJobs(items);
      const active = items.find((j) => j.status === 'pending' || j.status === 'processing');
      if (active) setActiveJob(active);
      else if (activeJob && items.find((j) => j.id === activeJob.id)) {
        setActiveJob(items.find((j) => j.id === activeJob.id) ?? null);
      }
    } catch { /* ignore */ }
  }, [activeJob]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  // Поллинг активной задачи раз в 3 сек
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed' || activeJob.status === 'cancelled') return;
    const t = setInterval(() => { void loadJobs(); }, 3000);
    return () => clearInterval(t);
  }, [activeJob, loadJobs]);

  const handlePreview = async () => {
    setError('');
    setPreview(null);
    if (queries.length === 0) {
      setError('Введите хотя бы один поисковый запрос');
      return;
    }
    if (!dateFrom || !dateTo) {
      setError('Выберите период');
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await authFetch('/api/parsers/hh-archive/preview', {
        method: 'POST',
        body: JSON.stringify({
          search_queries: queries,
          area: areas.join(','),
          date_from: dateFrom,
          date_to: dateTo,
          archived: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'preview failed' }));
        throw new Error(data.error ?? 'preview failed');
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка при оценке');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStart = async () => {
    setError('');
    if (queries.length === 0) { setError('Введите хотя бы один запрос'); return; }
    setSubmitting(true);
    try {
      const res = await authFetch('/api/parsers/hh-archive', {
        method: 'POST',
        body: JSON.stringify({
          search_queries: queries,
          area: areas.join(','),
          date_from: dateFrom,
          date_to: dateTo,
          archived: true,
          chunk_strategy: chunkStrategy,
          max_results: maxResults,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Ошибка запуска' }));
        throw new Error(data.error ?? 'Ошибка запуска');
      }
      const { job } = (await res.json()) as { job: ArchiveJob };
      setActiveJob(job);
      void loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запуска');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    await authFetch(`/api/parsers/hh-archive/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
    });
    void loadJobs();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить задачу и её результаты?')) return;
    await authFetch(`/api/parsers/hh-archive/${id}`, { method: 'DELETE' });
    if (activeJob?.id === id) setActiveJob(null);
    void loadJobs();
  };

  const handleExport = async (jobId: string) => {
    // Подгружаем партиями по 5000 и сшиваем CSV.
    let offset = 0;
    const LIMIT = 5000;
    const all: { vacancy_id: string; title: string; company: string; company_site_url: string; area: string; employer_id: string | null; published_at: string | null; raw_query: string }[] = [];
    for (;;) {
      const res = await authFetch(`/api/parsers/hh-archive/${jobId}/results?limit=${LIMIT}&offset=${offset}`);
      if (!res.ok) { setError('Не удалось загрузить результаты'); return; }
      const { results, total } = (await res.json()) as { results: typeof all; total: number };
      all.push(...results);
      offset += results.length;
      if (results.length === 0 || offset >= total) break;
    }
    if (all.length === 0) { setError('Пусто'); return; }

    const headers = ['Вакансия_URL', 'Название_вакансии', 'Компания', 'Сайт_компании', 'Город', 'ID_работодателя_HH', 'Работодатель_hh_URL', 'Дата_публикации', 'Запрос'];
    const lines = [headers.join(',')];
    for (const r of all) {
      const row = [
        `https://hh.ru/vacancy/${r.vacancy_id}`,
        r.title,
        r.company,
        r.company_site_url,
        r.area,
        r.employer_id ?? '',
        r.employer_id ? `https://hh.ru/employer/${r.employer_id}` : '',
        r.published_at ?? '',
        r.raw_query,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(row.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hh-archive-${jobId.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progress = activeJob && activeJob.total_chunks > 0
    ? Math.round((activeJob.processed_chunks / activeJob.total_chunks) * 100)
    : 0;
  const isRunning = activeJob && (activeJob.status === 'pending' || activeJob.status === 'processing');

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900 space-y-1">
        <div>
          <strong>Архивный режим:</strong> поиск идёт по <strong>локальному архиву</strong> уже
          собранных вакансий. Один активный job на пользователя. Cap:{' '}
          <strong>{maxResults.toLocaleString()}</strong> строк.
        </div>
        <div className="text-xs">
          Данные накоплены с <strong>января 2026</strong> — за более ранние периоды в HH нет доступа.
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Поисковые запросы (по одному на строку)</label>
          <textarea
            value={queriesRaw}
            onChange={(e) => { setQueriesRaw(e.target.value); setPreview(null); }}
            rows={6}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
            placeholder="PR-менеджер&#10;пресс-секретарь"
          />
          <p className="text-xs text-gray-500 mt-1">{queries.length} запрос(а/ов). Максимум 30.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Дата с</label>
            <input
              type="date"
              value={dateFrom}
              min={ARCHIVE_MIN_DATE}
              onChange={(e) => {
                // Клампим руками: `min` на input блокирует ТОЛЬКО стрелки
                // date-picker'а, но type=text-ввод и paste пропускают меньшие
                // значения (браузеры показывают их красным, но state обновляют).
                const next = clampToArchiveMin(e.target.value);
                setDateFrom(next);
                setPreview(null);
              }}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Дата по</label>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || ARCHIVE_MIN_DATE}
              onChange={(e) => {
                const clamped = clampToArchiveMin(e.target.value);
                // Не даём «по» уйти раньше «с» — это и логическая ошибка,
                // и запрос бы вернул 0.
                const next = clamped < dateFrom ? dateFrom : clamped;
                setDateTo(next);
                setPreview(null);
              }}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Регионы</label>
            <RegionPicker
              value={areas}
              onChange={(ids) => { setAreas(ids); setPreview(null); }}
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Разбивка периода</label>
            <select
              value={chunkStrategy}
              onChange={(e) => setChunkStrategy(e.target.value as ArchiveJob['chunk_strategy'])}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="monthly">по месяцам</option>
              <option value="weekly">по неделям</option>
              <option value="daily">по дням</option>
              <option value="single">одним запросом</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">{CHUNK_HELP[chunkStrategy]}</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Лимит строк</label>
            <input
              type="number"
              value={maxResults}
              onChange={(e) => setMaxResults(Math.max(1, Math.min(200000, Number(e.target.value) || 0)))}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
              min={100}
              max={200000}
              step={1000}
            />
            <p className="text-xs text-gray-500 mt-1">Hard-stop при достижении</p>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => void handlePreview()}
            disabled={previewLoading || queries.length === 0 || !dateFrom || !dateTo}
            className="flex-1 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            {previewLoading ? 'Считаем…' : '🔍 Узнать количество'}
          </button>
          <button
            onClick={() => void handleStart()}
            disabled={submitting || queries.length === 0 || !!isRunning}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Запускаем…' : isRunning ? 'Уже идёт задача…' : '▶ Запустить парсинг'}
          </button>
        </div>

        {preview && (() => {
          const errored = preview.per_query.filter((p) => p.error);
          const allErrored = errored.length === preview.per_query.length && preview.per_query.length > 0;
          const sample403 = errored.find((p) => p.error?.includes('403'));
          if (allErrored) {
            return (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm space-y-2">
                <div className="font-semibold text-red-800">
                  ❌ HH API недоступен — все запросы упали
                </div>
                <div className="text-xs text-red-700">
                  {sample403 ? (
                    <>
                      HH вернул <strong>403 Forbidden</strong>. Обычно причина — анонимный доступ
                      без OAuth-токена либо неправильный User-Agent. Попросите админа выставить
                      env-переменные <code className="font-mono">HH_OAUTH_TOKEN</code> и
                      {' '}<code className="font-mono">HH_ARCHIVE_USER_AGENT</code> на сервере.
                    </>
                  ) : (
                    <>
                      Ошибка от HH: <code className="font-mono">{errored[0]?.error}</code>.
                      Возможно, временный сбой — попробуйте ещё раз через минуту.
                    </>
                  )}
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-red-700">Все ошибки</summary>
                  <table className="mt-2 w-full text-left">
                    <tbody>
                      {preview.per_query.map((p) => (
                        <tr key={p.query}>
                          <td className="py-0.5 pr-2">{p.query}</td>
                          <td className="py-0.5 text-red-600 font-mono text-[11px]">{p.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            );
          }
          const outOfRange =
            preview.oldest_available &&
            dateFrom &&
            dateFrom < preview.oldest_available.slice(0, 10);
          return (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm space-y-2">
              <div className="font-semibold text-blue-900">
                В архиве найдено около {preview.total_estimated.toLocaleString()} строк
              </div>
              <div className="text-xs text-blue-700">{preview.note}</div>
              <div className="text-xs text-gray-600">
                ℹ Это до дедупа по vacancy_id (одна вакансия может лежать в нескольких job&#39;ах
                обычного парсера и в sink&#39;e auto-pipeline). После дедупа реально выгрузится меньше.
              </div>
              {outOfRange && (
                <div className="text-xs text-amber-800 font-medium">
                  ⚠ Начальная дата ({dateFrom}) раньше самой старой записи в архиве
                  ({preview.oldest_available?.slice(0, 10)}). За этот период данных нет —
                  ограничьте фильтр справа, либо ждите пока архив накопит больше.
                </div>
              )}
              {errored.length > 0 && (
                <div className="text-xs text-amber-800 font-medium">
                  ⚠ Часть запросов упала ({errored.length} из {preview.per_query.length}):
                  оценка занижена. См. разбивку ниже.
                </div>
              )}
              {preview.total_estimated > maxResults && (
                <div className="text-xs text-red-700 font-medium">
                  ⚠ Это больше вашего лимита {maxResults.toLocaleString()}. Сократите период
                  либо повысьте лимит (cap 200 000).
                </div>
              )}
              <details className="text-xs">
                <summary className="cursor-pointer text-blue-600">Разбивка по запросам</summary>
                <table className="mt-2 w-full text-left">
                  <tbody>
                    {preview.per_query.map((p) => (
                      <tr key={p.query}>
                        <td className="py-0.5">{p.query}</td>
                        <td className="py-0.5 text-right tabular-nums">
                          {p.error ? (
                            <span className="text-red-600 font-mono">{p.error}</span>
                          ) : (
                            p.found.toLocaleString()
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          );
        })()}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* Активная задача */}
      {activeJob && isRunning && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">
              {activeJob.status === 'pending' ? 'В очереди' : 'Обработка'}: {activeJob.processed_chunks}/{activeJob.total_chunks} чанков
            </span>
            <button
              onClick={() => void handleCancel(activeJob.id)}
              className="text-xs text-red-600 hover:text-red-700"
            >
              Отменить
            </button>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Найдено: {activeJob.found_total ?? 0} · Сохранено: {activeJob.saved_total}
            {activeJob.errors_count > 0 && <> · Ошибок: {activeJob.errors_count}</>}
          </div>
        </div>
      )}

      {/* История */}
      {jobs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">История задач</h3>
          <div className="space-y-2">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <StatusBadge status={j.status} />
                    <span className="text-gray-700 truncate">{j.search_queries.slice(0, 3).join(', ')}{j.search_queries.length > 3 ? '…' : ''}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {j.date_from} → {j.date_to} · {formatAreas(j.area)}
                  </div>
                  {j.status === 'completed' && (
                    <div className="text-xs text-gray-600 mt-0.5">
                      HH found: <span className="font-mono">{(j.found_total ?? 0).toLocaleString()}</span>
                      {' · '}уникальных сохранено: <span className="font-mono font-medium">{j.saved_total.toLocaleString()}</span>
                      {j.errors_count > 0 && (
                        <> · <span className="text-amber-700">ошибок: {j.errors_count}</span></>
                      )}
                      {(j.found_total ?? 0) > j.saved_total && j.saved_total > 0 && (
                        <span
                          className="text-gray-400 italic ml-1"
                          title="HH `found` включает повторы вакансий в нескольких регионах, скрытые/приватные позиции и архивные дубли. Реально уникально достать обычно 70-85% от found."
                        >
                          ({Math.round((j.saved_total / (j.found_total || 1)) * 100)}%, почему?)
                        </span>
                      )}
                    </div>
                  )}
                  {j.status !== 'completed' && (
                    <div className="text-xs text-gray-500 mt-0.5">
                      {j.saved_total.toLocaleString()} строк сохранено
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {j.status === 'completed' && j.saved_total > 0 && (
                    <button
                      onClick={() => void handleExport(j.id)}
                      className="text-xs text-blue-600 hover:text-blue-700"
                    >
                      Экспорт CSV
                    </button>
                  )}
                  {(j.status === 'pending' || j.status === 'processing') && (
                    <button
                      onClick={() => void handleCancel(j.id)}
                      className="text-xs text-red-600"
                    >
                      Отменить
                    </button>
                  )}
                  {(j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') && (
                    <button
                      onClick={() => void handleDelete(j.id)}
                      className="text-xs text-gray-400 hover:text-red-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Превращает CSV area ("1,2,3") в человекочитаемое «регионы: Москва, СПб, Екатеринбург». */
function formatAreas(csv: string): string {
  const ids = csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return 'регион 113';
  const names = ids.map((id) => findRegionById(id)?.name ?? `area=${id}`);
  if (names.length === 1) return `регион ${names[0]}`;
  if (names.length <= 3) return `регионы: ${names.join(', ')}`;
  return `${names.length} регионов: ${names.slice(0, 2).join(', ')}…`;
}

function StatusBadge({ status }: { status: ArchiveJob['status'] }) {
  const styles: Record<ArchiveJob['status'], string> = {
    pending: 'bg-gray-100 text-gray-700',
    processing: 'bg-blue-100 text-blue-700',
    completed: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-amber-100 text-amber-700',
  };
  const labels: Record<ArchiveJob['status'], string> = {
    pending: 'В очереди',
    processing: 'Обработка',
    completed: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}
