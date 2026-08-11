'use client';

import { useRef, useState } from 'react';
import TeamReviewRequestsPanel from './TeamReviewRequestsPanel';
import TeamTalentReservePanel from './TeamTalentReservePanel';

type HrView = 'talent' | 'requests';

interface TeamHrPanelProps {
  newRequestCount: number;
  onReviewRequestsChanged: () => void;
}

function newRequestsLabel(count: number): string {
  if (count <= 0) return 'Запросы на ревью';
  const singular = count % 10 === 1 && count % 100 !== 11;
  return `Запросы на ревью, ${count} ${singular ? 'новый' : 'новых'}`;
}

export default function TeamHrPanel({
  newRequestCount,
  onReviewRequestsChanged,
}: TeamHrPanelProps) {
  const [view, setView] = useState<HrView>('talent');
  const talentTabRef = useRef<HTMLButtonElement>(null);
  const requestsTabRef = useRef<HTMLButtonElement>(null);

  const selectAndFocus = (next: HrView) => {
    setView(next);
    const ref = next === 'talent' ? talentTabRef : requestsTabRef;
    queueMicrotask(() => ref.current?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') selectAndFocus('talent');
    else if (event.key === 'End') selectAndFocus('requests');
    else selectAndFocus(view === 'talent' ? 'requests' : 'talent');
  };

  return (
    <section aria-labelledby="team-hr-title" className="min-w-0 space-y-5">
      <div>
        <h2 id="team-hr-title" className="text-xl font-bold tracking-tight text-gray-900">HR-процессы</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-gray-500">
          Кандидаты на будущее и запросы руководителей на рабочие ревью.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="HR-процессы"
        className="inline-flex min-h-11 max-w-full w-fit gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-gray-200 bg-white p-1"
      >
        <button
          ref={talentTabRef}
          id="team-hr-talent-tab"
          type="button"
          role="tab"
          aria-selected={view === 'talent'}
          aria-controls="team-hr-talent-panel"
          tabIndex={view === 'talent' ? 0 : -1}
          onClick={() => setView('talent')}
          onKeyDown={handleKeyDown}
          className={`min-h-11 shrink-0 whitespace-nowrap rounded-lg px-4 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'talent' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}
        >
          Кадровый резерв
        </button>
        <button
          ref={requestsTabRef}
          id="team-hr-requests-tab"
          type="button"
          role="tab"
          aria-label={newRequestsLabel(newRequestCount)}
          aria-selected={view === 'requests'}
          aria-controls="team-hr-requests-panel"
          tabIndex={view === 'requests' ? 0 : -1}
          onClick={() => setView('requests')}
          onKeyDown={handleKeyDown}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'requests' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}
        >
          <span>Запросы на ревью</span>
          {newRequestCount > 0 && (
            <span
              aria-hidden="true"
              className={`inline-flex min-w-5 items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${view === 'requests' ? 'bg-amber-400 text-gray-950' : 'bg-amber-100 text-amber-800'}`}
            >
              {newRequestCount > 99 ? '99+' : newRequestCount}
            </span>
          )}
        </button>
      </div>

      {view === 'talent' ? (
        <div
          id="team-hr-talent-panel"
          role="tabpanel"
          aria-label="Кадровый резерв"
        >
          <TeamTalentReservePanel />
        </div>
      ) : (
        <div
          id="team-hr-requests-panel"
          role="tabpanel"
          aria-label="Запросы на ревью"
        >
          <TeamReviewRequestsPanel onChanged={onReviewRequestsChanged} />
        </div>
      )}
    </section>
  );
}
