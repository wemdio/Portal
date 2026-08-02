'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react';
import { ROLE_LABELS } from '@/lib/roles';
import type { UserRole } from '@/types';
import {
  buildTeamReviewCompletionWrite,
  buildTeamReviewScheduleWrite,
  formatRussianDate,
  localIsoDate,
  normalizeReviews,
  TeamApiError,
  teamApiFetch,
  type TeamReview,
  type TeamReviewEmployee,
  type TeamReviewsResponse,
} from './teamApi';

type ReviewFormPurpose = 'schedule' | 'complete';
type ReviewFormMode = 'create' | 'edit';
type ReviewFocusTarget = 'primary' | 'edit';

interface ReviewFormState {
  reviewDate: string;
  employeeUserId: string;
  reason: string;
  outcomes: string;
  problems: string;
  recommendations: string;
}

interface EditorState {
  reviewId: string;
  purpose: ReviewFormPurpose;
  returnFocus: ReviewFocusTarget;
  expectedUpdatedAt: string;
  conflicted: boolean;
}

const EMPTY_FORM: ReviewFormState = {
  reviewDate: '',
  employeeUserId: '',
  reason: '',
  outcomes: '',
  problems: '',
  recommendations: '',
};

const REVIEW_CONFLICT_MESSAGE = 'Ревью уже изменил другой руководитель. Ваш черновик пока остался в форме. Скопируйте нужные изменения, затем нажмите «Отмена»: мы загрузим актуальную версию.';

const REVIEW_TEXTAREA_CLASS = 'w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

function reviewText(value: string | null | undefined): string {
  return value || '';
}

function storeReviewButtonRef(
  refs: Map<string, HTMLButtonElement>,
  reviewId: string,
  node: HTMLButtonElement | null,
) {
  if (node) refs.set(reviewId, node);
  else refs.delete(reviewId);
}

function employeeRole(employee: TeamReviewEmployee): string {
  const role = employee.role as UserRole | null;
  return role && role in ROLE_LABELS ? ROLE_LABELS[role] : employee.role || 'Сотрудник';
}

function EmployeeAvatar({ employee }: { employee: TeamReviewEmployee }) {
  const [failed, setFailed] = useState(false);
  const initial = employee.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-gray-100 text-sm font-semibold text-gray-600">
      {employee.avatarUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={employee.avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : initial}
    </span>
  );
}

