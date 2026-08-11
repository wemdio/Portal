'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Inbox, Loader2 } from 'lucide-react';
import { currentMoscowDate } from '@/lib/calendarDate';
import {
  buildTeamReviewRequestActionWrite,
  buildTeamReviewRequestConversionWrite,
  normalizeReviewRequests,
  teamApiFetch,
  TeamApiError,
  type TeamReviewRequest,
  type TeamReviewRequestState,
  type TeamReviewRequestsResponse,
} from './teamApi';
import { TEAM_FORM_INPUT_CLASS, TEAM_FORM_TEXTAREA_CLASS } from './teamFormStyles';

const STATE_META: Record<TeamReviewRequestState, { heading: string; label: string; dot: string }> = {
  new: { heading: 'Новые', label: 'Новый', dot: 'bg-blue-500' },
  in_progress: { heading: 'В работе', label: 'В работе', dot: 'bg-amber-500' },
  converted: { heading: 'Ревью запланировано', label: 'Ревью запланировано', dot: 'bg-emerald-500' },
  declined: { heading: 'Не требуется', label: 'Не требуется', dot: 'bg-gray-400' },
};

const STATES: readonly TeamReviewRequestState[] = ['new', 'in_progress', 'converted', 'declined'];
const CONFLICT_MESSAGE = 'Запрос уже изменился у другого пользователя. Ваш черновик сохранён. Обновите данные запроса, чтобы продолжить.';

interface RequestActionError {
  message: string;
  conflict: boolean;
}

function newCountLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} новый`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} новых`;
  return `${count} новых`;
}

