'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Inbox } from 'lucide-react';
import {
  normalizeSharedReviewRequests,
  teamApiFetch,
  type TeamReviewRequestState,
  type TeamSharedReviewRequest,
  type TeamSharedReviewRequestsResponse,
} from './teamApi';
import {
  REVIEW_REQUEST_STATE_META,
  REVIEW_REQUEST_STATES,
  ReviewRequestDetail,
  ReviewRequestExamples,
  reviewRequestNewCountLabel,
} from './reviewRequestUi';

function SharedRequestRow({
  request,
  expanded,
  onToggle,
}: {
  request: TeamSharedReviewRequest;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = REVIEW_REQUEST_STATE_META[request.state];
  const employeeName = request.employee?.name || 'Сотрудник не найден';
  const initiatorName = request.initiator?.name || 'Инициатор не указан';
  const projectName = request.project?.name || 'Без проекта';

  return (
    <article role="listitem" className="border-t border-gray-100 first:border-t-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`shared-review-request-details-${request.id}`}
        onClick={onToggle}
        className="grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:grid-cols-[minmax(150px,.8fr)_minmax(150px,.8fr)_minmax(180px,1fr)_auto] sm:px-5"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-semibold text-gray-900">{employeeName}</span>
          <span className="block break-words text-xs text-gray-500 sm:hidden">{initiatorName} · {projectName}</span>
          {/* Суть запроса видна в свёрнутой строке: очередь читается целиком,
              без раскрытия каждой карточки по очереди. */}
          <span className="mt-0.5 block break-words text-xs text-gray-500 line-clamp-2">{request.problem}</span>
        </span>
        <span className="hidden min-w-0 break-words text-sm text-gray-700 sm:block">{initiatorName}</span>
        <span className="hidden min-w-0 break-words text-sm text-gray-600 sm:block">{projectName}</span>
        <span className="inline-flex items-center justify-end gap-2 whitespace-nowrap text-xs font-medium text-gray-600">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 text-gray-400 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {expanded && (
        <div
          id={`shared-review-request-details-${request.id}`}
          role="region"
          aria-label={`Детали запроса ${employeeName}`}
          className="min-w-0 bg-gray-50/60 px-4 py-4 sm:px-5"
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <ReviewRequestDetail label="Инициатор">{initiatorName}</ReviewRequestDetail>
            <ReviewRequestDetail label="Сотрудник">{employeeName}</ReviewRequestDetail>
            <ReviewRequestDetail label="Проект">{projectName}</ReviewRequestDetail>
            <ReviewRequestDetail label="Проблема / причина">{request.problem}</ReviewRequestDetail>
            <ReviewRequestDetail label="Что нужно выяснить">{request.desiredOutcome}</ReviewRequestDetail>
            {request.examples && (
              <ReviewRequestDetail label="Примеры и обсуждения">
                <ReviewRequestExamples value={request.examples} />
              </ReviewRequestDetail>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export default function TeamSharedReviewRequestsPanel() {
  const [response, setResponse] = useState<TeamSharedReviewRequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const payload = await teamApiFetch('/api/team/review-requests/shared');
      if (sequence !== requestSequence.current) return;
      setResponse(normalizeSharedReviewRequests(payload));
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setResponse(null);
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить запросы на ревью.');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial synchronization belongs to this subscription effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  const requestsByState = useMemo(() => {
    const groups = new Map<TeamReviewRequestState, TeamSharedReviewRequest[]>();
    REVIEW_REQUEST_STATES.forEach((state) => groups.set(state, []));
    response?.requests.forEach((request) => groups.get(request.state)?.push(request));
    return groups;
  }, [response]);

  const toggle = (requestId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  };

  return (
    <section
      role="region"
      aria-label="Общие запросы на ревью"
      aria-busy={loading}
      className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-900"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Inbox aria-hidden="true" className="h-4 w-4 text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900">Запросы на ревью</h2>
          </div>
          <p className="mt-1 max-w-[72ch] break-words text-sm text-gray-500">
            Здесь видны только запросы, созданные лидами и директорами. Обрабатывают их Алина и Сергей.
          </p>
        </div>
        {response && response.summary.newCount > 0 && (
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
            {reviewRequestNewCountLabel(response.summary.newCount)}
          </span>
        )}
      </header>

      {loading ? (
        <div className="space-y-2 p-4 sm:p-5">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-14 animate-pulse rounded-xl bg-gray-100 motion-reduce:animate-none" />
          ))}
        </div>
      ) : error ? (
        <div className="p-5 text-sm text-red-700">
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 min-h-11 rounded-xl border border-red-200 bg-white px-4 font-medium outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Повторить
          </button>
        </div>
      ) : response && response.requests.length > 0 ? (
        <div>
          {REVIEW_REQUEST_STATES.map((state) => {
            const requests = requestsByState.get(state) || [];
            if (!requests.length) return null;
            const meta = REVIEW_REQUEST_STATE_META[state];
            return (
              <section key={state} aria-labelledby={`shared-review-request-group-${state}`}>
                <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50/60 px-4 py-2.5 sm:px-5">
                  <h3 id={`shared-review-request-group-${state}`} className="text-sm font-semibold text-gray-800">
                    {meta.heading}
                  </h3>
                  <span className="text-xs tabular-nums text-gray-500">{requests.length}</span>
                </div>
                <div role="list">
                  {requests.map((request) => (
                    <SharedRequestRow
                      key={request.id}
                      request={request}
                      expanded={expanded.has(request.id)}
                      onToggle={() => toggle(request.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-gray-500 sm:px-5">
          Общих запросов пока нет.
        </p>
      )}
    </section>
  );
}