function ReviewForm({
  employees,
  initial,
  purpose,
  mode,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  employees: TeamReviewEmployee[];
  initial?: ReviewFormState;
  purpose: ReviewFormPurpose;
  mode: ReviewFormMode;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (values: ReviewFormState) => Promise<void>;
}) {
  const [values, setValues] = useState<ReviewFormState>(() => initial || {
    ...EMPTY_FORM,
    reviewDate: localIsoDate(),
  });
  const [validationError, setValidationError] = useState('');
  const completing = purpose === 'complete';

  const update = <K extends keyof ReviewFormState>(key: K, value: ReviewFormState[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.reviewDate || !values.employeeUserId) {
      setValidationError('Укажите дату и сотрудника.');
      return;
    }
    if (completing && !values.outcomes.trim()) {
      setValidationError('Заполните основные итоги ревью.');
      return;
    }
    setValidationError('');
    await onSubmit(values);
  };

  const formLabel = purpose === 'schedule'
    ? mode === 'create' ? 'Планирование ревью' : 'Редактирование запланированного ревью'
    : 'Редактирование итогов ревью';

  return (
    <form onSubmit={submit} className="space-y-5" aria-label={formLabel}>
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Дата ревью</span>
          <input
            type="date"
            autoFocus={!completing}
            value={values.reviewDate}
            onChange={(event) => update('reviewDate', event.target.value)}
            required
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Сотрудник</span>
          <select
            value={values.employeeUserId}
            onChange={(event) => update('employeeUserId', event.target.value)}
            required
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Выберите сотрудника</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}{employee.email ? `, ${employee.email}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-gray-700">
          Причина / повестка <span className="font-normal text-gray-500">(необязательно)</span>
        </span>
        <textarea
          value={values.reason}
          onChange={(event) => update('reason', event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Что важно обсудить на встрече"
          className={REVIEW_TEXTAREA_CLASS}
        />
      </label>

      {completing && (
        <>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Основные итоги</span>
            <textarea
              autoFocus={completing}
              value={values.outcomes}
              onChange={(event) => update('outcomes', event.target.value)}
              required
              rows={4}
              maxLength={5000}
              placeholder="Что получилось, какой прогресс заметен"
              className={REVIEW_TEXTAREA_CLASS}
            />
          </label>

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Зоны внимания</span>
              <textarea
                value={values.problems}
                onChange={(event) => update('problems', event.target.value)}
                rows={4}
                maxLength={5000}
                placeholder="Что мешает работе или требует поддержки"
                className={REVIEW_TEXTAREA_CLASS}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Рекомендации</span>
              <textarea
                value={values.recommendations}
                onChange={(event) => update('recommendations', event.target.value)}
                rows={4}
                maxLength={5000}
                placeholder="Следующие шаги, поддержка и договорённости"
                className={REVIEW_TEXTAREA_CLASS}
              />
            </label>
          </div>
        </>
      )}

      {(validationError || error) && (
        <p className="text-sm text-red-700" role="alert">{validationError || error}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {saving
            ? 'Сохраняем…'
            : completing
              ? 'Сохранить итоги'
              : mode === 'create' ? 'Запланировать' : 'Сохранить изменения'}
        </button>
      </div>
    </form>
  );
}

function ReviewSection({ title, text }: { title: string; text: string | null }) {
  const value = reviewText(text);
  return (
    <section className="min-w-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <p className={`mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 ${value ? 'text-gray-800' : 'text-gray-500'}`}>
        {value || 'Не указано'}
      </p>
    </section>
  );
}

function ReviewStatusBadge({ review, today }: { review: TeamReview; today: string }) {
  const meta = review.status === 'completed'
    ? { label: 'Проведено', dot: 'bg-emerald-500', text: 'text-emerald-700' }
    : review.reviewDate.slice(0, 10) < today
      ? { label: 'Ожидает итогов', dot: 'bg-red-500', text: 'text-red-700' }
      : { label: 'Запланировано', dot: 'bg-amber-500', text: 'text-amber-700' };

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function ReviewSummary({ review, today }: { review: TeamReview; today: string }) {
  const isScheduled = review.status === 'scheduled';
  const summary = isScheduled ? reviewText(review.reason) : reviewText(review.outcomes);
  return (
    <>
      <EmployeeAvatar employee={review.employee} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-semibold text-gray-900">{review.employee.name}</span>
          <span className="text-xs text-gray-500">{employeeRole(review.employee)}</span>
        </span>
        <span className={`mt-0.5 block truncate text-sm ${summary ? 'text-gray-600' : 'text-gray-500'}`}>
          {summary || (isScheduled ? 'Причина не указана' : 'Итоги не указаны')}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden">
          <span className="text-xs font-medium text-gray-500">{formatRussianDate(review.reviewDate)}</span>
          <ReviewStatusBadge review={review} today={today} />
        </span>
      </span>
    </>
  );
}

function ReviewMeta({ review, today }: { review: TeamReview; today: string }) {
  return (
    <span className="hidden shrink-0 text-right sm:block">
      <span className="block text-sm font-medium text-gray-700">{formatRussianDate(review.reviewDate)}</span>
      <span className="mt-1 flex justify-end"><ReviewStatusBadge review={review} today={today} /></span>
      <span className="mt-0.5 block text-xs text-gray-500">
        {review.reviewer ? `Автор: ${review.reviewer.name}` : 'Автор не указан'}
      </span>
    </span>
  );
}

function ReviewRow({
  review,
  today,
  employees,
  canManage,
  open,
  editorPurpose,
  saving,
  error,
  primaryButtonRef,
  editButtonRef,
  onToggle,
  onEdit,
  onComplete,
  onCancel,
  onSubmit,
}: {
  review: TeamReview;
  today: string;
  employees: TeamReviewEmployee[];
  canManage: boolean;
  open: boolean;
  editorPurpose: ReviewFormPurpose | null;
  saving: boolean;
  error: string;
  primaryButtonRef: (node: HTMLButtonElement | null) => void;
  editButtonRef: (node: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onEdit: () => void;
  onComplete: () => void;
  onCancel: () => void;
  onSubmit: (values: ReviewFormState, purpose: ReviewFormPurpose) => Promise<void>;
}) {
  const scheduled = review.status === 'scheduled';
  const regionId = `team-review-${review.id}`;
  const editLabel = scheduled
    ? `Редактировать запланированное ревью ${review.employee.name}`
    : `Редактировать ревью ${review.employee.name}`;

  const editButton = canManage && (
    <button
      ref={editButtonRef}
      type="button"
      onClick={onEdit}
      disabled={saving}
      aria-label={editLabel}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
    >
      <Pencil className="h-4 w-4" aria-hidden="true" />
      <span className="hidden lg:inline">Редактировать</span>
    </button>
  );

  return (
    <article>
      {scheduled ? (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3">
            <ReviewSummary review={review} today={today} />
            <ReviewMeta review={review} today={today} />
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2 sm:ml-2 sm:justify-end">
              <button
                ref={primaryButtonRef}
                type="button"
                onClick={onComplete}
                disabled={saving}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:flex-none"
              >
                Заполнить итоги
              </button>
              {editButton}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-stretch">
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={regionId}
            className="flex min-h-[72px] min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:px-5"
          >
            <ReviewSummary review={review} today={today} />
            <ReviewMeta review={review} today={today} />
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
          {canManage && <div className="flex shrink-0 items-center pr-3 sm:pr-5">{editButton}</div>}
        </div>
      )}

      {editorPurpose && canManage && (
        <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-5 sm:px-6">
          <ReviewForm
            key={`${review.id}:${editorPurpose}`}
            employees={employees}
            initial={{
              reviewDate: review.reviewDate.slice(0, 10),
              employeeUserId: review.employee.id,
              reason: reviewText(review.reason),
              outcomes: reviewText(review.outcomes),
              problems: reviewText(review.problems),
              recommendations: reviewText(review.recommendations),
            }}
            purpose={editorPurpose}
            mode="edit"
            saving={saving}
            error={error}
            onCancel={onCancel}
            onSubmit={(values) => onSubmit(values, editorPurpose)}
          />
        </div>
      )}

      {!scheduled && open && !editorPurpose && (
        <div id={regionId} className="border-t border-gray-100 bg-gray-50/60 px-4 py-5 sm:px-6">
          {review.reason && (
            <div className="mb-5">
              <ReviewSection title="Повестка" text={review.reason} />
            </div>
          )}
          <div className="grid gap-5 lg:grid-cols-3">
            <ReviewSection title="Основные итоги" text={review.outcomes} />
            <ReviewSection title="Зоны внимания" text={review.problems} />
            <ReviewSection title="Рекомендации" text={review.recommendations} />
          </div>
        </div>
      )}
    </article>
  );
}

function ReviewsGroup({
  id,
  title,
  shown,
  total,
  emptyTitle,
  emptyDescription,
  children,
}: {
  id: string;
  title: string;
  shown: number;
  total: number;
  emptyTitle: string;
  emptyDescription: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-3 sm:px-5">
        <h3 id={id} className="text-base font-bold text-gray-900">{title}</h3>
        <p className="text-xs text-gray-500">Показано {shown} из {total}</p>
      </div>
      {shown === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-semibold text-gray-900">{emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{emptyDescription}</p>
        </div>
      ) : <div className="divide-y divide-gray-100">{children}</div>}
    </section>
  );
}

function ReviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {[0, 1].map((group) => (
        <div key={group} className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          {[0, 1].map((item) => (
            <div key={item} className="flex h-20 items-center gap-3 border-b border-gray-100 px-5 last:border-0">
              <span className="h-9 w-9 animate-pulse rounded-full bg-gray-100 motion-reduce:animate-none" />
              <span className="h-4 w-40 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
              <span className="ml-auto h-4 w-24 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function TeamReviewsPanel() {
  const [data, setData] = useState<TeamReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [requestVersion, setRequestVersion] = useState(0);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const reviewPrimaryButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const reviewEditButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const today = localIsoDate();

  const restoreFocus = (
    reviewId?: string,
    target: ReviewFocusTarget = 'primary',
  ) => {
    window.requestAnimationFrame(() => {
      if (!reviewId) {
        createButtonRef.current?.focus();
        return;
      }
      const preferredRefs = target === 'edit'
        ? reviewEditButtonRefs.current
        : reviewPrimaryButtonRefs.current;
      const fallback = reviewPrimaryButtonRefs.current.get(reviewId)
        || createButtonRef.current;
      (preferredRefs.get(reviewId) || fallback)?.focus();
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await teamApiFetch('/api/team/reviews');
      setData(normalizeReviews(payload));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить ревью.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Loading starts from an external API boundary; the callback owns all state updates.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, requestVersion]);

  const years = useMemo(() => {
    const values = new Set<number>([new Date().getFullYear()]);
    data?.reviews.forEach((review) => {
      const year = Number(review.reviewDate.slice(0, 4));
      if (Number.isFinite(year) && year > 2000) values.add(year);
    });
    return Array.from(values).sort((a, b) => b - a);
  }, [data?.reviews]);

  const filteredReviews = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
    return (data?.reviews || []).filter((review) => {
      if (employeeFilter !== 'all' && review.employee.id !== employeeFilter) return false;
      if (yearFilter !== 'all' && review.reviewDate.slice(0, 4) !== yearFilter) return false;
      if (!normalizedQuery) return true;
      return [
        review.employee.name,
        review.employee.email || '',
        reviewText(review.reason),
        reviewText(review.outcomes),
        reviewText(review.problems),
        reviewText(review.recommendations),
      ].some((value) => value.toLocaleLowerCase('ru-RU').includes(normalizedQuery));
    });
  }, [data?.reviews, employeeFilter, query, yearFilter]);

  const scheduledReviews = useMemo(() => filteredReviews
    .filter((review) => review.status === 'scheduled')
    .sort((a, b) => a.reviewDate.localeCompare(b.reviewDate) || a.createdAt.localeCompare(b.createdAt)), [filteredReviews]);

  const completedReviews = useMemo(() => filteredReviews
    .filter((review) => review.status !== 'scheduled')
    .sort((a, b) => b.reviewDate.localeCompare(a.reviewDate) || b.updatedAt.localeCompare(a.updatedAt)), [filteredReviews]);

  const totalScheduled = data?.reviews.filter((review) => review.status === 'scheduled').length || 0;
  const totalCompleted = (data?.reviews.length || 0) - totalScheduled;
  const filtersActive = Boolean(query.trim() || employeeFilter !== 'all' || yearFilter !== 'all');

  const submitReview = async (
    values: ReviewFormState,
    purpose: ReviewFormPurpose,
    reviewId?: string,
    focusTarget: ReviewFocusTarget = 'primary',
    expectedUpdatedAt?: string,
  ) => {
    setSaving(true);
    setActionError('');
    const schedule = buildTeamReviewScheduleWrite({
      reviewDate: values.reviewDate,
      employeeUserId: values.employeeUserId,
      reason: values.reason,
    });
    const body = purpose === 'schedule'
      ? schedule
      : {
          ...schedule,
          ...buildTeamReviewCompletionWrite({
            outcomes: values.outcomes,
            problems: values.problems,
            recommendations: values.recommendations,
          }),
        };
    const requestBody = reviewId
      ? { ...body, expectedUpdatedAt }
      : body;
    let saved = false;
    try {
      await teamApiFetch(reviewId ? `/api/team/reviews/${reviewId}` : '/api/team/reviews', {
        method: reviewId ? 'PATCH' : 'POST',
        body: JSON.stringify(requestBody),
      });
      await load();
      setCreating(false);
      setEditor(null);
      saved = true;
    } catch (submitError) {
      if (
        reviewId
        && submitError instanceof TeamApiError
        && submitError.code === 'review_conflict'
      ) {
        setEditor((current) => current?.reviewId === reviewId
          ? { ...current, conflicted: true }
          : current);
        setActionError(REVIEW_CONFLICT_MESSAGE);
      } else {
        setActionError(submitError instanceof Error ? submitError.message : 'Не удалось сохранить ревью.');
      }
    } finally {
      setSaving(false);
      if (saved) restoreFocus(reviewId, focusTarget);
    }
  };

  const toggleReview = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEditor = (
    review: TeamReview,
    purpose: ReviewFormPurpose,
    returnFocus: ReviewFocusTarget,
  ) => {
    setCreating(false);
    setEditor({
      reviewId: review.id,
      purpose,
      returnFocus,
      expectedUpdatedAt: review.updatedAt,
      conflicted: false,
    });
    setActionError('');
  };

  const closeEditor = (
    reviewId: string,
    returnFocus: ReviewFocusTarget,
    refreshAfterConflict: boolean,
  ) => {
    setEditor(null);
    setActionError('');
    if (!refreshAfterConflict) {
      restoreFocus(reviewId, returnFocus);
      return;
    }

    void load().finally(() => restoreFocus(reviewId, returnFocus));
  };

  const renderReview = (review: TeamReview) => {
    const rowEditor = editor?.reviewId === review.id ? editor : null;
    const returnFocus = rowEditor?.returnFocus || 'primary';

    return (
      <ReviewRow
        key={review.id}
        review={review}
        today={today}
        employees={data?.employees || []}
        canManage={data?.canManage === true}
        open={expanded.has(review.id)}
        editorPurpose={rowEditor?.purpose || null}
        saving={saving || loading}
        error={rowEditor ? actionError : ''}
        primaryButtonRef={(node) => {
          storeReviewButtonRef(reviewPrimaryButtonRefs.current, review.id, node);
        }}
        editButtonRef={(node) => {
          storeReviewButtonRef(reviewEditButtonRefs.current, review.id, node);
        }}
        onToggle={() => toggleReview(review.id)}
        onEdit={() => openEditor(
          review,
          review.status === 'scheduled' ? 'schedule' : 'complete',
          'edit',
        )}
        onComplete={() => openEditor(review, 'complete', 'primary')}
        onCancel={() => closeEditor(
          review.id,
          returnFocus,
          rowEditor?.conflicted === true,
        )}
        onSubmit={(values, purpose) => submitReview(
          values,
          purpose,
          review.id,
          returnFocus,
          rowEditor?.expectedUpdatedAt,
        )}
      />
    );
  };

  return (
    <>
      <section
        className="space-y-5"
        aria-labelledby="team-reviews-title"
        aria-busy={loading}
      >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="team-reviews-title" className="text-xl font-bold tracking-tight text-gray-900">Ревью сотрудников</h2>
          <p className="mt-1 text-sm text-gray-500">Запланируйте встречу заранее, а после неё сохраните итоги и договорённости.</p>
        </div>
        {data?.canManage && !creating && (
          <button
            ref={createButtonRef}
            type="button"
            disabled={loading}
            onClick={() => {
              setCreating(true);
              setEditor(null);
              setActionError('');
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Запланировать ревью
          </button>
        )}
      </div>

      {creating && data?.canManage && (
        <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-gray-900">Запланировать ревью</h3>
              <p className="mt-0.5 text-sm text-gray-500">Сейчас достаточно даты и сотрудника. Причину можно добавить, если нужна повестка.</p>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setCreating(false);
                setActionError('');
                restoreFocus();
              }}
              aria-label="Закрыть форму"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ReviewForm
            employees={data.employees}
            purpose="schedule"
            mode="create"
            saving={saving}
            error={actionError}
            onCancel={() => {
              setCreating(false);
              setActionError('');
              restoreFocus();
            }}
            onSubmit={(values) => submitReview(values, 'schedule')}
          />
        </div>
      )}

      {error && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setRequestVersion((value) => value + 1);
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 font-medium outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Повторить
          </button>
        </div>
      )}

      <div className="grid gap-2 lg:grid-cols-[minmax(240px,1fr)_minmax(210px,280px)_150px]">
        <label className="relative block">
          <span className="sr-only">Поиск по ревью</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по сотруднику, причине или итогам"
            className="h-11 w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none placeholder:text-gray-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label>
          <span className="sr-only">Сотрудник</span>
          <select
            value={employeeFilter}
            onChange={(event) => setEmployeeFilter(event.target.value)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="all">Все сотрудники</option>
            {data?.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Год</span>
          <select
            value={yearFilter}
            onChange={(event) => setYearFilter(event.target.value)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="all">Все годы</option>
            {years.map((year) => <option key={year} value={String(year)}>{year}</option>)}
          </select>
        </label>
      </div>

      {loading && !data ? <ReviewSkeleton /> : data && (
        <div className="space-y-5">
          <ReviewsGroup
            id="scheduled-reviews-title"
            title="Запланировано"
            shown={scheduledReviews.length}
            total={totalScheduled}
            emptyTitle={filtersActive ? 'По фильтрам ничего не найдено' : 'Запланированных ревью нет'}
            emptyDescription={filtersActive
              ? 'Измените сотрудника, год или поисковый запрос.'
              : 'Запланируйте следующую встречу, чтобы она появилась здесь.'}
          >
            {scheduledReviews.map(renderReview)}
          </ReviewsGroup>

          <ReviewsGroup
            id="completed-reviews-title"
            title="История"
            shown={completedReviews.length}
            total={totalCompleted}
            emptyTitle={filtersActive ? 'По фильтрам ничего не найдено' : 'Проведённых ревью пока нет'}
            emptyDescription={filtersActive
              ? 'Измените сотрудника, год или поисковый запрос.'
              : 'После заполнения итогов завершённые ревью появятся здесь.'}
          >
            {completedReviews.map(renderReview)}
          </ReviewsGroup>
        </div>
      )}

        <p className="sr-only" aria-live="polite">
          {saving ? 'Ревью сохраняется' : ''}
        </p>
      </section>
      {loading && (
        <p className="sr-only" role="status">Загружаем ревью…</p>
      )}
    </>
  );
}