function examplesContent(value: string) {
  const links = Array.from(value.matchAll(/https?:\/\/[^\s,]+/gi))
    .map((match) => match[0].replace(/[.;!?)]*$/, ''))
    .filter(Boolean);
  if (!links.length) return <p className="whitespace-pre-wrap break-words text-gray-800">{value}</p>;
  return (
    <div className="min-w-0 space-y-2">
      <p className="whitespace-pre-wrap break-words text-gray-800">{value}</p>
      <div className="flex min-w-0 flex-col items-start gap-2">
        {links.map((href, index) => (
          <a
            key={`${href}-${index}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 break-all font-medium text-gray-900 underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Открыть обсуждение {links.length > 1 ? index + 1 : ''}
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}

function conversionPrefill(request: TeamReviewRequest): string {
  const sections = [
    request.project ? `Проект: ${request.project.name}` : '',
    `Проблема: ${request.problem}`,
    `Что нужно выяснить: ${request.desiredOutcome}`,
  ].filter(Boolean);
  return sections.join('\n').slice(0, 500);
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1 break-words text-sm text-gray-800">{children}</div>
    </div>
  );
}

interface RequestRowProps {
  request: TeamReviewRequest;
  expanded: boolean;
  canManage: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  declineOpen: boolean;
  conversionOpen: boolean;
  decisionNote: string;
  reviewDate: string;
  reviewReason: string;
  actionError: RequestActionError | null;
  toggleButtonRef: (node: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onClaim: () => void;
  onOpenDecline: () => void;
  onCancelDecline: () => void;
  onDecisionNoteChange: (value: string) => void;
  onDecline: () => void;
  onOpenConversion: () => void;
  onCancelConversion: () => void;
  onReviewDateChange: (value: string) => void;
  onReviewReasonChange: (value: string) => void;
  onConvert: () => void;
  onRefreshConflict: () => void;
}

function RequestRow({
  request,
  expanded,
  canManage,
  busy,
  actionsDisabled,
  declineOpen,
  conversionOpen,
  decisionNote,
  reviewDate,
  reviewReason,
  actionError,
  toggleButtonRef,
  onToggle,
  onClaim,
  onOpenDecline,
  onCancelDecline,
  onDecisionNoteChange,
  onDecline,
  onOpenConversion,
  onCancelConversion,
  onReviewDateChange,
  onReviewReasonChange,
  onConvert,
  onRefreshConflict,
}: RequestRowProps) {
  const confirmDeclineRef = useRef<HTMLButtonElement>(null);
  const declineTriggerRef = useRef<HTMLButtonElement>(null);
  const conversionTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewDateRef = useRef<HTMLInputElement>(null);
  const meta = STATE_META[request.state];
  const employeeName = request.employee?.name || 'Сотрудник не найден';
  const projectName = request.project?.name || 'Без проекта';

  useEffect(() => {
    if (declineOpen) confirmDeclineRef.current?.focus();
    else if (conversionOpen) reviewDateRef.current?.focus();
  }, [conversionOpen, declineOpen]);

  const cancelDecline = () => {
    onCancelDecline();
    window.requestAnimationFrame(() => declineTriggerRef.current?.focus());
  };

  const cancelConversion = () => {
    onCancelConversion();
    window.requestAnimationFrame(() => conversionTriggerRef.current?.focus());
  };

  return (
    <article role="listitem" className="border-t border-gray-100 first:border-t-0">
      <button
        ref={toggleButtonRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={`review-request-details-${request.id}`}
        onClick={onToggle}
        className="grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:grid-cols-[minmax(150px,.8fr)_minmax(220px,1.4fr)_minmax(150px,.8fr)_auto] sm:px-5"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-semibold text-gray-900">{employeeName}</span>
          <span className="block truncate text-xs text-gray-500 sm:hidden">{projectName}</span>
        </span>
        <span className="hidden min-w-0 break-words text-sm text-gray-700 sm:block">{request.problem}</span>
        <span className="hidden min-w-0 break-words text-sm text-gray-600 sm:block">{projectName}</span>
        <span className="inline-flex items-center justify-end gap-2 whitespace-nowrap text-xs font-medium text-gray-600">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
          <ChevronDown aria-hidden="true" className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {expanded && (
        <div
          id={`review-request-details-${request.id}`}
          role="region"
          aria-label={`Детали запроса ${employeeName}`}
          className="min-w-0 space-y-5 bg-gray-50/60 px-4 py-4 sm:px-5"
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Инициатор">{request.initiator?.name || 'Не указан'}</Detail>
            <Detail label="Проект">{projectName}</Detail>
            <Detail label="Проблема / причина">{request.problem}</Detail>
            <Detail label="Что нужно выяснить">{request.desiredOutcome}</Detail>
            {request.examples && <Detail label="Примеры и обсуждения">{examplesContent(request.examples)}</Detail>}
            {request.claimedBy && <Detail label="В работе у">{request.claimedBy.name}</Detail>}
            {request.decisionNote && <Detail label="Комментарий к решению">{request.decisionNote}</Detail>}
            {request.linkedReviewId && <Detail label="Результат"><span className="font-medium text-emerald-700">Связано с ревью</span></Detail>}
          </div>

          {actionError && (
            <div role="alert" className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
              <p>{actionError.message}</p>
              {actionError.conflict && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRefreshConflict}
                  className="min-h-11 shrink-0 rounded-xl border border-red-200 bg-white px-4 font-semibold text-red-700 outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
                >
                  Обновить данные запроса
                </button>
              )}
            </div>
          )}

          {canManage && request.state === 'new' && !declineOpen && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={actionsDisabled} onClick={onClaim} className="min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Взять в работу</button>
              <button ref={declineTriggerRef} type="button" disabled={actionsDisabled} onClick={onOpenDecline} className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Закрыть без ревью</button>
            </div>
          )}

          {canManage && request.state === 'in_progress' && !conversionOpen && !declineOpen && (
            <div className="flex flex-wrap gap-2">
              <button ref={conversionTriggerRef} type="button" disabled={actionsDisabled} onClick={onOpenConversion} className="min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Запланировать ревью</button>
              <button ref={declineTriggerRef} type="button" disabled={actionsDisabled} onClick={onOpenDecline} className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Закрыть без ревью</button>
            </div>
          )}

          {declineOpen && (
            <form
              aria-label="Закрытие запроса без ревью"
              className="max-w-2xl space-y-3 rounded-xl border border-gray-200 bg-white p-4"
              onSubmit={(event) => { event.preventDefault(); onDecline(); }}
            >
              <label className="block text-sm font-medium text-gray-800">
                Комментарий к решению, необязательно
                <textarea maxLength={1000} value={decisionNote} onChange={(event) => onDecisionNoteChange(event.target.value)} rows={3} className={`mt-1 block ${TEAM_FORM_TEXTAREA_CLASS}`} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button ref={confirmDeclineRef} type="submit" disabled={busy} className="min-h-11 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50">Подтвердить: ревью не требуется</button>
                <button type="button" disabled={busy} onClick={cancelDecline} className="min-h-11 rounded-xl px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500">Отмена</button>
              </div>
            </form>
          )}

          {conversionOpen && (
            <form
              aria-label="Запланировать ревью по запросу"
              className="max-w-2xl space-y-4 rounded-xl border border-gray-200 bg-white p-4"
              onSubmit={(event) => { event.preventDefault(); onConvert(); }}
            >
              <label className="block text-sm font-medium text-gray-800">
                Дата ревью
                <input ref={reviewDateRef} type="date" required value={reviewDate} onChange={(event) => onReviewDateChange(event.target.value)} className={`mt-1 block sm:max-w-xs ${TEAM_FORM_INPUT_CLASS}`} />
              </label>
              <label className="block text-sm font-medium text-gray-800">
                Причина и контекст ревью
                <textarea required maxLength={500} value={reviewReason} onChange={(event) => onReviewReasonChange(event.target.value)} rows={5} className={`mt-1 block ${TEAM_FORM_TEXTAREA_CLASS}`} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50">Создать ревью</button>
                <button type="button" disabled={busy} onClick={cancelConversion} className="min-h-11 rounded-xl px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500">Отмена</button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

export default function TeamReviewRequestsPanel({ onChanged }: { onChanged: () => void }) {
  const [response, setResponse] = useState<TeamReviewRequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declineId, setDeclineId] = useState<string | null>(null);
  const [conversionId, setConversionId] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [actionError, setActionError] = useState<(RequestActionError & { id: string }) | null>(null);
  const [refreshNotice, setRefreshNotice] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const requestSequence = useRef(0);
  const refreshNoticeRef = useRef<HTMLDivElement>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowToggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRequestId = useRef<string | null>(null);
  const actionsDisabled = busyId !== null || declineId !== null || conversionId !== null;

  const clearActionFeedback = () => {
    setActionError(null);
    setRefreshNotice('');
    setActionSuccess('');
  };

  const announceActionSuccess = (requestId: string, message: string) => {
    pendingFocusRequestId.current = requestId;
    setActionSuccess(message);
  };

  const load = useCallback(async (): Promise<TeamReviewRequestsResponse | null> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const payload = await teamApiFetch('/api/team/review-requests');
      if (sequence !== requestSequence.current) return null;
      const normalized = normalizeReviewRequests(payload);
      setResponse(normalized);
      return normalized;
    } catch (error) {
      if (sequence !== requestSequence.current) return null;
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить запросы на ревью.');
      return null;
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial remote synchronization belongs to this subscription effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  useEffect(() => {
    if (refreshNotice) refreshNoticeRef.current?.focus();
  }, [refreshNotice]);

  useEffect(() => {
    if (!actionSuccess || !pendingFocusRequestId.current) return;
    const requestId = pendingFocusRequestId.current;
    pendingFocusRequestId.current = null;
    (rowToggleRefs.current.get(requestId) || panelHeadingRef.current)?.focus();
  }, [actionSuccess, response]);

  const requestsByState = useMemo(() => {
    const result = new Map<TeamReviewRequestState, TeamReviewRequest[]>();
    STATES.forEach((state) => result.set(state, []));
    response?.groups.forEach((group) => result.set(group.state, group.requests));
    return result;
  }, [response]);

  const runAction = async (request: TeamReviewRequest, action: 'claim' | 'decline') => {
    setBusyId(request.id);
    clearActionFeedback();
    try {
      await teamApiFetch(`/api/team/review-requests/${request.id}`, {
        method: 'PATCH',
        body: JSON.stringify(buildTeamReviewRequestActionWrite({
          action,
          decisionNote,
          expectedUpdatedAt: request.updatedAt,
        })),
      });
      setDeclineId(null);
      setDecisionNote('');
      await load();
      onChanged();
      announceActionSuccess(
        request.id,
        action === 'claim' ? 'Запрос взят в работу.' : 'Запрос закрыт без ревью.',
      );
    } catch (error) {
      setActionError({
        id: request.id,
        conflict: error instanceof TeamApiError && error.code === 'review_request_conflict',
        message: error instanceof TeamApiError && error.code === 'review_request_conflict'
          ? CONFLICT_MESSAGE
          : error instanceof Error ? error.message : 'Не удалось обновить запрос.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const convert = async (request: TeamReviewRequest) => {
    setBusyId(request.id);
    clearActionFeedback();
    try {
      await teamApiFetch(`/api/team/review-requests/${request.id}/convert`, {
        method: 'POST',
        body: JSON.stringify(buildTeamReviewRequestConversionWrite({
          reviewDate,
          reviewReason,
          expectedUpdatedAt: request.updatedAt,
        })),
      });
      setConversionId(null);
      await load();
      onChanged();
      announceActionSuccess(request.id, 'Ревью запланировано.');
    } catch (error) {
      setActionError({
        id: request.id,
        conflict: error instanceof TeamApiError && error.code === 'review_request_conflict',
        message: error instanceof TeamApiError && error.code === 'review_request_conflict'
          ? CONFLICT_MESSAGE
          : error instanceof Error ? error.message : 'Не удалось запланировать ревью.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const openConversion = (request: TeamReviewRequest) => {
    setConversionId(request.id);
    setDeclineId(null);
    setReviewDate(currentMoscowDate());
    setReviewReason(conversionPrefill(request));
    clearActionFeedback();
  };

  const refreshConflict = async (request: TeamReviewRequest) => {
    setBusyId(request.id);
    const refreshed = await load();
    if (!refreshed) {
      setBusyId(null);
      return;
    }

    const latest = refreshed.groups
      .flatMap((group) => group.requests)
      .find((candidate) => candidate.id === request.id);
    let draftStillActionable = false;
    if (conversionId === request.id) {
      draftStillActionable = latest?.state === 'in_progress';
      if (!draftStillActionable) setConversionId(null);
    } else if (declineId === request.id) {
      draftStillActionable = latest?.state === 'new' || latest?.state === 'in_progress';
      if (!draftStillActionable) setDeclineId(null);
    }

    setActionError(null);
    setRefreshNotice(draftStillActionable
      ? 'Данные обновлены. Черновик сохранён — можно повторить действие.'
      : latest
        ? 'Данные обновлены. Проверьте актуальный статус запроса перед следующим действием.'
        : 'Данные обновлены. Запрос больше не находится в очереди.');
    setBusyId(null);
  };

  const renderGroup = (state: TeamReviewRequestState) => {
    const requests = requestsByState.get(state) || [];
    const meta = STATE_META[state];
    return (
      <section key={state} aria-labelledby={`review-request-group-${state}`}>
        <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50/60 px-4 py-2.5 sm:px-5">
          <h3 id={`review-request-group-${state}`} className="text-sm font-semibold text-gray-800">{meta.heading}</h3>
          <span className="text-xs tabular-nums text-gray-500">{requests.length}</span>
        </div>
        {requests.length ? (
          <div role="list">
            {requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                expanded={expanded.has(request.id)}
                canManage={response?.canManage === true}
                busy={busyId === request.id}
                actionsDisabled={actionsDisabled}
                declineOpen={declineId === request.id}
                conversionOpen={conversionId === request.id}
                decisionNote={declineId === request.id ? decisionNote : ''}
                reviewDate={conversionId === request.id ? reviewDate : ''}
                reviewReason={conversionId === request.id ? reviewReason : ''}
                actionError={actionError?.id === request.id ? actionError : null}
                toggleButtonRef={(node) => {
                  if (node) rowToggleRefs.current.set(request.id, node);
                  else rowToggleRefs.current.delete(request.id);
                }}
                onToggle={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(request.id)) next.delete(request.id);
                  else next.add(request.id);
                  return next;
                })}
                onClaim={() => { if (!actionsDisabled) void runAction(request, 'claim'); }}
                onOpenDecline={() => {
                  if (actionsDisabled) return;
                  setDeclineId(request.id);
                  setConversionId(null);
                  setDecisionNote('');
                  clearActionFeedback();
                }}
                onCancelDecline={() => { setDeclineId(null); setDecisionNote(''); }}
                onDecisionNoteChange={setDecisionNote}
                onDecline={() => void runAction(request, 'decline')}
                onOpenConversion={() => { if (!actionsDisabled) openConversion(request); }}
                onCancelConversion={() => setConversionId(null)}
                onReviewDateChange={setReviewDate}
                onReviewReasonChange={setReviewReason}
                onConvert={() => void convert(request)}
                onRefreshConflict={() => void refreshConflict(request)}
              />
            ))}
          </div>
        ) : <p className="px-4 py-4 text-sm text-gray-500 sm:px-5">Пока пусто</p>}
      </section>
    );
  };

  return (
    <section role="region" aria-label="Запросы на ревью" aria-busy={loading || busyId !== null} className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-900">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Inbox aria-hidden="true" className="h-4 w-4 text-gray-500" />
            <h3 ref={panelHeadingRef} tabIndex={-1} className="text-base font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Запросы на ревью</h3>
          </div>
          <p className="mt-1 text-sm text-gray-500">Очередь вопросов от руководителей — открытие запроса не меняет его статус.</p>
        </div>
        {response && response.summary.newCount > 0 && (
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">{newCountLabel(response.summary.newCount)}</span>
        )}
      </header>

      {actionSuccess && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="Действие с запросом выполнено"
          className="m-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 sm:mx-5"
        >
          {actionSuccess}
        </div>
      )}

      {refreshNotice && (
        <div
          ref={refreshNoticeRef}
          role="status"
          aria-label="Запрос обновлён"
          tabIndex={-1}
          className="m-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:mx-5"
        >
          {refreshNotice}
        </div>
      )}

      {loadError && response && (
        <div role="alert" aria-label="Ошибка обновления списка" className="m-4 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:mx-5 sm:flex-row sm:items-center sm:justify-between">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()} className="min-h-11 shrink-0 rounded-xl border border-red-200 bg-white px-4 font-semibold outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500">Повторить обновление списка</button>
        </div>
      )}

      {loading && !response ? (
        <div className="space-y-2 p-4 sm:p-5">
          {[0, 1, 2].map((item) => <div key={item} className="h-14 animate-pulse rounded-xl bg-gray-100 motion-reduce:animate-none" />)}
        </div>
      ) : loadError && !response ? (
        <div className="p-5 text-sm text-red-700"><p role="alert" aria-label="Ошибка обновления списка">{loadError}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-xl border border-red-200 px-4 font-medium outline-none focus-visible:ring-2 focus-visible:ring-red-500">Повторить</button></div>
      ) : (
        <div>{STATES.map(renderGroup)}</div>
      )}

      {busyId && <span className="sr-only" role="status"><Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />Сохраняем изменения</span>}
    </section>
  );
}
