'use client';

import { useMemo, useState } from 'react';

import type { VeLegacyCandidate } from '@/lib/verticalEngineV2/types.legacy';

export function LegacyReviewPanel({
  candidates,
  busyId,
  onApprove,
  onRemove,
}: {
  candidates: VeLegacyCandidate[];
  busyId: string | null;
  onApprove: (candidate: VeLegacyCandidate, notes: string) => Promise<void>;
  onRemove: (candidate: VeLegacyCandidate) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((candidate) =>
      [candidate.name, candidate.website_url, candidate.status, candidate.market]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [candidates, query]);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
        <h2 className="text-sm font-semibold text-red-900">
          Ручная проверка обязательна
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-red-700">
          Не добавляйте проект только потому, что у него market=ru или выключен
          autopilot. Сначала убедитесь, что это внутренний прогон специалиста, а не
          ENG-клиент или тест ENG-команды. Подтверждение сразу делает проект видимым
          всем внутренним специалистам во вкладке «Архив».
        </p>
      </div>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Поиск по названию, сайту, статусу или рынку"
        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-500"
      />

      <div className="space-y-3">
        {filtered.map((candidate) => {
          const isBusy = busyId === candidate.id;
          return (
            <article
              key={candidate.id}
              className="rounded-2xl border border-slate-200 bg-white p-5"
            >
              <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-950">
                      {candidate.name || 'Без названия'}
                    </h3>
                    {candidate.linked ? (
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                        В архиве
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {candidate.website_url}
                  </p>
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
                    <div>
                      <dt className="inline text-slate-400">status: </dt>
                      <dd className="inline">{candidate.status || '—'}</dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">market: </dt>
                      <dd className="inline">{candidate.market || '—'}</dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">autopilot: </dt>
                      <dd className="inline">
                        {candidate.autopilot === null
                          ? '—'
                          : candidate.autopilot
                            ? 'true'
                            : 'false'}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">created_by: </dt>
                      <dd className="inline">{candidate.created_by || '—'}</dd>
                    </div>
                  </dl>
                </div>

                <div className="w-full shrink-0 lg:w-[360px]">
                  {candidate.linked ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void onRemove(candidate)}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-red-300 hover:text-red-700 disabled:opacity-50"
                    >
                      {isBusy ? 'Удаляем…' : 'Убрать из архива'}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={notes[candidate.id] ?? ''}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [candidate.id]: event.target.value,
                          }))
                        }
                        placeholder="Основание проверки (обязательно)"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition focus:border-slate-500"
                      />
                      <button
                        type="button"
                        disabled={isBusy || !(notes[candidate.id] ?? '').trim()}
                        onClick={() =>
                          void onApprove(candidate, (notes[candidate.id] ?? '').trim())
                        }
                        className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isBusy ? 'Добавляем…' : 'Подтвердить внутренний проект'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          Ничего не найдено.
        </div>
      ) : null}
    </div>
  );
}
