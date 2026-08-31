'use client';

import { useMemo, useState } from 'react';

import type { VeLegacyCandidate } from '@/lib/verticalEngineV2/types.legacy';
import { StatusDot } from './engine/design';

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
  /** Двухшаговое подтверждение деструктивного действия без window.confirm. */
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
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
    <section className="space-y-5" aria-labelledby="legacy-review-title">
      <div className="ve2-nt ve2-nt-err p-5">
        <h2 className="ve2-h3 flex items-center gap-2.5">
          <StatusDot tone="err" />
          <span id="legacy-review-title">Ручная проверка обязательна</span>
        </h2>
        <p className="ve2-mut mt-2 max-w-3xl text-sm leading-6">
          Не добавляйте проект только потому, что у него market=ru или выключен
          autopilot. Сначала убедитесь, что это внутренний прогон специалиста, а не
          ENG-клиент или тест ENG-команды. Подтверждение сразу делает проект видимым
          всем внутренним специалистам во вкладке «Архив».
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по названию, сайту, статусу или рынку"
          aria-label="Поиск кандидатов"
          className="ve2-input max-w-[440px]"
        />
        <span className="ve2-faint shrink-0" aria-live="polite">
          {filtered.length} из {candidates.length}
        </span>
      </div>

      <div className="space-y-3">
        {filtered.map((candidate) => {
          const isBusy = busyId === candidate.id;
          return (
            <article
              key={candidate.id}
              className="ve2-panel px-5 py-4"
            >
              <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="ve2-h3">
                      {candidate.name || 'Без названия'}
                    </h3>
                    {candidate.linked ? (
                      <span className="ve2-st ve2-tg-ok">
                        <StatusDot tone="ok" />
                        В архиве
                      </span>
                    ) : null}
                  </div>
                  <p className="ve2-faint mt-1">
                    {candidate.website_url}
                  </p>
                  <dl className="ve2-mut mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                    <div>
                      <dt className="ve2-faint inline">status: </dt>
                      <dd className="inline">{candidate.status || '—'}</dd>
                    </div>
                    <div>
                      <dt className="ve2-faint inline">market: </dt>
                      <dd className="inline">{candidate.market || '—'}</dd>
                    </div>
                    <div>
                      <dt className="ve2-faint inline">autopilot: </dt>
                      <dd className="inline">
                        {candidate.autopilot === null
                          ? '—'
                          : candidate.autopilot
                            ? 'true'
                            : 'false'}
                      </dd>
                    </div>
                    <div>
                      <dt className="ve2-faint inline">created_by: </dt>
                      <dd className="inline">{candidate.created_by || '—'}</dd>
                    </div>
                  </dl>
                </div>

                <div className="w-full shrink-0 lg:w-[360px]">
                  {candidate.linked ? (
                    confirmRemoveId === candidate.id ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            setConfirmRemoveId(null);
                            void onRemove(candidate);
                          }}
                          className="ve2-btn ve2-b-dan ve2-b-sm flex-1 border border-current"
                        >
                          {isBusy ? 'Удаляем…' : 'Точно убрать'}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmRemoveId(null)}
                          className="ve2-btn ve2-b-sec ve2-b-sm"
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmRemoveId(candidate.id)}
                        className="ve2-btn ve2-b-sec ve2-b-dan w-full"
                      >
                        Убрать из архива
                      </button>
                    )
                  ) : (
                    <div className="space-y-2">
                      <label
                        className="ve2-label"
                        htmlFor={`legacy-review-notes-${candidate.id}`}
                      >
                        Основание проверки <span className="ve2-faint">обязательно</span>
                      </label>
                      <input
                        id={`legacy-review-notes-${candidate.id}`}
                        type="text"
                        value={notes[candidate.id] ?? ''}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [candidate.id]: event.target.value,
                          }))
                        }
                        placeholder="Например: прогон Сергея, апрель"
                        className="ve2-input"
                      />
                      <button
                        type="button"
                        disabled={isBusy || !(notes[candidate.id] ?? '').trim()}
                        onClick={() =>
                          void onApprove(candidate, (notes[candidate.id] ?? '').trim())
                        }
                        className="ve2-btn ve2-b-pri w-full"
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
        <div className="ve2-empty">
          Ничего не найдено.
        </div>
      ) : null}
    </section>
  );
}
