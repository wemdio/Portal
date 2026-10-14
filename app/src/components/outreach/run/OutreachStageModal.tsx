'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { OutreachStageData } from './types';

/**
 * Что происходило на конкретном шаге конвейера.
 *
 * Цепочка шагов отвечает «сколько прошло и сколько отсеялось», но не отвечает
 * «кто именно и почему». Между «домен нашёлся у 32 из 100» и доверием к этой
 * цифре стоит ровно один вопрос: а у кого не нашёлся. Здесь на него и
 * отвечаем — списком компаний с тем, что шаг про них узнал. Строки и правило
 * «прошла / нет» даёт язык (адаптер), окно — общее.
 */
export function OutreachStageModal({
  stageLabel,
  load,
  onClose,
}: {
  stageLabel: string;
  load: () => Promise<OutreachStageData>;
  onClose: () => void;
}) {
  const [data, setData] = useState<OutreachStageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Загрузка разбора шага по клику — запрос во внешнюю систему.
    load()
      .then((next) => { if (!cancelled) setData(next); })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить строки');
        setData({ entries: [] });
      });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = data?.entries ?? [];
  const failedCount = entries.filter((entry) => !entry.passed).length;
  const passedCount = data?.passedTotal ?? entries.length - failedCount;
  const shown = onlyFailed ? entries.filter((entry) => !entry.passed) : entries;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={stageLabel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{stageLabel}</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {data === null ? 'Загружаю строки прогона…' : `Прошли дальше: ${passedCount} · не прошли: ${failedCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {failedCount > 0 ? (
              <button
                type="button"
                onClick={() => setOnlyFailed((v) => !v)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                  onlyFailed ? 'border-rose-300 text-rose-600' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                }`}
              >
                Только отсеянные
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {data === null ? (
            <div className="flex items-center gap-2 px-6 py-10 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаю…
            </div>
          ) : error ? (
            <p className="px-6 py-10 text-center text-sm text-rose-600">{error}</p>
          ) : shown.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-gray-500">До этого этапа ещё ничего не дошло.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="px-6 py-2 font-medium">Компания</th>
                  <th className="px-3 py-2 font-medium">Что нашли</th>
                  <th className="px-6 py-2 font-medium">Итог</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shown.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-6 py-2.5">
                      <div className="font-medium text-gray-900">{entry.company}</div>
                      {entry.link ? (
                        <a href={entry.link.href} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 hover:underline">
                          {entry.link.label}
                        </a>
                      ) : null}
                    </td>
                    <td className="min-w-0 px-3 py-2.5 text-gray-700">
                      <span className="break-words">{entry.detail || '—'}</span>
                      {entry.quote ? (
                        <p className="mt-1 text-[11px] italic leading-relaxed text-gray-500">«{entry.quote}»</p>
                      ) : null}
                    </td>
                    <td className="px-6 py-2.5">
                      {entry.passed ? (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">прошла</span>
                      ) : (
                        <span className="rounded-md bg-rose-50 px-2 py-0.5 text-xs text-rose-700">{entry.reason ?? 'не прошла'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data?.note ? <p className="px-6 py-3 text-xs text-gray-500">{data.note}</p> : null}
        </div>
      </div>
    </div>
  );
}
